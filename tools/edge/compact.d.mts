/**
 * compact.mjs の型。
 *
 * 実装をJSのままにしてあるのは、**機器側と同じファイルをそのまま読ませたい**ため。
 * ここでビルドが要る形にすると、「サーバで作ったもの」と「機器に載せたもの」が
 * 別のコードになりうる。1つの実装をWorkerからも、CLIからも、テストからも呼ぶ。
 */

export declare const TRAIT_ORDER: readonly string[];
export declare const COMPACT_VERSION: 1;

export interface CompactPersona {
  v: 1;
  id: string;
  n: string;
  /** energy, gestureRate, idleVariance, responseDelayMs, gazeHoldMs, postureOpenness */
  m: number[];
  /** comfortableDistanceM, approachSpeedMps */
  p: number[];
  /** baselineSmile, blinkRatePerMin */
  e: number[];
  /** 性格6軸（TRAIT_ORDER の順） */
  t: number[];
  /** 振る舞いの方針の識別子 */
  c: string[];
}

export interface CompactAudit {
  ok: boolean;
  bytes: number;
  leaks: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function toCompact(card: any, options?: { maxPolicies?: number }): CompactPersona;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function toCompactJson(card: any, options?: { maxPolicies?: number }): string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function auditCompact(compact: CompactPersona, card: any): CompactAudit;
