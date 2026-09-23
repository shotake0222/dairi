/**
 * 納品 — 「実際に何を売るのか」。
 *
 * ここが曖昧なままだと、商談で出せるものが無い。売るのは分身そのものではなく、
 * **その人格を、相手の環境で動かせる形にしたもの**と、それを取り出す権利（引換券）。
 * 分身の所有権は持ち主のままで、こちらが渡すのは写しと、その写しを取る鍵。
 *
 * 相手によって渡す形が違う:
 *
 *   相手がAI（エージェント・LLMアプリ）    → MCP（この人格に問い合わせる口を開ける）
 *   相手が自前のLLM基盤を持っている        → 人格カード（JSON / systemPrompt / Modelfile）
 *   相手がAIを使っていない機器             → 振る舞いプロファイル（数値だけ。数百バイト）
 *   相手がネットに繋がない（スタンドアロン） → 持ち出し一式（上を全部まとめたもの）
 *
 * **振る舞いプロファイルにはAIが要らない**のが効く。ロボットや玩具、サイネージのように
 * 言語モデルを積めない・積みたくない相手にも、同じ人格データを売れる。
 */

import { auditCompact, toCompact } from "../tools/edge/compact.mjs";
import { buildDecisionProfile, buildSlmPackage, DEFAULT_SLM_BASE, SLM_BASES } from "./slm";
import { renderOllamaModelfile, renderReadme } from "./persona/personaCard";
import type { PersonaCard } from "./persona/personaCard";
import type { CharacterState } from "./durable-objects/characterState";

export interface DeliveryEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

export type DeliveryScope = "card" | "behavior" | "mcp" | "bundle" | "slm" | "decision";

export const DELIVERY_SCOPES: DeliveryScope[] = ["card", "behavior", "mcp", "bundle", "slm", "decision"];

export interface Sku {
  id: DeliveryScope;
  name: string;
  /** 誰に売るものか */
  buyer: string;
  /** 実際に渡すファイル・口 */
  delivers: string[];
  /** 相手の環境に必要なもの */
  requires: string;
  /** 渡らないもの（ここを曖昧にしない） */
  excludes: string;
  /**
   * 買い手が実際に叩く口。
   * **引換券を発行する前でも、何を渡すことになるのかが分かるように**画面へ出す
   * （商談中に「APIはどうなっていますか」と聞かれて、券を切らないと答えられないのは困る）。
   * <TOKEN> のところに引換券が入る。
   */
  endpoint: string;
}

/**
 * 商品の定義。**画面・書類・APIはすべてこの配列を見る。**
 * 営業資料と実装がずれるのが、この手の仕組みで最初に壊れるところなので、定義元を1つにする。
 */
export const SKUS: Sku[] = [
  {
    id: "card",
    name: "人格カード",
    buyer: "自前のLLM基盤を持っていて、その上でこの人格を動かしたい相手",
    delivers: [
      "persona_card.json（性格・価値観・口調・声・身体のパラメータ・選択肢で答えた属性）",
      "system_prompt.txt（そのまま渡せる形）",
      "Modelfile（Ollama用。ローカルで動かす場合）",
      "README.md（載せ方と、含まれていないものの説明）",
    ],
    requires: "任意のLLM（クラウドでもローカルでも可）",
    excludes:
      "会話の本文と、そこから抜いた応答例・記憶・覚え書き（規約で第三者へ渡さないと約束している）、" +
      "年収、入力方法などの設定、持ち主の連絡先。持ち主が「法人への個別提供」を入れていない分身は発行できない",
    endpoint: "GET /api/delivery?scope=card&token=<TOKEN>（&format=modelfile で Modelfile）",
  },
  {
    id: "behavior",
    name: "振る舞いプロファイル",
    buyer: "AIを積んでいない機器（ロボット・玩具・サイネージ・アバター）を作っている相手",
    delivers: [
      "persona.min.json（数値と識別子だけ。実測240〜250バイト）",
      "参照実装（Python / Arduino / MicroPython）",
    ],
    requires: "なし。**LLMは不要**（ESP32やRaspberry Pi Picoでも動く）",
    excludes: "会話・覚え書き・属性は1文字も含まない（機械で検査してから渡す）",
    endpoint: "GET /api/delivery?scope=behavior&token=<TOKEN>",
  },
  {
    id: "mcp",
    name: "MCP接続",
    buyer: "自社のAIエージェントから、この人格を参照したい相手",
    delivers: [
      "MCPエンドポイント（/mcp）と引換券",
      "使える道具: persona_profile（人物像）, persona_behavior（身体のパラメータ）, persona_reply（その子として答える）",
    ],
    requires: "MCPに対応したクライアント（Claude Desktop、各種エージェント基盤など）",
    excludes:
      "書き込みの口は開けない（読み取りだけ）。persona_reply も分身側には一切保存しないので、" +
      "呼んでも人格は変わらない。会話の全文ログと持ち主の連絡先は含まれない",
    endpoint: "POST /mcp（JSON-RPC 2.0） / Authorization: Bearer <TOKEN>",
  },
  {
    id: "slm",
    name: "自分専用のSLM（小さな言語モデル）一式",
    buyer: "クラウドに繋がず、手元の小さなモデルでこの人格を喋らせたい相手",
    delivers: [
      "Modelfile（土台のSLM＋人格。ollama create だけで動く）",
      "README.md（0.5B〜8Bの選び方、学習手順、移ったかどうかの確かめ方）",
      "※ LoRA学習データ（train.jsonl）は会話そのものなので、買い手には空で渡る。" +
        "中身が入るのは、持ち主が自分の分身を書き出したとき（/api/persona/card?format=slm）だけ",
    ],
    requires: "Ollama が動く環境。0.5BならRaspberry Pi 4でも回る",
    excludes:
      "会話の本文（学習データを含む）、持ち主の連絡先、機微な属性。" +
      "※ SLM は Small Language Model。SML（Standard ML という別の言語）ではない",
    endpoint: "GET /api/delivery?scope=slm&token=<TOKEN>",
  },
  {
    id: "decision",
    name: "判断プロファイル（判断特化AI向け）",
    buyer: "Jev のような『文章を書かない判断特化モデル』に、誰の判断かを与えたい相手",
    delivers: [
      "decision_profile.json（Choice / Score / Noul の問いと、この人の既定の答え）",
      "既定値の根拠（どの軸から来ているか）と、確からしさ（confidence）",
    ],
    requires: "判断特化モデルのAPI、または自前の分岐ロジック",
    excludes:
      "**Jev そのものは作れません**（TypeSafe AI の製品で、重みもファインチューンの口も非公開）。" +
      "渡すのは、判断特化モデルへ流し込む『この人の判断の癖』です",
    endpoint: "GET /api/delivery?scope=decision&token=<TOKEN>",
  },
  {
    id: "bundle",
    name: "持ち出し一式（スタンドアロン）",
    buyer: "ネットに繋がない環境で動かす相手（工場・車内・展示会場・医療機器まわり）",
    delivers: [
      "上の3つのうち、MCP以外を1つのzipに（カード・プロンプト・Modelfile・振る舞い・参照実装・README）",
      "オフラインでの動かし方（docs/EDGE_DEVICE_TEST.md と同じ手順）",
    ],
    requires: "言葉が要るなら Raspberry Pi 4 以上＋Ollama。振る舞いだけなら何も要らない",
    excludes: "納品後の更新は届かない（更新が要るなら、期限つきで再発行する）",
    endpoint: "GET /api/delivery?scope=bundle&token=<TOKEN>",
  },
];

// ---- 引換券 ----

/** 引換券の既定の有効期限。無期限にしないのは、失効させ忘れが必ず起きるため。 */
export const DEFAULT_GRANT_DAYS = 90;

function tokenAlphabet(): string {
  return "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
}

/** 引換券の文字列。口頭やメールで渡る前提なので、読み間違えやすい文字は使わない。 */
export function generateGrantToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const alphabet = tokenAlphabet();
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 6 === 0) out += "-";
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.trim().toUpperCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Grant {
  characterId: string;
  scopes: DeliveryScope[];
  label: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  usedCount: number;
  lastUsedAt: number | null;
  /** 画面に出すための断片。引換券そのものは保存していないので、末尾4文字も出せない */
  tokenHash: string;
}

export async function issueGrant(
  env: DeliveryEnv,
  params: { characterId?: unknown; scopes?: unknown; label?: unknown; days?: unknown }
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; status: number; error: string }> {
  const characterId = typeof params.characterId === "string" ? params.characterId.trim() : "";
  if (!characterId) return { ok: false, status: 400, error: "分身のIDを指定してください" };

  const requested = Array.isArray(params.scopes) ? params.scopes : [];
  const scopes = DELIVERY_SCOPES.filter((s) => requested.includes(s));
  if (scopes.length === 0) return { ok: false, status: 400, error: "渡す範囲を1つ以上選んでください" };

  // 持ち主が「法人への個別提供」を入れていない分身には、券を切らない。
  // 取り出しの側（buildBuyerCard）でも止まるが、発行できてしまうと「売れる」と誤解して商談が進む。
  const consentCheck = await env.CHARACTER.getByName(characterId).buildBuyerCard();
  if (!consentCheck.ok) {
    return consentCheck.error === "not found"
      ? { ok: false, status: 404, error: "その分身は見つかりませんでした" }
      : { ok: false, status: 409, error: "この分身の持ち主は、法人への個別提供を許可していません" };
  }

  const days = Number(params.days);
  const validDays = Number.isFinite(days) && days > 0 && days <= 730 ? Math.floor(days) : DEFAULT_GRANT_DAYS;
  const label = typeof params.label === "string" && params.label.trim() ? params.label.trim().slice(0, 80) : null;

  const token = generateGrantToken();
  const now = Date.now();
  const expiresAt = now + validDays * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    `INSERT INTO delivery_grants (token_hash, character_id, scopes, label, created_at, expires_at)
     VALUES (?,?,?,?,?,?)`
  )
    .bind(await hashToken(token), characterId, scopes.join(","), label, now, expiresAt)
    .run();

  // 引換券の平文はこの1回しか出せない。画面側でそう伝えること。
  return { ok: true, token, expiresAt };
}

export async function listGrants(env: { DB: D1Database }, limit = 100): Promise<Grant[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM delivery_grants ORDER BY created_at DESC LIMIT ?`
  )
    .bind(Math.max(1, Math.min(500, limit)))
    .all<{
      token_hash: string;
      character_id: string;
      scopes: string;
      label: string | null;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
      used_count: number;
      last_used_at: number | null;
    }>();

  return (result.results ?? []).map((r) => ({
    tokenHash: r.token_hash,
    characterId: r.character_id,
    scopes: r.scopes.split(",").filter((s): s is DeliveryScope => DELIVERY_SCOPES.includes(s as DeliveryScope)),
    label: r.label,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    usedCount: r.used_count,
    lastUsedAt: r.last_used_at,
  }));
}

export async function revokeGrant(env: { DB: D1Database }, tokenHash: unknown): Promise<{ ok: boolean }> {
  if (typeof tokenHash !== "string" || !tokenHash) return { ok: false };
  await env.DB.prepare("UPDATE delivery_grants SET revoked_at = ? WHERE token_hash = ?")
    .bind(Date.now(), tokenHash)
    .run();
  return { ok: true };
}

/**
 * 引換券を検証する。
 * 使われた回数を数えるのは、納品したのに一度も使われていない先を見つけるため
 * （たいてい先方が繋ぎ方で詰まっている）。
 */
export async function verifyGrant(
  env: { DB: D1Database },
  token: unknown,
  scope: DeliveryScope
): Promise<{ ok: true; characterId: string } | { ok: false; status: number; error: string }> {
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, status: 401, error: "引換券が必要です" };
  }
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare("SELECT * FROM delivery_grants WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ character_id: string; scopes: string; expires_at: number; revoked_at: number | null }>();

  if (!row) return { ok: false, status: 401, error: "この引換券は使えません" };
  if (row.revoked_at) return { ok: false, status: 403, error: "この引換券は失効しています" };
  if (row.expires_at < Date.now()) return { ok: false, status: 403, error: "この引換券は期限切れです" };
  if (!row.scopes.split(",").includes(scope)) {
    return { ok: false, status: 403, error: "この引換券では取り出せない内容です" };
  }

  await env.DB.prepare(
    "UPDATE delivery_grants SET used_count = used_count + 1, last_used_at = ? WHERE token_hash = ?"
  )
    .bind(Date.now(), tokenHash)
    .run();

  return { ok: true, characterId: row.character_id };
}

// ---- 実際に渡すもの ----

/**
 * 人格カードを、引換券の持ち主（買い手）向けに取り出す。
 *
 * 持ち主トークンでの取り出し（/api/persona/card）と経路を分けているのは、
 * 買い手に渡すものと本人に返すものを、同じ関数から出さないため。
 * 同じにすると、片方だけ範囲を変えたときに事故る。
 */
async function loadCard(env: DeliveryEnv, characterId: string): Promise<PersonaCard | null> {
  // 買い手向けの写しは、本人向けの buildCard とは別の入口（buildBuyerCard）で作る。
  // 以前は持ち主トークンを代行して buildCard を呼んでおり、会話の抜粋・記憶・覚え書きまで渡っていた。
  // 持ち主が「法人への個別提供」を切っていれば、ここで null になる（＝取り出せない）。
  const result = await env.CHARACTER.getByName(characterId).buildBuyerCard();
  return result.ok ? result.card : null;
}

export interface DeliveryPayload {
  contentType: string;
  filename: string;
  body: string;
}

export async function buildDelivery(
  env: DeliveryEnv,
  characterId: string,
  scope: DeliveryScope,
  format: string
): Promise<DeliveryPayload | null> {
  const card = await loadCard(env, characterId);
  if (!card) return null;

  const safeName = (card.identity.name || "persona").replace(/[^\w.\-ぁ-んァ-ヶー一-龠]/g, "_");

  if (scope === "behavior") {
    const compact = toCompact(card);
    const audit = auditCompact(compact, card);
    // 検査に落ちたものは渡さない。ここを警告で済ませると、いつか会話の断片が機器へ焼かれる。
    if (!audit.ok) return null;
    return {
      contentType: "application/json; charset=utf-8",
      filename: `${safeName}_persona.min.json`,
      body: JSON.stringify(compact),
    };
  }

  if (scope === "bundle") {
    // zipを作るには外部ライブラリが要る。納品は「1つのファイルで渡せること」が大事なので、
    // 中身をまとめた1つのJSONにしている（受け取り側は jq か数行のスクリプトで展開できる）。
    const compact = toCompact(card);
    const audit = auditCompact(compact, card);
    return {
      contentType: "application/json; charset=utf-8",
      filename: `${safeName}_bundle.json`,
      body: JSON.stringify(
        {
          format: "waketama.delivery-bundle",
          formatVersion: "1.0",
          generatedAt: Date.now(),
          files: {
            "persona_card.json": card,
            "system_prompt.txt": card.runtime.systemPrompt,
            Modelfile: renderOllamaModelfile(card),
            "persona.min.json": audit.ok ? compact : null,
            "README.md": renderReadme(card),
          },
          note:
            "files の各キーがそのままファイル名です。persona.min.json はLLM不要の機器向け（数値のみ）。" +
            "オフラインでの動かし方は README.md と、わけたまの docs/EDGE_DEVICE_TEST.md を参照してください。",
        },
        null,
        2
      ),
    };
  }

  if (scope === "slm") {
    const base = SLM_BASES.some((b) => b.id === format) ? format : DEFAULT_SLM_BASE;
    const pkg = buildSlmPackage(card, base);
    return {
      contentType: "application/json; charset=utf-8",
      filename: `${safeName}_slm.json`,
      body: JSON.stringify(
        {
          format: "waketama.slm-package",
          formatVersion: "1.0",
          generatedAt: Date.now(),
          stats: pkg.stats,
          files: {
            Modelfile: pkg.modelfile,
            "train.jsonl": pkg.trainJsonl,
            "eval.jsonl": pkg.evalJsonl,
            "README.md": pkg.readme,
          },
          note: "files の各キーがそのままファイル名です。まず Modelfile だけで動かしてみてください。",
        },
        null,
        2
      ),
    };
  }

  if (scope === "decision") {
    return {
      contentType: "application/json; charset=utf-8",
      filename: `${safeName}_decision_profile.json`,
      body: JSON.stringify(buildDecisionProfile(card), null, 2),
    };
  }

  // scope === "card"
  if (format === "prompt") {
    return { contentType: "text/plain; charset=utf-8", filename: `${safeName}_system_prompt.txt`, body: card.runtime.systemPrompt };
  }
  if (format === "modelfile") {
    return { contentType: "text/plain; charset=utf-8", filename: "Modelfile", body: renderOllamaModelfile(card) };
  }
  if (format === "readme") {
    return { contentType: "text/markdown; charset=utf-8", filename: `${safeName}_README.md`, body: renderReadme(card) };
  }
  return {
    contentType: "application/json; charset=utf-8",
    filename: `${safeName}_persona_card.json`,
    body: JSON.stringify(card, null, 2),
  };
}
