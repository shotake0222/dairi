/**
 * AI呼び出しの回数制限。
 *
 * なぜ作り直したか:
 * 元々の連投ガードは `lastMessageAt` を**ストレージに書く**ことで実現していた。
 * ところが「その場限りモード」は何も書かないのが売りなので、その方式では制限が効かない。
 * また、1.2秒間隔のガードだけでは「1人が延々と話し続ける」コストを止められず、
 * Workers AIは呼ぶたびに課金されるため、公開前にここを塞いでおく必要がある。
 *
 * 方式:
 * Durable Objectの**インスタンスメモリ**（ストレージではない）にカウンタを持つ。
 * - 1キャラクター = 1 Durable Object なので、どのコロケーションから来ても同じ場所で数えられる
 * - ストレージに書かないので「その場限り」の約束を破らない
 * - DOが退避されるとカウンタは消えるが、それは「しばらく使われていない」ということなので
 *   制限がリセットされても実害はない（悪用の連続アクセス中はDOが生き続けるため効き続ける）
 */

/** 制限の設定。テストから短い値を渡せるように引数化してある。 */
export interface RateLimitConfig {
  /** 連投ガード: 前回からこの間隔を空ける（ミリ秒） */
  minIntervalMs: number;
  /** 1分あたりの上限回数 */
  perMinute: number;
  /** 1日あたりの上限回数 */
  perDay: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  minIntervalMs: 1200,
  // 人が会話する速度としては十分で、機械的な連打は止まる水準にしてある。
  perMinute: 20,
  // 1日あたりのAIコストの上限。実運用の数字を見ながら調整する前提の暫定値。
  perDay: 300,
};

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "too_fast" | "per_minute" | "per_day"; message: string; retryAfterMs: number };

interface Window {
  startedAt: number;
  count: number;
}

/**
 * 使い方に応じた上限判定。呼ぶたびに1回分を消費する（判定と記録が同時）。
 * 上限に当たったときの文言は、世界観を壊さないようキャラクター側の言い方にしてある。
 */
export class RateLimiter {
  private lastAt = 0;
  private minute: Window = { startedAt: 0, count: 0 };
  private day: Window = { startedAt: 0, count: 0 };

  constructor(private readonly config: RateLimitConfig = DEFAULT_RATE_LIMIT) {}

  check(now: number = Date.now()): RateLimitResult {
    if (this.lastAt && now - this.lastAt < this.config.minIntervalMs) {
      return {
        allowed: false,
        reason: "too_fast",
        message: "ちょっと待って、少し間を空けてから話しかけてね",
        retryAfterMs: this.config.minIntervalMs - (now - this.lastAt),
      };
    }

    const minute = this.roll(this.minute, now, 60_000);
    if (minute.count >= this.config.perMinute) {
      return {
        allowed: false,
        reason: "per_minute",
        message: "ちょっと喋りすぎて息切れしてきた……少し休ませて",
        retryAfterMs: minute.startedAt + 60_000 - now,
      };
    }

    const day = this.roll(this.day, now, 24 * 60 * 60_000);
    if (day.count >= this.config.perDay) {
      return {
        allowed: false,
        reason: "per_day",
        message: "今日はたくさん話したから、少し眠くなってきた……また明日ね",
        retryAfterMs: day.startedAt + 24 * 60 * 60_000 - now,
      };
    }

    this.lastAt = now;
    minute.count += 1;
    day.count += 1;
    return { allowed: true };
  }

  /** 期限切れならウィンドウを開き直す。 */
  private roll(window: Window, now: number, spanMs: number): Window {
    if (!window.startedAt || now - window.startedAt >= spanMs) {
      window.startedAt = now;
      window.count = 0;
    }
    return window;
  }

  /** 現在の消費状況（/api/health やデバッグ用）。 */
  snapshot(now: number = Date.now()): { perMinute: number; perDay: number } {
    const minuteActive = this.minute.startedAt && now - this.minute.startedAt < 60_000;
    const dayActive = this.day.startedAt && now - this.day.startedAt < 24 * 60 * 60_000;
    return {
      perMinute: minuteActive ? this.minute.count : 0,
      perDay: dayActive ? this.day.count : 0,
    };
  }
}
