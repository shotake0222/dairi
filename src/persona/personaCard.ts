/**
 * 人格カード — 育てた分身を、別のAIランタイムへそのまま載せるための形式。
 *
 * 何のためにあるか:
 * わけたまの人格は、モデルの重みの中ではなく**こちら側の構造化データ**として持っている。
 * だからモデルを差し替えても人格は消えないし、逆に言えば、その人格データさえ渡せば
 * 手元のSLMでもロボットの中でも同じ分身が動かせるはずである。その「渡す形」がこれ。
 *
 * 人格パッケージ（PersonalityPackageV1）との違い:
 *   - 人格パッケージは**バックアップと復元**のための完全な記録。わけたまへ戻すことが前提。
 *   - 人格カードは**別のランタイムで即座に動かす**ための最小構成。戻ってくることは想定しない。
 *     成長グラフの履歴のような、動かすのに要らないものは入れない代わりに、
 *     そのまま渡せるシステムプロンプトと会話例を同梱する。
 *
 * 出力形式を3つ用意してあるのは、載せ先によって受け取れる形が違うため。
 *   - json:      自前の実装に組み込む場合
 *   - prompt:    システムプロンプト1枚だけあればよい場合（大半のAPIはこれで足りる）
 *   - modelfile: Ollama など、ローカルでモデルを定義して常駐させる場合
 */

import { PersonalityTraits, describePersonality } from "../ai/personality";
import { deriveSpeechStyle } from "../ai/speechStyle";
import { deriveVoiceProfile, VoiceProfile } from "../ai/voiceProfile";
import { Psychographics, describeValues, topInterests } from "../analysis/psychographics";
import { SegmentResult } from "../analysis/segments";
import { ProfileAnswers, describeProfile } from "./profile";
import { AccessibilityPrefs } from "./accessibility";

export const PERSONA_CARD_FORMAT = "waketama.persona-card";
export const PERSONA_CARD_VERSION = "1.0";

export interface PersonaCardMemory {
  text: string;
  at: number;
}

export interface PersonaCardExample {
  user: string;
  assistant: string;
}

export interface PersonaCard {
  format: typeof PERSONA_CARD_FORMAT;
  formatVersion: typeof PERSONA_CARD_VERSION;
  generatedAt: number;

  identity: {
    id: string;
    name: string;
    species: string;
    color: string;
    createdAt: number;
    growthStage: string;
    interactionCount: number;
  };

  personality: PersonalityTraits;
  speech: { styleLabel: string; endingHint: string; toneInstruction: string };
  voice: VoiceProfile;

  /** 人物像（本人＝育てた人の側の情報）。同意が無ければ空になる */
  owner: {
    values: Record<string, number>;
    interests: string[];
    segment: { id: string; label: string; confidence: number } | null;
    profile: ProfileAnswers;
  };

  /** 覚え書き（相手について長く覚えていること） */
  notes: string[];
  /** 長期記憶。埋め込みではなく平文で持つので、載せ先のモデルに依存しない */
  memories: PersonaCardMemory[];
  /** 実際の会話から抜いた応答例。口調を移植するのに、説明より遥かに効く */
  examples: PersonaCardExample[];

  /** そのまま使える形にしたもの */
  runtime: {
    systemPrompt: string;
    temperature: number;
    /** この人格を動かすのに必要な、おおよその文脈長（トークン） */
    recommendedContextTokens: number;
    /** 音声で喋らせる場合の指定 */
    speech: { language: "ja-JP"; pitch: number; rate: number };
  };

  /** 本人の手元に戻すときのため。販売・集約の対象には含めない */
  accessibility?: AccessibilityPrefs;
}

export interface BuildPersonaCardInput {
  characterId: string;
  name: string;
  species: string;
  color: string;
  createdAt: number;
  growthStage: string;
  interactionCount: number;
  personality: PersonalityTraits;
  psychographics: Psychographics;
  segment: SegmentResult | null;
  profileAnswers: ProfileAnswers;
  profileNotes: string;
  memories: PersonaCardMemory[];
  recentTurns: Array<{ role: "user" | "character"; text: string }>;
  accessibility?: AccessibilityPrefs;
  /** 属性・価値観を含めてよいか（同意が無ければ人物像を落として、分身の振る舞いだけを渡す） */
  includeOwnerProfile: boolean;
}

/** 直近のやり取りから、往復になっている組だけを取り出して応答例にする。 */
export function extractExamples(
  turns: Array<{ role: "user" | "character"; text: string }>,
  limit = 6
): PersonaCardExample[] {
  const examples: PersonaCardExample[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role !== "user" || turns[i + 1].role !== "character") continue;
    const user = turns[i].text.trim();
    const assistant = turns[i + 1].text.trim();
    if (!user || !assistant) continue;
    examples.push({ user, assistant });
    i++; // 使った組は飛ばす
  }
  // 新しい方が「いまの口調」に近いので、後ろから取る
  return examples.slice(-limit);
}

/**
 * 載せ先で system に入れるだけで動く、1枚のプロンプトを組み立てる。
 *
 * わけたま本体の promptBuilder と分けてあるのは、あちらが
 * 「毎ターンの文脈（想起した記憶・その日の時間帯）」を含む動的なものなのに対し、
 * こちらは**持ち出した先で固定して使う静的なもの**だから。
 * 同じ関数で兼ねようとすると、どちらかが不自然になる。
 */
export function renderSystemPrompt(card: PersonaCard): string {
  const blocks: string[] = [];

  blocks.push(`あなたは「${card.identity.name}」という名前のキャラクターです。
ある人が会話を重ねて育ててきた、その人だけの分身です。
これまでの会話の回数: ${card.identity.interactionCount}回（現在の段階: ${card.identity.growthStage}）`);

  blocks.push(`# 性格
${describePersonality(card.personality)}

口調タイプ: ${card.speech.styleLabel}
語尾の例: ${card.speech.endingHint}
話し方: ${card.speech.toneInstruction}`);

  if (card.notes.length > 0) {
    blocks.push(`# 相手について覚えていること\n${card.notes.map((n) => (n.startsWith("・") ? n : `・${n}`)).join("\n")}`);
  }

  const ownerLines: string[] = [];
  if (card.owner.interests.length > 0) ownerLines.push(`関心のある話題: ${card.owner.interests.join("、")}`);
  if (card.owner.segment) ownerLines.push(`人物像の傾向: ${card.owner.segment.label}`);
  if (ownerLines.length > 0) blocks.push(`# 相手の傾向\n${ownerLines.join("\n")}`);

  if (card.memories.length > 0) {
    const recent = card.memories.slice(-20);
    blocks.push(`# 覚えているやり取り\n${recent.map((m) => `・${m.text.replace(/\n/g, " / ")}`).join("\n")}`);
  }

  if (card.examples.length > 0) {
    blocks.push(
      `# 話し方の例（この調子で応答してください）\n` +
        card.examples.map((e) => `相手:「${e.user}」\n${card.identity.name}:「${e.assistant}」`).join("\n")
    );
  }

  blocks.push(`# 応答のルール
- 上の口調と語尾を保ってください。説明ではなく、その子として喋ってください
- 覚えていることに触れるのは、話の流れとして自然なときだけにしてください
- 知らないことは知らないと言ってください。それらしい作り話をしないでください
- 箇条書き・見出し・マークダウン記法は使わないでください
- 絵文字や顔文字は使わないでください
- 日本語で、2〜3文程度で応答してください`);

  return blocks.join("\n\n");
}

/**
 * Ollama の Modelfile として書き出す。
 * 手元のPCやエッジ機器で `ollama create <名前> -f Modelfile` すれば、そのまま常駐させられる。
 */
export function renderOllamaModelfile(card: PersonaCard, baseModel = "llama3.1:8b"): string {
  const escaped = card.runtime.systemPrompt.replace(/"""/g, '\\"\\"\\"');
  const messages = card.examples
    .map((e) => `MESSAGE user ${JSON.stringify(e.user)}\nMESSAGE assistant ${JSON.stringify(e.assistant)}`)
    .join("\n");

  return `# わけたま 人格カード → Ollama Modelfile
# 分身: ${card.identity.name}（${card.identity.growthStage} / 会話${card.identity.interactionCount}回）
# 書き出し: ${new Date(card.generatedAt).toISOString()}
#
# 使い方:
#   ollama create ${sanitizeModelName(card.identity.name)} -f ./Modelfile
#   ollama run ${sanitizeModelName(card.identity.name)}
#
# FROM は手元にあるモデルに読み替えてください。日本語の応答品質がそのまま体験に出ます。

FROM ${baseModel}

PARAMETER temperature ${card.runtime.temperature}
PARAMETER num_ctx ${card.runtime.recommendedContextTokens}

SYSTEM """
${escaped}
"""

${messages}
`;
}

function sanitizeModelName(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9_-]/g, "");
  return ascii.length > 0 ? `waketama-${ascii.toLowerCase()}` : "waketama-persona";
}

export function buildPersonaCard(input: BuildPersonaCardInput): PersonaCard {
  const style = deriveSpeechStyle(input.personality);
  const voice = deriveVoiceProfile(input.characterId, input.personality);

  const notes = input.profileNotes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const memories = input.memories.slice(-60);
  const examples = extractExamples(input.recentTurns);

  const card: PersonaCard = {
    format: PERSONA_CARD_FORMAT,
    formatVersion: PERSONA_CARD_VERSION,
    generatedAt: Date.now(),
    identity: {
      id: input.characterId,
      name: input.name,
      species: input.species,
      color: input.color,
      createdAt: input.createdAt,
      growthStage: input.growthStage,
      interactionCount: input.interactionCount,
    },
    personality: input.personality,
    speech: { styleLabel: style.label, endingHint: style.endingHint, toneInstruction: style.toneInstruction },
    voice,
    owner: input.includeOwnerProfile
      ? {
          values: input.psychographics.values,
          interests: topInterests(input.psychographics, 6),
          segment: input.segment
            ? { id: input.segment.id, label: input.segment.label, confidence: input.segment.confidence }
            : null,
          profile: input.profileAnswers,
        }
      : { values: {}, interests: [], segment: null, profile: {} },
    notes,
    memories,
    examples,
    runtime: {
      systemPrompt: "", // 直後に埋める（プロンプトの生成にカード自身が必要なため）
      temperature: 0.8,
      // 記憶と例を積んだうえで会話ができる程度。載せ先が小さいモデルでも現実的な値にしてある
      recommendedContextTokens: 8192,
      speech: { language: "ja-JP", pitch: voice.pitch, rate: voice.rate },
    },
    accessibility: input.accessibility,
  };

  card.runtime.systemPrompt = renderSystemPrompt(card);
  return card;
}

/** 人格カードを「持ち出せる説明つき」のテキストにする（何が入っているかを人が読めるようにするため）。 */
export function renderReadme(card: PersonaCard): string {
  return `# ${card.identity.name} — わけたま 人格カード

書き出し日時: ${new Date(card.generatedAt).toISOString()}
形式: ${card.format} v${card.formatVersion}

## これは何か

わけたまで育てた分身の人格を、わけたまの外でも動かせる形にしたものです。
特定のAIモデルに依存しない形にしてあるので、手元のPCで動かす小さなモデルでも、
ロボットやスマートスピーカーに載せる場合でも、同じ子として振る舞わせられます。

## 入っているもの

- 性格パラメータ（6軸）と、そこから決まる口調
- この子の声（高さ・速さ）
- 相手について覚えていること（${card.notes.length}件）
- 記憶しているやり取り（${card.memories.length}件・平文）
- 実際の会話から取った応答例（${card.examples.length}組）
- そのまま使えるシステムプロンプト（runtime.systemPrompt）

## 使い方

いちばん簡単なのは、runtime.systemPrompt をそのままシステムメッセージに入れる方法です。
それだけで、この子として応答するようになります。

Ollama で常駐させたい場合は、同じ内容を Modelfile 形式でも書き出せます
（?format=modelfile を付けてください）。

## 注意

記憶には、育てた人の生活に関わる内容が含まれていることがあります。
第三者へ渡す前に、中身を確認してください。
`;
}
