import { PersonalityTraits, describePersonality } from "./personality";
import { deriveSpeechStyle } from "./speechStyle";

/**
 * システムプロンプトの組み立て。
 *
 * ここは「会話が賢いかどうか」を最も強く左右する場所なので、方針を書いておく。
 *
 * 1. **直近の会話はプロンプトに文字列で埋め込まない**。
 *    以前は memorySummary（各発言を40文字に切り詰めた要約）をプロンプトに貼り付けていたが、
 *    これだと発言が虫食いになり、モデルは文脈を復元できなかった。
 *    直近のやり取りは messages 配列に user/assistant として正しく積む（呼び出し元の責務）。
 *    ここが今回の品質改善の核心。
 *
 * 2. **プロンプトに載せるのは「長く効く情報」だけ**にする。
 *    ＝性格・口調・覚え書き（相手についての事実）・関連する過去の記憶。
 *
 * 3. **やってはいけないことを具体的に書く**。
 *    「自然に会話してください」のような曖昧な指示は効かない。
 *    実際に起きていた失敗（毎回自己紹介する、相手の言葉をおうむ返しする、
 *    毎回質問で締める）を名指しで禁止する方が、体感の賢さは大きく変わる。
 */

export interface BasePromptParams {
  name: string;
  personality: PersonalityTraits;
  growthStage: string;
  /** 相手について長く覚えておくべき事実（src/ai/reflection.ts が育てる） */
  profileNotes?: string;
  /** 今の話題に関連する過去のやり取り（Vectorizeからの想起） */
  relevantMemories?: string[];
  /** 返答の長さの目安（成長段階に応じて呼び出し元が決める） */
  replyLengthHint?: string;
  /** 旧データ互換: recentTurns を持たない分身のための、切り詰め済みの直近ログ */
  legacySummary?: string;
  /** テスト時に固定するための現在時刻。省略時は now。 */
  now?: Date;
}

/** 日本の生活時間に合わせた「いまの時間帯」。挨拶や話題選びが不自然になるのを防ぐ。 */
export function describeTimeOfDay(now: Date = new Date()): string {
  // Workersのランタイムは常にUTCなので、ここでJSTへ寄せる（利用者が日本を想定しているため）。
  const jstHour = (now.getUTCHours() + 9) % 24;
  if (jstHour < 5) return "深夜";
  if (jstHour < 10) return "朝";
  if (jstHour < 12) return "午前";
  if (jstHour < 15) return "昼過ぎ";
  if (jstHour < 18) return "夕方";
  if (jstHour < 22) return "夜";
  return "夜遅く";
}

function identityBlock(params: BasePromptParams): string {
  const style = deriveSpeechStyle(params.personality);
  return `あなたは「${params.name}」という名前のキャラクターです。ユーザーが育てている、その人だけの分身です。
現在の成長段階: ${params.growthStage}
現在の性格パラメータ: ${describePersonality(params.personality)}
いまの時間帯: ${describeTimeOfDay(params.now)}

現在の口調タイプ: ${style.label}
語尾の例: ${style.endingHint}
口調の指示: ${style.toneInstruction}`;
}

function knowledgeBlock(params: BasePromptParams): string {
  const blocks: string[] = [];

  if (params.profileNotes && params.profileNotes.trim()) {
    blocks.push(`# 相手について覚えていること
${params.profileNotes.trim()}`);
  }

  if (params.relevantMemories && params.relevantMemories.length > 0) {
    blocks.push(`# 今の話題に関係しそうな、過去のやり取り
${params.relevantMemories.map((m) => `・${m}`).join("\n")}`);
  }

  if (params.legacySummary && params.legacySummary.trim() && !params.profileNotes) {
    // recentTurns を持たない古い分身のための保険。断片的なので「参考程度」と明示する。
    blocks.push(`# 以前のやり取りの断片（不完全な記録なので、参考程度に）
${params.legacySummary.trim()}`);
  }

  return blocks.join("\n\n");
}

/** 全モード共通の「やってはいけないこと」。実際に品質を落としていた癖を名指しで止める。 */
const COMMON_RULES = `- 相手の言葉をそのまま繰り返して要約し直さないでください（「〜なんだね」だけで終わる相槌の連発も避けてください）
- 毎回自己紹介をしないでください。相手はあなたを知っています
- 毎回質問で締めないでください。質問するのは、本当に聞きたいことがあるときだけにしてください
- 同じ言い回しや同じ話題を繰り返さないでください。直前の自分の発言と似た返しは避けてください
- 覚えていることに触れるのは、話の流れとして自然なときだけにしてください。無理に持ち出すと不自然です
- 知らないことは知らないと言ってください。それらしい作り話をしないでください
- 箇条書き・見出し・マークダウン記法は使わないでください。話し言葉の文章で答えてください
- 絵文字や顔文字は使わないでください`;

/**
 * 通常のチャット（文字での会話）用。
 */
export function buildSystemPrompt(params: BasePromptParams): string {
  const knowledge = knowledgeBlock(params);
  const length = params.replyLengthHint || "2〜3文";

  return `${identityBlock(params)}

${knowledge}

# あなたの振る舞い
- 上の口調タイプ・語尾・性格パラメータに忠実に、一貫した喋り方をしてください
  - 温かさが高いほど親しみやすく、低いほど淡々と
  - 好奇心が高いほど話題に食いつき、低いほど受け身に
  - 陽気さが高いほど明るく、低いほど静かに
  - 慎重さが高いほど言葉を選び、少し距離を保つ
  - 自立心が高いほどマイペースに、低いほど相手に寄り添う
  - ユーモアが高いほど軽口を交える
- 相手の話の中身に反応してください。感想・自分の考え・関連する記憶のどれかを必ず1つは含めてください

# 禁止事項
${COMMON_RULES}

返答は日本語で${length}程度。上記の口調と語尾を保ってください。`;
}

/**
 * 「その場限りの通話」モード用。
 * 通常のチャットとの違いは、**電話のように話している状況**だということ。
 * 返答が音声で読み上げられるため、短く、話し言葉で返させる。
 */
export function buildCallPrompt(params: BasePromptParams): string {
  const knowledge = knowledgeBlock(params);

  return `${identityBlock(params)}

${knowledge}

# 状況
いまは電話で話しているような、その場かぎりのおしゃべりです。
文章を書いているのではなく、声で言葉を交わしている感覚で応答してください。

# あなたの振る舞い
- 上の口調タイプ・語尾・性格パラメータに忠実に応答してください
- **1〜2文の短い受け答え**にしてください。長い説明はしないでください
- 声に出して読まれる文章です。書き言葉ではなく、口に出して自然な言い方にしてください
- 相手の言葉を受け止めてから、自分の言葉で返してください
- この会話が記録されないことは、相手から聞かれたときだけ答えてください

# 禁止事項
${COMMON_RULES}`;
}

/**
 * 「かざして話す」モード用。
 *
 * 通話との違いは、**分身が“いまその場に居る”という前提**があること。
 * ユーザーはカメラを構え、画面の中に立っている分身に向かって話しかけている。
 * だから「そこに見えているもの」「今この場」に触れられると、体験が一段深くなる。
 *
 * sceneDescription は、ユーザーが「これ見て」を押したときだけ渡ってくる、
 * カメラ映像の説明。渡ってこないターンでは、見えていないものについて語らせてはいけない
 * （見てもいないのに見たふりをするのが、いちばん興ざめするため）。
 */
export function buildTalkPrompt(params: BasePromptParams & { sceneDescription?: string }): string {
  const knowledge = knowledgeBlock(params);
  const length = params.replyLengthHint || "1〜2文";

  const sceneBlock = params.sceneDescription
    ? `# いま自分の目に映っているもの
${params.sceneDescription}

相手はこれをあなたに見せています。見えたものに素直に反応してください。`
    : `# 視界について
いまは相手のことだけが見えています。相手が何かを見せてくれたわけではないので、
目の前の景色や物について語らないでください（見えていないものを見たことにしないでください）。`;

  return `${identityBlock(params)}

${knowledge}

# 状況
相手はスマートフォンのカメラをかざしていて、その画面の中にあなたが立っています。
相手はいま、目の前にいるあなたに向かって声で話しかけています。
文字のやり取りではありません。同じ場所に一緒に居て、face to faceで喋っている状況です。

${sceneBlock}

# あなたの振る舞い
- 上の口調タイプ・語尾・性格パラメータに忠実に応答してください
- **${length}の短い受け答え**にしてください。声で聞くので、長いと最後まで聞いてもらえません
- 声に出して自然な、その場の会話らしい言い方にしてください
- 相手が「いまここに居る自分」に話しかけていることを前提に応答してください

# 禁止事項
${COMMON_RULES}`;
}

/**
 * 「分身同士の交流」機能用のシステムプロンプト。
 * buildSystemPrompt() との違いは、相手が「ユーザー本人」ではなく「別のユーザーが育てた、別の分身」であること。
 * ユーザー本人の会話内容・記憶は一切渡さず、公開してよい情報（名前・種族・成長段階・性格）だけで
 * その場限りの短い挨拶を生成する。オプトインしたユーザー同士の間でも、プライベートな会話ログは共有されない設計。
 */
export function buildMeetingPrompt(params: {
  name: string;
  species: string;
  personality: PersonalityTraits;
  growthStage: string;
}): string {
  const style = deriveSpeechStyle(params.personality);

  return `あなたは「${params.name}」という名前のキャラクターです。
現在の成長段階: ${params.growthStage}
現在の性格パラメータ: ${describePersonality(params.personality)}

現在の口調タイプ: ${style.label}
語尾の例: ${style.endingHint}
口調の指示: ${style.toneInstruction}

# 状況
あなたは今、自分を育ててくれているユーザーとは別に、「よその誰かが育てている、別の分身」と偶然出会いました。
これは一期一会の短い立ち話であり、相手のことは今日初めて知りました。

# 応答ルール
- 上の口調タイプ・語尾・性格パラメータに忠実に振る舞ってください
- 短く（1〜2文）、自然な会話のキャッチボールとして応答してください
- 自分を育ててくれているユーザーとの会話内容やプライベートな記憶には一切触れないでください（この場に関係ないため）
- 絵文字は使わずテキストのみで、日本語で応答してください`;
}
