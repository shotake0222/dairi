/**
 * アクセシビリティ設定。
 *
 * **この情報は、集約統計にもマーケットにも絶対に載せない。**
 * 「視線で入力している」「滞留時間を長くしている」といった設定は、
 * 事実上その人の身体の状態を示してしまう。日本の個人情報保護法でいう要配慮個人情報に
 * 直結しうる情報なので、同意の有無に関わらず、こちらから外に出す経路を作らない。
 *
 * そのため、属性情報（src/persona/profile.ts）とは型もフィールドも分けてある。
 * 集約処理は profile だけを見に行き、ここには触れない。
 * 人格パッケージの書き出しには含める（本人の手元に戻すのは問題なく、
 * 機種変更したときに設定をやり直さずに済む方が助かるため）。
 */

export type InputMode = "text" | "voice" | "gaze" | "switch";

export interface AccessibilityPrefs {
  /** 主に使う入力方法 */
  inputMode?: InputMode;
  /** 視線・スイッチ入力での決定までの滞留時間（ミリ秒） */
  dwellMs?: number;
  /** 文字の大きさの倍率 */
  fontScale?: number;
  /** 高コントラスト表示 */
  highContrast?: boolean;
  /** アニメーションを減らす */
  reduceMotion?: boolean;
  /** 読み上げを既定でオンにする */
  autoSpeak?: boolean;
  updatedAt?: number;
}

const INPUT_MODES: InputMode[] = ["text", "voice", "gaze", "switch"];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function sanitizeAccessibility(raw: unknown, previous?: AccessibilityPrefs): AccessibilityPrefs {
  const input = (raw ?? {}) as Record<string, unknown>;
  const next: AccessibilityPrefs = { ...(previous ?? {}) };

  if (typeof input.inputMode === "string" && INPUT_MODES.includes(input.inputMode as InputMode)) {
    next.inputMode = input.inputMode as InputMode;
  }
  if (typeof input.dwellMs === "number" && Number.isFinite(input.dwellMs)) {
    // 短すぎると誤選択が止まらなくなり、長すぎると1文字打つのに疲れてしまう
    next.dwellMs = Math.round(clamp(input.dwellMs, 300, 4000));
  }
  if (typeof input.fontScale === "number" && Number.isFinite(input.fontScale)) {
    next.fontScale = Math.round(clamp(input.fontScale, 0.8, 2.5) * 100) / 100;
  }
  if (typeof input.highContrast === "boolean") next.highContrast = input.highContrast;
  if (typeof input.reduceMotion === "boolean") next.reduceMotion = input.reduceMotion;
  if (typeof input.autoSpeak === "boolean") next.autoSpeak = input.autoSpeak;

  next.updatedAt = Date.now();
  return next;
}
