import { CharacterState, SPECIES_LABELS, MEETING_COOLDOWN_MS, MeetingLogEntry, SpeciesKey, ColorKey, PersonalityPackageV1 } from "./durable-objects/characterState";
import { deriveSpeechStyle } from "./ai/speechStyle";
import { PersonalityTraits, TRAIT_KEYS } from "./ai/personality";
import { handleCallStream } from "./call";
import { handleTalk } from "./talk";
import { deriveVoiceProfile } from "./ai/voiceProfile";
import { handleHealth } from "./health";
import { handleTranscribe, handleSpeak } from "./voice";
import { issueTransferCode, claimTransferCode } from "./transfer";
import { stagingGate, applyStagingHeaders } from "./stagingGuard";
import { LogContext, newRequestId } from "./lib/log";

export { CharacterState };

export interface Env {
  AI: Ai;
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  CHARACTER: DurableObjectNamespace<CharacterState>;
  ASSETS: Fetcher;
  /** デプロイ時に注入される版数（npm run deploy が git のコミットハッシュを渡す）。 */
  APP_VERSION?: string;
  BUILT_AT?: string;
  /** "production" | "staging"。wrangler.toml の [vars] で環境ごとに設定している。 */
  ENVIRONMENT?: string;
  /** ステージングの合言葉。設定されているときだけ入口で要求する（secretで設定）。 */
  STAGING_PASSCODE?: string;
  /**
   * 会話モデルの上書き。コードを変えずに品質評価やロールバックができるようにするための逃げ道。
   * 未設定なら src/ai/modelPolicy.ts の既定の連鎖を使う。
   */
  CHAT_MODEL?: string;
}

/**
 * 実機デバッグ用に、全レスポンスへ版数を載せる。
 * PWA化した以上「いま端末が掴んでいるのはどの版か」が分からないと、
 * Service Workerやキャッシュが絡んだ不具合の切り分けができなくなる。
 */
function versionHeaders(env: Env): Record<string, string> {
  return { "x-waketama-version": env.APP_VERSION || "dev" };
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
    const log: LogContext = { requestId: newRequestId(), route: url.pathname };

    // 検証環境に合言葉が設定されている場合、ここで止める（本番では何もしない）
    const gated = stagingGate(request, url, env);
    if (gated) return gated;

    // --- トップページ ---
    // public/ に index.html を置いていないため、素のドメインを開くと404になってしまう。
    // ドメイン直打ちや共有リンクからの流入は「分身一覧」に着地させる。
    if (url.pathname === "/") {
      return Response.redirect(new URL("/home", url.origin).toString(), 302);
    }

    // --- 死活・自己診断 ---
    // 「記憶が保存されていない気がする」類の切り分けを1秒で終わらせるためのエンドポイント。
    // 既定ではAIを呼ばない（呼ぶと課金が発生するため）。深い確認は ?deep=1 で明示的に行う。
    if (url.pathname === "/api/health") {
      return handleHealth(env, url, log);
    }

    // --- その場限りの通話（何も保存しないモード） ---
    // 応答はSSEで流す。詳しい設計方針は src/call.ts の冒頭コメントを参照。
    if (url.pathname === "/api/call/stream" && request.method === "POST") {
      const body = await request.json<Record<string, unknown>>();
      return handleCallStream(env, body, { ...log, characterId: typeof body.characterId === "string" ? body.characterId : undefined });
    }

    // --- かざして話す（カメラ映像を出したまま声で会話する） ---
    // 通話と違い、こちらは通常の会話と同じく保存され、性格も育つ。詳しい設計は src/talk.ts を参照。
    if (url.pathname === "/api/talk" && request.method === "POST") {
      const body = await request.json<Record<string, unknown>>();
      return handleTalk(env, body, {
        ...log,
        characterId: typeof body.characterId === "string" ? body.characterId : undefined,
      });
    }

    // --- 音声入力の文字起こし ---
    if (url.pathname === "/api/voice/transcribe" && request.method === "POST") {
      return handleTranscribe(env, request, log);
    }

    // --- 音声合成（読み上げ）。ブラウザ標準の音声より自然な声を使いたいとき用 ---
    if (url.pathname === "/api/voice/speak" && request.method === "POST") {
      return handleSpeak(env, request, log);
    }

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

      const redirectUrl = new URL("/summon", url.origin);
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
      // このAPIは cid さえ知っていれば誰でも叩ける。cid はチャットページのURLに乗って
      // 共有されうるので、ここから漏れてよいのは「見た目と育ち具合」までに限る。
      //
      // - ownerToken: 持ち主だけが知っている前提の値。含めたら持ち主保護の意味が無くなる。
      // - memorySummary / recentTurns / profileNotes: **会話の中身そのもの**。
      //   URLを知られただけで過去の会話が読めてしまうのは、記憶を厚く持つようにした以上、
      //   最も避けなければならない事故なので、この入口では必ず落とす。
      const {
        ownerToken: _ownerToken,
        memorySummary: _memorySummary,
        recentTurns: _recentTurns,
        profileNotes: _profileNotes,
        ...publicState
      } = state;
      return json({
        ...publicState,
        speechStyleLabel: deriveSpeechStyle(state.personality).label,
        // 読み上げに使う「この子の声」。保存はせず、characterIdと性格から毎回導出する。
        voice: deriveVoiceProfile(characterId, state.personality),
      });
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
      const fileName = `waketama_${pkg.character.name || characterId}.json`.replace(/[^\w.\-ぁ-んァ-ヶー一-龠]/g, "_");
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

    // --- 引き継ぎコードの発行（持ち主のみ） ---
    // 機種変更やブラウザのデータ削除で所有権を失うのを救うための仕組み。詳細は src/transfer.ts。
    if (url.pathname === "/api/character/transfer/issue" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; token?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const result = await issueTransferCode(env, body.characterId, body.token, {
        ...log,
        characterId: body.characterId,
      });
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ code: result.code, expiresAt: result.expiresAt });
    }

    // --- 引き継ぎコードの使用（新しい端末側） ---
    if (url.pathname === "/api/character/transfer/claim" && request.method === "POST") {
      const body = await request.json<{ code?: string }>();
      const result = await claimTransferCode(env, body.code || "", log);
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ characterId: result.characterId, ownerToken: result.ownerToken, name: result.name });
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
    return serveAsset(request, url, env);
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

/**
 * 静的ファイルの配信。HTMLだけは、OGP用のURLをその場で絶対URLに書き換えてから返す。
 *
 * なぜサーバー側で書き換えるのか:
 * OGPのog:image / og:urlは、SNSのクローラーがJavaScriptを実行せずに読むため相対パスでは正しく解決されず、
 * かといってHTMLに絶対URLを直書きすると、配信ドメイン（*.workers.dev / 独自ドメイン / プレビュー環境）が
 * 変わるたびにカード画像が壊れる。リクエストのオリジンを見てここで補完すれば、どのドメインで配信しても
 * 常に正しい絶対URLになり、HTML側はドメインを知らなくて済む。
 */
async function serveAsset(request: Request, url: URL, env: Env): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(request);
  const contentType = assetResponse.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return assetResponse;

  // 版数ヘッダを載せる。実機で「いま掴んでいるのはどの版か」を確認するための手がかり。
  // 検証環境なら、あわせて検索避け（noindex）も付ける。
  const withVersion = applyStagingHeaders(new Response(assetResponse.body, assetResponse), env);
  for (const [key, value] of Object.entries(versionHeaders(env))) {
    withVersion.headers.set(key, value);
  }

  const origin = url.origin;
  const toAbsolute = (value: string | null): string | null => {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return null; // すでに絶対URLなら触らない
    return origin + (value.startsWith("/") ? value : `/${value}`);
  };

  return new HTMLRewriter()
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(element) {
        const absolute = toAbsolute(element.getAttribute("content"));
        if (absolute) element.setAttribute("content", absolute);
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        // 共有されるのは「今開いているページ」。クエリ文字列（cid等）は共有カードに載せない。
        element.setAttribute("content", origin + url.pathname);
      },
    })
    .transform(withVersion);
}

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
