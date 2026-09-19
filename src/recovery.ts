/**
 * 分身の復旧（運営による、持ち主トークンを失った人の救済）。
 *
 * 何を解いているか:
 * 持ち主トークンは端末のlocalStorageにしか無い。機種変更で引き継ぎコードを取り忘れた、
 * ブラウザのデータを消した、端末を壊した——この場合、本人でも自分の分身を操作できなくなる。
 * 引き継ぎコード（src/transfer.ts）は「いま持ち主である人」しか発行できないので、
 * 失ってからでは使えない。そこで、運営が本人確認をしたうえで発行する経路をここに置く。
 *
 * 設計で外さないようにしたこと:
 *
 * 1. **復旧に会話の閲覧は要らない**。
 *    復旧とは「所有権を本人の新しい端末へ戻すこと」であって、
 *    トークンさえ戻れば、会話履歴も記憶も本人がそのまま見られる。
 *    だから運営が中身を読む必要がない。読めるようにすると、
 *    その閲覧機能自体が最大の情報漏洩経路になる。ここでは本人確認に使う項目までしか返さない。
 *
 * 2. **本人確認に使えるのは、本人しか知らないはずのこと**。
 *    分身の名前・育て始めた時期・会話の回数・見た目。これらは会話の中身ではないので出してよい。
 *    照合は運営が目で行う（自動判定にすると、当てずっぽうで通る条件を作ってしまう）。
 *
 * 3. **発行は必ず記録する**。誰の分身に、いつ、運営がコードを出したかをログに残す。
 *    この経路は「持ち主でない人に所有権を渡せる」経路なので、
 *    後から追えないまま運用してはいけない。
 */

import { CharacterState } from "./durable-objects/characterState";
import { createTransferCode } from "./transfer";
import { LogContext, logInfo, logWarn } from "./lib/log";

export interface RecoveryEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** タグIDから分身を引く。タグは物理的に手元にあるはずのものなので、申請時の手がかりになる。 */
async function resolveCharacterId(env: RecoveryEnv, query: string): Promise<string | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // まずタグIDとして引く（利用者が伝えやすいのはこちら）
  const row = await env.DB.prepare("SELECT character_id FROM nfc_tags WHERE tag_id = ?")
    .bind(trimmed)
    .first<{ character_id: string }>();
  if (row) return row.character_id;

  // 次に分身のID（URLに乗るので、古い端末やブックマークから拾えることがある）
  const asCharacter = await env.DB.prepare("SELECT character_id FROM nfc_tags WHERE character_id = ?")
    .bind(trimmed)
    .first<{ character_id: string }>();
  if (asCharacter) return asCharacter.character_id;

  // タグに紐づいていない分身（インポートで作られた等）もありうるので、最後にそのまま試す
  return trimmed;
}

/**
 * 本人確認のための情報を返す（管理画面から呼ぶ）。
 * **会話の本文・記憶・覚え書き・属性は返さない。** 返すのは、本人なら答えられるはずのことだけ。
 */
export async function handleRecoveryLookup(env: RecoveryEnv, url: URL, log: LogContext): Promise<Response> {
  const query = url.searchParams.get("q") || "";
  if (!query.trim()) return json({ error: "タグIDまたは分身のIDを入力してください" }, 400);

  const characterId = await resolveCharacterId(env, query);
  if (!characterId) return json({ error: "見つかりませんでした" }, 404);

  const state = await env.CHARACTER.getByName(characterId).getState();
  if (!state) return json({ error: "見つかりませんでした" }, 404);

  // このタグでの再タップ状況も出す（同じタグが再利用されていないかの確認に使う）
  const tags = await env.DB.prepare("SELECT tag_id, created_at FROM nfc_tags WHERE character_id = ?")
    .bind(characterId)
    .all<{ tag_id: string; created_at: number }>();

  logInfo(log, "recovery.lookup", { characterId });

  return json({
    characterId,
    // 本人確認用の項目。いずれも「本人なら答えられる」が「会話の中身ではない」もの。
    verification: {
      name: state.name,
      species: state.species,
      color: state.color,
      growthStage: state.growthStage,
      interactionCount: state.interactionCount,
      createdAt: state.createdAt,
      lastVisit: state.lastVisit,
      hasOwnerToken: Boolean(state.ownerToken),
      // 覚え書きの「件数」だけ。中身は出さない（何件覚えているかは本人も答えられる情報ではないが、
      // 別人に渡してしまったときの被害の見当をつけるために運営側で見えたほうがよい）
      noteLines:
        (state.profileNotes ?? "").split("\n").filter((l) => l.trim()).length +
        (state.profileNotesSeed ?? "").split("\n").filter((l) => l.trim()).length,
    },
    tags: (tags.results ?? []).map((t) => ({ tagId: t.tag_id, createdAt: t.created_at })),
  });
}

/**
 * 運営として引き継ぎコードを発行する。
 *
 * これは「持ち主でない人に所有権を渡せる」操作なので、
 * 呼び出しには必ず理由を添えさせ、記録に残す。
 */
export async function handleRecoveryIssue(
  env: RecoveryEnv,
  body: { characterId?: string; reason?: string },
  log: LogContext
): Promise<Response> {
  const characterId = (body.characterId || "").trim();
  const reason = (body.reason || "").trim();
  if (!characterId) return json({ error: "characterId is required" }, 400);
  if (reason.length < 4) {
    // 理由の記入を必須にしているのは、監査のためというより、
    // 「なんとなく押す」を防ぐため。所有権を移す操作を軽い動作にしない。
    return json({ error: "発行の理由を記入してください（本人確認の内容など）" }, 400);
  }

  const state = await env.CHARACTER.getByName(characterId).getState();
  if (!state) return json({ error: "見つかりませんでした" }, 404);

  const issued = await createTransferCode(env, characterId);

  // 理由の本文はログに出さない（本人確認のやり取りに個人情報が混じりうるため）。
  // 追跡に必要なのは「いつ・どの分身に・運営が出したか」まで。
  logWarn(log, "recovery.code_issued", {
    characterId,
    reasonLength: reason.length,
    expiresAt: issued.expiresAt,
  });

  return json({ code: issued.code, expiresAt: issued.expiresAt, name: state.name });
}
