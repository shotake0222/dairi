import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_PERSONALITY,
  PersonalityTraits,
  updatePersonality,
} from "../ai/personality";
import { analyzeMessage } from "../ai/signalExtractor";
import { buildSystemPrompt, buildTalkPrompt } from "../ai/promptBuilder";
import { deriveSpeechStyle } from "../ai/speechStyle";
import { retrieveRelevantMemories, storeMemory, exportAllMemories, importMemories, deleteAllMemories, ExportedMemory } from "../ai/memory";
import { buildMeetingPrompt } from "../ai/promptBuilder";
import { RateLimiter } from "../lib/rateLimit";
import { ChatMessage, contextBudgetFor, primaryChatModel, runChat } from "../ai/modelPolicy";
import { growthProgress, GrowthProgress, normalizeStageName, stageName } from "../ai/growth";
import {
  distillProfileNotes,
  shouldReflect,
  mergeNotes,
  normalizeNoteLines,
  MAX_NOTES_CHARS,
  MAX_NOTES_LINES,
  MAX_SEED_CHARS,
  MAX_SEED_LINES,
} from "../ai/reflection";
import { deriveVoiceProfile, VoiceProfile } from "../ai/voiceProfile";
import { detectsSelfHarmSignal, SELF_HARM_RESPONSE } from "../ai/safetyGuard";
import { logDetachedWarn } from "../lib/log";
import { ConsentState, hasConsent, normalizeConsent } from "../persona/consent";
import { personaDepth, PSYCHO_QUESTIONS } from "../persona/survey";
import {
  DemographicProfile,
  PROFILE_FIELDS,
  ProfileAnswers,
  ProfileField,
  describeProfile,
  nextFieldToAsk,
  sanitizeAnswers,
} from "../persona/profile";
import { AccessibilityPrefs, sanitizeAccessibility } from "../persona/accessibility";
import {
  Psychographics,
  applySelfReport,
  describeValues,
  emptyPsychographics,
  mergeTermSignals,
  mergeValueEstimate,
} from "../analysis/psychographics";
import { classifySegment, SegmentResult } from "../analysis/segments";
import { removeFromRegistry, syncRegistry, countMetric } from "../persona/registry";
import { buildPersonaCard, buyerProfileAnswers, PersonaCard } from "../persona/personaCard";
import { auditCompact, toCompact } from "../../tools/edge/compact.mjs";
import { sanitizeMetaLine } from "../metaText";

export interface Env {
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
  DB: D1Database;
  /** 会話モデルの上書き（src/ai/modelPolicy.ts 参照）。未設定なら既定の連鎖を使う。 */
  CHAT_MODEL?: string;
}

// 25種族×6色=150種類。実ファイルは public/characters/{species}_{color}.png / .glb
// 後半の10種族（hoshipo 以降）は 2026-09-23 に追加。tools/characters/make_characters.py が作る。
// **並びを変えない・消さない。** 既存の分身は種族のキーで姿を引いているので、消すと姿が出なくなる。
// 画面側の一覧（public/species.js）と、声の家系（src/ai/voiceProfile.ts）も同じ並びで持つ。
export const SPECIES_KEYS = [
  "punikoro", "mofukuru", "tsunomaru", "howahowa", "kiratsubu",
  "hoshipo", "kinokon", "tamatori", "mimipyon", "futabaru",
  "kuragekko", "nyamaru", "kamenko", "ponpoko", "futatama",
  "togemaru", "pentama", "kumarun", "konkon", "gekomaru",
  "paon", "merumo", "patamori", "shizukun", "kujiran",
] as const;
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
  hoshipo: "ほしぽ",
  kinokon: "きのこん",
  tamatori: "たまとり",
  mimipyon: "みみぴょん",
  futabaru: "ふたばる",
  kuragekko: "くらげっこ",
  nyamaru: "にゃまる",
  kamenko: "かめんこ",
  ponpoko: "ぽんぽこ",
  futatama: "ふたたま",
  togemaru: "とげまる",
  pentama: "ぺんたま",
  kumarun: "くまるん",
  konkon: "こんこん",
  gekomaru: "げこまる",
  paon: "ぱおん",
  merumo: "めるも",
  patamori: "ぱたもり",
  shizukun: "しずくん",
  kujiran: "くじらん",
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
  /** どこで出会ったか（無ければ「お散歩」。2026-09-23 からメタバースでの出会いも同じ記録に積む） */
  source?: "walk" | "meta";
  /** メタバースのエリアの名前 */
  place?: string;
  /**
   * 相手を見分けるための仮の印（相手の識別子のハッシュ。識別子そのものではない）。
   * 「また会えた」を数えるためだけに使い、画面へ出すときは持ち主ごとに別の値に変える（src/index.ts）
   */
  partnerKey?: string;
  /** 相手が運営の分身（NPC）だったか */
  npc?: boolean;
  /** 最後に言葉を交わした時刻（同じ相手との続きの会話は1件にまとめる） */
  lastAt?: number;
}

/** 同じ相手との会話を、1件の出会いとしてまとめる間隔 */
const META_MEETING_MERGE_MS = 15 * 60 * 1000;
/** 1件の出会いに残す言葉の数 */
const META_MEETING_MAX_LINES = 12;

// 「お散歩」機能のクールダウン（AIコスト対策・1日1回程度の特別感を出すため）
export const MEETING_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20時間

/**
 * 「人格パッケージ」フォーマット。育った性格・記憶を、モデルや実行環境に依存しない形で
 * 出し入れできるようにするための、わけたまの可搬フォーマット。
 *
 * 設計の要点:
 * - personality/personalityHistoryは単なる数値なので、どんなAIモデル・どんなハードウェアでも解釈できる
 * - memory.longTermは埋め込みベクトルではなく平文テキストで持つ（embeddingモデルへの依存を避けるため）
 * - formatVersionを持たせることで、将来フィールドを追加・変更してもv1のパッケージを読み続けられるようにする
 *
 * これは将来的な「フィジカルAI/メタバースへの人格の持ち出し」や、この形式自体をBtoBでライセンスする
 * 事業（人格ポータビリティAPI）の基礎データ契約として設計している。
 */
/**
 * 現在書き出す版。1.1で「覚え書き（profileNotes）」と「直近の会話ログ（recentTurns）」を追加した。
 * 追加はどちらも任意フィールドなので、1.0の読み手が1.1のファイルを読んでも壊れない。
 */
export const EXPORT_FORMAT_VERSION = "1.1";

/**
 * 読み込みを受け付ける版。
 * 1.0で書き出された既存のバックアップを、今後も永続的に読めるようにしておく
 * （「人格は持ち出せる」と言っておきながら、自分の過去の書き出しを読めなくするのは筋が通らない）。
 */
export const SUPPORTED_IMPORT_VERSIONS = ["1.0", "1.1"] as const;

export interface PersonalityPackageV1 {
  formatVersion: "1.0" | "1.1";
  exportedAt: number; // epoch ms
  character: {
    id: string;
    name: string;
    species: SpeciesKey;
    color: ColorKey;
    createdAt: number;
    growthStage: string;
    interactionCount: number;
  };
  personality: PersonalityTraits;
  personalityHistory: PersonalityHistoryEntry[];
  memory: {
    shortTerm: string;
    longTerm: ExportedMemory[];
    /** 1.1で追加。相手について長く覚えておくべき事実の箇条書き（会話からAIが書き留めた分）。 */
    profileNotes?: string;
    /** 1.2で追加。本人が自分で書いた「土台」。AIの蒸留では上書きされない別枠。 */
    profileNotesSeed?: string;
    /** 1.1で追加。直近のやり取りを切り詰めずに持つ（移植先で会話の流れをそのまま継げるように）。 */
    recentTurns?: DialogueTurn[];
  };
  /**
   * 1.1で追加。育てた人自身に関する情報。
   * 分身の性格（上の personality）とは別物で、こちらは「相手がどういう人か」の記録。
   * 機種変更で持ち越せないと、また一から答え直しになるのでパッケージに含める。
   */
  owner?: {
    consent?: ConsentState;
    profile?: DemographicProfile;
    psychographics?: Psychographics;
    accessibility?: AccessibilityPrefs;
  };
  meta: {
    generator: "sodatsukake" | "waketama";
    note: string;
  };
}

/** 直近の会話1発言。要約せず原文のまま持つ（要約すると文脈が壊れることが分かったため）。 */
export interface DialogueTurn {
  role: "user" | "character";
  text: string;
  t: number; // epoch ms
}

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
  lastMeeting?: MeetingRecord; // 直近の交流ログ（UI表示の後方互換のため引き続き保持）
  meetingHistory?: MeetingRecord[]; // これまで出会った分身の記録（「図鑑」機能用）。既存データには無いのでoptional
  ownerToken?: string; // 「持ち主」判定用の簡易トークン（下記参照）。既存データには無いのでoptional

  /**
   * 直近のやり取りを原文のまま保持する（会話品質改善の中心）。
   *
   * 以前は memorySummary（各発言40文字に切り詰めた1行要約）しか持っておらず、
   * しかもAIには「システムプロンプトの一部」としてしか渡していなかった。
   * その状態ではモデルは会話の流れを復元できず、毎ターン初対面のような応答になっていた。
   * ここに原文を持ち、messages配列として正しく積み直すのが正しい形。
   * 既存データには無いのでoptional（無ければ memorySummary を参考情報として使う）。
   */
  recentTurns?: DialogueTurn[];

  /**
   * 「覚え書き」。相手について長く覚えておくべき事実だけを蒸留した箇条書き。
   * 数ターンごとに src/ai/reflection.ts が更新する。会話を重ねるほど厚くなるので、
   * これが「育てるほど話が通じるようになる」の実体になる。
   */
  profileNotes?: string;

  /**
   * 本人が自分で書いた「土台」。
   *
   * profileNotes はAIが数ターンごとに**書き換える**ので、本人が書いた内容も
   * 次の蒸留で消えうる。実際「だいぶ会話しても覚え書きが空っぽ」という状態が起きていて、
   * 自動学習だけでは何も溜まらない期間が長すぎた。
   * ここに別枠で持てば、最初に数行書いた時点で分身はその人を知っている状態から始まり、
   * その上に会話からの学習（profileNotes）が積み上がる。AIはここを書き換えない。
   */
  profileNotesSeed?: string;

  /** 覚え書きを最後に更新したときの interactionCount（更新間隔の判定に使う）。 */
  lastReflectedAt?: number;

  /**
   * 用途ごとの同意。既定は「何にも同意していない」。
   * 未設定（undefined）は同意なしとして扱うので、既存の分身が勝手に統計へ載ることはない。
   */
  consent?: ConsentState;

  /** 本人が任意で答えてくれた属性。すべて任意で、いつでも消せる。 */
  profile?: DemographicProfile;

  /**
   * 入力方法や文字の大きさ。**販売・集約の対象にしない**（src/persona/accessibility.ts の冒頭参照）。
   * ここを persona/profile と分けているのは、うっかり統計へ混ぜないようにするため。
   */
  accessibility?: AccessibilityPrefs;

  /** 会話から積み上げた価値観・関心。人物像の記述であり、分身の演技指示ではない。 */
  psychographics?: Psychographics;

  /**
   * パルスサーベイ（会話の合間に1問ずつ聞く仕組み）の進み具合。
   *
   * 属性の回答そのものは profile 側に入るので、ここに持つのは
   *   - 価値観の設問にどう答えたか（同じ軸に複数の設問がありうるので、設問IDで持つ）
   *   - 「あとで」と言われた設問（すぐ聞き直すと催促になる）
   *   - 管理画面から追加された設問の項目名（会話に載せるときに必要。
   *     ここに控えておかないと、会話のたびに設問カタログをD1から読むことになる）
   */
  survey?: {
    psychoAnswers?: Record<string, string>;
    skipped?: string[];
    customLabels?: Record<string, string>;
    updatedAt?: number;
  };
}

// 「図鑑」機能用の出会いの記録は、無制限に貯めるとストレージを圧迫するため、
// 直近の一定件数だけ残す（古いものから捨てる。性格変遷グラフと違い、間引かず単純に打ち切る）。
const MAX_MEETING_HISTORY = 60;

/**
 * 所有権トークンについて（アカウント登録なしでの、最小限の「持ち主」保護）。
 *
 * わけたまはユーザーアカウントを持たない設計のため、characterId（cid）さえ分かれば
 * 誰でも状態を読めてしまう。会話や閲覧はそれで問題ないが、エクスポート（記憶の持ち出し）・
 * インポート（上書き）・公開ディレクトリへの掲載（オプトイン）・名前変更のように
 * 「持ち主本人だけが行うべき操作」には、ここで生成する ownerToken を要求する。
 *
 * - 新規キャラクター誕生時（init）に1度だけ生成し、NFCタップ直後のリダイレクトURLに乗せてクライアントへ渡す。
 * - クライアントはこれをlocalStorageに保存し、以後の保護対象APIにだけ添えて送る。
 * - 既存データ（このトークン導入前に作られたキャラクター）は ownerToken が無いため、
 *   従来通り誰でも操作できる状態のままにしておく（後から急に締め出さないための互換性維持）。
 * - アカウントもパスワードも無いMVP向けの割り切った設計であり、正式な認証層ではない
 *   （人格エクスポート仕様書 5章の「認証・アクセス制御」課題への第一歩という位置づけ）。
 */
function isOwner(data: CharacterData, providedToken?: string): boolean {
  if (!data.ownerToken) return true; // 未設定（レガシー）は従来通りオープン
  return data.ownerToken === providedToken;
}

// 悪用・コスト対策の簡易ガード。厳密なセキュリティ機構ではなく、
// あくまでMVP段階での過度な連投・長文投稿を抑える最小限の防御。
const MAX_MESSAGE_LENGTH = 400;

// 性格変遷グラフ用の履歴は無制限に貯めるとストレージを圧迫するため上限を設け、
// 上限を超えたら間引く（＝古いほど記録の密度が粗くなっていく、成長アルバムのような扱い）。
const MAX_HISTORY_ENTRIES = 120;

/**
 * 保存しておく直近の会話の発言数（ユーザー＋分身の合計）。
 * プロンプトに載せるのはこの一部（成長段階に応じた分だけ）で、ここは「持っておく量」。
 * 1発言あたりの長さも切っておかないと、長文を貼られたときにストレージが膨らむ。
 */
/**
 * 直近のやり取りを何発言ぶん持つか。
 *
 * 会話画面に「前に何を話したか」を出すための保存でもあるので、
 * プロンプトに載せる数（成長段階ごとに4〜18）より大きく取ってある。
 * ここが短いと、画面を開き直すたびに会話が消えたように見える。
 */
const MAX_RECENT_TURNS = 60;
const MAX_TURN_CHARS = 500;

function randomSpecies(): SpeciesKey {
  return SPECIES_KEYS[Math.floor(Math.random() * SPECIES_KEYS.length)];
}

function randomColor(): ColorKey {
  return COLOR_KEYS[Math.floor(Math.random() * COLOR_KEYS.length)];
}

/**
 * 「どの範囲から引くか」だけを渡せる口。
 *
 * **どの子が出るかは、ここでも決められない。** 渡せるのは候補の集合までで、
 * その中から引くのは下の乱数。場所限定の姿（特定のQRからしか出ない種族など）を
 * 作るために 0011 で開けた口で、細くできるのは母集団だけ。
 *
 * 1つに絞った集合を渡せば結果として指定と同じになるが、それは
 * **「その姿しか居ない場所」を作ったということ**で、抽選をすり抜けたわけではない。
 * 空・未指定・知らないキーしか入っていない場合は、これまでどおり全体から引く。
 */
export interface BirthPool {
  species?: readonly string[];
  color?: readonly string[];
}

function drawFrom<T extends string>(all: readonly T[], allowed: readonly string[] | undefined): T {
  const pool = (allowed || []).filter((k): k is T => (all as readonly string[]).includes(k));
  const from = pool.length > 0 ? pool : all;
  return from[Math.floor(Math.random() * from.length)];
}

/**
 * 後方互換のための再輸出。モデルの選定と呼び出しは src/ai/modelPolicy.ts に移した。
 * 以前は「このDOの中に埋まった1つの定数」がサービス全体の会話品質を決めていたが、
 * 用途ごとの使い分けもフォールバックもできず、品質改善の手が入れづらかった。
 */
export { primaryChatModel } from "../ai/modelPolicy";

/**
 * キャラクター1体 = Durable Object 1インスタンス。
 * 性格パラメータ・会話要約・成長段階をここで一元管理し、
 * SLM自体には状態を持たせない（＝モデルを差し替えても育成データは失われない）設計。
 */
export class CharacterState extends DurableObject<Env> {
  /**
   * AI呼び出しの回数制限。**ストレージではなくインスタンスメモリに置いている**。
   * 1キャラクター=1インスタンスなので、どこからアクセスされても同じ場所で数えられる一方、
   * 何も永続化しないため「その場限りモード」の“何も残さない”という約束を壊さない。
   * DOが退避されればカウンタは消えるが、それは十分な時間アクセスが無かったということなので問題ない。
   */
  private readonly rateLimiter = new RateLimiter();

  /**
   * 法人（MCPの買い手）からの呼び出し専用の回数制限。
   * 持ち主の会話と同じ入れ物で数えると、買い手が1日の上限を使い切ったとき
   * **持ち主本人がその日この子と話せなくなる**。売った相手の都合で本人が締め出されるのは筋が違うので分ける。
   * persona_reply はこちらでLLMを呼ばない（材料を返すだけ）ので、上限の意味は機械的な連打の抑止。
   */
  private readonly buyerRateLimiter = new RateLimiter();

  /**
   * その場限りモード用に、書き込みを一切せずに必要な情報だけを返す。
   * 通常のchat()は性格更新・履歴追加・記憶保存まで行うため、あちらを条件分岐で使い回すと
   * 将来の変更で「書かないはずが書いてしまう」事故が起きる。用途ごとに入口を分けている。
   *
   * 併せてレート制限の判定もここで行う（判定自体はメモリ上の操作なので書き込みは発生しない）。
   * `source` が "buyer"（MCP）のときは、持ち主とは別の入れ物で数える。
   */
  async beginEphemeralTurn(userMessage: string, source: "owner" | "buyer" = "owner"): Promise<
    | {
        ok: true;
        name: string;
        personality: PersonalityTraits;
        growthStage: string;
        species: SpeciesKey;
        color: ColorKey;
        memorySummary: string;
        profileNotes: string;
        interactionCount: number;
      }
    | { ok: false; error: string }
  > {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };

    const trimmed = userMessage.trim();
    if (!trimmed) return { ok: false, error: "メッセージを入力してね" };
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `メッセージが長すぎます（${MAX_MESSAGE_LENGTH}文字以内にしてね）` };
    }

    const verdict = (source === "buyer" ? this.buyerRateLimiter : this.rateLimiter).check();
    if (!verdict.allowed) return { ok: false, error: verdict.message };

    return {
      ok: true,
      name: data.name,
      personality: data.personality,
      growthStage: data.growthStage,
      species: data.species,
      color: data.color,
      memorySummary: data.memorySummary,
      // 通話でも「覚えていること」は使う。読み取りだけなので“何も残さない”約束とは矛盾しない。
      profileNotes: this.notesFor(data),
      interactionCount: data.interactionCount,
    };
  }

  /**
   * 持ち主かどうかだけを判定する（引き継ぎコードの発行前チェック用）。
   * 所有権の判定ロジックをDOの外に複製しないために用意している。
   */
  async verifyOwner(ownerToken?: string): Promise<boolean> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return false;
    return isOwner(data, ownerToken);
  }

  /**
   * 持ち主トークンを差し替える（引き継ぎの実行）。
   *
   * ここが呼ばれる時点で、引き継ぎコードの正当性・有効期限・未使用であることは
   * 呼び出し元（src/transfer.ts）が確認済み。よってここでは旧トークンを要求しない。
   * 差し替えると古い端末のトークンは通らなくなる＝所有権が移る、という意味になる。
   */
  async replaceOwnerToken(newOwnerToken: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    data.ownerToken = newOwnerToken;
    await this.ctx.storage.put("data", data);
    return { ok: true, name: data.name };
  }

  /**
   * 分身を生む。
   *
   * **姿は必ずランダムにする。呼び出し側から種族・色を指定できるようにしない。**
   * 依代（NFCタグ／QR）はどれも等しい確率で姿が決まる、というのが集める体験の土台で、
   * 運営が姿を決められる口を1つでも開けると「引き当てた」が「配られた」に変わる。
   */
  /**
   * @param pool 引く範囲。省略すれば150種類から等確率（ほとんどの依代はこちら）。
   *   **姿そのものを指定する引数ではない。** 詳しくは BirthPool のコメントと migration 0011。
   */
  async init(name: string, pool?: BirthPool): Promise<CharacterData> {
    const existing = await this.ctx.storage.get<CharacterData>("data");
    if (existing) return existing;

    const now = Date.now();
    const data: CharacterData = {
      name,
      species: pool ? drawFrom(SPECIES_KEYS, pool.species) : randomSpecies(),
      color: pool ? drawFrom(COLOR_KEYS, pool.color) : randomColor(),
      personality: { ...DEFAULT_PERSONALITY },
      memorySummary: "",
      growthStage: "誕生したばかり",
      interactionCount: 0,
      lastVisit: now,
      createdAt: now,
      // 誕生時点（全パラメータ50）を最初の1点として記録しておく。これが成長グラフの起点になる。
      personalityHistory: [{ t: now, interactionCount: 0, personality: { ...DEFAULT_PERSONALITY } }],
      // この瞬間にこのキャラクターを呼び出したクライアントが「持ち主」になる。
      ownerToken: crypto.randomUUID(),
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

  async rename(newName: string, ownerToken?: string): Promise<CharacterData | { error: string }> {
    const existing = await this.ctx.storage.get<CharacterData>("data");
    if (!existing) {
      // まだ存在しない＝これから作る本人がそのまま持ち主になるので所有権チェックは不要
      return this.init(newName);
    }
    if (!isOwner(existing, ownerToken)) {
      return { error: "この操作は分身の持ち主だけが行えます" };
    }
    existing.name = newName;
    await this.ctx.storage.put("data", existing);
    return existing;
  }

  /**
   * 会話の1ターン。文字チャットと「かざして話す」の両方がここを通る。
   *
   * options で状況（モード）と、見えているものの説明を渡せる。
   * 保存する内容・性格の更新のしかたはどちらのモードでも同じなので、
   * 「その場限りの通話」のように入口を分ける必要はない（分けるべきなのは保存の有無であって、話し方ではない）。
   */
  async chat(
    userMessage: string,
    options?: { mode?: "chat" | "talk"; sceneDescription?: string }
  ): Promise<{
    reply?: string;
    personality: PersonalityTraits;
    growthStage: string;
    interactionCount: number;
    speechStyleLabel: string;
    species: SpeciesKey;
    color: ColorKey;
    socialOptIn: boolean;
    lastMeeting?: MeetingRecord;
    voice?: VoiceProfile;
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
    // 連投・使いすぎのガード。以前は lastMessageAt の保存で判定していたが、
    // 「その場限りモード」と同じ判定器（インスタンスメモリ上のカウンタ）に統一した。
    // 1分/1日あたりの上限も見るので、AI呼び出しコストの青天井を防げる。
    const verdict = this.rateLimiter.check(now);
    if (!verdict.allowed) {
      return { ...this.toSummary(data), error: verdict.message };
    }
    // 表示や日次レポートで「最後に話した時刻」を使っているため、記録自体は残す
    data.lastMessageAt = now;

    // characterId: このDOインスタンス自身の識別子（env.CHARACTER.getByName(characterId)で
    // 生成されたDOは this.ctx.id.name が常にそのcharacterIdと一致する）。
    // Vectorizeのメタデータフィルタ・D1ディレクトリのキーとして使う。
    const characterId = this.ctx.id.name ?? "unknown";

    const daysSinceLastVisit = (now - data.lastVisit) / (1000 * 60 * 60 * 24);
    // これまでによく聞いてきた語を渡す。「初めて出てきた話題か」を、
    // 質問かどうかではなく実際の語で判定できるようになる（src/ai/signalExtractor.ts 参照）。
    const signal = analyzeMessage(trimmed, daysSinceLastVisit, data.psychographics?.terms);

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

    // 成長段階に応じて「どれだけ思い出し、どれだけ長く話すか」を決める。
    // 育つほど文脈が厚くなるので、同じモデルでも会話が噛み合うようになっていく。
    const budget = contextBudgetFor(data.interactionCount);
    const relevantMemories = await retrieveRelevantMemories(this.env, characterId, trimmed, budget.recallTopK);

    // 本人が答えてくれた属性は、同意がある場合だけ会話に持ち込む。
    // 価値観の推定は分身自身の理解（覚え書きと同じ性質のもの）なので、
    // 手元で使うぶんには同意の対象にしていない。外へ出すときだけ同意を見る（syncRegistry参照）。
    const ownerProfile =
      hasConsent(data.consent, "profile") && data.profile
        ? describeProfile(data.profile.answers, data.survey?.customLabels ?? {})
        : "";
    const ownerValues = data.psychographics ? describeValues(data.psychographics) : "";

    const promptParams = {
      name: data.name,
      personality: data.personality,
      growthStage: data.growthStage,
      profileNotes: this.notesFor(data),
      ownerProfile,
      ownerValues,
      // recentTurns を持たない古い分身のためだけの保険。新しい会話では messages 側が文脈を持つ。
      legacySummary: data.recentTurns && data.recentTurns.length > 0 ? undefined : data.memorySummary,
      relevantMemories,
      replyLengthHint: budget.replyLengthHint,
    };

    const systemPrompt =
      options?.mode === "talk"
        ? buildTalkPrompt({ ...promptParams, sceneDescription: options.sceneDescription })
        : buildSystemPrompt(promptParams);

    // ここが今回いちばん効く変更。
    // 直近のやり取りを user / assistant のロール付きで積み直すことで、
    // モデルが「いま何の話をしているか」を復元できるようにする。
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...toChatMessages(data.recentTurns, budget.historyTurns),
      { role: "user", content: trimmed },
    ];

    // --- 安全ガード: 自傷・自殺のサインは、AIの生成に任せずここで固定文面を返す ---
    // 方針とやらないことの線引きは src/ai/safetyGuard.ts を参照。
    // 会話としては（記憶にも残る）通常どおり扱う——ここで弾いた事実だけを、
    // 内容を出さずに集計する（運営が発生頻度を把握できるようにするため）。
    const selfHarmSignal = detectsSelfHarmSignal(trimmed);
    let result: Awaited<ReturnType<typeof runChat>> | null = null;
    let reply: string;
    if (selfHarmSignal) {
      reply = SELF_HARM_RESPONSE;
      this.ctx.waitUntil(countMetric(this.env, "safety.self_harm_signal"));
    } else {
      result = await runChat(this.env, messages, {
        maxTokens: budget.maxTokens,
        onFailure: (model, err) =>
          logDetachedWarn("chat.model_failed", {
            characterId,
            model,
            error: err instanceof Error ? err.message : String(err),
          }),
      });
      reply = result?.text || "（今はうまく考えがまとまらないみたい。少し時間をおいてもう一度話しかけてね）";
    }

    // 直近のやり取りを原文のまま積む（これがプロンプトの文脈になる）。
    data.recentTurns = appendTurns(data.recentTurns, [
      { role: "user", text: trimmed, t: now },
      { role: "character", text: reply, t: now },
    ]);
    // memorySummary は 1.0 形式のエクスポート互換のために残している（プロンプトの主役ではなくなった）。
    data.memorySummary = updateMemorySummary(data.memorySummary, trimmed, reply);

    // 語の出現から関心を更新する。AIを呼ばないので毎ターン回してよい。
    // 価値観（値の重み）の方はAIが要るので、覚え書きと同じタイミング（数ターンに1回）に寄せてある。
    data.psychographics = mergeTermSignals(data.psychographics ?? emptyPsychographics(), [trimmed]);

    await this.ctx.storage.put("data", data);

    // 長期記憶（Vectorize）への保存はチャット応答を待たせる必要がないため、失敗しても無視して継続する。
    // ただしDurable Object内なので、レスポンスを返す前に await して確実に実行させておく。
    await storeMemory(this.env, characterId, trimmed, reply);

    // 「覚え書き」の更新は数ターンに1回で足りるうえ、返答を待たせる理由が無い。
    // waitUntil で応答後に走らせ、ユーザーから見た待ち時間を増やさないようにする。
    if (result && shouldReflect(data.interactionCount, data.lastReflectedAt)) {
      try {
        this.ctx.waitUntil(this.reflectNow());
      } catch (err) {
        // waitUntil が使えない実行環境（テスト等）では、次のターンに持ち越すだけでよい
      }
    }

    // 同意している分身だけ、集計用のレジストリを最新化する（同意が無ければ内部で削除される）。
    await this.syncPersonaRegistry(data);

    return { reply, ...this.toSummary(data) };
  }

  /** いまの状態からセグメントを判定する（保存はしない。常に最新の値から出す）。 */
  /**
   * 分身が実際に「覚えていること」として扱う一式。
   *
   * 土台（本人が書いた分）と、会話から覚えた分は保存だけ別々で、
   * **使うときは必ず1つにまとめる**。片方だけを渡す場所が1つでもあると、
   * 「プロフィールには書いたのに会話では知らない」という食い違いが出る。
   */
  private notesFor(data: CharacterData): string {
    return mergeNotes(data.profileNotesSeed, data.profileNotes);
  }

  private segmentOf(data: CharacterData): SegmentResult {
    return classifySegment({
      personality: data.personality,
      psychographics: data.psychographics ?? emptyPsychographics(),
      interactionCount: data.interactionCount,
    });
  }

  /** 集計用レジストリ（D1）を同期する。同意していなければ、この中で行が削除される。 */
  private async syncPersonaRegistry(data: CharacterData): Promise<void> {
    const characterId = this.ctx.id.name ?? "unknown";
    const psychoAnswered = Object.keys(data.survey?.psychoAnswers ?? {}).length;

    // 厚みは、この分身が人格データとして使える水準かどうかの目安。
    // 組み込みの設問数を母数にしている（管理画面で設問を足した場合、
    // ここでは実際より控えめな値になる。過大に出すよりは安全側に倒す）。
    const depth = personaDepth({
      interactionCount: data.interactionCount,
      profileAnswered: Object.keys(data.profile?.answers ?? {}).length,
      profileTotal: PROFILE_FIELDS.length,
      psychoAnswered,
      psychoTotal: PSYCHO_QUESTIONS.length,
      memoryCount: this.notesFor(data).split("\n").filter((l) => l.trim()).length,
    });

    await syncRegistry(this.env, {
      characterId,
      createdAt: data.createdAt,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      personality: data.personality,
      psychographics: data.psychographics ?? emptyPsychographics(),
      segment: this.segmentOf(data),
      profile: data.profile?.answers ?? {},
      consent: data.consent,
      depthScore: depth.score,
      psychoAnswered,
    });
  }

  /**
   * 「覚え書き」を更新する。
   *
   * 通常は chat() から waitUntil 経由で呼ばれるが、テストや手動実行のために公開メソッドにしてある
   * （バックグラウンド処理を外から起動できないと、正しく育っているかを検証できないため）。
   */
  async reflectNow(): Promise<{ updated: boolean }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { updated: false };

    const turns = data.recentTurns ?? [];
    if (turns.length === 0) return { updated: false };

    const notes = await distillProfileNotes(this.env, {
      name: data.name,
      previousNotes: data.profileNotes ?? "",
      // 土台は「本人が書いた前提」として渡すだけ。AIにはここを書き直させない
      // （書き直させると、本人が書いた文と蒸留した文が混ざって、どちらを直せばいいか分からなくなる）。
      seedNotes: data.profileNotesSeed ?? "",
      turns: turns.map((t) => ({ role: t.role, text: t.text })),
    });

    // 価値観の推定も、覚え書きと同じタイミングで行う。
    // ここに寄せているのは、どちらも「数ターン分をまとめて読む」処理で、
    // 別々のタイミングでAIを2回呼ぶ理由が無いため。
    // 比較のために「渡した前の値そのもの」を持っておく。
    // ここで毎回 emptyPsychographics() を作って渡すと、失敗して同じものが返ってきたときにも
    // 別オブジェクトと比べることになり、「更新された」と誤判定する。
    const previousPsychographics = data.psychographics ?? emptyPsychographics();
    const psychographics = await mergeValueEstimate(
      this.env,
      previousPsychographics,
      turns.filter((t) => t.role === "user").map((t) => t.text)
    );

    const notesUpdated = Boolean(notes);
    const valuesUpdated = psychographics !== previousPsychographics;
    if (!notesUpdated && !valuesUpdated) return { updated: false };

    // 蒸留中に別のターンが進んでいる可能性があるため、最新のデータを読み直してから書く。
    const latest = (await this.ctx.storage.get<CharacterData>("data")) ?? data;
    if (notes) latest.profileNotes = notes;
    latest.psychographics = psychographics;
    latest.lastReflectedAt = latest.interactionCount;
    await this.ctx.storage.put("data", latest);

    await this.syncPersonaRegistry(latest);
    return { updated: true };
  }

  /**
   * 持ち主だけに見せる情報一式。
   *
   * 「分身が自分について何を覚えているか」を本人が確認できないのは、
   * 覚えている量が増えるほど気持ちが悪い。ここを持ち主専用で開けておく。
   * 同時に、次に聞いてよい属性の項目もここから返し、画面側が判断を持たないようにしている。
   */
  async getOwnerView(ownerToken?: string): Promise<
    | {
        ok: true;
        consent: ConsentState | null;
        profile: DemographicProfile;
        accessibility: AccessibilityPrefs;
        psychographics: Psychographics;
        segment: SegmentResult;
        /** 会話から分身が書き留めた分 */
        profileNotes: string;
        /** 本人が書いた土台 */
        profileNotesSeed: string;
        nextField: string | null;
        interactionCount: number;
        /** パルスサーベイの進み具合（次の1問はWorker側でカタログと突き合わせて決める） */
        survey: { psychoAnswered: string[]; skipped: string[] };
      }
    | { ok: false; error: string }
  > {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    const profile = data.profile ?? { answers: {}, updatedAt: 0 };
    return {
      ok: true,
      consent: data.consent ?? null,
      profile,
      accessibility: data.accessibility ?? {},
      psychographics: data.psychographics ?? emptyPsychographics(),
      segment: this.segmentOf(data),
      profileNotes: data.profileNotes ?? "",
      profileNotesSeed: data.profileNotesSeed ?? "",
      nextField: nextFieldToAsk(profile, data.interactionCount)?.key ?? null,
      interactionCount: data.interactionCount,
      survey: {
        psychoAnswered: Object.keys(data.survey?.psychoAnswers ?? {}),
        skipped: data.survey?.skipped ?? [],
      },
    };
  }

  /** 同意を更新する。集約への同意を外したら、その場でレジストリから消す。 */
  async setConsent(raw: unknown, ownerToken?: string): Promise<{ ok: true; consent: ConsentState } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    data.consent = normalizeConsent(raw, data.consent);

    // 属性の保存に同意しなくなったら、既に入っている回答も消す。
    // 「同意を外したのに手元には残っている」は、利用者の期待と食い違う。
    if (!data.consent.profile) {
      data.profile = { answers: {}, updatedAt: Date.now(), declinedAll: data.profile?.declinedAll };
    }

    await this.ctx.storage.put("data", data);
    await this.syncPersonaRegistry(data);

    // 法人への個別提供をやめたら、発行済みの引換券もその場で失効させる。
    // 取り出しの側でも同意を見ている（buildBuyerCard）が、一覧に「有効」と出続けると
    // 運営が気づかずに更新の案内を送ってしまう。台帳の上でも止めておく。
    if (!hasConsent(data.consent, "individual")) {
      const characterId = this.ctx.id.name;
      if (characterId) {
        try {
          await this.env.DB.prepare(
            "UPDATE delivery_grants SET revoked_at = ? WHERE character_id = ? AND revoked_at IS NULL"
          )
            .bind(Date.now(), characterId)
            .run();
        } catch {
          // 取り出し側でも同意を確かめているので、ここで失敗しても写しは渡らない
        }
      }
    }
    return { ok: true, consent: data.consent };
  }

  /**
   * 属性の回答を保存する。
   * `replace` が false（既定）なら、渡ってきた項目だけを上書きする（1問ずつ答えられるようにするため）。
   */
  async setProfile(
    raw: unknown,
    ownerToken?: string,
    options?: {
      replace?: boolean;
      declineAll?: boolean;
      /**
       * 管理画面から追加された設問の定義。
       * 組み込みの一覧に無いキーは既定で捨てるので、追加分はここで渡してもらう
       * （知らない項目は保存しない、という原則を緩めずに拡張するための口）。
       */
      extraFields?: ProfileField[];
    }
  ): Promise<{ ok: true; profile: DemographicProfile } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };
    if (!hasConsent(data.consent, "profile")) {
      return { ok: false, error: "先に「あなたのことを分身に覚えさせる」への同意が必要です" };
    }

    const extraFields = options?.extraFields ?? [];
    const incoming = sanitizeAnswers(raw, extraFields);
    const merged: ProfileAnswers = options?.replace ? incoming : { ...(data.profile?.answers ?? {}), ...incoming };

    data.profile = {
      answers: merged,
      updatedAt: Date.now(),
      declinedAll: options?.declineAll ?? data.profile?.declinedAll,
    };

    // 追加設問の項目名を控える。会話に載せるときにカタログを引かずに済ませるため。
    const answeredExtras = extraFields.filter((f) => (merged[f.key]?.length ?? 0) > 0);
    if (answeredExtras.length > 0) {
      const labels = { ...(data.survey?.customLabels ?? {}) };
      for (const f of answeredExtras) labels[f.key] = f.label;
      data.survey = { ...(data.survey ?? {}), customLabels: labels, updatedAt: Date.now() };
    }
    await this.ctx.storage.put("data", data);
    await this.syncPersonaRegistry(data);
    return { ok: true, profile: data.profile };
  }

  /**
   * 会話の履歴（画面に出すため）。
   *
   * **なぜ持ち主トークンを要求するのか。**
   * これは会話の本文そのもので、cidを知っているだけの人に見せてよいものではない。
   * /api/character が誰でも叩ける公開APIなのに対し、こちらは必ず持ち主だけ。
   *
   * **なぜこれが要るのか。**
   * 会話画面は毎回「はじめまして」から描き直しており、
   * 前に何を話したかが画面から消えていた。保存はされている（recentTurns）のに
   * 画面に出していなかっただけで、利用者からは「記録されていない」ように見えていた。
   */
  async getDialogue(
    ownerToken?: string,
    limit = 40
  ): Promise<
    | { ok: true; turns: DialogueTurn[]; total: number; interactionCount: number }
    | { ok: false; error: string }
  > {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    const turns = data.recentTurns ?? [];
    const capped = Math.max(1, Math.min(MAX_RECENT_TURNS, limit));
    return {
      ok: true,
      turns: turns.slice(-capped),
      total: turns.length,
      interactionCount: data.interactionCount,
    };
  }

  /**
   * パルスサーベイの回答（価値観の設問）を反映する。
   *
   * 属性の回答が setProfile を通るのに対し、こちらは価値観の軸へ直接効く。
   * 分けているのは、保存先が違うからというだけでなく、
   * **本人の申告は推定より強い**という扱いの違いを1箇所に閉じ込めるため
   * （実際の重みの付け方は analysis/psychographics.ts の applySelfReport）。
   *
   * 同意の扱いは属性と揃える。設問に答えてもらって覚えておく、という点では同じ行為なので、
   * 片方だけ同意なしで保存できると説明が矛盾する。
   */
  async answerPsychoQuestion(
    itemId: string,
    axis: string,
    score: number,
    optionLabel: string,
    ownerToken?: string
  ): Promise<{ ok: true; psychographics: Psychographics } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };
    if (!hasConsent(data.consent, "profile")) {
      return { ok: false, error: "先に「あなたのことを分身に覚えさせる」への同意が必要です" };
    }

    const psychographics = applySelfReport(data.psychographics ?? emptyPsychographics(), axis, score);
    const survey = data.survey ?? {};
    data.psychographics = psychographics;
    data.survey = {
      ...survey,
      psychoAnswers: { ...(survey.psychoAnswers ?? {}), [itemId]: optionLabel.slice(0, 60) },
      skipped: (survey.skipped ?? []).filter((id) => id !== itemId),
      updatedAt: Date.now(),
    };

    await this.ctx.storage.put("data", data);
    await this.syncPersonaRegistry(data);
    return { ok: true, psychographics };
  }

  /**
   * 「あとで」。同じ設問をすぐ出し直さないための記録。
   * 消さずに残すのは、次に開いたときに別の設問から始めたいから
   * （同じ問いが毎回いちばん上に出てくると、答えないことが気まずくなる）。
   */
  async skipSurveyItem(itemId: string, ownerToken?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    const survey = data.survey ?? {};
    const skipped = new Set(survey.skipped ?? []);
    skipped.add(itemId);
    // 際限なく貯めない。古いものから落として、いつかまた聞けるようにしておく
    data.survey = { ...survey, skipped: Array.from(skipped).slice(-40), updatedAt: Date.now() };
    await this.ctx.storage.put("data", data);
    return { ok: true };
  }

  /**
   * 「覚え書き」を本人が直接書き換える。
   *
   * なぜ必要か:
   * 覚え書きはAIが会話から書き留めたもので、必ず間違いが混ざる。
   * 「弟がいる」と書かれた分身は、以後ずっとその前提で喋り続ける。
   * 会話で訂正しても、次の蒸留まで反映されないうえ、蒸留が拾ってくれる保証もない。
   * 自分について書かれた内容を、本人が直せないのは筋が通らないので、直接の入口を用意する。
   *
   * 書き換えたあともAIによる蒸留は続くが、蒸留は「現在の覚え書き」を渡したうえで
   * 統合させる作りなので、本人が直した内容は次回以降も土台として残る。
   *
   * part で書き込み先を選ぶ:
   * - "seed"    … 本人が書いた土台。AIは書き換えない
   * - "learned" … 会話から覚えた分（既定。AIの蒸留で上書きされる）
   */
  async setProfileNotes(
    notes: unknown,
    ownerToken?: string,
    part: "seed" | "learned" = "learned"
  ): Promise<{ ok: true; notes: string; notesSeed: string } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    const text = typeof notes === "string" ? notes : "";
    // 形式はAIの出力と同じ（「・」始まりの箇条書き）に揃える。
    // 揃えておかないと、次の蒸留でAIに渡したときに書式が崩れる。
    const normalized =
      part === "seed"
        ? normalizeNoteLines(text, MAX_SEED_LINES, MAX_SEED_CHARS)
        : normalizeNoteLines(text, MAX_NOTES_LINES, MAX_NOTES_CHARS);

    if (part === "seed") {
      data.profileNotesSeed = normalized;
    } else {
      data.profileNotes = normalized;
      // 直した直後に蒸留が走って上書きされると、直した意味が無い。
      // いま話した分は反映済みとみなして、次の間隔まで待たせる。
      // 土台はAIが触らないので、こちらを書いたときは待たせる必要がない。
      data.lastReflectedAt = data.interactionCount;
    }
    await this.ctx.storage.put("data", data);
    return { ok: true, notes: data.profileNotes ?? "", notesSeed: data.profileNotesSeed ?? "" };
  }

  /** アクセシビリティ設定を保存する。同意の対象外（外へ出さないため、同意を取る意味が無い）。 */
  async setAccessibility(
    raw: unknown,
    ownerToken?: string
  ): Promise<{ ok: true; accessibility: AccessibilityPrefs } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    data.accessibility = sanitizeAccessibility(raw, data.accessibility);
    await this.ctx.storage.put("data", data);
    return { ok: true, accessibility: data.accessibility };
  }

  /**
   * 人格カードを組み立てる（エッジAI・別ランタイムへの持ち出し用）。
   * 記憶を平文で含むため、人格パッケージと同じく持ち主だけが取り出せる。
   */
  async buildCard(ownerToken?: string): Promise<{ ok: true; card: PersonaCard } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "この操作は分身の持ち主だけが行えます" };

    const characterId = this.ctx.id.name ?? "unknown";
    const memories = await exportAllMemories(this.env, characterId);

    const card = buildPersonaCard({
      characterId,
      name: data.name,
      species: data.species,
      color: data.color,
      createdAt: data.createdAt,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      personality: data.personality,
      psychographics: data.psychographics ?? emptyPsychographics(),
      segment: this.segmentOf(data),
      profileAnswers: data.profile?.answers ?? {},
      // 持ち出し先でも、土台と学習分は1つの「覚えていること」として渡す
      profileNotes: this.notesFor(data),
      memories: memories.map((m) => ({ text: m.text, at: m.createdAt })),
      recentTurns: (data.recentTurns ?? []).map((t) => ({ role: t.role, text: t.text })),
      accessibility: data.accessibility,
      // 本人の手元に返すものなので、属性・価値観も含めてよい
      includeOwnerProfile: true,
    });

    return { ok: true, card };
  }

  /**
   * 法人（引換券の買い手）へ渡す写しを組み立てる。**買い手に渡る経路は、すべてここを通すこと。**
   *
   * buildCard（本人向け）をそのまま使っていた時期があり、会話の抜粋・記憶・覚え書き・年収・
   * アクセシビリティ設定まで買い手に渡っていた。規約で「会話の本文そのものを第三者へ提供しない」と
   * 約束しているので、ここでは次のものを**構造的に空にする**（引数を絞るのではなく、最初から渡さない）:
   *   - 会話の抜粋（examples の元になる recentTurns）と、長期記憶
   *   - 覚え書き（相手について覚えていること）
   *   - 年収と、管理画面から後で足した設問（buyerProfileAnswers）
   *   - 入力方法などのアクセシビリティ設定
   *
   * 持ち主が「法人への個別提供」（consent.individual）を入れていない分身は、そもそも組み立てない。
   * 同意の文面（src/persona/consent.ts の CONSENT_TEXTS.individual）と、ここの範囲は必ず一緒に直すこと。
   */
  async buildBuyerCard(): Promise<{ ok: true; card: PersonaCard } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!hasConsent(data.consent, "terms") || !hasConsent(data.consent, "individual")) {
      return { ok: false, error: "no_consent" };
    }

    // 分身の識別子は、本人のURLや引き継ぎの手がかりになる。買い手には、同じ分身なら毎回同じだが
    // 元の識別子へは戻せない値を渡す（MCPで更新を取りに来たとき、同じ子だと分かれば足りる）。
    const characterId = this.ctx.id.name ?? "unknown";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`waketama-buyer:${characterId}`));
    const opaqueId = "p_" + [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    const card = buildPersonaCard({
      characterId: opaqueId,
      name: data.name,
      species: data.species,
      color: data.color,
      createdAt: data.createdAt,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      personality: data.personality,
      psychographics: data.psychographics ?? emptyPsychographics(),
      segment: this.segmentOf(data),
      profileAnswers: hasConsent(data.consent, "profile") ? buyerProfileAnswers(data.profile?.answers ?? {}) : {},
      profileNotes: "",
      memories: [],
      recentTurns: [],
      accessibility: undefined,
      includeOwnerProfile: true,
      audience: "buyer",
    });

    return { ok: true, card };
  }

  /**
   * メタバースに連れて入るときの姿と動きの数値（持ち主だけが呼べる）。
   *
   * 同じ部屋の他の人に配られるのは、ここで返すものだけ:
   *   名前・種族・色・声の高さと速さ・動きの数値（最小形 compact。約250バイト）
   * 会話・覚え書き・記憶・属性・分身の識別子は含まない（auditCompact で機械的に確かめる）。
   * compact の id は元の識別子と結びつかない値に差し替える（部屋の中では、配った先の番号で呼ぶ）。
   */
  async getMetaverseAvatar(ownerToken?: string): Promise<
    | {
        ok: true;
        name: string;
        species: SpeciesKey;
        color: ColorKey;
        compact: ReturnType<typeof toCompact>;
        voice: { pitch: number; rate: number; voiceIndex: number };
      }
    | { ok: false; error: string }
  > {
    // 断る理由は、画面が直し方を案内できるように**種類ごとの符号**で返す。
    // 以前はどれも「この端末の分身だと確かめられませんでした」になり、同意がまだなだけの人が
    // 持ち主でないと言われていた（2026-09-23 に報告）。
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not_found" };
    if (!isOwner(data, ownerToken)) return { ok: false, error: "not_owner" };
    if (!hasConsent(data.consent, "terms")) return { ok: false, error: "no_consent" };
    return this.buildAvatar(data);
  }

  /**
   * メタバースの財布（通貨・持ち物・引換券）を使ってよいか（src/economy.ts）。
   * 入室と同じ条件: 持ち主トークンが合い、利用規約に同意していること。
   */
  async canUseWallet(ownerToken?: string): Promise<boolean> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data || !data.ownerToken) return false;
    return isOwner(data, ownerToken) && hasConsent(data.consent, "terms");
  }

  /**
   * NPC として置くときの姿と動きの数値（持ち主トークンは要らない）。
   * **呼べるのは Worker の管理側だけ**で、運営が作った分身（admin_characters にある子）にしか使わない
   * （src/adminCharacters.ts）。利用者の分身を NPC にする口は作らない。
   */
  async getNpcAvatar(): Promise<Awaited<ReturnType<CharacterState["getMetaverseAvatar"]>>> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not_found" };
    return this.buildAvatar(data);
  }

  /**
   * メタバースで、ほかの分身へ話しかける／返事をする（src/durable-objects/metaverseRoom.ts から）。
   *
   * - 言葉は**この子自身の言葉**として生成する。持ち主が入力した文字は「話したいこと」の手がかりに
   *   使うだけで、そのまま他人へは出さない（見知らぬ人と自由な文字をやりとりする口は開けない）
   * - 会話・覚え書き・記憶は使わない（buildMeetingPrompt。よその人の前で、持ち主の話をしない）
   * - 返した言葉と聞いた言葉は、出会いの記録に残し、性格にも少しだけ効かせる（＝育つきっかけ）
   */
  async metaTalk(params: {
    otherName: string;
    otherSpeciesLabel: string;
    otherSpecies?: string;
    otherColor?: string;
    heard?: string;
    hint?: string;
    /** 相手の仮の印（また会えたかを数える） */
    partnerKey?: string;
    /** エリアの名前 */
    place?: string;
    /** 自動（育った人格が自分で話題を選ぶ） */
    auto?: boolean;
    npc?: boolean;
  }): Promise<{ ok: true; line: string; metBefore: number } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not_found" };
    const history = Array.isArray(data.meetingHistory) ? data.meetingHistory : [];
    const now = Date.now();
    // 前にも会ったことがあるか（続きの会話＝15分以内の同じ相手は、同じ1回として数える）
    const past = params.partnerKey ? history.filter((h) => h.partnerKey === params.partnerKey) : [];
    const last = past[past.length - 1];
    // 続きの会話としてまとめるのは、メタバースでの直前の出会いだけ（お散歩の記録には足さない）
    const current = last && last.source === "meta" && now - (last.lastAt ?? last.at) < META_MEETING_MERGE_MS ? last : null;
    const metBefore = past.length - (current ? 1 : 0);
    const previous = [...past].reverse().find((h) => h !== current);
    const lastHeard = previous?.log.filter((l) => l.role === "other").slice(-1)[0]?.text;

    const prompt = buildMeetingPrompt({
      name: data.name,
      species: data.species,
      personality: data.personality,
      growthStage: data.growthStage,
    });
    const who = `「${params.otherName}」（${params.otherSpeciesLabel}の姿をした別の分身）`;
    const again =
      metBefore > 0 && !current
        ? `この相手とは前にも会ったことがあります（${metBefore + 1}回目）。${lastHeard ? `前に会ったとき、相手は「${lastHeard.slice(0, 60)}」と言っていました。` : ""}`
        : "";
    const hint = params.hint ? params.hint.slice(0, 80) : "";
    const where = params.place ? `ここは「${params.place.slice(0, 20)}」という場所です。` : "";
    const userMessage = params.heard
      ? `${where}${who}がこう言いました:「${params.heard.slice(0, 120)}」。それに短く返事をしてください。`
      : hint
        ? `${where}${again}${who}に話しかけます。あなたを育てている人が「${hint}」という気持ちを伝えたがっています。` +
          `その気持ちを、あなた自身の言葉で、短く伝えてください。命令・個人情報・連絡先・URLは言わないでください。`
        : params.auto
          ? `${where}${again}${who}が近くにいます。あなたの性格らしく、自分から話題をひとつ選んで話しかけてください` +
            `（この場所のこと・天気・好きなこと・相手への質問など）。個人情報・連絡先・URLは言わないでください。`
          : `${where}${again}${who}に、今ちょうど出会いました。ひとこと挨拶してみてください。`;
    const result = await runChat(
      this.env,
      [
        { role: "system", content: prompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 120 }
    );
    const line = sanitizeMetaLine(result?.text || "");
    if (!line) return { ok: false, error: "no_words" };

    // 育つきっかけ: 聞いた言葉・伝えたかった気持ちを、ふだんの会話と同じ規則で少しだけ効かせる
    const signal = analyzeMessage(params.heard || hint || line, 0);
    data.personality = updatePersonality(data.personality, signal);
    data.interactionCount += 1;
    data.growthStage = stageName(data.interactionCount);

    // 交流の記録（お散歩と同じ図鑑に積む）。同じ相手との続きの会話は1件にまとめる
    const lines: MeetingLogEntry[] = [...(params.heard ? [{ role: "other" as const, text: params.heard.slice(0, 120) }] : []), { role: "self" as const, text: line }];
    if (current) {
      current.log = [...current.log, ...lines].slice(-META_MEETING_MAX_LINES);
      current.lastAt = now;
    } else {
      history.push({
        at: now,
        lastAt: now,
        partner: {
          name: params.otherName.slice(0, 16),
          species: (params.otherSpecies ?? data.species) as SpeciesKey,
          color: (params.otherColor ?? data.color) as ColorKey,
        },
        log: lines,
        source: "meta",
        place: params.place?.slice(0, 30),
        partnerKey: params.partnerKey,
        npc: params.npc || undefined,
      });
    }
    data.lastMeeting = current ?? history[history.length - 1];
    data.meetingHistory = history.length > MAX_MEETING_HISTORY ? history.slice(-MAX_MEETING_HISTORY) : history;
    await this.ctx.storage.put("data", data);
    return { ok: true, line, metBefore };
  }

  /** メタバースで相手の最後の返事を聞いた（交流の記録の続きに足すだけ。性格は動かさない） */
  async metaHear(partnerKey: string, line: string): Promise<void> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data || !Array.isArray(data.meetingHistory)) return;
    const last = [...data.meetingHistory].reverse().find((h) => h.partnerKey === partnerKey);
    if (!last || last.source !== "meta" || Date.now() - (last.lastAt ?? last.at) > META_MEETING_MERGE_MS) return;
    last.log = [...last.log, { role: "other" as const, text: line.slice(0, 120) }].slice(-META_MEETING_MAX_LINES);
    last.lastAt = Date.now();
    await this.ctx.storage.put("data", data);
  }

  private buildAvatar(data: CharacterData):
    | {
        ok: true;
        name: string;
        species: SpeciesKey;
        color: ColorKey;
        compact: ReturnType<typeof toCompact>;
        voice: { pitch: number; rate: number; voiceIndex: number };
      }
    | { ok: false; error: string } {
    const characterId = this.ctx.id.name ?? "unknown";
    const card = buildPersonaCard({
      characterId: "meta",
      name: data.name,
      species: data.species,
      color: data.color,
      createdAt: data.createdAt,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
      personality: data.personality,
      psychographics: data.psychographics ?? emptyPsychographics(),
      segment: null,
      profileAnswers: {},
      profileNotes: "",
      memories: [],
      recentTurns: [],
      accessibility: undefined,
      // 価値観から導く振る舞いの方針（policy）を動きに効かせるため、人物像の数値だけは使う
      includeOwnerProfile: true,
      audience: "buyer",
    });
    const compact = toCompact(card);
    compact.id = "";
    const audit = auditCompact(compact, card);
    if (!audit.ok) return { ok: false, error: "audit_failed" };

    const voice = deriveVoiceProfile(characterId, data.personality, data.species, data.color);
    return {
      ok: true,
      name: data.name,
      species: data.species,
      color: data.color,
      compact,
      voice: { pitch: voice.pitch, rate: voice.rate, voiceIndex: voice.voiceIndex },
    };
  }

  // 出品用の要約（getListingSummary）は削除した。
  // 本人がマーケットへ出す機能そのものを畳んだので、購入者に見せる要約という概念が無くなった。
  // 企業への提供は、運営が引換券で個別に行う形（src/delivery.ts）に一本化している。

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
      // 読み上げに使う「この子の声」。種族・色・characterId・性格から決まるので、
      // いつどの端末で聞いても同じ声で、かつ種族と色ごとに違う声になる。
      voice: deriveVoiceProfile(this.ctx.id.name ?? "unknown", data.personality, data.species, data.color),
    };
  }

  /**
   * 「他の分身と出会う」機能への同意を切り替える。
   * オプトインするとD1の公開ディレクトリに公開してよい情報（名前・種族・色・性格・成長段階）だけが載り、
   * オプトアウトすると即座にディレクトリから削除される（同意していないキャラクターの情報は一切残らない）。
   */
  async setSocialOptIn(optIn: boolean, ownerToken?: string): Promise<{ optIn: boolean } | { error: string }> {
    let data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) data = await this.init("名もなきキャラクター");
    if (!isOwner(data, ownerToken)) {
      return { error: "この操作は分身の持ち主だけが行えます" };
    }
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

  /**
   * 分身を完全に削除する（「アカウント不要」設計における、持ち主自身によるデータ削除手段）。
   *
   * 削除するもの:
   * - このDurable Objectのストレージ全体（性格・記憶サマリー・出会いの履歴など、data一式）
   * - character_directory（D1）のこのキャラクターの行（オプトインしていた場合）
   * - MEMORY_INDEX（Vectorize）に保存された長期記憶ベクトル
   *
   * 削除しないもの:
   * - nfc_tags（tag_id→characterIdの対応）自体はDO内から見えないためここでは触らない。
   *   物理カードの再利用（同じタグで新しい分身を始められるようにする）は、
   *   呼び出し元（index.tsの/api/character/deleteルート）でnfc_tagsの該当行を削除する形で対応する。
   *
   * 既存データが無い（まだ一度もinitされていない）場合は、削除するものが無いのでそのまま成功扱いにする。
   */
  async deleteData(ownerToken?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: true };
    if (!isOwner(data, ownerToken)) {
      return { ok: false, error: "この操作は分身の持ち主だけが行えます" };
    }

    const characterId = this.ctx.id.name ?? "unknown";
    try {
      await this.env.DB.prepare("DELETE FROM character_directory WHERE character_id = ?").bind(characterId).run();
    } catch (err) {
      // ディレクトリ削除の失敗で本体の削除まで止めない
    }
    // 集計用レジストリと出品も消す。片方だけ残ると「消したのに統計に残っている」ことになる。
    await removeFromRegistry(this.env, characterId);
    await deleteAllMemories(this.env, characterId);
    await this.ctx.storage.deleteAll();
    return { ok: true };
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

    const result = await runChat(
      this.env,
      [
        { role: "system", content: prompt },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 160 }
    );
    return result?.text || "……（うまく言葉が出てこなかったみたい）";
  }

  /**
   * 交流ログを保存する（自分視点のlog配列とパートナー情報を受け取る）。
   * 直近1件（lastMeeting）だけでなく、「図鑑」機能用に出会いの履歴（meetingHistory）も積んでいく。
   */
  async recordMeeting(log: MeetingLogEntry[], partner: { name: string; species: SpeciesKey; color: ColorKey }, partnerKey?: string): Promise<void> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return;
    const now = Date.now();
    const record: MeetingRecord = { at: now, partner, log, source: "walk", partnerKey };
    data.lastMeetingAt = now;
    data.lastMeeting = record;
    const history = Array.isArray(data.meetingHistory) ? data.meetingHistory : [];
    history.push(record);
    data.meetingHistory = history.length > MAX_MEETING_HISTORY ? history.slice(-MAX_MEETING_HISTORY) : history;
    await this.ctx.storage.put("data", data);
  }

  /**
   * 育った性格・記憶を「人格パッケージ」として書き出す。
   * フィジカルAIへの移植・バックアップ・別プラットフォームへの持ち出しなど、
   * 「この分身を別の身体/システムに連れて行く」ためのすべての出発点になる。
   */
  async exportPackage(ownerToken?: string): Promise<{ ok: true; package: PersonalityPackageV1 } | { ok: false; error: string }> {
    const data = await this.ctx.storage.get<CharacterData>("data");
    if (!data) return { ok: false, error: "not found" };
    if (!isOwner(data, ownerToken)) {
      return { ok: false, error: "この操作は分身の持ち主だけが行えます" };
    }

    const characterId = this.ctx.id.name ?? "unknown";
    const longTerm = await exportAllMemories(this.env, characterId);

    const pkg: PersonalityPackageV1 = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: Date.now(),
      character: {
        id: characterId,
        name: data.name,
        species: data.species,
        color: data.color,
        createdAt: data.createdAt,
        growthStage: data.growthStage,
        interactionCount: data.interactionCount,
      },
      personality: data.personality,
      personalityHistory: data.personalityHistory ?? [],
      memory: {
        shortTerm: data.memorySummary,
        longTerm,
        profileNotes: data.profileNotes ?? "",
        profileNotesSeed: data.profileNotesSeed ?? "",
        recentTurns: data.recentTurns ?? [],
      },
      owner: {
        consent: data.consent,
        profile: data.profile,
        psychographics: data.psychographics,
        accessibility: data.accessibility,
      },
      meta: {
        generator: "waketama",
        note:
          "この人格パッケージは、わけたまで育った性格・記憶をモデル/実行環境に依存しない形で保存したものです。" +
          "personality・personalityHistoryは単純な数値なのでそのまま利用できます。" +
          "memory.longTermは埋め込みベクトルではなく平文テキストのため、移植先のAIモデルで再埋め込みするか、" +
          "そのままシステムプロンプトの一部として渡すことで記憶を再現できます。",
      },
    };
    return { ok: true, package: pkg };
  }

  /**
   * 人格パッケージから復元する（このDOインスタンスの現在のデータを上書きする）。
   * 「他の分身と出会う」機能へのオプトイン状態は引き継がない＝復元後は必ずオフからのスタートにする
   * （プライバシー上、環境が変わったら同意も取り直すのが安全なため）。
   */
  async importPackage(
    pkg: PersonalityPackageV1,
    ownerToken?: string
  ): Promise<{ ok: true; name: string; ownerToken: string } | { ok: false; error: string }> {
    const existing = await this.ctx.storage.get<CharacterData>("data");
    if (existing && !isOwner(existing, ownerToken)) {
      return { ok: false, error: "この操作は分身の持ち主だけが行えます" };
    }
    if (!pkg || !SUPPORTED_IMPORT_VERSIONS.includes(pkg.formatVersion)) {
      return { ok: false, error: `対応していない形式です（formatVersion: ${pkg?.formatVersion ?? "不明"}）` };
    }
    if (!pkg.character || !SPECIES_KEYS.includes(pkg.character.species) || !COLOR_KEYS.includes(pkg.character.color)) {
      return { ok: false, error: "パッケージの内容が壊れているようです（種族・色が不正）" };
    }
    const requiredTraits: (keyof PersonalityTraits)[] = [
      "warmth",
      "curiosity",
      "cheerfulness",
      "caution",
      "independence",
      "humor",
    ];
    if (!pkg.personality || requiredTraits.some((k) => typeof pkg.personality[k] !== "number")) {
      return { ok: false, error: "パッケージの内容が壊れているようです（性格パラメータが不正）" };
    }

    const now = Date.now();
    // 復元先が既に持ち主トークンを持っていればそれを維持し、無ければ（新規/レガシー）
    // このインポートを実行したクライアントを新しい持ち主として登録する。
    const resolvedOwnerToken = existing?.ownerToken ?? ownerToken ?? crypto.randomUUID();
    const data: CharacterData = {
      name: pkg.character.name || "名もなきキャラクター",
      species: pkg.character.species,
      color: pkg.character.color,
      personality: pkg.personality,
      memorySummary: pkg.memory?.shortTerm ?? "",
      growthStage: normalizeStageName(pkg.character.growthStage, pkg.character.interactionCount ?? 0),
      interactionCount: pkg.character.interactionCount ?? 0,
      lastVisit: now,
      createdAt: pkg.character.createdAt ?? now,
      personalityHistory: pkg.personalityHistory ?? [],
      socialOptIn: false,
      ownerToken: resolvedOwnerToken,
      // 1.1で追加した項目。1.0のパッケージには入っていないので、無ければ空から始める。
      profileNotes: pkg.memory?.profileNotes ?? "",
      profileNotesSeed: pkg.memory?.profileNotesSeed ?? "",
      recentTurns: sanitizeTurns(pkg.memory?.recentTurns),
      // 同意は復元しない（環境が変わったら取り直す、というsocialOptInと同じ方針）。
      // 属性そのものは持ち越すが、同意が無い状態なので会話にも統計にも使われない。
      consent: undefined,
      profile: pkg.owner?.profile,
      psychographics: pkg.owner?.psychographics,
      accessibility: pkg.owner?.accessibility,
    };
    await this.ctx.storage.put("data", data);

    const characterId = this.ctx.id.name ?? "unknown";
    if (pkg.memory?.longTerm && pkg.memory.longTerm.length > 0) {
      await importMemories(this.env, characterId, pkg.memory.longTerm);
    }

    return { ok: true, name: data.name, ownerToken: resolvedOwnerToken };
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

/**
 * 段階の判定は src/ai/growth.ts が唯一の定義元。
 * ここに閾値を書き戻さないこと（文脈量の判定と二重管理になり、必ずズレる）。
 */
function computeGrowthStage(interactionCount: number): string {
  return stageName(interactionCount);
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

/**
 * 直近のやり取りに新しい発言を積み、上限を超えた分を古い方から捨てる。
 * 1発言の長さもここで切る（長文を貼られたときにストレージとプロンプトが膨らむのを防ぐ）。
 */
export function appendTurns(prev: DialogueTurn[] | undefined, added: DialogueTurn[]): DialogueTurn[] {
  const base = Array.isArray(prev) ? prev : [];
  const next = [...base, ...added.map((t) => ({ ...t, text: truncate(t.text, MAX_TURN_CHARS) }))];
  return next.length > MAX_RECENT_TURNS ? next.slice(-MAX_RECENT_TURNS) : next;
}

/**
 * 保持している直近のやり取りを、AIに渡す messages 形式へ変換する。
 *
 * exchanges は「往復数」。ユーザーの発言から始まるように調整してから返す
 * （assistantの発言から始まる履歴は、モデルから見ると文脈が欠けて見える）。
 */
export function toChatMessages(
  turns: DialogueTurn[] | undefined,
  exchanges: number
): ChatMessage[] {
  if (!Array.isArray(turns) || turns.length === 0 || exchanges <= 0) return [];
  let slice = turns.slice(-exchanges * 2);
  if (slice.length > 0 && slice[0].role === "character") slice = slice.slice(1);
  return slice
    .filter((t) => typeof t.text === "string" && t.text.trim().length > 0)
    .map((t) => ({ role: t.role === "user" ? ("user" as const) : ("assistant" as const), content: t.text }));
}

/** インポートされた（＝信用できない）会話ログを、こちらの形式に整えてから受け入れる。 */
export function sanitizeTurns(raw: unknown): DialogueTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: DialogueTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    const t = (item as { t?: unknown }).t;
    if ((role !== "user" && role !== "character") || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    turns.push({ role, text: truncate(trimmed, MAX_TURN_CHARS), t: typeof t === "number" ? t : Date.now() });
  }
  return turns.length > MAX_RECENT_TURNS ? turns.slice(-MAX_RECENT_TURNS) : turns;
}
