/**
 * 人格レジストリ（D1）への写しと、利用状況カウンタ。
 *
 * なぜ写すのか:
 * Durable Object は1体につき1インスタンスで、横断して数える手段が無い。
 * 「いま何体いるか」「どのセグメントが多いか」を知るには、集計できる場所へ写す必要がある。
 *
 * 何を写さないのか（ここが本質なので、変更するときは必ず読むこと）:
 * - **会話の本文・記憶・覚え書きは写さない**。写すのは数値と、こちらが定義した選択肢の値だけ。
 * - **同意していない分身は行ごと存在しない**。オプトアウトしたら削除する（値を空にするのではなく行を消す）。
 * - **アクセシビリティ設定は写さない**。同意の有無に関わらず、外へ出す経路自体を作らない。
 */

import { PersonalityTraits } from "../ai/personality";
import { Psychographics } from "../analysis/psychographics";
import { SegmentResult } from "../analysis/segments";
import { ProfileAnswers, completionRate } from "./profile";
import { ConsentState, hasConsent } from "./consent";
import { logDetachedError } from "../lib/log";

export interface RegistryEnv {
  DB: D1Database;
}

export interface RegistrySnapshot {
  characterId: string;
  createdAt: number;
  growthStage: string;
  interactionCount: number;
  personality: PersonalityTraits;
  psychographics: Psychographics;
  segment: SegmentResult;
  profile: ProfileAnswers;
  consent: ConsentState | undefined;
  /** 人格データの厚み（0〜100）。計算は src/persona/survey.ts の personaDepth。 */
  depthScore: number;
  /** 価値観の設問に答えた数。厚みの内訳として、出品可否の判断に使う。 */
  psychoAnswered: number;
}

const first = (answers: ProfileAnswers, key: string): string | null => answers[key]?.[0] ?? null;

/**
 * レジストリを最新化する。同意が無ければ削除する。
 *
 * 「同意が無ければ書かない」ではなく「同意が無ければ消す」にしてあるのは、
 * 一度同意した人が取り消したときに、古い行が残り続けるのを防ぐため。
 * 取り消しは即座に効かないと意味が無い。
 */
export async function syncRegistry(env: RegistryEnv, snap: RegistrySnapshot): Promise<void> {
  const aggregate = hasConsent(snap.consent, "aggregate");
  const marketplace = hasConsent(snap.consent, "marketplace");

  if (!aggregate && !marketplace) {
    await removeFromRegistry(env, snap.characterId);
    return;
  }

  // 属性は「属性の保存」と「集約利用」の両方に同意しているときだけ写す。
  // 片方だけの同意で統計に載せるのは、説明した範囲を超えてしまう。
  const shareProfile = aggregate && hasConsent(snap.consent, "profile");
  const answers = shareProfile ? snap.profile : {};

  const values = snap.psychographics.values;
  const topInterests = Object.entries(snap.psychographics.interests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic]) => topic)
    .join(",");

  try {
    await env.DB.prepare(
      `INSERT INTO persona_registry (
         character_id, created_at, updated_at, growth_stage, interaction_count,
         segment_id, segment_confidence,
         warmth, curiosity, cheerfulness, caution, independence, humor,
         v_achievement, v_benevolence, v_hedonism, v_security,
         v_stimulation, v_selfdirection, v_tradition, v_power,
         age_band, gender, region, occupation, income, profile_completion,
         top_interests, consent_aggregate, consent_marketplace,
         depth_score, psycho_answered
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32)
       ON CONFLICT(character_id) DO UPDATE SET
         updated_at=excluded.updated_at, growth_stage=excluded.growth_stage,
         interaction_count=excluded.interaction_count,
         segment_id=excluded.segment_id, segment_confidence=excluded.segment_confidence,
         warmth=excluded.warmth, curiosity=excluded.curiosity, cheerfulness=excluded.cheerfulness,
         caution=excluded.caution, independence=excluded.independence, humor=excluded.humor,
         v_achievement=excluded.v_achievement, v_benevolence=excluded.v_benevolence,
         v_hedonism=excluded.v_hedonism, v_security=excluded.v_security,
         v_stimulation=excluded.v_stimulation, v_selfdirection=excluded.v_selfdirection,
         v_tradition=excluded.v_tradition, v_power=excluded.v_power,
         age_band=excluded.age_band, gender=excluded.gender, region=excluded.region,
         occupation=excluded.occupation, income=excluded.income,
         profile_completion=excluded.profile_completion,
         top_interests=excluded.top_interests,
         consent_aggregate=excluded.consent_aggregate, consent_marketplace=excluded.consent_marketplace,
         depth_score=excluded.depth_score, psycho_answered=excluded.psycho_answered`
    )
      .bind(
        snap.characterId,
        snap.createdAt,
        Date.now(),
        snap.growthStage,
        snap.interactionCount,
        snap.segment.id,
        snap.segment.confidence,
        Math.round(snap.personality.warmth),
        Math.round(snap.personality.curiosity),
        Math.round(snap.personality.cheerfulness),
        Math.round(snap.personality.caution),
        Math.round(snap.personality.independence),
        Math.round(snap.personality.humor),
        Math.round(values.achievement ?? 50),
        Math.round(values.benevolence ?? 50),
        Math.round(values.hedonism ?? 50),
        Math.round(values.security ?? 50),
        Math.round(values.stimulation ?? 50),
        Math.round(values.selfDirection ?? 50),
        Math.round(values.tradition ?? 50),
        Math.round(values.power ?? 50),
        first(answers, "ageBand"),
        first(answers, "gender"),
        first(answers, "region"),
        first(answers, "occupation"),
        first(answers, "income"),
        shareProfile ? completionRate(snap.profile) : 0,
        topInterests,
        aggregate ? 1 : 0,
        marketplace ? 1 : 0,
        Math.round(snap.depthScore),
        snap.psychoAnswered
      )
      .run();
  } catch (err) {
    // レジストリの同期に失敗しても会話は止めない（次のターンで再同期される）
    logDetachedError("registry.sync_failed", err, { characterId: snap.characterId });
  }
}

/** 同意の取り消し・分身の削除に伴い、レジストリと出品を消す。 */
export async function removeFromRegistry(env: RegistryEnv, characterId: string): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM persona_registry WHERE character_id = ?").bind(characterId),
      env.DB.prepare("DELETE FROM market_listings WHERE character_id = ?").bind(characterId),
    ]);
  } catch (err) {
    logDetachedError("registry.remove_failed", err, { characterId });
  }
}

/** 日付キー（JST基準の日付。運用者が見る単位を日本時間に合わせる）。 */
export function todayKey(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 利用状況を1つ数える。
 * 失敗しても呼び出し元は気にしない（統計が1件欠けることより、会話が止まる方が損失が大きい）。
 */
export async function countMetric(env: RegistryEnv, metric: string, delta = 1): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO analytics_daily (day, metric, value) VALUES (?1, ?2, ?3)
       ON CONFLICT(day, metric) DO UPDATE SET value = value + ?3`
    )
      .bind(todayKey(), metric, delta)
      .run();
  } catch (err) {
    logDetachedError("analytics.count_failed", err, { metric });
  }
}
