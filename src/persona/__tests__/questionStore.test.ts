import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { builtinCatalog, deleteQuestion, loadCatalog, saveQuestion } from "../questionStore";

/**
 * 設問カタログ（組み込み＋管理画面での上書き）の検証。
 *
 * ここで守りたいこと:
 *  - **DBが空でも完全に動く**。初期化を忘れて設問が全部消える、という壊れ方をしない
 *  - 壊れた設問（選択肢なし・点数なし・知らない軸）は保存させない
 *  - 上書きを消したら、組み込みの文言に戻る（消滅ではなく復帰）
 */

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM survey_questions").run();
});

describe("loadCatalog", () => {
  it("DBが空なら組み込みのカタログそのまま", async () => {
    const catalog = await loadCatalog(env);
    const builtin = builtinCatalog();
    expect(catalog.fields.length).toBe(builtin.fields.length);
    expect(catalog.psycho.length).toBe(builtin.psycho.length);
  });

  it("同じIDで保存すると、組み込みの設問を上書きする", async () => {
    const ok = await saveQuestion(env, {
      id: "ageBand",
      kind: "demographic",
      groupKey: "basic",
      label: "おいくつですか",
      why: "話し方を合わせるためです",
      type: "single",
      options: ["20代", "30代"],
      askAfter: 2,
    });
    expect(ok.ok).toBe(true);

    const catalog = await loadCatalog(env);
    const field = catalog.fields.find((f) => f.key === "ageBand");
    expect(field?.label).toBe("おいくつですか");
    expect(field?.options).toEqual(["20代", "30代"]);
    // 他の設問は消えていない
    expect(catalog.fields.length).toBe(builtinCatalog().fields.length);
  });

  it("上書きを取り消すと、組み込みの文言に戻る", async () => {
    await saveQuestion(env, {
      id: "ageBand", kind: "demographic", label: "上書き", why: "", options: ["A", "B"],
    });
    await deleteQuestion(env, "ageBand");
    const catalog = await loadCatalog(env);
    expect(catalog.fields.find((f) => f.key === "ageBand")?.label).toBe("年代");
  });

  it("enabled=false にすると、その設問は出てこなくなる", async () => {
    await saveQuestion(env, {
      id: "income", kind: "demographic", label: "世帯年収", why: "", options: ["A", "B"], enabled: false,
    });
    const catalog = await loadCatalog(env);
    expect(catalog.fields.some((f) => f.key === "income")).toBe(false);
  });

  it("新しい価値観の設問を足せる", async () => {
    const ok = await saveQuestion(env, {
      id: "psy_extra",
      kind: "psychographic",
      axis: "hedonism",
      label: "休日はどう過ごしますか",
      why: "楽しみ方を知るためです",
      options: [{ label: "出かける", score: 80 }, { label: "うちにいる", score: 25 }],
      askAfter: 5,
    });
    expect(ok.ok).toBe(true);
    const catalog = await loadCatalog(env);
    const q = catalog.psycho.find((x) => x.id === "psy_extra");
    expect(q?.axis).toBe("hedonism");
    expect(q?.options[0].score).toBe(80);
  });
});

describe("saveQuestion の検証", () => {
  it("選択肢が1つ以下なら保存しない", async () => {
    const res = await saveQuestion(env, { id: "bad1", kind: "demographic", label: "だめ", options: ["ひとつ"] });
    expect(res.ok).toBe(false);
  });

  it("知らない価値観の軸は保存しない", async () => {
    const res = await saveQuestion(env, {
      id: "bad2", kind: "psychographic", axis: "nonexistent", label: "だめ",
      options: [{ label: "A", score: 10 }, { label: "B", score: 90 }],
    });
    expect(res.ok).toBe(false);
  });

  it("価値観の設問で点数が無ければ保存しない（答えても何も動かない設問になるため）", async () => {
    const res = await saveQuestion(env, {
      id: "bad3", kind: "psychographic", axis: "hedonism", label: "だめ",
      options: ["A", "B"],
    });
    expect(res.ok).toBe(false);
  });

  it("設問文が空なら保存しない", async () => {
    const res = await saveQuestion(env, { id: "bad4", kind: "demographic", label: "  ", options: ["A", "B"] });
    expect(res.ok).toBe(false);
  });

  it("IDに変な文字は使わせない", async () => {
    const res = await saveQuestion(env, { id: "だめな ID", kind: "demographic", label: "x", options: ["A", "B"] });
    expect(res.ok).toBe(false);
  });

  it("点数は0〜100に丸められる", async () => {
    await saveQuestion(env, {
      id: "psy_clamp", kind: "psychographic", axis: "power", label: "テスト",
      options: [{ label: "A", score: 500 }, { label: "B", score: -20 }],
    });
    const catalog = await loadCatalog(env);
    const q = catalog.psycho.find((x) => x.id === "psy_clamp");
    expect(q?.options[0].score).toBe(100);
    expect(q?.options[1].score).toBe(0);
  });
});
