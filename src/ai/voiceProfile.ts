/**
 * 分身ごとの「固有の声」。
 *
 * 狙い:
 * これまで読み上げの声は端末の既定の声そのままで、どの分身も同じ声で喋っていた。
 * 「かざして話す」のように声が主役になるモードでは、それだと分身の個体差が消えてしまう。
 * ここでは **タグID（＝characterId）から決まる不変の声質** と、
 * **性格によって変化する話し方（速さ・抑揚）** の2階建てで声を決める。
 *
 * 設計上の要点:
 * - 声質は characterId のハッシュから決まるので、いつ・どの端末で開いても同じ声になる。
 *   1つのNFCタグ = 1体の分身 = 1つの声、という対応が崩れない。
 * - 性格は会話で変わるので、話す速さや抑揚は育つにつれて少しずつ変化する。
 *   「声そのものは変わらないが、喋り方は育つ」というのが自然だと考えた。
 * - 保存はしない（characterIdと性格から毎回導出できる）。データを増やさずに済み、
 *   既存の分身にも移行作業なしで声が割り当たる。
 */

import { PersonalityTraits } from "./personality";

export interface VoiceProfile {
  /** 声の高さ。SpeechSynthesisUtterance.pitch にそのまま渡せる範囲（0.7〜1.5）。 */
  pitch: number;
  /** 話す速さ。SpeechSynthesisUtterance.rate にそのまま渡せる範囲（0.8〜1.3）。 */
  rate: number;
  /** 端末に複数の日本語音声があるとき、何番目を選ぶか（安定して同じ声になるようにするための番号）。 */
  voiceIndex: number;
  /** 画面に出す説明（「この子の声」を言葉で示すため）。 */
  label: string;
}

/** 文字列から安定した32bitの数値を作る（FNV-1a）。端末やランタイムに依存せず同じ値になる。 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const TIMBRE_LABELS = ["高くて澄んだ声", "やわらかい声", "落ち着いた声", "低めの穏やかな声"];

/**
 * その分身の声を導く。
 *
 * @param seed 分身の識別子（characterId）。同じ値なら常に同じ声質になる。
 * @param personality 現在の性格。話し方（速さ・抑揚）にだけ効く。
 */
export function deriveVoiceProfile(seed: string, personality?: Partial<PersonalityTraits>): VoiceProfile {
  const h = hash32(seed || "waketama");

  // 声質（4段階）。characterIdだけで決まるので、性格がどう育っても変わらない。
  const timbre = h % TIMBRE_LABELS.length;
  const basePitch = [1.28, 1.12, 0.98, 0.86][timbre];
  // 同じ声質の中でも個体差が出るよう、細かいゆらぎを足す（±0.06）。
  const jitter = (((h >>> 8) % 100) / 100 - 0.5) * 0.12;

  const p = personality || {};
  const warmth = p.warmth ?? 50;
  const cheerfulness = p.cheerfulness ?? 50;
  const caution = p.caution ?? 50;

  // 陽気なほど速く、慎重なほどゆっくり話す。
  const rate = clamp(1.0 + (cheerfulness - 50) / 220 - (caution - 50) / 260, 0.8, 1.3);
  // 温かいほど、ほんの少しだけ声が明るくなる（抑揚の代わりに高さで表現している）。
  const pitch = clamp(basePitch + jitter + (warmth - 50) / 420, 0.7, 1.5);

  const speedLabel = rate >= 1.08 ? "少し早口" : rate <= 0.94 ? "ゆっくりめ" : "自然な速さ";

  return {
    pitch: Math.round(pitch * 100) / 100,
    rate: Math.round(rate * 100) / 100,
    voiceIndex: (h >>> 16) % 4,
    label: `${TIMBRE_LABELS[timbre]}・${speedLabel}`,
  };
}
