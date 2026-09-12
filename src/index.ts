import { CharacterState, SPECIES_LABELS, MEETING_COOLDOWN_MS, MeetingLogEntry, SpeciesKey, ColorKey, PersonalityPackageV1 } from "./durable-objects/characterState";
import { deriveSpeechStyle } from "./ai/speechStyle";
import { PersonalityTraits, TRAIT_KEYS } from "./ai/personality";

export { CharacterState };

export interface Env {
  AI: Ai;
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  CHARACTER: DurableObjectNamespace<CharacterState>;
  ASSETS: Fetcher;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers || {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- NFCタグ読み取り: /t/:tagId ---
    // NFCタグにはこのURL（例: https://<your-domain>/t/xxxxxx）を書き込む想定。
    if (url.pathname.startsWith("/t/")) {
      const tagId = decodeURIComponent(url.pathname.split("/")[2] || "");
      if (!tagId) {
        return new Response("invalid tag", { status: 400 });
      }

      const row = await env.DB.prepare(
        "SELECT character_id FROM nfc_tags WHERE tag_id = ?"
      )
        .bind(tagId)
        .first<{ character_id: string }>();

      let characterId: string;
      let isFirstTime = false;
      let ownerToken: string | undefined;

      if (row) {
        characterId = row.character_id;
      } else {
        // 初回タップ: このタグに紐づくキャラクターを新規発行
        characterId = crypto.randomUUID();
        isFirstTime = true;
        await env.DB.prepare(
          "INSERT INTO nfc_tags (tag_id, character_id, created_at) VALUES (?, ?, ?)"
        )
          .bind(tagId, characterId, Date.now())
          .run();

        const stub = env.CHARACTER.getByName(characterId);
        const initData = await stub.init("名もなきキャラクター");
        ownerToken = initData.ownerToken;
      }

      const redirectUrl = new URL("/summon.html", url.origin);
      redirectUrl.searchParams.set("cid", characterId);
      if (isFirstTime) {
        redirectUrl.searchParams.set("first", "1");
        // 「持ち主トークン」は初回タップの瞬間だけURLに乗せてクライアントへ渡す。
        // summon.html側ですぐlocalStorageへ保存し、URLからは消す想定（人格エクスポート仕様書5章参照）。
        if (ownerToken) redirectUrl.searchParams.set("token", ownerToken);
      }

      return Response.redirect(redirectUrl.toString(), 302);
    }

    // --- チャットAPI ---
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; message?: string }>();
      if (!body.characterId || !body.message) {
        return json({ error: "characterId and message are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.chat(body.message);
      return json(result);
    }

    // --- キャラクター状態取得API ---
    if (url.pathname === "/api/character" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const state = await stub.getState();
      if (!state) return json({ error: "not found" }, { status: 404 });
      // ownerToken は「持ち主だけが知っている秘密」が前提の値。cid自体はチャットページのURLに
      // 乗って共有されうるため、この公開GET APIのレスポンスに含めてしまうと持ち主保護の意味が無くなる。
      // よって明示的に除外してから返す。
      const { ownerToken: _ownerToken, ...publicState } = state;
      return json({ ...publicState, speechStyleLabel: deriveSpeechStyle(state.personality).label });
    }

    // --- 性格変遷（成長グラフ）取得API ---
    if (url.pathname === "/api/character/history" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const history = await stub.getHistory();
      if (!history) return json({ error: "not found" }, { status: 404 });
      return json(history);
    }

    // --- 「他の分身と出会う」機能へのオプトイン/オプトアウトAPI ---
    // 公開ディレクトリへの掲載可否に関わるため、持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/social" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; optIn?: boolean; token?: string }>();
      if (!body.characterId || typeof body.optIn !== "boolean") {
        return json({ error: "characterId and optIn are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.setSocialOptIn(body.optIn, body.token);
      if ("error" in result) return json(result, { status: 403 });
      return json(result);
    }

    // --- 「お散歩」機能: 性格の近い、他ユーザーの分身とのAI同士の短い交流を生成する ---
    // 安全上の配慮: 人間同士のメッセージ交換は一切行わない。オプトイン制。
    // 相手に渡るのは名前・種族・成長段階のみで、ユーザー本人との会話内容・記憶は渡さない。
    // 実処理は runMeeting() に切り出してあり、手動実行（このAPI）と自動実行（scheduled）の両方から呼ばれる。
    if (url.pathname === "/api/character/meet" && request.method === "POST") {
      const body = await request.json<{ characterId?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const result = await runMeeting(env, body.characterId);
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ partner: result.partner, log: result.log });
    }

    // --- 人格パッケージのエクスポート（ダウンロード） ---
    // 育った性格・記憶を、モデル/実行環境に依存しない形の1ファイルとして書き出す。
    // フィジカルAI移植・バックアップ・他プラットフォームへの持ち出しの共通の出発点になるAPI。
    // 記憶の持ち出しという性質上、持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/export" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      const token = url.searchParams.get("token") || undefined;
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const result = await stub.exportPackage(token);
      if (!result.ok) return json({ error: result.error }, { status: result.error === "not found" ? 404 : 403 });
      const pkg = result.package;
      const fileName = `sodatsukake_${pkg.character.name || characterId}.json`.replace(/[^\w.\-ぁ-んァ-ヶー一-龠]/g, "_");
      return new Response(JSON.stringify(pkg, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    }

    // --- 人格パッケージのインポート（復元） ---
    // 指定したcharacterId（＝復元先のDOインスタンス）の現在のデータを上書きする破壊的操作。
    // 「他の分身と出会う」機能へのオプトイン状態は引き継がない（復元後は必ずオフから）。
    // 上書き操作のため、既にデータがある場合は持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/import" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; package?: PersonalityPackageV1; token?: string }>();
      if (!body.characterId || !body.package) {
        return json({ error: "characterId and package are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.importPackage(body.package, body.token);
      if (!result.ok) {
        const status = result.error === "この操作は分身の持ち主だけが行えます" ? 403 : 400;
        return json({ error: result.error }, { status });
      }
      return json(result);
    }

    // --- キャラクター名前設定API（初回サモン時に使う想定） ---
    if (url.pathname === "/api/character/rename" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; name?: string; token?: string }>();
      if (!body.characterId || !body.name) {
        return json({ error: "characterId and name are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const state = await stub.rename(body.name, body.token);
      if ("error" in state) return json(state, { status: 403 });
      return json(state);
    }

    // --- 分身の削除API（「アカウント不要」設計における、持ち主自身によるデータ削除手段） ---
    // 破壊的操作のため持ち主トークンによる保護対象。成功時、このタグから新しい分身を始め直せるように
    // nfc_tagsの対応も併せて削除する（同じ物理カードを再利用・譲渡できるようにするため）。
    if (url.pathname === "/api/character/delete" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; token?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.deleteData(body.token);
      if (!result.ok) return json(result, { status: 403 });
      try {
        await env.DB.prepare("DELETE FROM nfc_tags WHERE character_id = ?").bind(body.characterId).run();
      } catch (err) {
        // nfc_tags削除の失敗は致命的ではない（分身本体のデータは既に削除済み）
      }
      return json({ ok: true });
    }

    // --- それ以外は静的ファイル（public/ 配下）を配信 ---
    return env.ASSETS.fetch(request);
  },

  /**
   * 留守番エージェント（自動お散歩）: Cronトリガーから定期的に呼ばれる。
   * オプトイン済み・クールダウン明けのキャラクターを一定件数だけ選び、
   * ユーザーの操作なしに「お散歩」を自動実行しておく。
   * ユーザーが次にチャットを開いたときに「今日の出会い」として結果を見られるようにするのが狙い
   * （サービスコンセプトの「自分の代わりに動いてくれる分身」を体現する機能）。
   *
   * AIコスト・D1負荷を抑えるため、1回の実行で処理する件数には上限を設けている。
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const BATCH_LIMIT = 50;
    const rows = await env.DB.prepare(
      `SELECT character_id FROM character_directory ORDER BY updated_at ASC LIMIT ?1`
    )
      .bind(BATCH_LIMIT)
      .all<{ character_id: string }>();

    const candidateIds = (rows.results ?? []).map((r) => r.character_id);

    for (const characterId of candidateIds) {
      // 1件ずつ順に処理する（Durable Object/AI呼び出しの同時実行数を抑えるため）。
      // 個々の失敗（オプトイン済みだがクールダウン中、相手なし等）は他の処理を止めない。
      ctx.waitUntil(
        runMeeting(env, characterId).catch(() => {
          /* 自動実行なのでエラーは静かに無視する（次回のCronでまた試される） */
        })
      );
    }
  },
} satisfies ExportedHandler<Env>;

export type MeetingResult =
  | { ok: true; partner: { name: string; species: SpeciesKey; color: ColorKey }; log: MeetingLogEntry[] }
  | { ok: false; error: string; status: number };

/**
 * 「お散歩」の実処理本体。手動API（/api/character/meet）と自動実行（scheduled）の両方から呼ばれる共通関数。
 * オプトイン確認・クールダウン確認・相手探し・AI同士の立ち話生成・双方への記録保存までをここで行う。
 */
export async function runMeeting(env: Env, characterId: string): Promise<MeetingResult> {
  const selfStub = env.CHARACTER.getByName(characterId);
  const selfState = await selfStub.getState();
  if (!selfState) return { ok: false, error: "not found", status: 404 };
  if (!selfState.socialOptIn) {
    return { ok: false, error: "「他の分身と出会う」がオフになっています。まずオンにしてください", status: 400 };
  }
  const now = Date.now();
  if (selfState.lastMeetingAt && now - selfState.lastMeetingAt < MEETING_COOLDOWN_MS) {
    const remainingHours = Math.ceil((MEETING_COOLDOWN_MS - (now - selfState.lastMeetingAt)) / (60 * 60 * 1000));
    return { ok: false, error: `また今度お散歩に行こうね（あと${remainingHours}時間くらい待ってね）`, status: 429 };
  }

  const candidates = await env.DB.prepare(
    `SELECT character_id, name, species, color, warmth, curiosity, cheerfulness, caution, independence, humor
     FROM character_directory WHERE character_id != ?1 ORDER BY RANDOM() LIMIT 30`
  )
    .bind(characterId)
    .all<{
      character_id: string;
      name: string;
      species: SpeciesKey;
      color: ColorKey;
      warmth: number;
      curiosity: number;
      cheerfulness: number;
      caution: number;
      independence: number;
      humor: number;
    }>();

  const rows = candidates.results ?? [];
  if (rows.length === 0) {
    return { ok: false, error: "まだお散歩できる相手がいないみたい。また今度試してね", status: 404 };
  }

  const partnerRow = pickMostSimilar(selfState.personality, rows);
  const partnerId = partnerRow.character_id;
  const partnerStub = env.CHARACTER.getByName(partnerId);

  const selfSpeciesLabel = SPECIES_LABELS[selfState.species];
  const partnerSpeciesLabel = SPECIES_LABELS[partnerRow.species];

  // 3ターンのその場限りの立ち話を生成する（AI呼び出しはこの3回のみ。クールダウンで頻度も抑えている）
  const lineA1 = await selfStub.speakInMeeting(partnerRow.name, partnerSpeciesLabel);
  const lineB1 = await partnerStub.speakInMeeting(selfState.name, selfSpeciesLabel, lineA1);
  const lineA2 = await selfStub.speakInMeeting(partnerRow.name, partnerSpeciesLabel, lineB1);

  const selfLog: MeetingLogEntry[] = [
    { role: "self", text: lineA1 },
    { role: "other", text: lineB1 },
    { role: "self", text: lineA2 },
  ];
  const partnerLog: MeetingLogEntry[] = [
    { role: "other", text: lineA1 },
    { role: "self", text: lineB1 },
    { role: "other", text: lineA2 },
  ];

  await selfStub.recordMeeting(selfLog, { name: partnerRow.name, species: partnerRow.species, color: partnerRow.color });
  await partnerStub.recordMeeting(partnerLog, { name: selfState.name, species: selfState.species, color: selfState.color });

  return {
    ok: true,
    partner: { name: partnerRow.name, species: partnerRow.species, color: partnerRow.color },
    log: selfLog,
  };
}

/** 性格パラメータ（6軸）のユークリッド距離が最も近い候補を選ぶ（＝いちばん性格が近い分身とマッチングする）。 */
export function pickMostSimilar<T extends Pick<PersonalityTraits, (typeof TRAIT_KEYS)[number]>>(
  self: PersonalityTraits,
  candidates: T[]
): T {
  let best = candidates[0];
  let bestDist = Infinity;
  for (const candidate of candidates) {
    let distSq = 0;
    for (const key of TRAIT_KEYS) {
      const diff = self[key] - candidate[key];
      distSq += diff * diff;
    }
    if (distSq < bestDist) {
      bestDist = distSq;
      best = candidate;
    }
  }
  return best;
}
