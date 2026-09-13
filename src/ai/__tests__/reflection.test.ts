import { describe, it, expect, vi } from "vitest";
import { distillProfileNotes, normalizeNotes, shouldReflect, MAX_NOTES_LINES, REFLECTION_INTERVAL } from "../reflection";

/**
 * 「覚え書き」の蒸留の検証。
 *
 * この機能の怖いところは、失敗の仕方が静かなこと。
 * モデルが前置きを喋っただけでも、そのゴミがプロンプトに毎回載り続けてしまう。
 * だから「箇条書き以外は捨てる」「取れなければ前回の覚え書きを守る」を厳密に確認する。
 */

describe("shouldReflect", () => {
  it("waits for the interval before spending an AI call", () => {
    expect(shouldReflect(1, 0)).toBe(false);
    expect(shouldReflect(REFLECTION_INTERVAL, 0)).toBe(true);
    expect(shouldReflect(REFLECTION_INTERVAL + 1, REFLECTION_INTERVAL)).toBe(false);
    expect(shouldReflect(REFLECTION_INTERVAL * 2, REFLECTION_INTERVAL)).toBe(true);
  });

  it("treats a character that has never reflected as due once it has talked enough", () => {
    expect(shouldReflect(REFLECTION_INTERVAL, undefined)).toBe(true);
  });
});

describe("normalizeNotes", () => {
  it("keeps only the bullet lines and drops the model's chatter", () => {
    const raw = `わかりました。以下が更新後の覚え書きです。

- 犬を飼っている
* 夜勤の仕事をしている
1. コーヒーが苦手

以上です。`;
    expect(normalizeNotes(raw)).toBe("・犬を飼っている\n・夜勤の仕事をしている\n・コーヒーが苦手");
  });

  it("removes code fences and duplicate lines", () => {
    const raw = "```\n・猫を飼っている\n・猫を飼っている\n```";
    expect(normalizeNotes(raw)).toBe("・猫を飼っている");
  });

  it("caps the number of lines so the prompt cannot grow without limit", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `・事実${i}`).join("\n");
    expect(normalizeNotes(raw).split("\n")).toHaveLength(MAX_NOTES_LINES);
  });

  it("returns an empty string when nothing usable came back", () => {
    expect(normalizeNotes("すみません、よく分かりませんでした。")).toBe("");
  });
});

describe("distillProfileNotes", () => {
  function fakeAi(response: string | Error) {
    const run = vi.fn(async (_model: string, _input: unknown) => {
      if (response instanceof Error) throw response;
      return { response };
    });
    return { env: { AI: { run } } as unknown as { AI: Ai }, run };
  }

  it("passes the previous notes to the model so old facts are not lost", async () => {
    const { env, run } = fakeAi("・犬のポチを飼っている\n・パン屋で働いている");
    const notes = await distillProfileNotes(env, {
      name: "ぽち丸",
      previousNotes: "・犬のポチを飼っている",
      turns: [{ role: "user", text: "パン屋で働き始めたよ" }],
    });

    expect(notes).toBe("・犬のポチを飼っている\n・パン屋で働いている");
    const sent = JSON.stringify(run.mock.calls[0][1]);
    expect(sent).toContain("犬のポチを飼っている");
    expect(sent).toContain("パン屋で働き始めたよ");
  });

  it("returns null (keeping the old notes) when the model answers with nothing usable", async () => {
    const { env } = fakeAi("すみません、分かりません");
    const notes = await distillProfileNotes(env, {
      name: "のこ",
      previousNotes: "・大事な事実",
      turns: [{ role: "user", text: "やあ" }],
    });
    expect(notes).toBeNull();
  });

  it("returns null when the AI call fails, without throwing into the chat path", async () => {
    const { env } = fakeAi(new Error("AI down"));
    await expect(
      distillProfileNotes(env, { name: "のこ", previousNotes: "", turns: [{ role: "user", text: "やあ" }] })
    ).resolves.toBeNull();
  });

  it("does not call the AI at all when there is nothing to summarize", async () => {
    const { env, run } = fakeAi("・何か");
    const notes = await distillProfileNotes(env, { name: "のこ", previousNotes: "", turns: [] });
    expect(notes).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
