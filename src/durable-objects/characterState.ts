import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_PERSONALITY,
  PersonalityTraits,
  updatePersonality,
} from "../ai/personality";
import { analyzeMessage } from "../ai/signalExtractor";
import { buildSystemPrompt } from "../ai/promptBuilder";
import { deriveSpeechStyle } from "../ai/speechStyle";
import { retrieveRelevantMemories, storeMemory } from "../ai/memory";

export interface Env {
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
}

// 5種族×6色=30種類。実ファイルは public/characters/{species}_{color}.png / .glb
export const SPECIES_KEYS = ["punikoro", "mofukuru", "tsunomaru", "howahowa", "kiratsubu"] as const;
export const COLOR_KEYS = ["coral", "sky", "leaf", "sun", "lavender", "peach"] as const;
export type SpeciesKey = (typeof SPECIES_KEYS)[number];
export type ColorKey = (typeof COLOR_KEYS)[number];

export interface CharacterData {
  name: string;
  species: SpeciesKey;
  color: ColorKey;
  personality: PersonalityTraits;
  memorySummary: string;
  growthStage: string;
  interactionCount: number;
  lastVisit: number; // epoch ms（日単位の「放置」判定に使用）
  lastMessageAt?: number; // epoch ms（連投防止の簡易レート制限に使用。既存データには無いのでoptional）
  createdAt: number;
}

// 悪用・コスト対策の簡易ガード。厳密なセキュリティ機構ではなく、
// あくまでMVP段階での過度な連投・長文投稿を抑える最小限の防御。
const MAX_MESSAGE_LENGTH = 400;
const MIN_MESSAGE_INTERVAL_MS = 1200;

function randomSpecies(): SpeciesKey {
  return SPECIES_KEYS[Math.floor(Math.random() * SPECIES_KEYS.length)];
}

function randomColor(): ColorKey {
  return COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)];
}

const CHAT_MODEL = "@cf/meta/llama-3.2-3b-instruct"; // 序盤運用の軽量モデル。品質次第で差し替え可能

/**
 * キャラクター1体 = Durable Object 1インスタンス。
 * 性格パラメータ・会話要約・成長段階をここで一元管理し、
 * SLM自体には状態を持たせない（＝モデルを差し替えても育成データは失われない）設計。
 */
export class CharacterState extends DurableObject<Env> {
  async init(name: string): Promise<CharacterData> {
    const existing = await this.ctx.storage.get<CharacterData>("data");
    if (existing) return existing;

    const data: CharacterData = {
      name,
      species: randomSpecies(),
      color: randomColor(),
      personality: { ...DEFAULT_PERSONALITY },
      memorySummary: "",
      growthStage: "誕生したばかり",
      interactionCount: 0,
      lastVisit: Date.now(),
      createdAt: Date.now(),
    };
    await this.ctx.storage.put("data", data);
    return data;
  }

  async getState(): Promise<CharacterData | null> {
    return (await this.ctx.storage.get<CharacterData>("data")) ?? null;
  }

  async rename(newName: string): Promise<CharacterData> {
    const data = (await this.ctx.storage.get<CharacterData>("data")) ?? (await this.init(newName));
    data.name = newName;
    await this.ctx.storage.put("data", data);
    return data;
  }

  async chat(userMessage: string): Promise<{
    reply?: string;
    personality: PersonalityTraits;
    growthStage: string;
    interactionCount: number;
    speechStyleLabel: string;
    species: SpeciesKey;
    color: ColorKey;
    error?: string;
  }> {
    let data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) {
      data = await this.init("名もなきキャラクター");
    }

    const now = Date.now();

    // --- 簡易ガード: 空文字・長すぎるメッセージ・連投は、SLM呼び出し前に弾く ---
    const trimmed = userMessage.trim();
    if (!trimmed) {
      return { ...this.toSummary(data), error: "メッセージを入力してね" };
    }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return { ...this.toSummary(data), error: `メッセージが長すぎます（${MAX_MESSAGE_LENGTH}文字以内にしてね）` };
    }
    if (data.lastMessageAt && now - data.lastMessageAt < MIN_MESSAGE_INTERVAL_MS) {
      return { ...this.toSummary(data), error: "ちょっと待って、少し間を空けてから話しかけてね" };
    }
    data.lastMessageAt = now;

    const daysSinceLastVisit = (now - data.lastVisit) / (1000 * 60 * 60 * 24);
    const signal = analyzeMessage(trimmed, daysSinceLastVisit);

    // ここが「育て方で性格が変わる」の核。会話のたびに少しずつパラメータが動く。
    data.personality = updatePersonality(data.personality, signal);
    data.interactionCount += 1;
    data.lastVisit = now;
    data.growthStage = computeGrowthStage(data.interactionCount);

    // characterId: このDOインスタンス自身の識別子（env.CHARACTER.getByName(characterId)で
    // 生成されたDOは this.ctx.id.name が常にそのcharacterIdと一致する）。
    // Vectorizeのメタデータフィルタに使い、キャラクターごとに記憶を分離する。
    const characterId = this.ctx.id.name ?? "unknown";
    const relevantMemories = await retrieveRelevantMemories(this.env, characterId, trimmed);

    const systemPrompt = buildSystemPrompt({
      name: data.name,
      personality: data.personality,
      memorySummary: data.memorySummary,
      growthStage: data.growthStage,
      relevantMemories,
    });

    let reply: string;
    try {
      const aiResponse = (await this.env.AI.run(CHAT_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmed },
        ],
      })) as { response?: string };
      reply = aiResponse.response?.trim() || "……（うまく言葉が出てこなかったみたい）";
    } catch (err) {
      // Workers AIの呼び出し失敗時のフォールバック（開発初期はモデルIDの変更等で起きやすい）
      reply = "（今はうまく考えがまとまらないみたい。少し時間をおいてもう一度話しかけてね）";
    }

    data.memorySummary = updateMemorySummary(data.memorySummary, trimmed, reply);
    await this.ctx.storage.put("data", data);

    // 長期記憶（Vectorize）への保存はチャット応答を待たせる必要がないため、失敗しても無視して継続する。
    // ただしDurable Object内なので、レスポンスを返す前に await して確実に実行させておく。
    await storeMemory(this.env, characterId, trimmed, reply);

    return { reply, ...this.toSummary(data) };
  }

  /** ガード節でreplyなしの応答を返すための共通フィールドまとめ */
  private toSummary(data: CharacterData) {
    return {
      personality: data.personality,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      speechStyleLabel: deriveSpeechStyle(data.personality).label,
      species: data.species,
      color: data.color,
    };
  }
}

function computeGrowthStage(interactionCount: number): string {
  if (interactionCount < 5) return "誕生したばかり";
  if (interactionCount < 20) return "よちよち期";
  if (interactionCount < 50) return "成長期";
  return "成熟期";
}

/**
 * 短期記憶（直近のやり取りの生ログ）。プロンプトに毎回そのまま載せるため、件数を絞って肥大化を防ぐ。
 * より古い/話題的に離れたやり取りは、Vectorize側の長期記憶（src/ai/memory.ts）が
 * 類似検索で必要なときだけ思い出す形でカバーする。
 */
function updateMemorySummary(prev: string, userMessage: string, reply: string): string {
  const line = `・ユーザー「${truncate(userMessage, 40)}」→ 自分「${truncate(reply, 40)}」`;
  const combined = prev ? `${prev}\n${line}` : line;
  return combined.split("\n").slice(-8).join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
