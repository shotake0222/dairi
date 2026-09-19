/**
 * 分身ごとの「固有の声」。
 *
 * 狙い:
 * これまで読み上げの声は端末の既定の声そのままで、どの分身も同じ声で喋っていた。
 * 「かざして話す」のように声が主役になるモードでは、それだと分身の個体差が消えてしまう。
 *
 * **3階建てで決める。**
 *   1. 種族  … 声の家系。ぷにころは高くて弾む、つのまるは低めで落ち着く、といった大枠
 *   2. 色    … 同じ種族の中での枝分かれ。ここで30通り（5種族 × 6色）に分かれる
 *   3. 個体  … characterId のハッシュによる細かいゆらぎ。同じ種族・同じ色でも同じ声にならない
 * さらに、性格によって**話し方**（速さ）が育つにつれて変わる。
 *
 * 設計上の要点:
 * - 声質は種族・色・characterId から決まるので、いつ・どの端末で開いても同じ声になる。
 *   1つの依代 = 1体の分身 = 1つの声、という対応が崩れない。
 * - **全体に高め・軽めへ寄せてある。** このサービスの分身は手のひらサイズの生き物なので、
 *   落ち着いた大人の声だと見た目と食い違う。低い側でも 1.18 までしか下げていない。
 * - 保存はしない（種族・色・characterId・性格から毎回導出できる）。
 *   データを増やさずに済み、既存の分身にも移行作業なしで声が割り当たる。
 */

import { PersonalityTraits } from "./personality";

export interface VoiceProfile {
  /** 声の高さ。SpeechSynthesisUtterance.pitch にそのまま渡せる範囲（0.7〜2.0）。 */
  pitch: number;
  /** 話す速さ。SpeechSynthesisUtterance.rate にそのまま渡せる範囲（0.8〜1.4）。 */
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

/**
 * 種族ごとの声の家系。
 *
 * pitch は「高さ」、rate は「速さの癖」、voiceBias は端末の音声一覧から選ぶ位置の偏り。
 * **下限を 1.18 にしてある**のは、見た目が小さくて丸い生き物なので、
 * 低い声だと姿と声が食い違って気持ち悪くなるため。
 */
const SPECIES_VOICE: Record<string, { pitch: number; rate: number; voiceBias: number; label: string }> = {
  punikoro: { pitch: 1.62, rate: 1.06, voiceBias: 0, label: "ぷにぷに弾む声" },
  mofukuru: { pitch: 1.34, rate: 0.96, voiceBias: 1, label: "もふもふした甘い声" },
  tsunomaru: { pitch: 1.22, rate: 1.02, voiceBias: 2, label: "つんとした元気な声" },
  howahowa: { pitch: 1.48, rate: 0.92, voiceBias: 3, label: "ふわふわした柔らかい声" },
  kiratsubu: { pitch: 1.74, rate: 1.12, voiceBias: 0, label: "きらきら澄んだ声" },
};

const DEFAULT_SPECIES_VOICE = { pitch: 1.44, rate: 1.0, voiceBias: 0, label: "やわらかい声" };

/**
 * 色ごとの枝分かれ。
 *
 * 同じ種族でも色が違えば違う子なので、聞き分けられる程度には差を付ける。
 * ただし**家系が分からなくなるほど動かさない**（±0.16まで）。
 * 色から受ける印象に素直に寄せている——sun は明るく速く、lavender は静かでゆっくり。
 */
const COLOR_VOICE: Record<string, { pitch: number; rate: number; label: string }> = {
  coral:    { pitch:  0.06, rate:  0.03, label: "あたたかい" },
  sky:      { pitch:  0.10, rate:  0.01, label: "すきとおった" },
  leaf:     { pitch: -0.06, rate: -0.02, label: "おだやかな" },
  sun:      { pitch:  0.14, rate:  0.06, label: "はずんだ" },
  lavender: { pitch: -0.12, rate: -0.05, label: "しずかな" },
  peach:    { pitch:  0.16, rate: -0.01, label: "あまえた" },
};

/**
 * その分身の声を導く。
 *
 * @param seed 分身の識別子（characterId）。同じ値なら常に同じ個体差になる。
 * @param personality 現在の性格。話し方（速さ）にだけ効く。
 * @param species 種族。声の家系を決める
 * @param color 色。家系の中の枝分かれを決める
 */
export function deriveVoiceProfile(
  seed: string,
  personality?: Partial<PersonalityTraits>,
  species?: string,
  color?: string
): VoiceProfile {
  const h = hash32(seed || "waketama");

  // 種族・色が分からない古い呼び出しでも壊れないよう、ハッシュから割り当てて落ち着かせる。
  const speciesKeys = Object.keys(SPECIES_VOICE);
  const colorKeys = Object.keys(COLOR_VOICE);
  const sp = SPECIES_VOICE[species ?? ""] ?? SPECIES_VOICE[speciesKeys[h % speciesKeys.length]] ?? DEFAULT_SPECIES_VOICE;
  const co = COLOR_VOICE[color ?? ""] ?? COLOR_VOICE[colorKeys[(h >>> 4) % colorKeys.length]];

  // 個体差。同じ種族・同じ色でも同じ声にしないための、ごく小さなゆらぎ（±0.05）。
  // ここを大きくすると、色の差が埋もれて「色で声が変わる」が成立しなくなる。
  const jitter = (((h >>> 8) % 100) / 100 - 0.5) * 0.10;

  const p = personality || {};
  const warmth = p.warmth ?? 50;
  const cheerfulness = p.cheerfulness ?? 50;
  const caution = p.caution ?? 50;

  // 陽気なほど速く、慎重なほどゆっくり話す。声そのものは変わらないが、喋り方は育つ。
  const rate = clamp(sp.rate + co.rate + (cheerfulness - 50) / 220 - (caution - 50) / 260, 0.8, 1.4);
  // 温かいほど、ほんの少しだけ声が明るくなる。
  const pitch = clamp(sp.pitch + co.pitch + jitter + (warmth - 50) / 420, 1.0, 2.0);

  const speedLabel = rate >= 1.08 ? "少し早口" : rate <= 0.94 ? "ゆっくりめ" : "自然な速さ";

  return {
    pitch: Math.round(pitch * 100) / 100,
    rate: Math.round(rate * 100) / 100,
    // 端末に複数の日本語音声があるときは、種族ごとに違うものを掴みにいく。
    // 高さだけで差を付けるより、元の声が違うほうがはっきり別人に聞こえる。
    voiceIndex: (sp.voiceBias + ((h >>> 16) % 2)) % 4,
    label: `${co.label}${sp.label}・${speedLabel}`,
  };
}
