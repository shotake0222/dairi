/**
 * 成長段階 — 何回話したら、どこまで育つか。
 *
 * **なぜ作り直したか。**
 * 以前は4段階で、50回話すと最上位の「成熟期」に着いてしまった。
 * 1日に数回話す人なら2週間で上限に達する。そこから先は何回話しても
 * 画面の表示が変わらないので、「育てている」という手応えが消える。
 * このサービスは育てること自体が体験なので、そこが終わってしまうのは致命的。
 *
 * **段階の置き方。**
 * 間隔を等分にせず、後ろへ行くほど広げてある（0 → 5 → 15 → 35 → 70 → 130 → 220 → 360 の8段階）。
 * 最初は数回で段階が上がって手応えが出る。後半は簡単には上がらないが、
 * そのぶん1つ上がったときの意味が大きい。育成ゲームの経験曲線と同じ考え方。
 *
 * **段階に意味を持たせる。**
 * 表示名だけ変えても、ただのラベルになる。段階ごとに
 *   - どれだけ過去を踏まえて話すか（historyTurns / recallTopK）
 *   - どれだけ長く話すか（replyLengthHint / maxTokens）
 *   - 何ができるようになるか（unlocks）
 * を変える。育つほど会話が実際に厚くなるので、数字ではなく体感で分かる。
 */

export interface GrowthStage {
  /** この段階に入る会話回数 */
  from: number;
  name: string;
  /** その段階の一言説明（画面にそのまま出す） */
  summary: string;
  /** その段階で新しくできるようになること。空なら特になし */
  unlocks: string[];
  /** 会話に持ち込む直近のやり取りの数（往復ではなく発言数） */
  historyTurns: number;
  /** 長期記憶から思い出す件数 */
  recallTopK: number;
  replyLengthHint: string;
  maxTokens: number;
}

/**
 * 段階の定義。**この配列が唯一の定義元**で、会話の文脈量もここから決まる。
 * 以前は段階の判定（characterState）と文脈量の判定（modelPolicy）に同じ閾値が
 * 二重に書かれていて、片方だけ直すとズレる状態だった。
 */
export const GROWTH_STAGES: GrowthStage[] = [
  {
    from: 0,
    name: "生まれたて",
    summary: "まだ何者でもない。名前だけを持っている状態です",
    unlocks: [],
    historyTurns: 4,
    recallTopK: 2,
    replyLengthHint: "1〜2文",
    maxTokens: 160,
  },
  {
    from: 5,
    name: "人見知り期",
    summary: "あなたの話し方を、少しずつ真似しはじめます",
    unlocks: ["性格の数値が動きはじめる"],
    historyTurns: 6,
    recallTopK: 3,
    replyLengthHint: "1〜3文",
    maxTokens: 200,
  },
  {
    from: 15,
    name: "よちよち期",
    summary: "前に話したことを覚えて、持ち出せるようになります",
    unlocks: ["覚え書きを書きはじめる", "分身どうしのお散歩に出られる"],
    historyTurns: 8,
    recallTopK: 4,
    replyLengthHint: "1〜3文",
    maxTokens: 240,
  },
  {
    from: 35,
    name: "おしゃべり期",
    summary: "口調が固まってきて、その子らしい返し方になります",
    unlocks: ["口調の個性がはっきりする"],
    historyTurns: 10,
    recallTopK: 5,
    replyLengthHint: "2〜3文",
    maxTokens: 300,
  },
  {
    from: 70,
    name: "なじみ期",
    summary: "こちらの事情を踏まえた返事が増えてきます",
    unlocks: ["人格カードの持ち出しが実用水準に入る"],
    historyTurns: 12,
    recallTopK: 6,
    replyLengthHint: "2〜3文",
    maxTokens: 340,
  },
  {
    from: 130,
    name: "相棒期",
    summary: "聞かなくても、こちらの好みで先に候補を出してきます",
    unlocks: ["マーケットに出せる厚みに届きやすくなる"],
    historyTurns: 14,
    recallTopK: 7,
    replyLengthHint: "2〜4文",
    maxTokens: 380,
  },
  {
    from: 220,
    name: "分身期",
    summary: "留守のあいだの出来事まで、自分の言葉で話します",
    unlocks: ["長い文脈を保ったまま話せる"],
    historyTurns: 16,
    recallTopK: 8,
    replyLengthHint: "2〜4文",
    maxTokens: 420,
  },
  {
    from: 360,
    name: "御霊期",
    summary: "ここから先は、回数ではなく積み重ねで変わっていきます",
    unlocks: ["段階の上限。以降は性格と記憶だけが深まる"],
    historyTurns: 18,
    recallTopK: 9,
    replyLengthHint: "2〜5文",
    maxTokens: 460,
  },
];

export function stageFor(interactionCount: number): GrowthStage {
  let current = GROWTH_STAGES[0];
  for (const stage of GROWTH_STAGES) {
    if (interactionCount >= stage.from) current = stage;
    else break;
  }
  return current;
}

export function stageName(interactionCount: number): string {
  return stageFor(interactionCount).name;
}

export interface GrowthProgress {
  stage: string;
  summary: string;
  unlocks: string[];
  index: number;
  total: number;
  /** 次の段階の名前。最終段階なら null */
  nextStage: string | null;
  /** 次の段階まであと何回か。最終段階なら null */
  toNext: number | null;
  /** いまの段階の中での進み具合（0〜100）。最終段階は常に100 */
  percent: number;
}

/**
 * 画面に出すための進み具合。
 *
 * 「次まであと何回」を出すのが肝。段階名だけだと、次に何かが起きるのか、
 * もう打ち止めなのかが分からず、育てる手が止まる。
 */
export function growthProgress(interactionCount: number): GrowthProgress {
  const index = GROWTH_STAGES.findIndex((s) => s === stageFor(interactionCount));
  const stage = GROWTH_STAGES[index];
  const next = GROWTH_STAGES[index + 1] ?? null;

  const percent = next
    ? Math.min(100, Math.round(((interactionCount - stage.from) / (next.from - stage.from)) * 100))
    : 100;

  return {
    stage: stage.name,
    summary: stage.summary,
    unlocks: stage.unlocks,
    index,
    total: GROWTH_STAGES.length,
    nextStage: next?.name ?? null,
    toNext: next ? Math.max(0, next.from - interactionCount) : null,
    percent,
  };
}

/**
 * 古い段階名を、新しい段階名へ読み替える。
 *
 * 既存の分身は "成熟期" のような古い名前を保存したまま動いている。
 * 名前だけ差し替えると、同じ会話回数なのに昨日と違う段階名が出ることになるが、
 * **会話回数から引き直せば必ず正しい段階になる**ので、保存値は信用せず毎回計算する。
 * この関数は、保存済みの文字列を表示する必要がある場所（人格パッケージの取り込みなど）のためにある。
 */
export function normalizeStageName(saved: string | undefined, interactionCount: number): string {
  const known = GROWTH_STAGES.some((s) => s.name === saved);
  return known && saved ? saved : stageName(interactionCount);
}
