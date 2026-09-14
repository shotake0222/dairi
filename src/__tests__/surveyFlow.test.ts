import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import type { CharacterData } from "../durable-objects/characterState";

/**
 * サーベイの通し検証（API越し）。
 *
 * ここで守りたい線:
 *  - **同意していない相手からは、1問も保存しない**
 *  - 本人が申告した価値観は、あとからのAI推定でほとんど動かない
 *  - 持ち主でなければ、設問も進み具合も見えない
 */

const BASE = "https://example.com";

async function createCharacter(cid: string): Promise<string> {
  await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name: "しらべこ" }),
  });
  const stub = env.CHARACTER.getByName(cid);
  return runInDurableObject(stub, async (_i, state) => {
    const data = await state.storage.get<CharacterData>("data");
    return data!.ownerToken!;
  });
}

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function consentProfile(cid: string, token: string) {
  await post("/api/consent", { characterId: cid, token, consent: { profile: true } });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
  await env.DB.prepare("DELETE FROM survey_questions").run();
});

describe("設問の出し分け", () => {
  it("同意していないうちは、設問ではなく同意の依頼が返る", async () => {
    const cid = `survey-consent-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    const res = await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`);
    const data = await res.json<{ needsConsent: boolean; item: unknown; consentText: string }>();
    expect(data.needsConsent).toBe(true);
    expect(data.item).toBeNull();
    expect(data.consentText.length).toBeGreaterThan(10);
  });

  it("同意していない相手の回答は保存しない", async () => {
    const cid = `survey-nosave-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    const res = await post("/api/survey/answer", { characterId: cid, token, id: "ageBand", values: ["30代"] });
    expect(res.status).toBe(403);

    const stub = env.CHARACTER.getByName(cid);
    const saved = await runInDurableObject(stub, async (_i, state) => {
      const data = await state.storage.get<CharacterData>("data");
      return data?.profile?.answers ?? {};
    });
    expect(saved).toEqual({});
  });

  it("持ち主でなければ、設問も進み具合も見えない", async () => {
    const cid = `survey-owner-${crypto.randomUUID()}`;
    await createCharacter(cid);
    const res = await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=wrong`);
    expect(res.status).toBe(403);
  });

  it("同意すれば1問目が返り、答えると次の設問に進む", async () => {
    const cid = `survey-flow-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    const first = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: { id: string; options: string[] } }>();
    expect(first.item).not.toBeNull();

    const answered = await post("/api/survey/answer", {
      characterId: cid,
      token,
      id: first.item.id,
      values: [first.item.options[0]],
    });
    expect(answered.status).toBe(200);

    const second = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: { id: string }; answered: number; depth: { score: number } }>();
    expect(second.item.id).not.toBe(first.item.id);
    expect(second.answered).toBe(1);
    expect(second.depth.score).toBeGreaterThan(0);
  });

  it("「あとで」と言った設問は、その場では出し直さない", async () => {
    const cid = `survey-skip-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    const first = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: { id: string } }>();
    await post("/api/survey/skip", { characterId: cid, token, id: first.item.id });

    const second = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: { id: string } }>();
    expect(second.item.id).not.toBe(first.item.id);
  });

  it("「もう聞かないで」で、こちらからは聞かなくなる", async () => {
    const cid = `survey-decline-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);
    await post("/api/survey/decline", { characterId: cid, token });

    const after = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: unknown }>();
    expect(after.item).toBeNull();
  });
});

describe("価値観の申告", () => {
  it("答えた軸が、その点数へ寄る", async () => {
    const cid = `survey-value-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    // 「絶対はじめての店」= stimulation 92
    const res = await post("/api/survey/answer", {
      characterId: cid,
      token,
      id: "psy_stimulation",
      values: ["絶対はじめての店"],
    });
    expect(res.status).toBe(200);

    const view = await (
      await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ psychographics: { values: Record<string, number>; selfReported?: Record<string, number> } }>();
    expect(view.psychographics.values.stimulation).toBeGreaterThan(70);
    expect(view.psychographics.selfReported?.stimulation).toBe(92);
  });

  it("設問に無い選択肢は受け付けない", async () => {
    const cid = `survey-badopt-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);
    const res = await post("/api/survey/answer", {
      characterId: cid,
      token,
      id: "psy_stimulation",
      values: ["でっちあげの選択肢"],
    });
    expect(res.status).toBe(400);
  });

  it("本人の申告は、あとからのAI推定でほとんど動かない", async () => {
    const cid = `survey-hold-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);
    await post("/api/survey/answer", {
      characterId: cid,
      token,
      id: "psy_stimulation",
      values: ["絶対はじめての店"],
    });

    // AIが正反対（0）を推定してきても、申告した値は大きくは動かない
    vi.spyOn(env.AI, "run").mockResolvedValue({
      response: JSON.stringify({ values: { stimulation: 0 } }),
    } as never);

    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { reflectNow: () => Promise<unknown> }).reflectNow();
    });

    const view = await (
      await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ psychographics: { values: Record<string, number> } }>();
    // 推定の重み 0.06 なので、1回では数ポイントしか下がらない
    expect(view.psychographics.values.stimulation).toBeGreaterThan(70);
  });
});

describe("管理画面で編集した設問", () => {
  it("編集した文言が、そのまま利用者に出る", async () => {
    const cid = `survey-edit-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    await env.DB.prepare(
      `INSERT INTO survey_questions (id, kind, group_key, label, why, type, options, ask_after, sort_order, enabled, updated_at)
       VALUES ('ageBand','demographic','basic','おいくつですか','年齢で話し方を変えるためです','single','["20代","30代"]',0,1,1,?)`
    )
      .bind(Date.now())
      .run();

    const next = await (
      await SELF.fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
    ).json<{ item: { id: string; label: string; options: string[] } }>();
    expect(next.item.id).toBe("ageBand");
    expect(next.item.label).toBe("おいくつですか");
    expect(next.item.options).toEqual(["20代", "30代"]);
  });

  it("追加した設問の回答も保存される（組み込みに無いキーでも捨てられない）", async () => {
    const cid = `survey-custom-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    await env.DB.prepare(
      `INSERT INTO survey_questions (id, kind, group_key, label, why, type, options, ask_after, sort_order, enabled, updated_at)
       VALUES ('favoriteSeason','demographic','life','好きな季節','季節の話題に使います','single','["春","夏","秋","冬"]',0,1,1,?)`
    )
      .bind(Date.now())
      .run();

    const res = await post("/api/survey/answer", {
      characterId: cid,
      token,
      id: "favoriteSeason",
      values: ["秋"],
    });
    expect(res.status).toBe(200);

    const stub = env.CHARACTER.getByName(cid);
    const saved = await runInDurableObject(stub, async (_i, state) => {
      const data = await state.storage.get<CharacterData>("data");
      return { answers: data?.profile?.answers, labels: data?.survey?.customLabels };
    });
    expect(saved.answers?.favoriteSeason).toEqual(["秋"]);
    // 会話に載せるための項目名も控えてある
    expect(saved.labels?.favoriteSeason).toBe("好きな季節");
  });

  it("無効にした設問には答えられない", async () => {
    const cid = `survey-disabled-${crypto.randomUUID()}`;
    const token = await createCharacter(cid);
    await consentProfile(cid, token);

    await env.DB.prepare(
      `INSERT INTO survey_questions (id, kind, group_key, label, why, type, options, ask_after, sort_order, enabled, updated_at)
       VALUES ('income','demographic','work','世帯年収','','single','["A","B"]',0,1,0,?)`
    )
      .bind(Date.now())
      .run();

    const res = await post("/api/survey/answer", { characterId: cid, token, id: "income", values: ["A"] });
    expect(res.status).toBe(404);
  });
});
