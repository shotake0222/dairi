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
import { buildMeetingPrompt } from "../ai/promptBuilder";

export interface Env {
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
  DB: D1Database;
}

// 5種族×6色=30種類。実ファイルは public/characters/{species}_{color}.png / .glb
export const SPECIES_KEYS = ["punikoro", "mofukuru", "tsunomaru", "howahowa", "kiratsubu"] as const;
export const COLOR_KEYS = ["coral", "sky", "leaf", "sun", "lavender", "peach"] as const;
export type SpeciesKey = (typeof SPECIES_KEYS)[number];
export type ColorKey = (typeof COLOR_KEYS)[number];

// 「分身同士の交流」機能で、他ユーザーの分身に種族を自然な日本語で紹介するための表示名。
export const SPECIES_LABELS: Record<SpeciesKey, string> = {
  punikoro: "ぷにころ",
  mofukuru: "もふくる",
  tsunomaru: "つのまる",
  howahowa: "ほわほわ",
  kiratsubu: "きらつぶ",
};

/** 分身同士の交流ログの1発言。roleはこのキャラクター視点での自分/相手。 */
export interface MeetingLogEntry {
  role: "self" | "other";
  text: string;
}

export interface MeetingRecord {
  at: number; // epoch ms
  partner: { name: string; species: SpeciesKey; color: ColorKey };
  log: MeetingLogEntry[];
}

// 「お散歩」機能のクールダウン（AIコスト対策・1日1回程度の特別感を出すため）
export const MEETING_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20時間

/** 性格変遷の可視化（成長グラフ）用の1スナップショット。 */
export interface PersonalityHistoryEntry {
  t: number; // epoch ms
  interactionCount: number;
  personality: PersonalityTraits;
}

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
  personalityHistory?: PersonalityHistoryEntry[]; // 既存データには無いのでoptional。無ければ誕生時点として扱う
  socialOptIn?: boolean; // 「他の分身と出会う」機能への同意（デフォルトfalse＝非公開）
  lastMeetingAt?: number; // epoch ms（お散歩機能のクールダウン判定用）
  lastMeeting?: MeetingRecord; // 直近の交流ログ
}

// 悪用・コスト対策の簡易ガード。厳密なセキュリティ機構ではなく、
// あくまでMVP段階での過度な連投・長文投稿を抑える最小限の防御。
const MAX_MESSAGE_LENGTH = 400;
const MIN_MESSAGE_INTERVAL_MS = 1200;

// 性格変遷グラフ用の履歴は無制限に貯めるとストレージを圧迫するため上限を設け、
// 上限を超えたら間引く（＝古いほど記録の密度が粗くなっていく、成長アルバムのような扱い）。
const MAX_HISTORY_ENTRIES = 120;

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

    const now = Date.now();
    const data: CharacterData = {
      name,
      species: randomSpecies(),
      color: randomColor(),
      personality: { ...DEFAULT_PERSONALITY },
      memorySummary: "",
      growthStage: "誕生したばかり",
      interactionCount: 0,
      lastVisit: now,
      createdAt: now,
      // 誕生時点（全パラメータ50）を最初の1点として記録しておく。これが成長グラフの起点になる。
      personalityHistory: [{ t: now, interactionCount: 0, personality: { ...DEFAULT_PERSONALITY } }],
    };
    await this.ctx.storage.put("data", data);
    return data;
  }

  /** 成長グラフ（性格変遷の可視化）用に、履歴データだけを取得する。 */
  async getHistory(): Promise<{
    name: string;
    species: SpeciesKey;
    color: ColorKey;
    growthStage: string;
    interactionCount: number;
    history: PersonalityHistoryEntry[];
  } | null> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return null;
    const history =
      data.personalityHistory && data.personalityHistory.length > 0
        ? data.personalityHistory
        : [{ t: data.createdAt, interactionCount: 0, personality: { ...DEFAULT_PERSONALITY } }];
    return {
      name: data.name,
      species: data.species,
      color: data.color,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      history,
    };
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
    socialOptIn: boolean;
    lastMeeting?: MeetingRecord;
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

    // characterId: このDOインスタンス自身の識別子（env.CHARACTER.getByName(characterId)で
    // 生成されたDOは this.ctx.id.name が常にそのcharacterIdと一致する）。
    // Vectorizeのメタデータフィルタ・D1ディレクトリのキーとして使う。
    const characterId = this.ctx.id.name ?? "unknown";

    const daysSinceLastVisit = (now - data.lastVisit) / (1000 * 60 * 60 * 24);
    const signal = analyzeMessage(trimmed, daysSinceLastVisit);

    // ここが「育て方で性格が変わる」の核。会話のたびに少しずつパラメータが動く。
    data.personality = updatePersonality(data.personality, signal);
    data.interactionCount += 1;
    data.lastVisit = now;
    data.growthStage = computeGrowthStage(data.interactionCount);

    // 性格変遷グラフ用に、この瞬間のスナップショットを履歴へ積む。
    if (!data.personalityHistory) data.personalityHistory = [];
    data.personalityHistory.push({
      t: now,
      interactionCount: data.interactionCount,
      personality: { ...data.personality },
    });
    data.personalityHistory = decimateHistory(data.personalityHistory);

    // 「他の分身と出会う」機能にオプトイン済みなら、マッチング用ディレクトリ（D1）も最新の性格に同期しておく。
    if (data.socialOptIn) {
      await this.syncDirectory(characterId, data);
    }

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
      socialOptIn: data.socialOptIn ?? false,
      lastMeeting: data.lastMeeting,
    };
  }

  /**
   * 「他の分身と出会う」機能への同意を切り替える。
   * オプトインするとD1の公開ディレクトリに公開してよい情報（名前・種族・色・性格・成長段階）だけが載り、
   * オプトアウトすると即座にディレクトリから削除される（同意していないキャラクターの情報は一切残らない）。
   */
  async setSocialOptIn(optIn: boolean): Promise<{ optIn: boolean }> {
    let data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) data = await this.init("名もなきキャラクター");
    data.socialOptIn = optIn;
    await this.ctx.storage.put("data", data);

    const characterId = this.ctx.id.name ?? "unknown";
    if (optIn) {
      await this.syncDirectory(characterId, data);
    } else {
      try {
        await this.env.DB.prepare("DELETE FROM character_directory WHERE character_id = ?").bind(characterId).run();
      } catch (err) {
        // 削除に失敗しても致命的ではない（次回オプトアウト操作や運用側のクリーンアップで解消可能）
      }
    }
    return { optIn };
  }

  private async syncDirectory(characterId: string, data: CharacterData): Promise<void> {
    try {
      await this.env.DB.prepare(
        `INSERT INTO character_directory
           (character_id, name, species, color, growth_stage, warmth, curiosity, cheerfulness, caution, independence, humor, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(character_id) DO UPDATE SET
           name=excluded.name, species=excluded.species, color=excluded.color, growth_stage=excluded.growth_stage,
           warmth=excluded.warmth, curiosity=excluded.curiosity, cheerfulness=excluded.cheerfulness,
           caution=excluded.caution, independence=excluded.independence, humor=excluded.humor, updated_at=excluded.updated_at`
      )
        .bind(
          characterId,
          data.name,
          data.species,
          data.color,
          data.growthStage,
          data.personality.warmth,
          data.personality.curiosity,
          data.personality.cheerfulness,
          data.personality.caution,
          data.personality.independence,
          data.personality.humor,
          Date.now()
        )
        .run();
    } catch (err) {
      // ディレクトリ同期の失敗は致命的ではない（次回のchat()呼び出し時に再同期される）
    }
  }

  /**
   * 「お散歩」機能の1発言を生成する。相手には名前・種族の表示名だけを渡し、
   * ユーザー本人との会話内容・記憶は一切渡さない（buildMeetingPromptもその前提で書かれている）。
   */
  async speakInMeeting(otherName: string, otherSpeciesLabel: string, lastLine?: string): Promise<string> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return "……（誰かの気配がしたけれど、うまく声が出なかった）";

    const prompt = buildMeetingPrompt({
      name: data.name,
      species: data.species,
      personality: data.personality,
      growthStage: data.growthStage,
    });
    const userMessage = lastLine
      ? `「${otherName}」（${otherSpeciesLabel}の姿をした別の分身）がこう言いました:「${lastLine}」。それに短く返事をしてください。`
      : `「${otherName}」（${otherSpeciesLabel}の姿をした別の分身）に、今ちょうど出会いました。ひとこと挨拶してみてください。`;

    try {
      const aiResponse = (await this.env.AI.run(CHAT_MODEL, {
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userMessage },
        ],
      })) as { response?: string };
      return aiResponse.response?.trim() || "……（うまく言葉が出てこなかったみたい）";
    } catch (err) {
      return "（今はうまく話せないみたい）";
    }
  }

  /** 交流ログを保存する（自分視点のlog配列とパートナー情報を受け取る）。 */
  async recordMeeting(log: MeetingLogEntry[], partner: { name: string; species: SpeciesKey; color: ColorKey }): Promise<void> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return;
    const now = Date.now();
    data.lastMeetingAt = now;
    data.lastMeeting = { at: now, partner, log };
    await this.ctx.storage.put("data", data);
  }
}

/**
 * 履歴が上限を超えたら間引く。最初と最後の点は必ず残しつつ、
 * それ以外を1つ飛ばしで削ることで「古いほど記録が粗くなる」形にし、
 * 長く使うほどストレージが際限なく増えるのを防ぐ。
 */
function decimateHistory(history: PersonalityHistoryEntry[]): PersonalityHistoryEntry[] {
  if (history.length <= MAX_HISTORY_ENTRIES) return history;
  const first = history[0];
  const last = history[history.length - 1];
  const middle = history.slice(1, -1).filter((_, i) => i % 2 === 0);
  return [first, ...middle, last];
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
