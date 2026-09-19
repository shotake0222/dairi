/**
 * 「自分専用の小さなモデル（SLM）を、喋って作る」の中身。
 *
 * ── 用語について、先に整理しておく ──────────────────────────────
 *
 * **SML ではなく SLM が正しい。**
 * Small Language Model の略。SML は Standard ML（関数型プログラミング言語）の
 * 略称として広く通っているので、そのまま出すと別物にぶつかる。訴求では SLM を使う。
 *
 * **Jev は実在する、他社の製品名。**
 * TypeSafe AI が2026年9月に発表した「判断特化モデル」で、
 *   - **文章を生成しない。** Choice / Score / Noul の3種類の問いに、確率つきの値だけを返す
 *   - 重みも学習方法も非公開。APIのみで、ファインチューンの口は公開されていない
 * したがって「自分専用のJevを作れる」とは**言えない**。作れないし、他社製品名を
 * 自社の生成物のように名乗ることになる。しかも Jev は喋らないので、
 * 「喋って作る」というこのサービスの体験とも噛み合わない。
 *
 * **では何ができるのか。** ここが本題で、実は相性がいい。
 * わけたまが会話から取り出しているもの（性格6軸・価値観・方針コード）は、
 * そのまま「**この状況で、この人はどちらを選ぶか**」という判断の癖になっている。
 * Jev のような判断特化モデルが欲しがるのは、まさにその形の入力。
 * だから立ち位置は「Jevを作る」ではなく「**あなたの判断の癖を、判断特化AIに
 * 渡せる形で書き出す**」。これなら嘘が無く、実際に動く。
 *
 * この2つを、別々の納品物として出す:
 *   slm      … 小さなモデルで「その人らしく喋る」ための一式（Modelfile + 学習データ + 手順）
 *   decision … 判断特化モデルへ渡す判断プロファイル（Choice / Score / Noul）
 */

import type { PersonaCard } from "./persona/personaCard";
import { renderOllamaModelfile } from "./persona/personaCard";

/**
 * 自分専用SLMの土台にする候補。
 * 「喋って作る」ので、日本語がある程度通って、手元で回せる大きさのものに絞る。
 */
export const SLM_BASES = [
  { id: "qwen2.5:0.5b-instruct", name: "Qwen2.5 0.5B", ram: "1GB", runsOn: "Raspberry Pi 4 / スマホ" },
  { id: "qwen2.5:1.5b-instruct", name: "Qwen2.5 1.5B", ram: "2GB", runsOn: "Raspberry Pi 5 / ノートPC" },
  { id: "qwen2.5:3b-instruct", name: "Qwen2.5 3B", ram: "4GB", runsOn: "Raspberry Pi 5(8GB) / ノートPC" },
  { id: "llama3.1:8b-instruct", name: "Llama 3.1 8B", ram: "8GB", runsOn: "そこそこのPC" },
] as const;

export const DEFAULT_SLM_BASE = "qwen2.5:1.5b-instruct";

/** 学習データの最小件数。これを割ると、載せても口調が移らない。 */
export const MIN_TRAIN_PAIRS = 12;

export interface SlmPackage {
  /** そのまま ollama create に渡せる */
  modelfile: string;
  /** LoRA用の学習データ（1行1件のJSONL） */
  trainJsonl: string;
  /** 学習に使わずに取っておく検証用 */
  evalJsonl: string;
  readme: string;
  stats: { trainPairs: number; evalPairs: number; enough: boolean; base: string };
}

/**
 * 会話から学習データを作る。
 *
 * 大事なのは**口調が移ること**で、知識ではない。
 * だから system には人格カードのプロンプトをそのまま置き、
 * user/assistant には実際のやり取りをそのまま入れる。
 * 言い換えたり整えたりすると、移したい癖のほうが消える。
 */
function buildPairs(card: PersonaCard): Array<{ user: string; assistant: string }> {
  const pairs = card.examples.map((e) => ({ user: e.user, assistant: e.assistant }));
  // 短すぎる相づちだけの往復は、学習データとしては害のほうが大きい
  return pairs.filter((p) => p.user.trim().length >= 2 && p.assistant.trim().length >= 4);
}

function toJsonl(
  pairs: Array<{ user: string; assistant: string }>,
  systemPrompt: string
): string {
  return pairs
    .map((p) =>
      JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: p.user },
          { role: "assistant", content: p.assistant },
        ],
      })
    )
    .join("\n");
}

export function buildSlmPackage(card: PersonaCard, base = DEFAULT_SLM_BASE): SlmPackage {
  const pairs = buildPairs(card);
  // 2割を検証に回す。全部学習に使うと、覚えたのか真似できるのかが分からなくなる
  const evalCount = Math.min(4, Math.floor(pairs.length * 0.2));
  const evalPairs = pairs.slice(0, evalCount);
  const trainPairs = pairs.slice(evalCount);
  const prompt = card.runtime.systemPrompt;

  const readme = [
    `# ${card.identity.name} — 自分専用のSLM`,
    "",
    "わけたまで育った人格を、手元の小さなモデルに載せるための一式です。",
    "**クラウドに繋がなくても、この子として喋ります。**",
    "",
    "## 入っているもの",
    "",
    "| ファイル | 中身 |",
    "| --- | --- |",
    "| `Modelfile` | 土台のモデル＋人格。これだけで動きます |",
    "| `train.jsonl` | 口調をさらに寄せたいとき用の学習データ |",
    "| `eval.jsonl` | 学習に使っていない確認用 |",
    "",
    "## 1. まず、学習なしで動かす",
    "",
    "**多くの場合これで足ります。** Modelfile には人格・価値観・覚え書き・応答例が入っています。",
    "",
    "```bash",
    `ollama pull ${base}`,
    "ollama create mypersona -f Modelfile",
    "ollama run mypersona",
    "```",
    "",
    "## 2. それでも口調が硬いとき（LoRA）",
    "",
    `学習データは **${trainPairs.length}件**です。` +
      (trainPairs.length >= MIN_TRAIN_PAIRS
        ? "学習に回すには十分あります。"
        : `**${MIN_TRAIN_PAIRS}件を下回っています。** この量で学習すると、口調が移るより先に過学習します。もう少し会話を重ねてから書き出し直してください。`),
    "",
    "```bash",
    "pip install unsloth",
    "python -m unsloth.cli train \\",
    `  --model ${base.split(":")[0]} \\`,
    "  --dataset train.jsonl \\",
    "  --lora-r 16 --epochs 3 --max-seq-length 2048 \\",
    "  --output ./mypersona-lora",
    "```",
    "",
    "## 3. 移ったかどうかの確かめ方",
    "",
    "`eval.jsonl` の user 側だけを入力して、assistant 側と**言い回しが似ているか**を見ます。",
    "内容が合っているかではありません。**移したいのは口調と判断の癖**です。",
    "",
    "数字で見たいときは、わけたま側の検査（`npm run persona:check`）を",
    "`PERSONA_LLM_URL` で手元のOllamaに向けると、到達率・弁別性が出ます。",
    "",
    "## 含まれていないもの",
    "",
    "- 会話の全文ログ",
    "- 持ち主の連絡先",
    "- 年収などの機微な属性",
    "",
    "## 注意",
    "",
    "小さいモデルほど、長いプロンプトで崩れます。0.5Bで不安定なら、",
    "Modelfile の SYSTEM を削るより先に、1.5B以上へ上げてください。",
    "",
  ].join("\n");

  return {
    modelfile: renderOllamaModelfile(card, base),
    trainJsonl: toJsonl(trainPairs, prompt),
    evalJsonl: toJsonl(evalPairs, prompt),
    readme,
    stats: {
      trainPairs: trainPairs.length,
      evalPairs: evalPairs.length,
      enough: trainPairs.length >= MIN_TRAIN_PAIRS,
      base,
    },
  };
}

// ---- 判断プロファイル（判断特化モデルへ渡す形）----

/**
 * Jev のような「文章を書かない判断特化モデル」へ渡すための形。
 *
 * 向こうが受け取るのは3種類の問いだけ:
 *   choice … 選択肢から1つ（最大255）
 *   score  … 2〜10段階の点
 *   noul   … はい/いいえ の確率
 *
 * こちらが渡せるのは「**この人ならどう答えるか**」の既定値。
 * 判断特化モデルは速くて安いが、**誰の判断なのかは持っていない**。
 * そこを埋めるのが、わけたまの人格データの役どころ。
 */
export interface DecisionQuestion {
  id: string;
  type: "choice" | "score" | "noul";
  /** 判断特化モデルへそのまま渡す問い */
  question: string;
  options?: string[];
  /** 0〜10 のときの上限 */
  scale?: number;
  /** この人の既定の答え。choice は options の index、score は値、noul は 0〜1 */
  prior: number;
  /** なぜその既定値になるのか（人が読む用。モデルには渡さなくてよい） */
  because: string;
}

export interface DecisionProfile {
  format: "waketama.decision-profile";
  formatVersion: "1.0";
  generatedAt: number;
  persona: { name: string; interactionCount: number };
  /**
   * 既定値の確からしさ（0〜100）。会話が浅いほど低い。
   * **ここを見ずに prior を信じないこと。** 会話5回の分身の「判断の癖」は、ほぼ初期値。
   */
  confidence: number;
  questions: DecisionQuestion[];
  note: string;
}

/** 性格・価値観から、判断の既定値を引く。0〜100 を 0〜1 に落とす。 */
const p01 = (v: number) => Math.round(Math.max(0, Math.min(100, v)) / 100 * 100) / 100;

export function buildDecisionProfile(card: PersonaCard): DecisionProfile {
  const values = card.owner?.values ?? {};
  const t = card.personality;
  const codes = new Set((card.runtime.avatar.policy ?? []).map((p) => p.code));
  const v = (axis: string, fallback = 50) => (typeof values[axis] === "number" ? values[axis] : fallback);

  const questions: DecisionQuestion[] = [
    {
      id: "novel_or_familiar",
      type: "choice",
      question: "はじめての選択肢と、いつもの選択肢。この人はどちらを選ぶか",
      options: ["はじめての方", "いつもの方"],
      prior: codes.has("prefer_novel_options") ? 0 : 1,
      because: `刺激 ${v("stimulation")} / 好奇心 ${t.curiosity}`,
    },
    {
      id: "confirm_before_change",
      type: "noul",
      question: "予定が変わるとき、この人は動く前に確認を取るか",
      prior: p01((v("security") + t.caution) / 2),
      because: `安定 ${v("security")} / 慎重さ ${t.caution}`,
    },
    {
      id: "decide_for_me",
      type: "choice",
      question: "迷っている相手に、この人は選択肢を並べるか、1つに絞って勧めるか",
      options: ["選択肢を並べる", "1つに絞って勧める"],
      prior: codes.has("give_one_clear_suggestion") ? 1 : 0,
      because: `自律 ${v("selfDirection")}`,
    },
    {
      id: "initiative",
      type: "noul",
      question: "会話が止まったとき、この人は自分から次を切り出すか",
      prior: p01((v("power") + (100 - t.caution) + t.cheerfulness) / 3),
      because: `主導 ${v("power")} / 慎重さ ${t.caution} / 陽気さ ${t.cheerfulness}`,
    },
    {
      id: "notice_others",
      type: "noul",
      question: "用件より先に、相手の様子の変化へ触れるか",
      prior: p01((v("benevolence") + t.warmth) / 2),
      because: `他者配慮 ${v("benevolence")} / 温かさ ${t.warmth}`,
    },
    {
      id: "risk_tolerance",
      type: "score",
      question: "この人が受け入れられるリスクの大きさ（1=避ける 〜 5=踏み込む）",
      scale: 5,
      prior: Math.max(1, Math.min(5, Math.round(((v("stimulation") + (100 - v("security"))) / 2) / 20))),
      because: `刺激 ${v("stimulation")} / 安定 ${v("security")}`,
    },
    {
      id: "formality",
      type: "score",
      question: "この人が心地よい距離感（1=くだけた 〜 5=きちんと）",
      scale: 5,
      prior: Math.max(1, Math.min(5, Math.round((v("tradition") + t.caution) / 2 / 20))),
      because: `伝統 ${v("tradition")} / 慎重さ ${t.caution}`,
    },
    {
      id: "lighten_mood",
      type: "noul",
      question: "重い話が続いたとき、この人は話を軽い方へ寄せるか",
      prior: p01((v("hedonism") + t.humor) / 2),
      because: `楽しさ ${v("hedonism")} / ユーモア ${t.humor}`,
    },
  ];

  // 会話が浅いうちは、性格も価値観もほぼ初期値のまま。そこを隠さない。
  const n = card.identity.interactionCount;
  const declared = Object.keys(card.owner?.declaredValues ?? {}).length;
  const confidence = Math.min(100, Math.round(Math.min(70, n / 2) + declared * 4));

  return {
    format: "waketama.decision-profile",
    formatVersion: "1.0",
    generatedAt: Date.now(),
    persona: { name: card.identity.name, interactionCount: n },
    confidence,
    questions,
    note:
      "判断特化モデル（TypeSafe AI の Jev など、文章を生成せず Choice / Score / Noul だけを返す種類）へ、" +
      "『誰の判断か』を与えるためのプロファイルです。prior はこの人の既定の答えで、" +
      "実際の判断はモデル側が状況と突き合わせて出します。confidence が低いうちは prior を弱い事前分布として扱ってください。" +
      "会話の全文・持ち主の連絡先・機微な属性は含まれません。",
  };
}
