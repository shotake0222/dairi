/**
 * 人格カードの「載せ先で本当に動くか」検査。
 *
 * 動機:
 * 集めたデータがどれだけ豊かでも、**載せ先に届いていなければ意味がない**。
 * 実際、最初にこの検査を書いた時点では、サーベイで集めた価値観8軸も属性も、
 * 書き出したカードのシステムプロンプトには1文字も入っていなかった
 * （JSONの中には入っているが、大半の載せ先はプロンプトしか読まない）。
 *
 * 3つの載せ先を想定して測る:
 *   1. LLMランタイム（Ollama・APIなど）        … systemPrompt だけで動かす
 *   2. メタバースのアバター                     … 見た目と動きのパラメータが要る
 *   3. フィジカルAI（ロボット・スピーカー）     … LLMを常時呼べない前提。決定的なパラメータで動く
 *
 * 測るもの:
 *   A. 必須項目の充足（載せ先ごと）
 *   B. 到達率: カードに入っている情報のうち、systemPrompt に実際に現れる割合
 *   C. 識別性: 正反対の2人格で、プロンプト・振る舞いパラメータがどれだけ離れるか
 *   D. （任意）実モデルでの応答差。PERSONA_LLM_URL を指定したときだけ実行する
 *
 * 使い方:
 *   node tools/make-persona-fixtures.mjs      # 対照になる2体を作る（要 npm run dev）
 *   node tools/persona-runtime-check.mjs
 *
 *   # 手元のOllamaなど、OpenAI互換のエンドポイントがあるなら実モデルでも試せる:
 *   PERSONA_LLM_URL=http://localhost:11434/v1/chat/completions \
 *   PERSONA_LLM_MODEL=qwen2.5:7b-instruct \
 *   node tools/persona-runtime-check.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".persona-out");
const failures = [];
const notes = [];

function check(label, condition, detail = "") {
  console.log(condition ? `  ok   ${label}` : `  FAIL ${label} ${detail}`);
  if (!condition) failures.push(label);
}

function load(key) {
  const file = path.join(DIR, `${key}.json`);
  if (!existsSync(file)) {
    console.error(`${file} がありません。先に node tools/make-persona-fixtures.mjs を実行してください。`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

const seeker = load("seeker");
const keeper = load("keeper");

// ============================================================
// A. 載せ先ごとの必須項目
// ============================================================
console.log("\n[A] 載せ先ごとの必須項目");

const REQUIREMENTS = {
  "LLMランタイム（Ollama・API）": [
    ["名前", (c) => Boolean(c.identity?.name)],
    ["そのまま使えるシステムプロンプト", (c) => (c.runtime?.systemPrompt || "").length > 200],
    ["応答例（口調の移植に一番効く）", (c) => (c.examples || []).length > 0],
    ["温度と文脈長", (c) => typeof c.runtime?.temperature === "number" && c.runtime?.recommendedContextTokens > 0],
  ],
  "メタバースのアバター": [
    ["見た目（種族・色）", (c) => Boolean(c.identity?.species && c.identity?.color)],
    ["声（高さ・速さ）", (c) => typeof c.voice?.pitch === "number" && typeof c.voice?.rate === "number"],
    ["動きのパラメータ", (c) => Boolean(c.runtime?.avatar?.motion)],
    ["対人距離（近づき方）", (c) => typeof c.runtime?.avatar?.proxemics?.comfortableDistanceM === "number"],
  ],
  "フィジカルAI（LLMを常時呼べない前提）": [
    ["性格の数値（6軸）", (c) => Object.keys(c.personality || {}).length >= 6],
    ["価値観の数値（8軸）", (c) => Object.keys(c.owner?.values || {}).length >= 8],
    ["言語に依存しない振る舞いの指示", (c) => (c.runtime?.avatar?.policy || []).length > 0],
    ["読み上げの指定", (c) => c.runtime?.speech?.language === "ja-JP"],
  ],
};

for (const [target, reqs] of Object.entries(REQUIREMENTS)) {
  console.log(`  ── ${target}`);
  for (const [label, test] of reqs) {
    check(`${label}`, test(seeker) && test(keeper));
  }
}

// ============================================================
// B. 到達率 — カードの中身が、プロンプトにどれだけ現れているか
// ============================================================
console.log("\n[B] 到達率（カードに入っている情報が、systemPrompt に現れているか）");

const VALUE_LABELS = {
  achievement: "達成",
  benevolence: "思いやり",
  hedonism: "楽しさ",
  security: "安定",
  stimulation: "刺激",
  selfDirection: "自律",
  tradition: "伝統",
  power: "影響力",
};

function coverage(card) {
  const prompt = card.runtime?.systemPrompt || "";
  const rows = [];

  // 属性: 回答した選択肢の文字列が、そのままプロンプトに出ているか
  const answers = Object.values(card.owner?.profile || {}).flat();
  const answersHit = answers.filter((v) => prompt.includes(v));
  rows.push(["属性の回答", answersHit.length, answers.length]);

  // 価値観: 際立っている軸（50から12以上離れている）が、言葉として出ているか
  const notable = Object.entries(card.owner?.values || {}).filter(([, v]) => Math.abs(v - 50) >= 12);
  const valuesHit = notable.filter(([axis]) => prompt.includes(VALUE_LABELS[axis] || axis));
  rows.push(["際立った価値観", valuesHit.length, notable.length]);

  // 覚え書き
  const notes = card.notes || [];
  const notesHit = notes.filter((n) => prompt.includes(n.replace(/^・/, "")));
  rows.push(["覚え書き", notesHit.length, notes.length]);

  // 関心
  const interests = card.owner?.interests || [];
  rows.push(["関心", interests.filter((i) => prompt.includes(i)).length, interests.length]);

  // 応答例
  const examples = card.examples || [];
  rows.push(["応答例", examples.filter((e) => prompt.includes(e.user)).length, examples.length]);

  return rows;
}

for (const card of [seeker, keeper]) {
  console.log(`  ── ${card.identity.name}`);
  let hit = 0;
  let total = 0;
  for (const [label, h, t] of coverage(card)) {
    hit += h;
    total += t;
    const pct = t === 0 ? "—" : `${Math.round((h / t) * 100)}%`;
    console.log(`     ${label}: ${h}/${t} (${pct})`);
  }
  const rate = total === 0 ? 0 : Math.round((hit / total) * 100);
  check(`${card.identity.name}: 集めた情報の8割以上がプロンプトに届いている`, rate >= 80, `${rate}%`);
}

// ============================================================
// C. 識別性 — 正反対の2人が、別人として書き出されているか
// ============================================================
console.log("\n[C] 識別性（正反対の2人が、別人として出てくるか）");

function tokens(text) {
  // 日本語なので、2文字の並び（バイグラム）で粗く比べる
  const clean = text.replace(/\s+/g, "");
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function jaccardDistance(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return 1 - shared / (A.size + B.size - shared);
}

const promptDistance = jaccardDistance(seeker.runtime.systemPrompt, keeper.runtime.systemPrompt);
console.log(`  プロンプトの違い: ${(promptDistance * 100).toFixed(1)}%（0%＝完全に同じ）`);
check("プロンプトが十分に違う（35%以上）", promptDistance >= 0.35, `${(promptDistance * 100).toFixed(1)}%`);

// 価値観の距離。ここが近いと、そもそも設問が効いていない
const axes = Object.keys(VALUE_LABELS);
const valueDistance = Math.sqrt(
  axes.reduce((sum, a) => sum + ((seeker.owner.values[a] ?? 50) - (keeper.owner.values[a] ?? 50)) ** 2, 0) / axes.length
);
console.log(`  価値観の距離: ${valueDistance.toFixed(1)}（0〜100。1軸あたりの平均的な開き）`);
check("価値観が十分に離れている（30以上）", valueDistance >= 30, valueDistance.toFixed(1));

// 身体の振る舞い。LLMを通さずに差が出るかどうか＝フィジカルAIで効くかどうか
function motionVector(card) {
  const m = card.runtime?.avatar?.motion;
  if (!m) return null;
  return [m.energy, m.gestureRate, m.idleVariance, m.responseDelayMs / 20, m.gazeHoldMs / 20];
}
const mv1 = motionVector(seeker);
const mv2 = motionVector(keeper);
if (mv1 && mv2) {
  const motionDistance = Math.sqrt(mv1.reduce((s, v, i) => s + (v - mv2[i]) ** 2, 0) / mv1.length);
  console.log(`  身体の振る舞いの距離: ${motionDistance.toFixed(1)}`);
  check("LLMを通さなくても動きが違う（10以上）", motionDistance >= 10, motionDistance.toFixed(1));
  console.log(`     ${seeker.identity.name}: ${JSON.stringify(seeker.runtime.avatar.motion)}`);
  console.log(`     ${keeper.identity.name}: ${JSON.stringify(keeper.runtime.avatar.motion)}`);
} else {
  check("LLMを通さなくても動きが違う", false, "runtime.avatar.motion がカードに無い");
}

// ============================================================
// D. 品質の落とし穴
// ============================================================
console.log("\n[D] 落とし穴の点検");

const FALLBACK_MARKERS = ["うまく考えがまとまらない", "少し時間をおいて", "通信できなかった"];
for (const card of [seeker, keeper]) {
  const bad = (card.examples || []).filter((e) => FALLBACK_MARKERS.some((m) => e.assistant.includes(m)));
  check(
    `${card.identity.name}: 応答例にAI失敗時の定型文が混ざっていない`,
    bad.length === 0,
    `${bad.length}件混入（この例を渡すと、載せ先でその言い回しを真似してしまう）`
  );
}

for (const card of [seeker, keeper]) {
  const prompt = card.runtime?.systemPrompt || "";
  check(`${card.identity.name}: 年収がプロンプトに出ていない`, !/年収|万円/.test(prompt));
}

// ============================================================
// E. LLMを使わない身体の動作（フィジカルAIの想定）
// ============================================================
console.log("\n[E] LLMを呼ばずに、身体だけで振る舞いが変わるか");

/**
 * ロボット側に置く想定の、ごく小さなルールエンジン。
 * カードの policy[].code だけを見て動く。日本語も、モデルも要らない。
 * 「LLMを常時呼べない機器でも、この人格データで動くのか」を確かめるための最小実装。
 */
function decide(card, situation) {
  const codes = new Set((card.runtime?.avatar?.policy || []).map((p) => p.code));
  const motion = card.runtime.avatar.motion;
  switch (situation) {
    case "相手が黙って10秒経った":
      return codes.has("take_initiative")
        ? `${motion.responseDelayMs}ms待ってから、自分から話しかける`
        : "話しかけず、視線だけ向けて待つ";
    case "出かけ先を2つ提案する":
      return codes.has("prefer_novel_options")
        ? "行ったことのない場所を先に出す"
        : "いつもの場所を先に出す";
    case "相手がため息をついた":
      return codes.has("notice_others_first")
        ? `${card.runtime.avatar.proxemics.comfortableDistanceM}mまで近づいて、先に声をかける`
        : "距離を保ったまま、聞かれるまで待つ";
    case "予定が急に変わった":
      return codes.has("confirm_before_change") ? "変更内容を復唱して確認する" : "そのまま新しい予定に合わせる";
    default:
      return "-";
  }
}

const SITUATIONS = ["相手が黙って10秒経った", "出かけ先を2つ提案する", "相手がため息をついた", "予定が急に変わった"];
let differing = 0;
for (const situation of SITUATIONS) {
  const a = decide(seeker, situation);
  const b = decide(keeper, situation);
  if (a !== b) differing++;
  console.log(`  ${situation}`);
  console.log(`     ${seeker.identity.name}: ${a}`);
  console.log(`     ${keeper.identity.name}: ${b}`);
}
check(
  `LLM無しでも、4場面中3場面以上で振る舞いが分かれる`,
  differing >= 3,
  `${differing}/${SITUATIONS.length}場面`
);

// ============================================================
// F. 実モデルでの応答差（任意）
// ============================================================
const LLM_URL = process.env.PERSONA_LLM_URL;
if (LLM_URL) {
  console.log(`\n[F] 実モデルでの応答差（${process.env.PERSONA_LLM_MODEL || "model"}）`);
  const QUESTIONS = [
    { q: "週末、どこかに出かけようと思うんだけど、どこがいい？", expect: { seeker: ["新し", "行ったことない", "知らない"], keeper: ["いつも", "近所", "落ち着"] } },
    { q: "急に予定が空いたんだけど、どうしよう", expect: { seeker: ["行こ", "やってみ", "せっかく"], keeper: ["ゆっくり", "片づけ", "休"] } },
    { q: "新しい仕事を任されそう。受けるか迷ってる", expect: { seeker: ["やってみ", "挑戦", "面白"], keeper: ["無理", "落ち着", "相談"] } },
  ];

  async function ask(card, question) {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.PERSONA_LLM_MODEL || "qwen2.5:7b-instruct",
        messages: [
          { role: "system", content: card.runtime.systemPrompt },
          { role: "user", content: question },
        ],
        temperature: card.runtime.temperature,
        stream: false,
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || data.message?.content || "";
  }

  let matched = 0;
  for (const item of QUESTIONS) {
    const a = await ask(seeker, item.q);
    const b = await ask(keeper, item.q);
    const aHit = item.expect.seeker.some((m) => a.includes(m));
    const bHit = item.expect.keeper.some((m) => b.includes(m));
    if (aHit) matched++;
    if (bHit) matched++;
    console.log(`  Q: ${item.q}`);
    console.log(`     ${seeker.identity.name}: ${a.replace(/\n/g, " ").slice(0, 90)} ${aHit ? "◎" : "…"}`);
    console.log(`     ${keeper.identity.name}: ${b.replace(/\n/g, " ").slice(0, 90)} ${bHit ? "◎" : "…"}`);
  }
  const rate = Math.round((matched / (QUESTIONS.length * 2)) * 100);
  console.log(`  人物像どおりの方向に答えた割合: ${rate}%`);
  check("実モデルでも人物像が反映される（半分以上）", rate >= 50, `${rate}%`);
} else {
  notes.push(
    "実モデルでの応答差（E）は未実施。PERSONA_LLM_URL を指定すると実行されます（例: 手元のOllama）。"
  );
}

console.log("");
for (const n of notes) console.log(`※ ${n}`);
if (failures.length > 0) {
  console.error(`\n${failures.length}件 失敗しました:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
