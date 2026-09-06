import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_PERSONALITY,
  PersonalityTraits,
  updatePersonality,
} from "../ai/personality";
import { analyzeMessage } from "../ai/signalExtractor";
import { buildSystemPrompt } from "../ai/promptBuilder";
import { deriveSpeechStyle } from "../ai/speechStyle";

export interface Env {
  AI: Ai;
}

export interface CharacterData {
  name: string;
  personality: PersonalityTraits;
  memorySummary: string;
  growthStage: string;
  interactionCount: number;
  lastVisit: number; // epoch ms
  createdAt: number;
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
    reply: string;
    personality: PersonalityTraits;
    growthStage: string;
    interactionCount: number;
    speechStyleLabel: string;
  }> {
    let data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) {
      data = await this.init("名もなきキャラクター");
    }

    const now = Date.now();
    const daysSinceLastVisit = (now - data.lastVisit) / (1000 * 60 * 60 * 24);
    const signal = analyzeMessage(userMessage, daysSinceLastVisit);

    // ここが「育て方で性格が変わる」の核。会話のたびに少しずつパラメータが動く。
    data.personality = updatePersonality(data.personality, signal);
    data.interactionCount += 1;
    data.lastVisit = now;
    data.growthStage = computeGrowthStage(data.interactionCount);

    const systemPrompt = buildSystemPrompt({
      name: data.name,
      personality: data.personality,
      memorySummary: data.memorySummary,
      growthStage: data.growthStage,
    });

    let reply: string;
    try {
      const aiResponse = (await this.env.AI.run(CHAT_MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      })) as { response?: string };
      reply = aiResponse.response?.trim() || "……（うまく言葉が出てこなかったみたい）";
    } catch (err) {
      // Workers AIの呼び出し失敗時のフォールバック（開発初期はモデルIDの変更等で起きやすい）
      reply = "（今はうまく考えがまとまらないみたい。少し時間をおいてもう一度話しかけてね）";
    }

    data.memorySummary = updateMemorySummary(data.memorySummary, userMessage, reply);
    await this.ctx.storage.put("data", data);

    return {
      reply,
      personality: data.personality,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      speechStyleLabel: deriveSpeechStyle(data.personality).label,
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
 * MVP版の簡易メモリ要約。直近のやり取りをそのまま蓄積し、件数で切り詰める。
 * 会話量が増えてきたら、Vectorizeへの埋め込み保存＋類似検索によるRAG方式に置き換える想定。
 */
function updateMemorySummary(prev: string, userMessage: string, reply: string): string {
  const line = `・ユーザー「${truncate(userMessage, 40)}」→ 自分「${truncate(reply, 40)}」`;
  const combined = prev ? `${prev}\n${line}` : line;
  return combined.split("\n").slice(-20).join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
