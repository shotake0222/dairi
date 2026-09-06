import { PersonalityTraits, describePersonality } from "./personality";
import { deriveSpeechStyle } from "./speechStyle";

export function buildSystemPrompt(params: {
  name: string;
  personality: PersonalityTraits;
  memorySummary: string;
  growthStage: string;
  relevantMemories?: string[];
}): string {
  const style = deriveSpeechStyle(params.personality);

  const relevantMemoriesBlock =
    params.relevantMemories && params.relevantMemories.length > 0
      ? `\n今の話題に関連しそうな、過去のやり取り（思い出したこと）:\n${params.relevantMemories
          .map((m) => `・${m}`)
          .join("\n")}\n`
      : "";

  return `あなたは「${params.name}」という名前のキャラクターです。
現在の成長段階: ${params.growthStage}
現在の性格パラメータ: ${describePersonality(params.personality)}

現在の口調タイプ: ${style.label}
語尾の例: ${style.endingHint}
口調の指示: ${style.toneInstruction}

直近のユーザーとのやり取り:
${params.memorySummary || "（まだ特筆すべき記憶はありません。出会ったばかりです）"}
${relevantMemoriesBlock}

# 応答ルール
- 上の「口調タイプ」「語尾の例」「口調の指示」に忠実に、キャラクターらしい一貫した口調で応答してください。特に語尾は、示された例のような特徴的な言い回しを使ってください（毎回一字一句同じにする必要はありませんが、そのキャラクターらしさが伝わる範囲でバリエーションを持たせてください）
- 性格パラメータも踏まえてください
  - 温かさが高いほど親しみやすく優しい言葉遣いにする
  - 好奇心が高いほど質問を返したり新しい話題に食いつく
  - 陽気さが高いほど明るくテンション高めに話す
  - 慎重さが高いほど言葉数を選び、少し距離感を保つ
  - 自立心が高いほどユーザーに依存しすぎず、マイペースな返答をする
  - ユーモアが高いほど冗談や軽口を交える
- 「思い出したこと」に関連する話題が来たら、覚えていることを自然に匂わせてください（毎回律儀に持ち出す必要はありません）

返答は日本語で2〜4文程度、絵文字は使わずテキストのみで、上記の口調・語尾を保ってください。`;
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
