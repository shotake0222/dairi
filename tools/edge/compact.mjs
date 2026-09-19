/**
 * 人格カード → 機器に焼ける「振る舞いだけ」の最小形。
 *
 * **なぜ必要か。**
 * 人格カード（/api/character/card）は、会話の抜粋・覚え書き・属性まで含む数十KBのJSONで、
 * LLMに読ませる前提で作ってある。ESP32やRaspberry Pi Picoにはそもそも載らないし、
 * 載ったとしても、そこには**その人の生活が書いてある**。
 * 部屋に置く機器や、人に配るデバイスへ、会話の中身を焼き込むべきではない。
 *
 * そこでこの形に落とす:
 *   - 数値と識別子だけ。**日本語の文章も、会話も、属性も入らない**（名前だけは呼びかけのため残す）
 *   - 数百バイト。ArduinoJson でも ujson でも素直に読める
 *   - キーは1文字。マイコンでは1バイトが効く
 *
 * この形で動くということは、「人格データが言葉を介さずに身体を動かせる」ということで、
 * それがフィジカルAI／メタバースへ持ち出せるという主張の実体になる。
 */

/** 性格6軸の並び。ここの順番は機器側の実装と揃えること（変えるとv を上げる）。 */
export const TRAIT_ORDER = ["warmth", "curiosity", "cheerfulness", "caution", "independence", "humor"];

export const COMPACT_VERSION = 1;

const int = (v) => Math.round(Number(v) || 0);
const f2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * 人格カードから、機器用の最小形を作る。
 *
 * @param {object} card /api/character/card?format=json で得たもの
 * @param {{ maxPolicies?: number }} [options]
 */
export function toCompact(card, options = {}) {
  const maxPolicies = options.maxPolicies ?? 6;
  const avatar = card?.runtime?.avatar;
  if (!avatar) throw new Error("runtime.avatar がありません（古い形式の人格カードです）");

  const m = avatar.motion;
  const p = avatar.proxemics;
  const e = avatar.expression;

  return {
    v: COMPACT_VERSION,
    // 機器のログで人格を見分けるためだけの短いID。元のIDは載せない（突き合わせに使えてしまう）
    id: String(card.identity?.id ?? "").slice(0, 8),
    n: String(card.identity?.name ?? "").slice(0, 16),
    // energy, gestureRate, idleVariance, responseDelayMs, gazeHoldMs, postureOpenness
    m: [int(m.energy), int(m.gestureRate), int(m.idleVariance), int(m.responseDelayMs), int(m.gazeHoldMs), int(m.postureOpenness)],
    // comfortableDistanceM, approachSpeedMps
    p: [f2(p.comfortableDistanceM), f2(p.approachSpeedMps)],
    // baselineSmile, blinkRatePerMin
    e: [int(e.baselineSmile), int(e.blinkRatePerMin)],
    t: TRAIT_ORDER.map((k) => int(card.personality?.[k] ?? 50)),
    // 振る舞いの方針は、機械が分岐できる識別子だけ。日本語の説明（behavior）は載せない
    c: (avatar.policy ?? []).slice(0, maxPolicies).map((x) => String(x.code)),
  };
}

/**
 * 機器へ渡す実体（1行のJSON文字列）。
 * 改行やインデントを入れないのは、シリアル越しに1行で送れるようにするため。
 */
export function toCompactJson(card, options) {
  return JSON.stringify(toCompact(card, options));
}

/**
 * 焼き込む前の確認用。
 * **会話・覚え書き・属性が1文字も混ざっていないこと**を機械的に確かめる。
 * ここを人の目視に任せると、いつか事故る。
 */
export function auditCompact(compact, card) {
  const json = JSON.stringify(compact);
  const leaks = [];

  const secrets = [
    ...(card.notes ?? []),
    ...(card.memories ?? []).map((x) => x.text),
    ...(card.examples ?? []).flatMap((x) => [x.user, x.assistant]),
    ...Object.values(card.owner?.attributes ?? {}).map((x) => String(x)),
    card.runtime?.systemPrompt ?? "",
  ];

  for (const secret of secrets) {
    const s = String(secret || "").trim();
    // 短すぎる断片は偶然一致するので見ない（「はい」等）
    if (s.length < 6) continue;
    if (json.includes(s)) leaks.push(s.slice(0, 40));
  }

  return { ok: leaks.length === 0, bytes: new TextEncoder().encode(json).length, leaks };
}
