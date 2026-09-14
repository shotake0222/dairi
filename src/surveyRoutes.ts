/**
 * パルスサーベイのAPI。
 *
 * 画面側には「次の1問」と「答える」「あとで」しか渡さない。
 * どの設問をいつ聞くか、属性と価値観のどちらを先に出すかは、すべてこちら側で決める
 * （画面に判断を持たせると、chat・profile・talk で挙動がずれて、
 *   同じ人に同じ設問が3回出る、というようなことが起きる）。
 *
 * 同意について:
 * 属性も価値観の申告も「答えを覚えておく」行為なので、どちらも profile 同意を要求する。
 * 同意がまだなら、設問の代わりに同意の依頼を返す。ここで勝手に保存しないのが唯一の正解で、
 * 「答えてくれたから同意したものとみなす」は、後から説明できない。
 */

import { CharacterState } from "./durable-objects/characterState";
import { CONSENT_TEXTS } from "./persona/consent";
import { completionRate } from "./persona/profile";
import { loadCatalog, QuestionStoreEnv } from "./persona/questionStore";
import { nextSurveyItem, personaDepth, psychoQuestionById, SurveyItem } from "./persona/survey";
import { LogContext, logInfo } from "./lib/log";

export interface SurveyEnv extends QuestionStoreEnv {
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 覚え書きの行数を「覚えていることの数」として数える（厚みの材料のひとつ）。 */
function countNotes(notes: string): number {
  return notes.split("\n").filter((line) => line.trim().length > 0).length;
}

export async function handleSurveyNext(env: SurveyEnv, url: URL): Promise<Response> {
  const cid = url.searchParams.get("cid");
  const token = url.searchParams.get("token") || undefined;
  if (!cid) return json({ error: "cid is required" }, 400);

  const view = await env.CHARACTER.getByName(cid).getOwnerView(token);
  if (!view.ok) return json({ error: view.error }, view.error === "not found" ? 404 : 403);

  const catalog = await loadCatalog(env);
  const depth = personaDepth({
    interactionCount: view.interactionCount,
    profileAnswered: Object.keys(view.profile.answers).length,
    profileTotal: catalog.fields.length,
    psychoAnswered: view.survey.psychoAnswered.length,
    psychoTotal: catalog.psycho.length,
    memoryCount: countNotes(view.profileNotes),
  });

  // 同意がまだなら、設問ではなく同意の依頼を返す。文面は consent.ts が唯一の定義元
  if (!view.consent?.profile) {
    // 文面は consent.ts が唯一の定義元。ここで書き直すと、同意画面と食い違う
    const text = CONSENT_TEXTS.profile;
    return json({
      needsConsent: true,
      consentTitle: text.title,
      consentText: `${text.body}\n${text.note}`,
      depth,
      item: null,
    });
  }

  const item = nextSurveyItem(catalog.fields, catalog.psycho, {
    answers: view.profile.answers,
    psychoAnswered: view.survey.psychoAnswered,
    skipped: view.survey.skipped,
    declinedAll: view.profile.declinedAll,
    interactionCount: view.interactionCount,
  });

  return json({
    item,
    depth,
    answered: Object.keys(view.profile.answers).length + view.survey.psychoAnswered.length,
    total: catalog.fields.length + catalog.psycho.length,
    completion: completionRate(view.profile.answers, catalog.fields),
  });
}

export async function handleSurveyAnswer(
  env: SurveyEnv,
  body: { characterId?: unknown; token?: unknown; id?: unknown; values?: unknown; declineAll?: unknown },
  log: LogContext
): Promise<Response> {
  const cid = typeof body.characterId === "string" ? body.characterId : "";
  const id = typeof body.id === "string" ? body.id : "";
  const token = typeof body.token === "string" ? body.token : undefined;
  if (!cid || !id) return json({ error: "characterId and id are required" }, 400);

  const values = Array.isArray(body.values) ? body.values.filter((v): v is string => typeof v === "string") : [];
  if (values.length === 0) return json({ error: "values is required" }, 400);

  const catalog = await loadCatalog(env);
  const stub = env.CHARACTER.getByName(cid);

  // 価値観の設問か（IDで引けるかどうかで判別する。属性と価値観でIDの空間は共有している）
  const psycho = psychoQuestionById(id, catalog.psycho);
  if (psycho) {
    const chosen = psycho.options.find((o) => o.label === values[0]);
    if (!chosen) return json({ error: "その選択肢は設問にありません" }, 400);
    const result = await stub.answerPsychoQuestion(psycho.id, psycho.axis, chosen.score, chosen.label, token);
    if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);
    // 回答の中身は記録しない。どの軸が埋まったかだけ分かれば運用には足りる
    logInfo(log, "survey.answered", { characterId: cid, kind: "psychographic", axis: psycho.axis });
    return json({ ok: true });
  }

  const field = catalog.fields.find((f) => f.key === id);
  if (!field) return json({ error: "設問が見つかりません" }, 404);

  const result = await stub.setProfile({ [field.key]: values }, token, {
    extraFields: [field],
    declineAll: body.declineAll === true ? true : undefined,
  });
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);
  logInfo(log, "survey.answered", { characterId: cid, kind: "demographic", field: field.key });
  return json({ ok: true });
}

/**
 * 「もう聞かないで」。
 *
 * skip（あとで）と分けているのは、意味がまったく違うから。
 * あとで＝この設問は今は答えたくない、もう聞かないで＝こちらから促すのをやめてほしい。
 * 前者を積み上げて後者と解釈すると、答えたくない設問が数問あっただけで
 * 二度と聞かれなくなる。属性ページからは引き続き自分で答えられる。
 */
export async function handleSurveyDecline(
  env: SurveyEnv,
  body: { characterId?: unknown; token?: unknown },
  log: LogContext
): Promise<Response> {
  const cid = typeof body.characterId === "string" ? body.characterId : "";
  const token = typeof body.token === "string" ? body.token : undefined;
  if (!cid) return json({ error: "characterId is required" }, 400);

  const result = await env.CHARACTER.getByName(cid).setProfile({}, token, { declineAll: true });
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);
  logInfo(log, "survey.declined_all", { characterId: cid });
  return json({ ok: true });
}

export async function handleSurveySkip(
  env: SurveyEnv,
  body: { characterId?: unknown; token?: unknown; id?: unknown }
): Promise<Response> {
  const cid = typeof body.characterId === "string" ? body.characterId : "";
  const id = typeof body.id === "string" ? body.id : "";
  const token = typeof body.token === "string" ? body.token : undefined;
  if (!cid || !id) return json({ error: "characterId and id are required" }, 400);

  const result = await env.CHARACTER.getByName(cid).skipSurveyItem(id, token);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);
  return json({ ok: true });
}

/** 属性ページなどから、まとめて聞きたいとき用。設問カタログをそのまま返す。 */
export async function handleSurveyCatalog(env: SurveyEnv): Promise<Response> {
  const catalog = await loadCatalog(env);
  return json({
    groups: catalog.groups,
    psycho: catalog.psycho.map((q) => ({
      id: q.id,
      axis: q.axis,
      label: q.label,
      why: q.why,
      askAfter: q.askAfter,
      options: q.options.map((o) => o.label),
    })),
  });
}

export type { SurveyItem };
