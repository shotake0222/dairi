/**
 * メタバースの1部屋（Durable Object・1部屋＝1インスタンス）。
 *
 * やること:
 *   - WebSocketで入退室を受け付け、分身の「姿と動きの数値」を部屋の全員に配る
 *   - 移動（行き先）・スタンプ・挨拶を中継する
 *
 * やらないこと（設計の約束）:
 *   - **入退室・移動の記録を残さない。** 誰がいつどの部屋にいたかは、つながっている間のメモリにしかない
 *   - **利用者が書いた文字を、他人に配らない。** 挨拶は決まった台詞の番号、スタンプは決まった種類だけ。
 *     子どもも使うサービスで、見知らぬ人と自由に文字をやりとりする口は開けない
 *   - **分身の識別子・持ち主トークンを、他人に配らない。** 部屋の中では、入室のたびに振る番号（aid）で呼ぶ
 *     （分身どうしの会話のために、識別子はこの部屋のメモリ＝attachment にだけ持つ。配る電文には入れない）
 *
 * 分身どうしの会話（talk）:
 *   持ち主が「伝えたいこと」を入力すると、**自分の分身が自分の言葉で**相手に話しかけ、相手の分身が返事をする。
 *   配るのは AI が生成した分身の言葉だけ（metaText.ts で連絡先・URL・不適切な語を落とす）。持ち主の入力は配らない。
 *   話したこと・聞いたことは、それぞれの分身の出会いの記録と性格に少しだけ残る（育つきっかけ）。
 *
 * 分身の動きそのもの（間・身振り・近づくか）は、配った数値から各端末が同じ規則
 * （public/meta/wt_core.mjs ＝ 実機の検証機と同じエンジン）で計算する。サーバーは位置と合図だけを配る。
 *
 * WebSocket Hibernation API を使う。人がいても静かな間は Durable Object が眠れる（課金が止まる）。
 * そのため、端末ごとの状態は WebSocket の attachment（2KBまで）に、分身の姿は storage に置く。
 */

import { DurableObject } from "cloudflare:workers";
import { SPECIES_LABELS, type CharacterState, type SpeciesKey } from "./characterState";
import { partnerKeyOf, sanitizeHint } from "../metaText";
import { GREETING_LINES, MAX_ACTORS_PER_PERSON, MAX_PEOPLE, STAMPS, TEST_AREA_ID, WORLD_HALF, type AreaState, type RoomConfig } from "../metaverse";

export interface MetaRoomEnv {
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

/** 部屋の中で配る、分身1体ぶんの公開情報 */
export interface PublicActor {
  aid: string;
  name: string;
  species: string;
  color: string;
  voice: { pitch: number; rate: number; voiceIndex: number };
  compact: unknown;
  x: number;
  z: number;
}

interface Attachment {
  pid: string;
  joined: boolean;
  actors: Array<{ aid: string; x: number; z: number; cidHash: string; cid: string }>;
  /** 移動の回数制限（1秒の窓） */
  moveWindow: number;
  moveCount: number;
  lastStampAt: number;
  lastGreetAt: number;
  lastTalkAt?: number;
  talkCount?: number;
  lastTypingAt?: number;
}

const MAX_MESSAGE_BYTES = 4096;
const MOVES_PER_SECOND = 8;
const STAMP_INTERVAL_MS = 700;
const GREET_INTERVAL_MS = 2500;
/** 分身どうしの会話は AI を使うので、間隔と1回の入室あたりの回数を絞る */
const TALK_INTERVAL_MS = 5000;
/** 自動（育った人格が自分で話しかける）のときは、もっと間をあける */
const AUTO_TALK_INTERVAL_MS = 15000;
const TALKS_PER_CONNECTION = 80;

function randomToken(n: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** 相手の仮の印（お散歩と同じ値。src/metaText.ts の partnerKeyOf） */
const hashShort = partnerKeyOf;

function clampCoord(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(-WORLD_HALF, Math.min(WORLD_HALF, Math.round(n * 100) / 100));
}

export class MetaverseRoom extends DurableObject<MetaRoomEnv> {
  /**
   * 入室の受付。Worker 側で「部屋が存在すること」と Origin を確かめ、setConfig で設定を渡してから、ここへ回してくる。
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocketで接続してください", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const attachment: Attachment = {
      pid: randomToken(10),
      joined: false,
      actors: [],
      moveWindow: 0,
      moveCount: 0,
      lastStampAt: 0,
      lastGreetAt: 0,
    };
    server.serializeAttachment(attachment);

    // 満員なら、理由を伝えてから閉じる（黙って切れると、壊れたと思われる）
    const people = this.ctx.getWebSockets().filter((ws) => (ws.deserializeAttachment() as Attachment | null)?.joined).length;
    if (people >= MAX_PEOPLE) {
      server.send(JSON.stringify({ t: "error", code: "full", message: `この部屋は満員です（${MAX_PEOPLE}人まで）` }));
      server.close(4001, "full");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 入室の直前に、いまの部屋の設定を置いておく（入ってきた人に最初に渡すため。配り直しはしない） */
  async setConfig(config: RoomConfig): Promise<void> {
    await this.ctx.storage.put("config", config);
  }

  /**
   * 部屋の設定が変わったとき（Worker から呼ぶ）。入っている全員へ配り直す。
   * 公開中でなくなったら（まとめた・閉じた・開放前に戻した）、そのことを知らせて全員を出す。
   */
  async pushConfig(config: RoomConfig | null, state: AreaState = "open", movedTo: string | null = null): Promise<void> {
    // 準備中に戻したエリアからは出てもらう（試し場は管理者しか入れないので、そのまま配り直す）
    if (config && (state === "open" || (state === "draft" && config.id === TEST_AREA_ID))) {
      await this.ctx.storage.put("config", config);
      this.broadcast({ t: "config", config: this.publicConfig(config) });
      return;
    }
    if (config) await this.ctx.storage.put("config", config);
    else await this.ctx.storage.delete("config");
    const msg = state === "moved" && movedTo ? { t: "moved", to: movedTo } : { t: "closed", state };
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(msg));
        ws.close(4003, state);
      } catch {
        // もう切れている
      }
    }
  }

  /** 部屋にいまいる人数（管理画面・ロビー用） */
  async population(): Promise<{ people: number; actors: number }> {
    let people = 0;
    let actors = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined) {
        people += 1;
        actors += a.actors.length;
      }
    }
    return { people, actors };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (text.length > MAX_MESSAGE_BYTES) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    if (!att) return;

    switch (msg.t) {
      case "join":
        await this.onJoin(ws, att, msg);
        return;
      case "move":
        this.onMove(ws, att, msg);
        return;
      case "stamp":
        this.onStamp(ws, att, msg);
        return;
      case "greet":
        this.onGreet(ws, att, msg);
        return;
      case "talk":
        await this.onTalk(ws, att, msg);
        return;
      case "typing":
        this.onTyping(ws, att, msg);
        return;
      case "ping":
        this.send(ws, { t: "pong" });
        return;
      case "leave":
        // 画面を閉じる・ロビーへ戻るときに、画面側から先に知らせる（回線が切れるのを待たずに消える）
        await this.leave(ws);
        return;
      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    await this.leave(ws);
    // 閉じる手続きをこちらからも返して終わらせる（返さないと、相手側の close が完了しない実行環境がある）
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* すでに閉じている */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  // ---- 内部 ----

  private async onJoin(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (att.joined) return;
    const list = Array.isArray(msg.characters) ? msg.characters.slice(0, MAX_ACTORS_PER_PERSON) : [];

    // すでに部屋にいる分身（同じ子を2つの端末・タブから連れてきた）は重ねない
    const present = new Set<string>();
    for (const other of this.ctx.getWebSockets()) {
      const a = other.deserializeAttachment() as Attachment | null;
      a?.actors.forEach((x) => present.add(x.cidHash));
    }

    const joined: PublicActor[] = [];
    // 断った子と理由（符号）。画面は index で自分の一覧と突き合わせ、子の名前つきで直し方を出す
    const rejected: Array<{ index: number; code: string }> = [];
    for (const [index, item] of list.entries()) {
      const cid = typeof item?.cid === "string" ? item.cid.slice(0, 200) : "";
      const token = typeof item?.token === "string" ? item.token.slice(0, 200) : "";
      if (!cid || !token) {
        rejected.push({ index, code: "no_token" });
        continue;
      }
      const cidHash = await hashShort(cid);
      if (present.has(cidHash)) {
        rejected.push({ index, code: "already_here" });
        continue;
      }
      let result: Awaited<ReturnType<CharacterState["getMetaverseAvatar"]>>;
      try {
        result = await this.env.CHARACTER.getByName(cid).getMetaverseAvatar(token);
      } catch {
        rejected.push({ index, code: "unavailable" });
        continue;
      }
      if (!result.ok) {
        rejected.push({ index, code: result.error });
        continue;
      }
      const aid = randomToken(8);
      // 入ってきた位置は、中央付近のばらけた場所
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.5 + Math.random() * 2.5;
      const actor: PublicActor = {
        aid,
        name: result.name.slice(0, 16),
        species: result.species,
        color: result.color,
        voice: result.voice,
        compact: { ...result.compact, id: aid },
        x: Math.round(Math.cos(angle) * radius * 100) / 100,
        z: Math.round(Math.sin(angle) * radius * 100) / 100,
      };
      await this.ctx.storage.put(`actor:${aid}`, actor);
      att.actors.push({ aid, x: actor.x, z: actor.z, cidHash, cid });
      present.add(cidHash);
      joined.push(actor);
    }

    if (joined.length === 0) {
      this.send(ws, { t: "error", code: "join_failed", rejected, message: "連れて入れる分身がいませんでした" });
      return;
    }

    att.joined = true;
    ws.serializeAttachment(att);

    const config = (await this.ctx.storage.get<RoomConfig>("config")) ?? null;
    this.send(ws, {
      t: "welcome",
      you: att.pid,
      mine: joined.map((a) => a.aid),
      actors: await this.allActors(),
      config: config ? this.publicConfig(config) : null,
      notices: rejected,
    });
    this.broadcast({ t: "joined", actors: joined }, ws);
  }

  private onMove(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (!att.joined) return;
    const now = Date.now();
    const windowId = Math.floor(now / 1000);
    if (att.moveWindow !== windowId) {
      att.moveWindow = windowId;
      att.moveCount = 0;
    }
    if (++att.moveCount > MOVES_PER_SECOND) return;

    const actor = att.actors.find((a) => a.aid === msg.aid);
    const x = clampCoord(msg.x);
    const z = clampCoord(msg.z);
    if (!actor || x === null || z === null) return;
    actor.x = x;
    actor.z = z;
    ws.serializeAttachment(att);
    this.broadcast({ t: "move", aid: actor.aid, x, z }, ws);
  }

  private onStamp(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (!att.joined) return;
    const now = Date.now();
    if (now - att.lastStampAt < STAMP_INTERVAL_MS) return;
    const actor = att.actors.find((a) => a.aid === msg.aid);
    if (!actor || !(STAMPS as readonly string[]).includes(String(msg.kind))) return;
    att.lastStampAt = now;
    ws.serializeAttachment(att);
    this.broadcast({ t: "stamp", aid: actor.aid, kind: msg.kind }, ws);
  }

  private onGreet(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (!att.joined) return;
    const now = Date.now();
    if (now - att.lastGreetAt < GREET_INTERVAL_MS) return;
    const actor = att.actors.find((a) => a.aid === msg.aid);
    const line = Number(msg.line);
    if (!actor || !Number.isInteger(line) || line < 0 || line >= GREETING_LINES.length) return;
    att.lastGreetAt = now;
    ws.serializeAttachment(att);
    this.broadcast({ t: "greet", aid: actor.aid, line }, ws);
  }

  /** 「いま自分の分身と話している」印（吹き出しに「…」を出すだけ。中身は配らない） */
  private onTyping(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (!att.joined) return;
    const now = Date.now();
    if (now - (att.lastTypingAt ?? 0) < 1500) return;
    const actor = att.actors.find((a) => a.aid === msg.aid);
    if (!actor) return;
    att.lastTypingAt = now;
    ws.serializeAttachment(att);
    this.broadcast({ t: "typing", aid: actor.aid }, ws);
  }

  /** 部屋の中で、aid から「分身の識別子・名前・姿」を引く（利用者の分身と NPC） */
  private async findSpeaker(aid: string): Promise<{ cid: string; name: string; species: string; color: string; npc: boolean; key: string } | null> {
    const config = await this.ctx.storage.get<RoomConfig>("config");
    const npc = config?.npcs?.find((n) => n.aid === aid);
    if (npc) {
      if ((npc as { talk?: boolean }).talk === false) return null;
      return { cid: npc.cid, name: String(npc.name), species: String(npc.species), color: String(npc.color), npc: true, key: await hashShort(npc.cid) };
    }
    for (const other of this.ctx.getWebSockets()) {
      const a = other.deserializeAttachment() as Attachment | null;
      const hit = a?.joined ? a.actors.find((x) => x.aid === aid) : undefined;
      if (hit) {
        const pub = await this.ctx.storage.get<PublicActor>(`actor:${aid}`);
        if (!pub) return null;
        return { cid: hit.cid, name: pub.name, species: pub.species, color: pub.color, npc: false, key: hit.cidHash };
      }
    }
    return null;
  }

  private async onTalk(ws: WebSocket, att: Attachment, msg: Record<string, unknown>) {
    if (!att.joined) return;
    const now = Date.now();
    const auto = msg.auto === true;
    if (now - (att.lastTalkAt ?? 0) < (auto ? AUTO_TALK_INTERVAL_MS : TALK_INTERVAL_MS)) {
      this.send(ws, { t: "talk_failed", code: "too_fast", message: "少し待ってから、また話しかけてね" });
      return;
    }
    if ((att.talkCount ?? 0) >= TALKS_PER_CONNECTION) {
      this.send(ws, { t: "talk_failed", code: "limit", message: "今日はたくさんお話ししたね。また入り直すと話せるよ" });
      return;
    }
    const mine = att.actors.find((a) => a.aid === msg.aid);
    const toAid = typeof msg.to === "string" ? msg.to.slice(0, 40) : "";
    if (!mine || !toAid || toAid === mine.aid) return;
    const me = await this.findSpeaker(mine.aid);
    const target = await this.findSpeaker(toAid);
    if (!me || !target) {
      this.send(ws, { t: "talk_failed", code: "no_target", message: "その子とは、いまお話しできないみたい" });
      return;
    }
    att.lastTalkAt = now;
    att.talkCount = (att.talkCount ?? 0) + 1;
    ws.serializeAttachment(att);

    const hint = auto ? "" : sanitizeHint(msg.hint);
    const label = (species: string) => SPECIES_LABELS[species as SpeciesKey] ?? "ふしぎな生きもの";
    const config = await this.ctx.storage.get<RoomConfig>("config");
    const place = config?.name ?? "";
    type Talker = NonNullable<Awaited<ReturnType<MetaverseRoom["findSpeaker"]>>>;
    const say = async (speaker: Talker, speakerAid: string, listener: Talker, heard?: string, extra: { hint?: string; auto?: boolean } = {}) => {
      this.broadcast({ t: "typing", aid: speakerAid });
      try {
        const r = await this.env.CHARACTER.getByName(speaker.cid).metaTalk({
          otherName: listener.name,
          otherSpeciesLabel: label(listener.species),
          otherSpecies: listener.species,
          otherColor: listener.color,
          heard,
          hint: extra.hint,
          auto: extra.auto,
          partnerKey: listener.key,
          place,
          npc: listener.npc,
        });
        return r;
      } catch {
        return { ok: false as const, error: "unavailable" };
      }
    };

    // 1往復（自動のときは2往復）。どちらも、それぞれの分身が自分の言葉で話す
    const rounds = auto ? 2 : 1;
    let heard: string | undefined;
    for (let round = 0; round < rounds; round++) {
      const first = await say(me, mine.aid, target, heard, round === 0 ? { hint, auto } : {});
      if (!first.ok) {
        if (round === 0) this.send(ws, { t: "talk_failed", code: first.error, message: "うまく言葉が出てこなかったみたい" });
        return;
      }
      this.broadcast({ t: "say", aid: mine.aid, to: toAid, line: first.line });
      // 前にも会ったことがある相手なら、話しかけた本人にだけ知らせる（交流の記録とつながっている）
      if (round === 0 && first.metBefore > 0) this.send(ws, { t: "met_before", aid: toAid, count: first.metBefore + 1 });
      const reply = await say(target, toAid, me, first.line);
      if (!reply.ok) return;
      this.broadcast({ t: "say", aid: toAid, to: mine.aid, line: reply.line });
      heard = reply.line;
    }
    // 最後の返事も、話しかけた側の交流の記録に残す
    if (heard) await this.env.CHARACTER.getByName(me.cid).metaHear(target.key, heard).catch(() => undefined);
  }

  private async leave(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || !att.joined) return;
    const aids = att.actors.map((a) => a.aid);
    att.joined = false;
    att.actors = [];
    try {
      ws.serializeAttachment(att);
    } catch {
      /* 閉じた後は書けないことがある */
    }
    if (aids.length > 0) {
      await this.ctx.storage.delete(aids.map((aid) => `actor:${aid}`));
      this.broadcast({ t: "left", aids }, ws);
    }
  }

  /** いま部屋にいる分身すべて（つながっている端末の分だけ。落ちた端末の残りは拾わない） */
  private async allActors(): Promise<PublicActor[]> {
    const live: Array<{ aid: string; x: number; z: number }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.joined) live.push(...a.actors);
    }
    if (live.length === 0) return [];
    const stored = await this.ctx.storage.get<PublicActor>(live.map((a) => `actor:${a.aid}`));
    const out: PublicActor[] = [];
    for (const a of live) {
      const actor = stored.get(`actor:${a.aid}`);
      if (actor) out.push({ ...actor, x: a.x, z: a.z });
    }
    return out;
  }

  /** 画面に渡す設定（内部の印は落とす） */
  private publicConfig(config: RoomConfig) {
    return {
      id: config.id,
      name: config.name,
      place: config.place,
      time: config.time,
      camera: config.camera,
      objects: config.objects,
      // NPC は分身の識別子（cid）を抜いて渡す
      npcs: (config.npcs ?? []).map(({ cid: _cid, ...rest }) => rest),
      placements: config.placements ?? [],
      plotsForSale: config.plotsForSale ?? [],
    };
  }

  private send(ws: WebSocket, data: unknown) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* 相手が切れていたら、close のほうで片付く */
    }
  }

  private broadcast(data: unknown, except?: WebSocket) {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a?.joined) continue;
      try {
        ws.send(text);
      } catch {
        /* noop */
      }
    }
  }
}
