/**
 * 持ち主向けのAPI群 — 同意・属性・アクセシビリティ設定・人格カードの書き出し。
 *
 * 共通の方針:
 * - すべて持ち主トークンで保護する。cid だけ知っている人には何も返さない。
 *   属性も価値観の推定も、会話の中身と同じくらい「その人のもの」なので、公開APIには置かない。
 * - 画面側に判断を持たせない。項目の定義・次に聞く質問・同意の文面はすべてサーバーが返し、
 *   HTMLは受け取って並べるだけにする（説明文が2箇所に散ると、必ず食い違う）。
 */

import { CharacterState } from "./durable-objects/characterState";
import { CONSENT_TEXTS, CONSENT_VERSION } from "./persona/consent";
import { PROFILE_GROUPS, completionRate } from "./persona/profile";
import { renderOllamaModelfile, renderReadme } from "./persona/personaCard";
import { LogContext, logInfo } from "./lib/log";

export interface PersonaRoutesEnv {
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    },
  });
}

/**
 * 質問票と同意文面の定義を返す。個人のデータは含まないので保護しない。
 * 画面側で項目を書き写さずに済むよう、ここを唯一の定義元にしている。
 */
export function handleProfileSchema(): Response {
  return new Response(
    JSON.stringify({
      consentVersion: CONSENT_VERSION,
      consentTexts: CONSENT_TEXTS,
      groups: PROFILE_GROUPS,
    }),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        // 定義は滅多に変わらないが、変えたときに古い版が残り続けると同意の版と食い違う
        "cache-control": "public, max-age=300",
      },
    }
  );
}

/** 持ち主に、いま保存されている自分の情報を見せる。 */
export async function handleGetOwnerView(env: PersonaRoutesEnv, url: URL): Promise<Response> {
  const cid = url.searchParams.get("cid");
  const token = url.searchParams.get("token") || undefined;
  if (!cid) return json({ error: "cid is required" }, 400);

  const result = await env.CHARACTER.getByName(cid).getOwnerView(token);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  return json({
    consent: result.consent,
    consentVersion: CONSENT_VERSION,
    profile: result.profile,
    completion: completionRate(result.profile.answers),
    accessibility: result.accessibility,
    psychographics: result.psychographics,
    segment: result.segment,
    // 「分身が自分について何を覚えているか」は、本人には見えていた方がいい。
    // 土台（本人が書いた分）と学習分を分けて返すのは、画面で別々に直せるようにするため。
    notes: result.profileNotes,
    notesSeed: result.profileNotesSeed,
    nextField: result.nextField,
    interactionCount: result.interactionCount,
  });
}

export async function handleSetConsent(
  env: PersonaRoutesEnv,
  body: { characterId?: string; token?: string; consent?: unknown },
  log: LogContext
): Promise<Response> {
  if (!body.characterId) return json({ error: "characterId is required" }, 400);

  const result = await env.CHARACTER.getByName(body.characterId).setConsent(body.consent, body.token);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  // 同意の状態は運用上の重要な事実なので記録する（本文は出さない、という原則は守る）
  logInfo(log, "consent.updated", {
    characterId: body.characterId,
    profile: result.consent.profile,
    aggregate: result.consent.aggregate,
    marketplace: result.consent.marketplace,
  });
  return json({ consent: result.consent });
}

export async function handleSetProfile(
  env: PersonaRoutesEnv,
  body: { characterId?: string; token?: string; answers?: unknown; replace?: boolean; declineAll?: boolean }
): Promise<Response> {
  if (!body.characterId) return json({ error: "characterId is required" }, 400);

  const result = await env.CHARACTER.getByName(body.characterId).setProfile(body.answers, body.token, {
    replace: body.replace === true,
    declineAll: body.declineAll === true,
  });
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  return json({ profile: result.profile, completion: completionRate(result.profile.answers) });
}

/**
 * 覚え書きの書き換え。
 * 「分身が自分について何を覚えているか」を見せている以上、間違いを直す手段も要る。
 */
export async function handleSetNotes(
  env: PersonaRoutesEnv,
  body: { characterId?: string; token?: string; notes?: unknown; part?: unknown }
): Promise<Response> {
  if (!body.characterId) return json({ error: "characterId is required" }, 400);

  // part を省いた場合は従来どおり「会話から覚えた分」への書き込み（既存クライアント互換）。
  const part = body.part === "seed" ? "seed" : "learned";

  const result = await env.CHARACTER.getByName(body.characterId).setProfileNotes(body.notes, body.token, part);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  return json({ notes: result.notes, notesSeed: result.notesSeed });
}

export async function handleSetAccessibility(
  env: PersonaRoutesEnv,
  body: { characterId?: string; token?: string; prefs?: unknown }
): Promise<Response> {
  if (!body.characterId) return json({ error: "characterId is required" }, 400);

  const result = await env.CHARACTER.getByName(body.characterId).setAccessibility(body.prefs, body.token);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  return json({ accessibility: result.accessibility });
}

/**
 * 人格カードの書き出し。
 * format で受け取り方を変える（載せ先によって、要るものが違うため）。
 */
export async function handlePersonaCard(env: PersonaRoutesEnv, url: URL, log: LogContext): Promise<Response> {
  const cid = url.searchParams.get("cid");
  const token = url.searchParams.get("token") || undefined;
  const format = url.searchParams.get("format") || "json";
  const baseModel = url.searchParams.get("base") || "llama3.1:8b";
  if (!cid) return json({ error: "cid is required" }, 400);

  const result = await env.CHARACTER.getByName(cid).buildCard(token);
  if (!result.ok) return json({ error: result.error }, result.error === "not found" ? 404 : 403);

  const card = result.card;
  const safeName = (card.identity.name || "persona").replace(/[^\w.\-ぁ-んァ-ヶー一-龠]/g, "_");
  logInfo(log, "persona.card_exported", {
    characterId: cid,
    format,
    memories: card.memories.length,
    examples: card.examples.length,
  });

  if (format === "prompt") {
    return text(card.runtime.systemPrompt, `${safeName}_system_prompt.txt`);
  }
  if (format === "modelfile") {
    return text(renderOllamaModelfile(card, baseModel), `Modelfile`);
  }
  if (format === "readme") {
    return text(renderReadme(card), `${safeName}_README.md`);
  }

  return new Response(JSON.stringify(card, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${encodeURIComponent(`${safeName}_persona_card.json`)}"`,
    },
  });
}
