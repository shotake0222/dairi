/**
 * 設問カタログの読み書き。
 *
 * 組み込みの設問（profile.ts / survey.ts）を土台に、D1の survey_questions で
 * **上書き・追加・無効化**する。表が空なら組み込みのまま動く。
 *
 * この形にした理由:
 * - 設問を1つ足すたびにデプロイが必要だと、運用しながら聞き方を直せない。
 *   人格データの質は設問の質でほぼ決まるので、ここは運用側で回せる必要がある。
 * - 一方で、全部をDBに移すと「なぜこれを聞くのか」がコードレビューの外に出る。
 *   要配慮個人情報を避ける・自由記述を置かない、といった判断は組み込み側に残しておきたい。
 * - だから既定はコード、変更履歴のいらない微調整はDB、という分担にしている。
 *
 * **管理画面から入る値も信用しない。** 選択肢は必ず配列に正規化し、
 * 価値観の点数は0〜100に丸める。壊れた行は黙って捨てて組み込みへ戻す
 * （設問が1つ壊れただけで、サーベイ全体が止まる方が損失が大きい）。
 */

import { PROFILE_FIELDS, PROFILE_GROUPS, ProfileField, ProfileGroup } from "./profile";
import { PSYCHO_QUESTIONS, PsychoQuestion } from "./survey";
import { VALUE_AXES, ValueAxis } from "../analysis/psychographics";

export interface QuestionStoreEnv {
  DB: D1Database;
}

export interface QuestionRow {
  id: string;
  kind: "demographic" | "psychographic";
  group_key: string;
  label: string;
  why: string;
  type: "single" | "multi";
  options: string;
  axis: string | null;
  ask_after: number;
  max_selections: number | null;
  sort_order: number;
  enabled: number;
  updated_at: number;
}

export interface Catalog {
  /** 属性の設問（画面のグループ表示用） */
  groups: ProfileGroup[];
  /** 属性の設問を、聞く順に並べたもの */
  fields: ProfileField[];
  /** 価値観の設問 */
  psycho: PsychoQuestion[];
}

/** 組み込みだけのカタログ。DBが読めないときの落とし先でもある。 */
export function builtinCatalog(): Catalog {
  return { groups: PROFILE_GROUPS, fields: PROFILE_FIELDS, psycho: PSYCHO_QUESTIONS };
}

function parseOptions(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toField(row: QuestionRow): ProfileField | null {
  const options = parseOptions(row.options).filter((o): o is string => typeof o === "string" && o.length > 0);
  if (options.length === 0) return null;
  return {
    key: row.id,
    label: row.label,
    why: row.why,
    type: row.type === "multi" ? "multi" : "single",
    options,
    askAfter: Math.max(0, row.ask_after | 0),
    maxSelections: row.max_selections ?? undefined,
  };
}

function toPsycho(row: QuestionRow): PsychoQuestion | null {
  if (!row.axis || !VALUE_AXES.includes(row.axis as ValueAxis)) return null;
  const options = parseOptions(row.options)
    .map((o) => o as { label?: unknown; score?: unknown })
    .filter((o) => typeof o?.label === "string" && typeof o?.score === "number")
    .map((o) => ({ label: String(o.label), score: Math.max(0, Math.min(100, Number(o.score))) }));
  if (options.length < 2) return null;
  return {
    id: row.id,
    axis: row.axis as ValueAxis,
    label: row.label,
    why: row.why,
    options,
    askAfter: Math.max(0, row.ask_after | 0),
  };
}

export async function listQuestionRows(env: QuestionStoreEnv): Promise<QuestionRow[]> {
  try {
    const res = await env.DB.prepare(
      "SELECT * FROM survey_questions ORDER BY sort_order ASC, id ASC"
    ).all<QuestionRow>();
    return res.results ?? [];
  } catch {
    // 表がまだ無い（マイグレーション前）ときは、組み込みだけで動かす
    return [];
  }
}

/**
 * 組み込み＋DBの上書きを合わせたカタログを返す。
 * 無効化された設問は、この時点で消えている（呼び出し側は enabled を意識しなくてよい）。
 */
export async function loadCatalog(env: QuestionStoreEnv): Promise<Catalog> {
  const rows = await listQuestionRows(env);
  if (rows.length === 0) return builtinCatalog();

  const byId = new Map(rows.map((r) => [r.id, r]));
  const disabled = new Set(rows.filter((r) => !r.enabled).map((r) => r.id));

  // --- 属性 ---
  const groups: ProfileGroup[] = PROFILE_GROUPS.map((g) => ({
    ...g,
    fields: g.fields
      .filter((f) => !disabled.has(f.key))
      .map((f) => {
        const row = byId.get(f.key);
        if (!row || row.kind !== "demographic") return f;
        return toField(row) ?? f;
      }),
  }));

  // 組み込みに無いIDは、追加された設問。所属グループごとに足す
  const builtinKeys = new Set(PROFILE_FIELDS.map((f) => f.key));
  const extras = rows.filter((r) => r.kind === "demographic" && r.enabled && !builtinKeys.has(r.id));
  for (const row of extras) {
    const field = toField(row);
    if (!field) continue;
    const group = groups.find((g) => g.key === row.group_key);
    if (group) group.fields.push(field);
    else groups.push({ key: row.group_key, title: row.group_key, lead: "", fields: [field] });
  }

  // --- 価値観 ---
  const psycho: PsychoQuestion[] = PSYCHO_QUESTIONS.filter((q) => !disabled.has(q.id)).map((q) => {
    const row = byId.get(q.id);
    if (!row || row.kind !== "psychographic") return q;
    return toPsycho(row) ?? q;
  });
  const builtinPsychoIds = new Set(PSYCHO_QUESTIONS.map((q) => q.id));
  for (const row of rows) {
    if (row.kind !== "psychographic" || !row.enabled || builtinPsychoIds.has(row.id)) continue;
    const q = toPsycho(row);
    if (q) psycho.push(q);
  }

  // 聞く順は askAfter が小さいものから。管理画面で順番を入れ替えたぶんは sort_order で効く
  const fields = groups.flatMap((g) => g.fields).sort((a, b) => a.askAfter - b.askAfter);
  psycho.sort((a, b) => a.askAfter - b.askAfter);

  return { groups, fields, psycho };
}

export interface QuestionInput {
  id?: unknown;
  kind?: unknown;
  groupKey?: unknown;
  label?: unknown;
  why?: unknown;
  type?: unknown;
  options?: unknown;
  axis?: unknown;
  askAfter?: unknown;
  maxSelections?: unknown;
  sortOrder?: unknown;
  enabled?: unknown;
}

const ID_RE = /^[a-zA-Z0-9_]{2,40}$/;

/** 管理画面から来た1件を検証して保存する。壊れた設問を保存させないための関門。 */
export async function saveQuestion(
  env: QuestionStoreEnv,
  input: QuestionInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!ID_RE.test(id)) return { ok: false, error: "IDは英数字とアンダースコアで2〜40文字にしてください" };

  const kind = input.kind === "psychographic" ? "psychographic" : "demographic";
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 120) : "";
  if (!label) return { ok: false, error: "設問文を入力してください" };
  const why = typeof input.why === "string" ? input.why.trim().slice(0, 160) : "";
  const type = input.type === "multi" && kind === "demographic" ? "multi" : "single";
  const askAfter = Math.max(0, Math.min(500, Number(input.askAfter) || 0));
  const sortOrder = Math.max(0, Math.min(9999, Number(input.sortOrder) || 100));
  const enabled = input.enabled === false ? 0 : 1;
  const maxSelections =
    typeof input.maxSelections === "number" && input.maxSelections > 0
      ? Math.min(20, Math.round(input.maxSelections))
      : null;

  let optionsJson: string;
  let axis: string | null = null;

  if (kind === "psychographic") {
    if (typeof input.axis !== "string" || !VALUE_AXES.includes(input.axis as ValueAxis)) {
      return { ok: false, error: "価値観の設問には、8つの軸のどれかを指定してください" };
    }
    axis = input.axis;
    const raw = Array.isArray(input.options) ? input.options : [];
    const options = raw
      .map((o) => o as { label?: unknown; score?: unknown })
      .filter((o) => typeof o?.label === "string" && o.label.trim() && Number.isFinite(Number(o?.score)))
      .map((o) => ({ label: String(o.label).trim().slice(0, 60), score: Math.max(0, Math.min(100, Number(o.score))) }));
    if (options.length < 2) return { ok: false, error: "選択肢は2つ以上必要です（各選択肢に0〜100の点数を付けてください）" };
    optionsJson = JSON.stringify(options.slice(0, 8));
  } else {
    const raw = Array.isArray(input.options) ? input.options : [];
    const options = raw
      .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
      .map((o) => o.trim().slice(0, 60));
    if (options.length < 2) return { ok: false, error: "選択肢は2つ以上必要です" };
    optionsJson = JSON.stringify(Array.from(new Set(options)).slice(0, 30));
  }

  const groupKey = typeof input.groupKey === "string" && input.groupKey.trim() ? input.groupKey.trim().slice(0, 40) : "custom";

  await env.DB.prepare(
    `INSERT INTO survey_questions
       (id, kind, group_key, label, why, type, options, axis, ask_after, max_selections, sort_order, enabled, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       kind=excluded.kind, group_key=excluded.group_key, label=excluded.label, why=excluded.why,
       type=excluded.type, options=excluded.options, axis=excluded.axis, ask_after=excluded.ask_after,
       max_selections=excluded.max_selections, sort_order=excluded.sort_order, enabled=excluded.enabled,
       updated_at=excluded.updated_at`
  )
    .bind(id, kind, groupKey, label, why, type, optionsJson, axis, askAfter, maxSelections, sortOrder, enabled, Date.now())
    .run();

  return { ok: true };
}

/**
 * 上書き・追加を取り消す。
 * 組み込みの設問なら、これで元の文言に戻る（消えるのではなく既定に復帰する）。
 */
export async function deleteQuestion(env: QuestionStoreEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM survey_questions WHERE id = ?").bind(id).run();
}
