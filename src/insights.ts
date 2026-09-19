/**
 * 匿名化・集約したセグメント統計。
 *
 * **もともとは「マーケット」の一部だった。** 本人が自分の分身を出品する仕組みと、
 * 企業向けの集約統計が同じファイルに同居していたが、出品の機能そのものを畳んだので、
 * 残った統計だけをここへ移した。性質がまったく違うものを1つのファイルに置くと、
 * 片方を消すときにもう片方まで巻き込む——実際そうなりかけた。
 *
 * 企業向けに「どういう人たちがどんな話をしているか」の傾向を出す。
 * 個人を特定できないことが前提なので、**人数が一定に満たないグループは出さない**。
 * aggregate に同意した分身しか母集団に入らない（レジストリにそもそも載っていない）。
 */

import { segmentById } from "./analysis/segments";
import { LogContext, logInfo, logWarn } from "./lib/log";

export interface InsightsEnv {
  DB: D1Database;
}

/**
 * 集約統計を出すときの最小人数。
 *
 * これを下回るグループは、条件を重ねていくと個人が特定できてしまう
 * （「30代・北陸・獣医」が1人しかいなければ、それは統計ではなく個人情報）。
 * 数字を下げたくなったら、下げるのではなく条件を粗くすること。
 */
export const MIN_COHORT_SIZE = 20;

export interface SegmentInsight {
  id: string;
  label: string;
  description: string;
  count: number;
  share: number;
  avgInteractions: number;
  topInterests: string[];
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleInsights(env: InsightsEnv, log: LogContext): Promise<Response> {
  try {
    const rows = await env.DB.prepare(
      `SELECT segment_id, COUNT(*) AS n, AVG(interaction_count) AS avg_interactions,
              GROUP_CONCAT(top_interests) AS interests
       FROM persona_registry
       WHERE consent_aggregate = 1
       GROUP BY segment_id`
    ).all<{ segment_id: string | null; n: number; avg_interactions: number; interests: string | null }>();

    const all = rows.results ?? [];
    const totalConsented = all.reduce((sum, r) => sum + r.n, 0);

    const insights: SegmentInsight[] = [];
    for (const row of all) {
      if (row.n < MIN_COHORT_SIZE) continue;
      const def = row.segment_id ? segmentById(row.segment_id) : undefined;

      // 関心はカテゴリ名の集合なので、そのまま数えても個人には結びつかない
      const counts = new Map<string, number>();
      for (const topic of (row.interests ?? "").split(",")) {
        const key = topic.trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      insights.push({
        id: row.segment_id ?? "unknown",
        label: def?.label ?? row.segment_id ?? "不明",
        description: def?.description ?? "",
        count: row.n,
        share: totalConsented > 0 ? Math.round((row.n / totalConsented) * 100) : 0,
        avgInteractions: Math.round(row.avg_interactions ?? 0),
        topInterests: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([topic]) => topic),
      });
    }

    insights.sort((a, b) => b.count - a.count);
    logInfo(log, "market.insights", { segments: insights.length, suppressed: all.length - insights.length });

    return json({
      minCohortSize: MIN_COHORT_SIZE,
      totalConsented,
      // 出せなかったグループがあること自体は伝える（データが無いのか、伏せたのかを区別できるように）
      suppressedSegments: all.length - insights.length,
      insights,
    });
  } catch (err) {
    logWarn(log, "market.insights_failed", { error: err instanceof Error ? err.message : String(err) });
    return json({ error: "統計を取得できませんでした" }, 500);
  }
}
