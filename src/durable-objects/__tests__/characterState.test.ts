import { env } from "cloudflare:workers";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CharacterData, PersonalityPackageV1 } from "../characterState";
import { EXPORT_FORMAT_VERSION } from "../characterState";

/**
 * Durable Object（CharacterState）本体の統合テスト。
 *
 * env.CHARACTER.getByName(...) は本番コード（src/index.ts）と全く同じ呼び方で、
 * @cloudflare/vitest-plugin がworkerdランタイム上に実際のDurable Objectを立ち上げる。
 * D1もwrangler.tomlの設定どおりローカルSQLiteで動くので、character_directoryテーブルへの
 * 実際の読み書きも検証できる。
 *
 * AI(env.AI.run)にはローカルシミュレータが無く、実際に呼ぶとCloudflareアカウントへの
 * アクセス（＝課金）が発生するため、AIに依存するテストでは必ず vi.spyOn でモックする。
 * モックしないテスト（所有者トークン・D1連携・履歴の積み上げなど）は、AI呼び出しを経由しない
 * メソッドだけを対象にしている。
 */

function freshCid(label: string): string {
  // テストごとに衝突しないよう、呼び出し元ラベル＋ランダム値でDO名を作る
  return `test-${label}-${crypto.randomUUID()}`;
}

function getStub(cid: string) {
  return env.CHARACTER.getByName(cid);
}

// AI(env.AI.run)にはローカルシミュレータが無く、モックしないまま呼ぶと実際にネットワークへ
// アクセスしようとして(workerd側で)例外になる。exportPackageなど、AIを直接は使わないつもりの
// メソッドでも内部でembedText()経由でAIを呼ぶことがあるため、既定では常に失敗させておき、
// 個々のテストが必要な時だけ vi.spyOn で上書きする(embedText等は失敗時にnullへフォールバックする
// 設計なので、これによって壊れることはない)。
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("CharacterState.init", () => {
  it("creates a brand-new character with sensible defaults and an ownerToken", async () => {
    const stub = getStub(freshCid("init"));
    const data = await stub.init("テスト太郎");

    expect(data.name).toBe("テスト太郎");
    expect(data.interactionCount).toBe(0);
    expect(data.growthStage).toBe("誕生したばかり");
    expect(typeof data.ownerToken).toBe("string");
    expect(data.ownerToken!.length).toBeGreaterThan(0);
    expect(data.personalityHistory).toHaveLength(1);
    expect(data.personalityHistory![0].interactionCount).toBe(0);
    // 6軸すべてデフォルト値(50)で誕生する
    for (const v of Object.values(data.personality)) {
      expect(v).toBe(50);
    }
  });

  it("returns the existing data (and does not mint a new ownerToken) on repeated init", async () => {
    const stub = getStub(freshCid("init-idempotent"));
    const first = await stub.init("いちろう");
    const second = await stub.init("にろう"); // 名前を変えて呼んでも無視される
    expect(second.name).toBe("いちろう");
    expect(second.ownerToken).toBe(first.ownerToken);
  });
});

describe("CharacterState.rename (owner-token protected)", () => {
  it("allows the first rename with no token when the character has no data yet (auto-creates it)", async () => {
    const stub = getStub(freshCid("rename-new"));
    const result = await stub.rename("はじめの名前");
    expect("error" in result).toBe(false);
    expect((result as CharacterData).name).toBe("はじめの名前");
  });

  it("rejects rename from the wrong owner token once a character exists", async () => {
    const stub = getStub(freshCid("rename-wrong-token"));
    const created = await stub.init("もとの名前");

    const wrong = await stub.rename("乗っ取り", "totally-wrong-token");
    expect(wrong).toEqual({ error: "この操作は分身の持ち主だけが行えます" });

    // 実際に名前は変わっていないことも確認する
    const state = await stub.getState();
    expect(state?.name).toBe("もとの名前");
    void created;
  });

  it("allows rename with the correct owner token", async () => {
    const stub = getStub(freshCid("rename-correct-token"));
    const created = await stub.init("もとの名前");

    const result = await stub.rename("新しい名前", created.ownerToken);
    expect("error" in result).toBe(false);
    expect((result as CharacterData).name).toBe("新しい名前");
  });

  it("stays open (backward compatible) for legacy characters with no ownerToken", async () => {
    const cid = freshCid("rename-legacy");
    const stub = getStub(cid);
    await stub.init("レガシー");

    // ownerToken導入前のデータを模倣するため、storageから直接ownerTokenを取り除く
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      expect(data).toBeTruthy();
      delete (data as CharacterData).ownerToken;
      await state.storage.put("data", data);
    });

    // トークンを一切渡さなくても改名できる(=互換性維持)
    const result = await stub.rename("誰でも改名できる", undefined);
    expect("error" in result).toBe(false);
    expect((result as CharacterData).name).toBe("誰でも改名できる");
  });
});

describe("CharacterState.setSocialOptIn (owner-token protected, D1-backed directory)", () => {
  it("rejects with the wrong owner token and does not touch the directory", async () => {
    const cid = freshCid("social-wrong-token");
    const stub = getStub(cid);
    const created = await stub.init("しゃかいてき");
    void created;

    const result = await stub.setSocialOptIn(true, "wrong-token");
    expect(result).toEqual({ error: "この操作は分身の持ち主だけが行えます" });

    const row = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?")
      .bind(cid)
      .first();
    expect(row).toBeNull();
  });

  it("opting in writes a row to character_directory, opting out removes it", async () => {
    const cid = freshCid("social-toggle");
    const stub = getStub(cid);
    const created = await stub.init("こうかい");

    const onResult = await stub.setSocialOptIn(true, created.ownerToken);
    expect(onResult).toEqual({ optIn: true });

    const row = await env.DB.prepare(
      "SELECT character_id, name, warmth FROM character_directory WHERE character_id = ?"
    )
      .bind(cid)
      .first<{ character_id: string; name: string; warmth: number }>();
    expect(row?.character_id).toBe(cid);
    expect(row?.name).toBe("こうかい");
    expect(row?.warmth).toBe(50);

    const offResult = await stub.setSocialOptIn(false, created.ownerToken);
    expect(offResult).toEqual({ optIn: false });

    const rowAfter = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?")
      .bind(cid)
      .first();
    expect(rowAfter).toBeNull();
  });
});

describe("CharacterState.recordMeeting (encounter history)", () => {
  const partner = { name: "あいて", species: "punikoro" as const, color: "coral" as const };

  it("accumulates meetings into meetingHistory while also keeping lastMeeting", async () => {
    const stub = getStub(freshCid("meeting-history"));
    await stub.init("であうこ");

    await stub.recordMeeting([{ role: "self", text: "こんにちは" }], partner);
    await stub.recordMeeting([{ role: "self", text: "またね" }], partner);

    const state = await stub.getState();
    expect(state?.meetingHistory).toHaveLength(2);
    expect(state?.lastMeeting?.log[0].text).toBe("またね");
  });

  it("caps meetingHistory at 60 entries, dropping the oldest first", async () => {
    const stub = getStub(freshCid("meeting-history-cap"));
    await stub.init("たくさんであうこ");

    for (let i = 0; i < 65; i++) {
      await stub.recordMeeting([{ role: "self", text: `hello-${i}` }], partner);
    }

    const state = await stub.getState();
    expect(state?.meetingHistory).toHaveLength(60);
    // 古い出会い(0〜4番目)は捨てられ、直近60件(5〜64番目)だけが残る
    expect(state?.meetingHistory?.[0].log[0].text).toBe("hello-5");
    expect(state?.meetingHistory?.[59].log[0].text).toBe("hello-64");
  });
});

describe("CharacterState.exportPackage / importPackage (owner-token protected, round-trip)", () => {
  it("rejects export with the wrong owner token", async () => {
    const stub = getStub(freshCid("export-wrong-token"));
    await stub.init("えくすぽーと");

    const result = await stub.exportPackage("wrong-token");
    expect(result).toEqual({ ok: false, error: "この操作は分身の持ち主だけが行えます" });
  });

  it("exports a package with the correct owner token, and round-trips it into a fresh character", async () => {
    const sourceCid = freshCid("export-source");
    const sourceStub = getStub(sourceCid);
    const created = await sourceStub.init("げんきなこ");
    await sourceStub.rename("げんきなこ", created.ownerToken);

    const exported = await sourceStub.exportPackage(created.ownerToken);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("unreachable");
    const pkg = exported.package;
    expect(pkg.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(pkg.character.name).toBe("げんきなこ");
    expect(pkg.personality.warmth).toBe(50);

    // 別の(まだ存在しない)キャラクターへインポート = 「引っ越し」のシミュレーション
    const destCid = freshCid("export-dest");
    const destStub = getStub(destCid);
    const imported = await destStub.importPackage(pkg);
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("unreachable");
    expect(imported.name).toBe("げんきなこ");
    expect(typeof imported.ownerToken).toBe("string");

    const destState = await destStub.getState();
    expect(destState?.personality.warmth).toBe(50);
    expect(destState?.socialOptIn).toBe(false); // インポート後はオプトインを必ずリセットする仕様
  });

  it("rejects import onto an existing owned character with the wrong token", async () => {
    const cid = freshCid("import-wrong-token");
    const stub = getStub(cid);
    const created = await stub.init("まもられこ");

    const validPkg: PersonalityPackageV1 = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: Date.now(),
      character: {
        id: "irrelevant",
        name: "のっとりこ",
        species: "mofukuru",
        color: "sky",
        createdAt: Date.now(),
        growthStage: "誕生したばかり",
        interactionCount: 0,
      },
      personality: { warmth: 10, curiosity: 10, cheerfulness: 10, caution: 10, independence: 10, humor: 10 },
      personalityHistory: [],
      memory: { shortTerm: "", longTerm: [] },
      meta: { generator: "sodatsukake", note: "" },
    };

    const result = await stub.importPackage(validPkg, "wrong-token");
    expect(result).toEqual({ ok: false, error: "この操作は分身の持ち主だけが行えます" });

    const state = await stub.getState();
    expect(state?.name).toBe("まもられこ"); // 上書きされていない
    void created;
  });

  it("rejects a package with an unsupported formatVersion", async () => {
    const stub = getStub(freshCid("import-bad-version"));
    const created = await stub.init("けんさこ");

    const badPkg = { formatVersion: "0.9" } as unknown as PersonalityPackageV1;
    // 所有者トークンは正しいものを渡し、フォーマット検証そのものを確かめる
    const result = await stub.importPackage(badPkg, created.ownerToken);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("対応していない形式");
  });
});

describe("CharacterState.chat (mocked AI)", () => {
  it("returns the mocked AI reply and updates personality/interactionCount", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "元気だよ！" } as never);

    const stub = getStub(freshCid("chat-basic"));
    await stub.init("かいわこ");

    const result = await stub.chat("やっほー！今日も元気？");
    expect(result.reply).toBe("元気だよ！");
    expect(result.interactionCount).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("falls back to an apology reply (not a crash) when the AI binding throws", async () => {
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("boom"));

    const stub = getStub(freshCid("chat-ai-failure"));
    await stub.init("こまりこ");

    const result = await stub.chat("こんにちは");
    expect(result.error).toBeUndefined(); // ガード節エラーではない
    expect(result.reply).toContain("うまく考えがまとまらない");
    expect(result.interactionCount).toBe(1); // 会話自体はカウントされる
  });

  it("rejects empty messages before ever calling the AI binding", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "呼ばれるはずがない" } as never);

    const stub = getStub(freshCid("chat-empty-guard"));
    await stub.init("がーどこ");

    const result = await stub.chat("   ");
    expect(result.error).toBe("メッセージを入力してね");
    expect(result.reply).toBeUndefined();
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("rejects overly long messages before ever calling the AI binding", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "呼ばれるはずがない" } as never);

    const stub = getStub(freshCid("chat-length-guard"));
    await stub.init("ながぶんこ");

    const result = await stub.chat("あ".repeat(401));
    expect(result.error).toContain("長すぎます");
    expect(aiSpy).not.toHaveBeenCalled();
  });
});

describe("CharacterState.deleteData (owner-token protected, right-to-be-forgotten)", () => {
  it("succeeds with no-op when the character was never created", async () => {
    const stub = getStub(freshCid("delete-never-created"));
    const result = await stub.deleteData(undefined);
    expect(result).toEqual({ ok: true });
  });

  it("rejects with the wrong owner token and leaves the data (and directory row) intact", async () => {
    const cid = freshCid("delete-wrong-token");
    const stub = getStub(cid);
    const created = await stub.init("けされないこ");
    await stub.setSocialOptIn(true, created.ownerToken);

    const result = await stub.deleteData("wrong-token");
    expect(result).toEqual({ ok: false, error: "この操作は分身の持ち主だけが行えます" });

    const state = await stub.getState();
    expect(state?.name).toBe("けされないこ");
    const row = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?")
      .bind(cid)
      .first();
    expect(row).toBeTruthy();
  });

  it("with the correct token, clears storage entirely and removes the directory row", async () => {
    const cid = freshCid("delete-ok");
    const stub = getStub(cid);
    const created = await stub.init("きえるこ");
    await stub.setSocialOptIn(true, created.ownerToken);
    await stub.recordMeeting([{ role: "self", text: "こんにちは" }], {
      name: "あいて",
      species: "punikoro",
      color: "coral",
    });

    const result = await stub.deleteData(created.ownerToken);
    expect(result).toEqual({ ok: true });

    // DurableObjectのストレージが本当に空になっている(dataキーが無い)ことを直接確認する
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      expect(data).toBeUndefined();
    });

    expect(await stub.getState()).toBeNull();

    const row = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?")
      .bind(cid)
      .first();
    expect(row).toBeNull();
  });

  it("legacy (no-ownerToken) characters can still be deleted without a token", async () => {
    const cid = freshCid("delete-legacy");
    const stub = getStub(cid);
    await stub.init("むかしのこ");

    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      delete (data as CharacterData).ownerToken;
      await state.storage.put("data", data);
    });

    const result = await stub.deleteData(undefined);
    expect(result).toEqual({ ok: true });
    expect(await stub.getState()).toBeNull();
  });
});
