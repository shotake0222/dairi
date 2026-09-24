/**
 * わけたまのメタバース（/meta）。
 *
 *   /meta?cid=<分身>              キャラクター画面から来たとき。その子と一緒に入る部屋を選ぶ
 *   /meta?cid=<分身>&room=<id>    その子と、その部屋へ入る
 *   /meta                         この端末の分身から、連れて行く子を選ぶ
 *
 * 部屋の設定（場所・時間帯・最初のカメラ・置く物＝看板／動画／ミニゲーム）は管理画面で作り
 * （src/metaverse.ts）、入室・移動・挨拶の中継は Durable Object（src/durable-objects/metaverseRoom.ts）。
 * この画面は、届いた「姿と動きの数値」から分身を描き、人格どおりに動かすだけ。
 *
 * スマホで動かすための約束:
 *   - 描画の解像度は端末の画素密度に合わせすぎない（最大1.75倍）
 *   - 影・後処理は使わない。光は2つ
 *   - 画面を隠している間（別のタブ・ロック）は描画を止める
 */

import * as THREE from "/vendor/three.module.min.js";
import { buildWorld } from "./world.mjs";
import { Actor } from "./actors.mjs";
import { buildObjects } from "./objects.mjs";
import { GameRunner } from "./games.mjs";
import { buildPlacements } from "./land.mjs";
import { openGazePicker } from "./gaze.mjs";
import { createWallet } from "./wallet.mjs";
import { spawnEffect } from "./wear.mjs";
import { createImageViewer } from "./imageviewer.mjs";

const MY_CHARACTERS_KEY = "sodatsukake_myCharacters";
const SOUND_KEY = "sodatsukake_metaSound";
const CAMERA_KEY = "sodatsukake_metaCamera";
const NOTICE_KEY = "sodatsukake_metaNoticeSeen";
/** 自動（育った人格が自分で歩いて話しかける）か、手動（自分で動かして入力する）か */
const MODE_KEY = "sodatsukake_metaMode";

const STAMP_TEXT = { heart: "♡", clap: "ぱちぱち", wow: "！", question: "？", music: "♪", sleepy: "zzz" };

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = params.get("room");
const fromCid = params.get("cid");

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 保存できなくても、この場では使える */
  }
}
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, init) {
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "うまくいきませんでした");
  return data;
}

function myCharacters() {
  try {
    const list = JSON.parse(load(MY_CHARACTERS_KEY) || "[]");
    return (Array.isArray(list) ? list : [])
      .map((c) => ({ ...c, token: load(`sodatsukake_token_${c.cid}`) }))
      .filter((c) => c.cid && c.token);
  } catch {
    return [];
  }
}

/** ミニゲームかどうか（種類の定義は、サーバーが返す catalog.objectTypes） */
function isGame(catalog, type) {
  return !!(catalog.objectTypes || []).find((t) => t.id === type && t.game);
}

function formatDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function labelOf(list, id) {
  return (list.find((x) => x.id === id) || {}).label || id;
}

const back = $("backLink");
back.href = fromCid ? `/chat?cid=${encodeURIComponent(fromCid)}` : "/home";
// 部屋から出るときは、キャラクター画面から来たならそこへ、そうでなければロビーへ
$("hudBack").href = fromCid ? `/chat?cid=${encodeURIComponent(fromCid)}` : "/meta";

// ---------------------------------------------------------------- ダイアログ・案内

function dialog({ title, body, actions }) {
  $("dlgTitle").textContent = title || "";
  $("dlgBody").textContent = body || "";
  const bar = $("dlgActions");
  bar.innerHTML = "";
  for (const a of actions || [{ label: "とじる" }]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = a.label;
    if (a.primary) b.className = "primary";
    b.addEventListener("click", () => {
      $("dialog").hidden = true;
      a.run?.();
    });
    bar.appendChild(b);
  }
  $("dialog").hidden = false;
}

/**
 * 部屋に断られた子について、理由ごとに直し方を案内する。
 * （以前はすべて「この端末の分身だと確かめられませんでした」だった）
 */
const REJECT_TEXT = {
  not_owner: (n) =>
    `「${n}」は、この端末では持ち主だと確かめられませんでした。別の端末で育てた子か、この端末の持ち主の印が古くなっています。` +
    `もとの端末で「📦 保存/復元」から引き継ぎコードを出すと、この端末に戻せます。`,
  no_token: (n) => `「${n}」の持ち主の印が、この端末にありません。引き継ぎコードで戻せます。`,
  no_consent: (n) => `「${n}」は、まだ「はじめる前の同意」が済んでいません。キャラクター画面を開くと、同意の画面が出ます。`,
  not_found: (n) => `「${n}」が見つかりませんでした。削除された子かもしれません。`,
  already_here: (n) => `「${n}」は、もうこの部屋にいます（別のタブや端末で入っています）。`,
  unavailable: (n) => `「${n}」をいま確かめられませんでした。少し待ってから入り直してください。`,
  audit_failed: (n) => `「${n}」の動きの数値を用意できませんでした。少し待ってから入り直してください。`,
};

function explainRejections(rejected, chosen) {
  const lines = [];
  let fixCid = null;
  for (const r of rejected || []) {
    const c = chosen[r.index];
    const name = (c && c.name) || "この子";
    lines.push((REJECT_TEXT[r.code] || REJECT_TEXT.unavailable)(name));
    if (c && ["no_consent", "not_owner", "no_token"].includes(r.code)) fixCid = fixCid || c.cid;
    // この端末の「同意済み」の印が古かった。次に入るときは同意の画面を出し直す
    if (c && r.code === "no_consent") window.waketamaGate?.forget?.(c.cid);
  }
  return { text: lines.join("\n\n"), fixCid };
}

/** ミニゲーム中の短い案内（画面の上の方に、しばらく出す）。null で消す */
function hint(text, ms = 2200) {
  const el = $("gameHint");
  clearTimeout(hint.timer);
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  hint.timer = setTimeout(() => (el.hidden = true), ms);
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2400);
}

// ---------------------------------------------------------------- ロビー・連れて行く子

async function showLobby() {
  $("lobby").hidden = false;
  let data;
  try {
    data = await api("/api/meta/rooms");
  } catch (e) {
    $("roomList").textContent = e.message;
    return;
  }
  const { rooms, catalog } = data;
  const chars = myCharacters();
  const picker = $("picker");

  if (chars.length === 0) {
    picker.innerHTML = `<p class="empty">この端末には、まだ分身がいません。<br />依代をかざして分身を迎えてから来てください。</p>`;
  } else {
    const max = catalog.maxActorsPerPerson;
    picker.innerHTML = "";
    chars.forEach((c, i) => {
      const label = document.createElement("label");
      label.className = "pick";
      const img = c.species && c.color ? window.WaketamaSpecies.image(c.species, c.color) : "";
      const on = fromCid ? c.cid === fromCid : i === 0;
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(c.cid)}" ${on ? "checked" : ""} />
        ${img ? `<img src="${escapeHtml(img)}" alt="" />` : ""}<span>${escapeHtml(c.name || "名もなき分身")}</span>`;
      picker.appendChild(label);
    });
    picker.addEventListener("change", (e) => {
      const checked = [...picker.querySelectorAll("input:checked")];
      if (checked.length > max) {
        e.target.checked = false;
        toast(`連れて行けるのは${max}体までです`);
      }
    });
  }
  // 注意書きは、はじめての1回だけ開いて見せる。2回目からは畳んでおく（見出しを押せばいつでも読める）
  $("noticeBox").open = load(NOTICE_KEY) !== "1";
  store(NOTICE_KEY, "1");

  const chosen = () =>
    [...picker.querySelectorAll("input:checked")].map((el) => chars.find((c) => c.cid === el.value)).filter(Boolean);

  const go = async (room) => {
    const list = chosen();
    if (list.length === 0) {
      toast("いっしょに行く子を選んでね");
      return;
    }
    unlockAudio();
    // 「はじめる前の同意」がまだの子（同意の文面の版が上がった後、まだ開いていない子など）は、
    // ここで同意の画面を出す。入ってから断られるより先に済ませる
    const ready = [];
    for (const c of list) {
      const ok = window.waketamaGate ? await window.waketamaGate.require(c.cid, c.token) : true;
      if (ok) ready.push(c);
    }
    if (ready.length === 0) return;
    list.length = 0;
    list.push(...ready);
    $("lobby").hidden = true;
    history.replaceState(null, "", `/meta?room=${encodeURIComponent(room.id)}${fromCid ? `&cid=${encodeURIComponent(fromCid)}` : ""}`);
    enterRoom(room, catalog, list);
  };

  $("roomList").innerHTML = "";
  if (rooms.length === 0) $("roomList").innerHTML = `<p class="empty">いま開いているエリアはありません。</p>`;
  for (const r of rooms) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `roomCard place-${r.place} time-${r.time}${r.state === "soon" ? " soon" : ""}`;
    const games = r.objects.filter((o) => isGame(catalog, o.type)).map((o) => o.title);
    const soon = r.state === "soon" ? `<em class="soonTag">近日開放: ${escapeHtml(formatDate(r.opensAt))}</em>` : "";
    b.innerHTML = `<b>${escapeHtml(r.name)}</b><span>${escapeHtml(labelOf(catalog.places, r.place))}・${escapeHtml(labelOf(catalog.times, r.time))}</span>${
      games.length ? `<em>あそべる: ${escapeHtml(games.join("・"))}</em>` : ""
    }${soon}`;
    b.addEventListener("click", () => {
      if (r.state === "soon") {
        toast(`「${r.name}」は ${formatDate(r.opensAt)} に開きます`);
        return;
      }
      go(r);
    });
    $("roomList").appendChild(b);
  }

  // リンクでエリアが決まっているとき（一覧に出していないエリアも含む）
  if (roomId) {
    try {
      const info = await api(`/api/meta/rooms/${encodeURIComponent(roomId)}`);
      const { room } = info;
      $("directRoom").hidden = false;
      $("directName").textContent = room.name;
      // まとめたエリアの古いリンク: まとめた先へ案内する
      if (info.movedFrom) $("directNote").textContent = "このエリアは、ほかのエリアとひとつになりました。新しいエリアへご案内します。";
      if (!info.canEnter) {
        $("directNote").textContent = info.message || "このエリアには、いまは入れません。";
        $("directGo").disabled = true;
      } else {
        $("directGo").addEventListener("click", () => go(room));
      }
    } catch (e) {
      toast(e.message);
    }
  }
}

// ---------------------------------------------------------------- 声

let japaneseVoices = [];
function refreshVoices() {
  if (typeof speechSynthesis === "undefined") return;
  japaneseVoices = speechSynthesis.getVoices().filter((v) => (v.lang || "").toLowerCase().startsWith("ja"));
}
if (typeof speechSynthesis !== "undefined") {
  refreshVoices();
  speechSynthesis.addEventListener?.("voiceschanged", refreshVoices);
}

function unlockAudio() {
  try {
    window.WaketamaVoice?.unlock();
    if (typeof speechSynthesis !== "undefined") {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {
    /* 音が出せない端末でも、見た目は動く */
  }
}

let soundOn = load(SOUND_KEY) !== "0";

/** その子の声で喋らせる。高音質がオンなら MeloTTS（声ごとに再生速度を変える）、だめなら端末の声 */
async function speak(text, voice) {
  if (!soundOn || !text) return;
  if (window.WaketamaVoice && WaketamaVoice.getQuality() === "high") {
    if (await WaketamaVoice.speakHighQuality(text, { voice })) return;
  }
  if (typeof speechSynthesis === "undefined") return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    if (japaneseVoices.length && voice) u.voice = japaneseVoices[voice.voiceIndex % japaneseVoices.length];
    if (voice) {
      u.pitch = voice.pitch;
      u.rate = voice.rate;
    }
    speechSynthesis.speak(u);
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------- 部屋

function enterRoom(room, catalog, chosen) {
  const stage = $("stage");
  stage.hidden = false;
  $("hud").hidden = false;
  $("hudName").textContent = room.name;

  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  // alpha: カメラの映像を背景に映すミニゲーム（AR）のため。部屋の空は scene.background で塗る
  const renderer = new THREE.WebGLRenderer({ antialias: dpr < 2, powerPreference: "low-power", alpha: true });
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
  let world = null;
  let things = null;
  let land = null;
  let config = room;
  /** 自分の子の aid → 分身の識別子（自分の子と話すときに使う。端末の外へは出さない） */
  const mineCid = new Map();
  /** 話しかける相手（null なら自分の子と話す） */
  let talkTarget = null;
  /** 自動モード: 育った人格（性格の数値）で、自分の子が自分から歩き・話しかける */
  let autoMode = load(MODE_KEY) === "auto";
  let autoPauseUntil = 0;
  let lastAutoTalk = -Infinity;
  let autoTalkOff = false;

  const actors = new Map(); // aid -> Actor
  let mine = [];
  let selected = null;
  let ws = null;
  let closedByUs = false;

  // --- ミニゲーム ---
  const games = new GameRunner({
    THREE,
    scene,
    renderer,
    roomId: room.id,
    catalog,
    layer: {
      root: $("gameLayer"),
      touch: $("gameTouch"),
      ctrl: $("gameCtrl"),
      meter: $("gameMeters"),
      center: $("gameCenter"),
      info: $("gameInfo"),
      video: $("arVideo"),
    },
    hint,
    sound: () => soundOn,
    speak,
    aspect: () => camera.aspect,
    me: () => selected,
    get avoid() {
      return (things?.items || []).map((i) => ({ x: i.root.position.x, z: i.root.position.z }));
    },
    hud: (text) => {
      $("gameHud").hidden = !text;
      $("gameHud").textContent = text || "";
      $("gameInfo").textContent = text || "";
      $("quitGame").hidden = !text;
    },
    dialog,
    onClear: (o) => {
      if (selected) send({ t: "clear", aid: selected.aid, objectId: o.id });
    },
    celebrate: () => {
      if (!selected) return;
      selected.bubble("やったね！", 2400);
      speak("やったね！", selected.voice);
      selected.act("greet");
      // 同じ部屋の人には、拍手のスタンプで知らせる（自由な文字は配らない）
      send({ t: "stamp", aid: selected.aid, kind: "clap" });
    },
  });
  $("quitGame").addEventListener("click", () => games.stop());
  $("quitGame2").addEventListener("click", () => games.stop());

  // --- 通貨・お店（wallet.mjs）と、演出（wear.mjs） ---
  const wallet = createWallet({
    $,
    dialog,
    toast,
    hint,
    selected: () => selected,
    creds: (aid) => {
      const cid = mineCid.get(aid);
      const c = cid ? chosen.find((x) => x.cid === cid) : null;
      return c && c.token ? { cid, token: c.token } : null;
    },
    send: (m) => send(m),
  });
  const effects = [];
  const imageViewer = createImageViewer($);
  $("shopBtn").addEventListener("click", () => {
    const shops = (config.objects || []).filter((o) => o.type === "shop");
    if (shops.length === 1) return wallet.openShop(shops[0].shopId, shops[0].title);
    dialog({
      title: "このエリアのお店",
      body: "どのお店に入りますか？",
      actions: [...shops.map((o) => ({ label: `🛍 ${o.title}`, primary: true, run: () => wallet.openShop(o.shopId, o.title) })), { label: "とじる" }],
    });
  });

  // --- カメラ ---
  const CAMERA_MODES = catalog.cameras.map((c) => c.id);
  let cameraMode = load(CAMERA_KEY) || room.camera || "overview";
  if (!CAMERA_MODES.includes(cameraMode)) cameraMode = "overview";
  let yaw = 0;
  let zoom = 1;
  const camTarget = new THREE.Vector3(0, 0.5, 0);

  function updateCameraLabel() {
    $("camBtn").textContent = `視点: ${labelOf(catalog.cameras, cameraMode)}`;
  }
  updateCameraLabel();
  $("camBtn").addEventListener("click", () => {
    cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length];
    store(CAMERA_KEY, cameraMode);
    updateCameraLabel();
  });

  function placeCamera(dt) {
    const sel = selected ? selected.position : new THREE.Vector3();
    let pos;
    let look;
    // 縦長の画面では横の見える幅が狭いので、少し引いて左右の屋台が入るようにする
    const portrait = Math.min(1.75, Math.max(1, Math.sqrt(0.75 / Math.max(0.3, camera.aspect)) * 1.12));
    if (cameraMode === "overview") {
      const r = 13 * zoom * portrait;
      pos = new THREE.Vector3(Math.sin(yaw) * r, 10 * zoom * portrait, Math.cos(yaw) * r);
      look = new THREE.Vector3(0, 0.3, 0);
    } else if (cameraMode === "front") {
      const r = 8 * zoom * portrait;
      pos = new THREE.Vector3(Math.sin(yaw) * r, 2.2, Math.cos(yaw) * r);
      look = new THREE.Vector3(0, 0.8, 0);
    } else if (cameraMode === "follow") {
      const h = (selected ? selected.group.rotation.y : 0) + yaw;
      const r = 6 * zoom;
      pos = sel.clone().add(new THREE.Vector3(-Math.sin(h) * r, 3.2 * zoom, -Math.cos(h) * r));
      look = sel.clone().add(new THREE.Vector3(0, 0.7, 0));
    } else {
      // この子の目線: 頭の高さから、向いている方へ
      const h = (selected ? selected.group.rotation.y : 0) + yaw;
      pos = sel.clone().add(new THREE.Vector3(Math.sin(h) * 0.2, 0.95, Math.cos(h) * 0.2));
      look = pos.clone().add(new THREE.Vector3(Math.sin(h) * 5, -0.4, Math.cos(h) * 5));
    }
    const k = Math.min(1, dt * 5);
    camera.position.lerp(pos, k);
    camTarget.lerp(look, k);
    camera.lookAt(camTarget);
  }

  // --- 場所・置く物 ---
  function refreshPeople() {
    $("hudCount").textContent = `${actors.size}体`;
    things?.refreshMembers([...actors.values()].map((a) => `${a.name}（${window.WaketamaSpecies.label(a.species)}）`));
  }

  function applyConfig(next) {
    config = next;
    $("hudName").textContent = config.name;
    games.stop();
    world?.dispose();
    things?.dispose();
    world = buildWorld(THREE, scene, config.place, config.time);
    things = buildObjects(THREE, scene, config.objects || [], catalog);
    land?.dispose();
    land = buildPlacements(THREE, scene, config.placements || [], config.plotsForSale || [], catalog);
    syncNpcs(config.npcs || []);
    refreshPeople();
    // お店の屋台は画面の端（縦長の画面では外）にあることが多いので、HUD からも開けるようにする
    $("shopBtn").hidden = !(config.objects || []).some((o) => o.type === "shop");
  }

  // --- NPC（運営が置いた分身）。動きは各端末で同じ規則（時刻と番号から決まる散歩）で計算する ---
  function syncNpcs(list) {
    const keep = new Set(list.map((n) => n.aid));
    for (const [aid, a] of [...actors]) if (a.npc && !keep.has(aid)) removeActor(aid);
    for (const n of list) {
      if (actors.has(n.aid)) continue;
      const a = new Actor(THREE, n, { mine: false, scene, npc: n });
      a.npcHome = { x: n.x, z: n.z };
      actors.set(n.aid, a);
    }
  }

  function hashNum(text) {
    let h = 2166136261;
    for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
  }

  function wanderNpcs() {
    const now = Date.now() / 1000;
    for (const a of actors.values()) {
      if (!a.npc || !(a.npc.radius > 0) || a.busy) continue;
      const phase = hashNum(a.aid) * 8;
      const epoch = Math.floor((now + phase) / 8);
      if (a.npcEpoch === epoch) continue;
      a.npcEpoch = epoch;
      const r = hashNum(`${a.aid}:${epoch}`);
      const ang = hashNum(`${epoch}:${a.aid}`) * Math.PI * 2;
      const dist = a.npc.radius * Math.sqrt(r);
      const half = catalog.worldHalf - 0.5;
      a.setDestination(
        Math.max(-half, Math.min(half, a.npcHome.x + Math.cos(ang) * dist)),
        Math.max(-half, Math.min(half, a.npcHome.z + Math.sin(ang) * dist))
      );
    }
  }
  applyConfig(room);

  // --- 分身 ---
  function addActor(data) {
    if (actors.has(data.aid)) return actors.get(data.aid);
    const isMine = mine.includes(data.aid);
    const actor = new Actor(THREE, data, { mine: isMine, scene });
    if (isMine) actor.onMoved = (x, z) => send({ t: "move", aid: actor.aid, x, z });
    actors.set(data.aid, actor);
    return actor;
  }
  function removeActor(aid) {
    const a = actors.get(aid);
    if (!a) return;
    a.dispose(scene);
    actors.delete(aid);
    if (selected === a) selected = null;
    if (talkTarget === a) setTalkTarget(null);
  }

  function renderMine() {
    const bar = $("mineBar");
    bar.innerHTML = "";
    for (const aid of mine) {
      const a = actors.get(aid);
      if (!a) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = `chip${a === selected ? " on" : ""}`;
      b.innerHTML = `<img src="${escapeHtml(window.WaketamaSpecies.image(a.species, a.color))}" alt="" /><span>${escapeHtml(a.name)}</span>`;
      b.addEventListener("click", () => {
        selected = a;
        setTalkTarget(talkTarget);
        renderMine();
        wallet.refresh();
      });
      bar.appendChild(b);
    }
  }

  function greetFrom(actor, lineIndex, { broadcast }) {
    const line = catalog.greetings[lineIndex] || catalog.greetings[0];
    actor.bubble(line);
    speak(line, actor.voice);
    actor.act("greet");
    if (broadcast) send({ t: "greet", aid: actor.aid, line: lineIndex });
  }
  const randomLine = () => Math.floor(Math.random() * catalog.greetings.length);

  // --- 通信 ---
  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/meta/rooms/${encodeURIComponent(room.id)}/ws`);
    $("hudStatus").textContent = "つないでいます…";
    ws.addEventListener("open", () => {
      send({ t: "join", characters: chosen.map((c) => ({ cid: c.cid, token: c.token })) });
    });
    ws.addEventListener("message", (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onMessage(msg);
    });
    ws.addEventListener("close", () => {
      if (closedByUs) return;
      $("hudStatus").textContent = "";
      $("lost").hidden = false;
    });
  }

  function onMessage(msg) {
    switch (msg.t) {
      case "welcome": {
        $("hudStatus").textContent = "";
        mine = msg.mine || [];
        {
          const rejectedIdx = new Set((msg.notices || []).map((n) => n.index));
          const ok = chosen.filter((_, i) => !rejectedIdx.has(i));
          mine.forEach((aid, i) => ok[i] && mineCid.set(aid, ok[i].cid));
        }
        for (const a of msg.actors || []) addActor(a);
        selected = actors.get(mine[0]) || null;
        if (msg.config) applyConfig({ ...config, ...msg.config });
        if ((msg.notices || []).length) {
          const { text } = explainRejections(msg.notices, chosen);
          dialog({ title: "いっしょに入れなかった子がいます", body: text, actions: [{ label: "とじる" }] });
        }
        renderMine();
        refreshPeople();
        wallet.refresh();
        break;
      }
      case "coins":
        wallet.onCoins(msg);
        break;
      case "wear": {
        const a = actors.get(msg.aid);
        if (a) a.setWear(msg.wear);
        break;
      }
      case "effect": {
        const a = actors.get(msg.aid);
        if (a) {
          effects.push(spawnEffect(THREE, scene, a.position.clone(), msg.effect));
          if (a.persona) a.act("greet");
        }
        break;
      }
      case "effect_left":
        wallet.onEffectLeft(msg);
        break;
      case "effect_failed":
        toast(msg.message || "使えませんでした");
        break;
      case "joined":
        for (const a of msg.actors || []) {
          const actor = addActor(a);
          actor.bubble("こんにちは", 1800);
        }
        refreshPeople();
        break;
      case "left":
        (msg.aids || []).forEach(removeActor);
        refreshPeople();
        break;
      case "move": {
        const a = actors.get(msg.aid);
        if (a && !a.mine) a.setDestination(msg.x, msg.z);
        break;
      }
      case "stamp": {
        const a = actors.get(msg.aid);
        if (a) a.bubble(STAMP_TEXT[msg.kind] || "♪", 2000, "stamp");
        break;
      }
      case "greet": {
        const a = actors.get(msg.aid);
        if (a) greetFrom(a, msg.line, { broadcast: false });
        break;
      }
      case "config":
        applyConfig({ ...config, ...msg.config });
        toast("部屋の様子が変わりました");
        break;
      case "typing": {
        const a = actors.get(msg.aid);
        if (a) a.bubble("…", 4000, "talk");
        break;
      }
      case "say": {
        const a = actors.get(msg.aid);
        if (!a) break;
        a.bubble(msg.line, 7000, "talk");
        a.act("greet");
        const other = actors.get(msg.to);
        if (other) {
          a.other = other;
          a.faceOther = true;
          setTimeout(() => (a.faceOther = false), 2500);
        }
        // 自分の子が関わる会話か、近くの会話だけ声に出す
        const near = selected && a.position.distanceTo(selected.position) < 6;
        if (a.mine || other?.mine || near) speak(msg.line, a.voice);
        if (other?.mine || a.mine) addTalkLog(a.name, msg.line, a.mine);
        break;
      }
      case "talk_failed":
        if (msg.code === "limit") autoTalkOff = true;
        // 自動モードで間隔が短すぎたときは黙って次を待つ
        if (!(autoMode && msg.code === "too_fast")) toast(msg.message || "うまく話せなかったみたい");
        break;
      case "met_before": {
        const a = actors.get(msg.aid);
        if (!a) break;
        a.metCount = msg.count;
        toast(`${a.name}とは${msg.count}回目の出会い！（交流の記録に残っています）`);
        addTalkLog("交流の記録", `${a.name}とは${msg.count}回目の出会い`, false);
        break;
      }
      case "moved":
        // エリアがまとめられた: まとめた先へ、同じ子たちで入り直す
        closedByUs = true;
        games.stop();
        dialog({
          title: "エリアがひとつになりました",
          body: "このエリアは、ほかのエリアとまとめられました。新しいエリアへ移動します。",
          actions: [
            {
              label: "移動する",
              primary: true,
              run: () => (location.href = `/meta?room=${encodeURIComponent(msg.to)}${fromCid ? `&cid=${encodeURIComponent(fromCid)}` : ""}`),
            },
            { label: "ロビーへ", run: () => (location.href = fromCid ? `/meta?cid=${encodeURIComponent(fromCid)}` : "/meta") },
          ],
        });
        break;
      case "closed":
        closedByUs = true;
        games.stop();
        $("lostText").textContent = msg.state === "soon" ? "このエリアは、開放の準備に戻りました。" : "このエリアは閉じられました。";
        $("reconnect").hidden = true;
        $("lost").hidden = false;
        break;
      case "error":
        if (msg.code === "join_failed") {
          const { text, fixCid } = explainRejections(msg.rejected, chosen);
          closedByUs = true;
          ws?.close();
          dialog({
            title: "部屋に入れませんでした",
            body: text || msg.message,
            actions: [
              ...(fixCid ? [{ label: "キャラクター画面を開く", primary: true, run: () => (location.href = `/chat?cid=${encodeURIComponent(fixCid)}`) }] : []),
              { label: "ロビーへ", run: () => (location.href = fromCid ? `/meta?cid=${encodeURIComponent(fromCid)}` : "/meta") },
            ],
          });
          break;
        }
        toast(msg.message || "うまくいきませんでした");
        if (msg.code === "full") {
          $("lost").hidden = false;
          $("lostText").textContent = msg.message;
        }
        break;
      default:
        break;
    }
  }

  $("reconnect").addEventListener("click", () => {
    $("lost").hidden = true;
    for (const aid of [...actors.keys()]) removeActor(aid);
    mine = [];
    connect();
  });
  const leave = () => {
    closedByUs = true;
    send({ t: "leave" });
    ws?.close();
  };
  $("hudBack").addEventListener("click", leave);
  window.addEventListener("pagehide", leave);

  // --- 看板・屋台をタップしたとき ---
  function onObjectTap(item) {
    const o = item.obj;
    if (o.type === "shop") {
      wallet.openShop(o.shopId, o.title);
      return;
    }
    if (isGame(catalog, o.type)) {
      if (!games.running) games.offer(item);
      return;
    }
    // 画像のある看板も、タップで詳細（画像の拡大）を開く
    if (o.type === "board" && (o.ad || o.couponCode || o.detail || o.qrUrl || o.imageUrl)) {
      openAdDetail({
        key: `o-${room.id}-${o.id}`,
        ad: !!o.ad,
        content: { title: o.title, text: o.text, detail: o.detail, imageUrl: o.imageUrl, linkUrl: o.linkUrl, sponsor: "", couponCode: o.couponCode, couponNote: o.couponNote, couponUntil: o.couponUntil, qrUrl: o.qrUrl },
      });
      return;
    }
    if (o.type === "board") {
      const actions = [];
      if (o.linkUrl) {
        let host = "";
        try {
          host = new URL(o.linkUrl).host;
        } catch {
          host = "";
        }
        actions.push({
          label: `${host || "リンク"} を開く`,
          primary: true,
          // 外のサイトへ出る。わけたまの情報（どの分身か等）は渡さない
          run: () => window.open(o.linkUrl, "_blank", "noopener,noreferrer"),
        });
      }
      actions.push({ label: "とじる" });
      dialog({ title: `${o.ad ? "【広告】" : ""}${o.title}`, body: o.text || "", actions });
    }
  }

  // --- NPC をタップしたとき ---
  function openNpcDialog(actor) {
    const n = actor.npc;
    const species = window.WaketamaSpecies.label(actor.species);
    const actions = [];
    if (n.talk !== false && selected) {
      actions.push({
        label: "話しかける",
        primary: true,
        run: () => {
          setTalkTarget(actor);
          openTalk();
        },
      });
    }
    if (n.linkUrl) {
      let host = "";
      try {
        host = new URL(n.linkUrl).host;
      } catch {
        host = "";
      }
      actions.push({ label: `${host || "リンク"} を開く`, run: () => window.open(n.linkUrl, "_blank", "noopener,noreferrer") });
    }
    actions.push({ label: "とじる" });
    actor.bubble(catalog.greetings[Math.floor(Math.random() * catalog.greetings.length)], 2500);
    speak(n.message || "こんにちは！", actor.voice);
    dialog({
      title: `${n.ad ? "【広告】" : ""}${actor.name}${n.role ? `（${n.role}）` : ""}`,
      body: `${n.message || `わけたまの${species}の${actor.name}です。`}\n\n運営の分身（NPC）です。話しかけると、この子が自分の言葉で答えます。`,
      actions,
    });
  }

  // --- 区画の広告・ランドマーク・販売中の目印 ---
  function onLandTap(item) {
    if (item.kind === "forsale") {
      const f = item.plot;
      const prices = [
        f.adPrice != null && (f.sale === "ad" || f.sale === "both") ? `広告 ${f.adPrice.toLocaleString()}円〜` : "",
        f.landmarkPrice != null && (f.sale === "landmark" || f.sale === "both") ? `ランドマーク ${f.landmarkPrice.toLocaleString()}円〜` : "",
      ].filter(Boolean);
      dialog({
        title: "この区画で、広告・ランドマークを募集しています",
        body: `広告の看板や、デジタルランドマーク（記念の塔・鳥居・像など）を置けます。\n${prices.join("／")}`,
        actions: [
          { label: "申し込みページを開く", primary: true, run: () => window.open(`/land?area=${encodeURIComponent(room.id)}&spot=${encodeURIComponent(f.spot)}`, "_blank", "noopener") },
          { label: "とじる" },
        ],
      });
      return;
    }
    const p = item.placement;
    openAdDetail({ key: `p-${p.id}`, ad: p.kind === "ad", landmark: p.kind === "landmark", content: p.content || {} });
  }

  function adEvent(key, type) {
    fetch("/api/meta-ad-event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, type }), keepalive: true }).catch(() => undefined);
  }

  /** 広告の詳細（画像・説明・QRコード・リンク・特別クーポン） */
  function openAdDetail({ key, ad, landmark, content: c }) {
    const sheet = $("adSheet");
    $("adTag").hidden = !ad;
    $("adTag").textContent = ad ? "広告" : "";
    $("adTitle").textContent = (landmark ? c.plaque || c.title : c.title) || "お知らせ";
    $("adSponsor").textContent = c.sponsor ? `提供: ${c.sponsor}` : "";
    // 画像は切り取らずに全体を見せ、タップで拡大表示へ（細かい文字まで読めるように）
    $("adImageWrap").hidden = !c.imageUrl;
    if (c.imageUrl) {
      $("adImage").src = c.imageUrl;
      $("adImage").alt = c.title || "";
      $("adImageWrap").onclick = () => imageViewer.open(c.imageUrl, c.title || "");
    }
    $("adText").textContent = [c.text, c.detail].filter(Boolean).join("\n\n");
    // クーポン（押すまでコードは隠す。押した回数だけ数える）
    const couponBox = $("adCoupon");
    const expired = c.couponUntil && Date.now() > c.couponUntil;
    couponBox.hidden = !c.couponCode;
    $("adCouponNote").textContent = c.couponNote || "";
    $("adCouponUntil").textContent = c.couponUntil ? `有効期限: ${new Date(c.couponUntil).toLocaleDateString("ja-JP")}` : "";
    $("adCouponCode").hidden = true;
    $("adCouponShow").hidden = false;
    $("adCouponShow").disabled = !!expired;
    $("adCouponShow").textContent = expired ? "期限が過ぎました" : "🎟 クーポンを表示";
    $("adCouponShow").onclick = () => {
      $("adCouponCode").hidden = false;
      $("adCouponCodeText").textContent = c.couponCode;
      $("adCouponShow").hidden = true;
      adEvent(key, "coupon");
    };
    $("adCouponCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(c.couponCode);
        toast("コードをコピーしました");
      } catch {
        toast(c.couponCode);
      }
    };
    // QRコード（行き先: 指定があればそれ、無ければリンク先）
    const qrTarget = c.qrUrl || c.linkUrl || "";
    const qrBox = $("adQr");
    qrBox.hidden = !qrTarget || typeof window.qrcode !== "function";
    if (!qrBox.hidden) {
      const qr = window.qrcode(0, "M");
      qr.addData(qrTarget);
      qr.make();
      $("adQrImg").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 });
      $("adQrCap").textContent = "スマホのカメラで読み取ると開きます";
    }
    const link = $("adLink");
    link.hidden = !c.linkUrl;
    if (c.linkUrl) {
      let host = "";
      try {
        host = new URL(c.linkUrl).host;
      } catch {
        host = "";
      }
      link.textContent = `${host || "リンク"} を開く ↗`;
      link.onclick = () => {
        adEvent(key, "click");
        // 外のサイトへ出る。わけたまの情報（どの分身か等）は渡さない
        window.open(c.linkUrl, "_blank", "noopener,noreferrer");
      };
    }
    sheet.hidden = false;
    adEvent(key, "view");
  }
  $("adClose").addEventListener("click", () => ($("adSheet").hidden = true));

  // --- メタバースでの会話（吹き出しの中で、文字・声・視線で入力する） ---
  //   相手なし  … 自分の子と話す（ふだんの会話と同じ。育つ。返事は自分の画面だけに出す＝覚えていることを人前で言わない）
  //   相手あり  … 伝えたいことを、自分の子が自分の言葉で相手に伝える（部屋の全員に見えるのは分身の言葉だけ）
  const talkBox = $("talkBox");
  const talkInput = $("talkInput");
  let talkLog = [];
  let gaze = null;

  function setTalkTarget(actor) {
    talkTarget = actor && !actor.mine ? actor : null;
    $("talkWho").textContent = talkTarget
      ? `${talkTarget.name}${talkTarget.npc?.role ? `（${talkTarget.npc.role}）` : ""}に話しかける`
      : selected
        ? `${selected.name}と話す（育つ）`
        : "話す";
    $("talkSelf").hidden = !talkTarget;
    talkInput.placeholder = talkTarget ? "伝えたいこと（あなたの子が、自分の言葉で伝えます）" : "話しかける";
  }
  function openTalk() {
    if (!selected) {
      toast("話す子を下から選んでね");
      return;
    }
    setTalkTarget(talkTarget);
    talkBox.hidden = false;
    $("talkBtn").classList.add("on");
    renderTalkLog();
  }
  function closeTalk() {
    talkBox.hidden = true;
    $("talkBtn").classList.remove("on");
    gaze?.close();
    gaze = null;
  }
  $("talkBtn").addEventListener("click", () => (talkBox.hidden ? openTalk() : closeTalk()));
  $("talkClose").addEventListener("click", closeTalk);
  $("talkSelf").addEventListener("click", () => setTalkTarget(null));

  function addTalkLog(name, text, mineSide) {
    talkLog.push({ name, text, mine: mineSide });
    if (talkLog.length > 30) talkLog = talkLog.slice(-30);
    renderTalkLog();
  }
  function renderTalkLog() {
    const box = $("talkLog");
    box.innerHTML = "";
    for (const l of talkLog.slice(-6)) {
      const row = document.createElement("div");
      row.className = `tl${l.mine ? " me" : ""}`;
      row.innerHTML = `<b>${escapeHtml(l.name)}</b>${escapeHtml(l.text)}`;
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
  }

  let talking = false;
  async function sendTalk(text) {
    text = String(text || "").trim().slice(0, 200);
    if (!text || !selected || talking) return;
    talkInput.value = "";
    if (talkTarget) {
      if (!actors.has(talkTarget.aid)) {
        toast("その子は、もうここにいないみたい");
        setTalkTarget(null);
        return;
      }
      addTalkLog("あなた", `（${talkTarget.name}へ）${text}`, true);
      send({ t: "talk", aid: selected.aid, to: talkTarget.aid, hint: text.slice(0, 80) });
      selected.stepToward(talkTarget, 20);
      return;
    }
    const cid = mineCid.get(selected.aid);
    if (!cid) return;
    talking = true;
    addTalkLog("あなた", text, true);
    send({ t: "typing", aid: selected.aid });
    selected.bubble("…", 8000, "talk");
    const me = selected;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: cid, message: text }),
      });
      const data = await res.json();
      const reply = data.reply || "……";
      // 返事は自分の画面だけに出す（覚えていることを、同じ部屋の人に見せない）
      me.bubble(reply.length > 60 ? `${reply.slice(0, 58)}…` : reply, 8000, "talk");
      me.act("greet");
      speak(reply, me.voice);
      addTalkLog(me.name, reply, false);
    } catch {
      toast("うまく話せなかったみたい");
    } finally {
      talking = false;
    }
  }
  $("talkForm").addEventListener("submit", (e) => {
    e.preventDefault();
    sendTalk(talkInput.value);
  });

  // 声で入力（端末の音声認識。対応していないブラウザではボタンを出さない）
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  $("talkMic").hidden = !Recognition;
  let recognizing = null;
  $("talkMic").addEventListener("click", () => {
    if (recognizing) {
      recognizing.stop();
      return;
    }
    const r = new Recognition();
    r.lang = "ja-JP";
    r.interimResults = true;
    r.maxAlternatives = 1;
    recognizing = r;
    $("talkMic").classList.add("on");
    r.onresult = (e) => {
      const text = [...e.results].map((x) => x[0].transcript).join("");
      talkInput.value = text;
      if (e.results[e.results.length - 1].isFinal) sendTalk(text);
    };
    r.onend = () => {
      recognizing = null;
      $("talkMic").classList.remove("on");
    };
    r.onerror = () => toast("声を聞き取れませんでした");
    r.start();
  });

  // 視線で選ぶ（よく使う言葉を、見つめて選ぶ）
  $("talkGaze").addEventListener("click", () => {
    if (gaze) {
      gaze.close();
      gaze = null;
      return;
    }
    gaze = openGazePicker($("talkGazeBox"), {
      onPick: (text) => sendTalk(text),
      onClose: () => (gaze = null),
    });
  });

  /** 吹き出しを、話している子の頭の上に寄せる（画面の外へははみ出さない） */
  function placeTalkBox() {
    if (talkBox.hidden || !selected) return;
    const v = selected.position.clone();
    v.y += 2.4;
    v.project(camera);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const bw = talkBox.offsetWidth || 300;
    const bh = talkBox.offsetHeight || 160;
    let x = ((v.x + 1) / 2) * w - bw / 2;
    let y = ((1 - v.y) / 2) * h - bh - 14;
    x = Math.max(8, Math.min(w - bw - 8, x));
    y = Math.max(60, Math.min(h - bh - 150, y));
    talkBox.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  // --- 自動と手動 ---
  //   手動: 自分でタップして歩かせ、吹き出しに入力して話す（これまでどおり）
  //   自動: 育った人格（性格の数値）で、自分の子が自分から歩き、近くの子に話しかける（話題も自分で選ぶ）
  //         人なつっこい子ほど近づいて話しかけ、好奇心の強い子ほど屋台や看板を見に行く。慎重な子は間をあける
  function renderMode() {
    $("modeBtn").textContent = autoMode ? "🤖 自動" : "✋ 手動";
    $("modeBtn").classList.toggle("on", autoMode);
    $("modeBtn").title = autoMode ? "育った性格で、自分から歩いて話しかけます（タップで手動に）" : "自分で動かして話します（タップで自動に）";
  }
  renderMode();
  $("modeBtn").addEventListener("click", () => {
    autoMode = !autoMode;
    store(MODE_KEY, autoMode ? "auto" : "manual");
    renderMode();
    for (const a of actors.values()) if (a.mine) a.autoNextAt = 0;
    toast(autoMode ? "自動: 育った性格のとおりに、自分から歩いて話しかけます" : "手動: 自分で動かして、話しかけます");
  });

  function sociability(p) {
    if (!p) return 0.5;
    const v = (p.warmth + p.cheerfulness + p.curiosity) / 3 - p.caution * 0.3 - p.independence * 0.2;
    return Math.max(0, Math.min(1, (v + 25) / 75));
  }

  function autoTick(now) {
    if (!autoMode || games.running || now < autoPauseUntil) return;
    const list = [...actors.values()];
    for (const a of list) {
      // 身振り（idle の揺れ）の最中でも決めてよい。歩いている間だけ待つ
      if (!a.mine || a.walking || now < (a.autoNextAt || 0)) continue;
      const p = a.persona;
      const soc = sociability(p);
      const curious = p ? p.curiosity / 100 : 0.5;
      const energy = p ? p.energy / 100 : 0.5;
      a.autoNextAt = now + 4000 + (1 - energy) * 8000 + Math.random() * 3000;
      let nearest = null;
      let nd = Infinity;
      for (const b of list) {
        if (b.mine) continue;
        const d = a.position.distanceTo(b.position);
        if (d < nd) {
          nd = d;
          nearest = b;
        }
      }
      // 話しかける: 近くにいて、その相手とはしばらく話していない。間は人なつっこさで決まる（20〜60秒）
      const talkGap = 60000 - soc * 40000;
      a.talkedWith ??= new Map();
      if (
        !autoTalkOff &&
        nearest &&
        nd < 3.4 &&
        now - lastAutoTalk > talkGap &&
        now - (a.talkedWith.get(nearest.aid) || -Infinity) > 120000 &&
        (!nearest.npc || nearest.npc.talk !== false)
      ) {
        lastAutoTalk = now;
        a.talkedWith.set(nearest.aid, now);
        a.other = nearest;
        a.faceOther = true;
        setTimeout(() => (a.faceOther = false), 3000);
        send({ t: "talk", aid: a.aid, to: nearest.aid, auto: true });
        continue;
      }
      const r = Math.random();
      const half = catalog.worldHalf - 1;
      if (nearest && r < 0.2 + soc * 0.5) {
        a.other = nearest;
        a.stepToward(nearest, 20);
      } else if (things && things.items.length && r < 0.2 + soc * 0.5 + curious * 0.3) {
        const it = things.items[Math.floor(Math.random() * things.items.length)];
        const target = it.startPoint || it.root.position;
        const x = Math.max(-half, Math.min(half, target.x + (Math.random() - 0.5) * 1.5));
        const z = Math.max(-half, Math.min(half, target.z + (Math.random() - 0.5) * 1.5));
        a.setDestination(x, z);
        send({ t: "move", aid: a.aid, x, z });
      } else {
        const x = Math.max(-half, Math.min(half, a.position.x + (Math.random() * 2 - 1) * 3));
        const z = Math.max(-half, Math.min(half, a.position.z + (Math.random() * 2 - 1) * 3));
        a.setDestination(x, z);
        send({ t: "move", aid: a.aid, x, z });
      }
    }
  }

  // 交流の記録（お散歩とメタバースの出会いを、同じ図鑑で見る）
  $("friendsBtn").addEventListener("click", () => {
    const cid = selected ? mineCid.get(selected.aid) : null;
    if (!cid) return toast("記録を見る子を下から選んでね");
    window.open(`/friends?cid=${encodeURIComponent(cid)}`, "_blank", "noopener");
  });

  // --- 操作（タップで移動・挨拶、ドラッグで回す、ピンチで寄る） ---
  const raycaster = new THREE.Raycaster();
  const pointers = new Map();
  let dragMoved = false;
  let pinchStart = 0;
  let zoomStart = 1;

  renderer.domElement.addEventListener("pointerdown", (e) => {
    renderer.domElement.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    dragMoved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      zoomStart = zoom;
    }
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > 8) dragMoved = true;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) zoom = Math.max(0.5, Math.min(1.8, zoomStart * (pinchStart / d)));
    } else if (dragMoved) {
      yaw -= dx * 0.008;
    }
  });
  const endPointer = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p || dragMoved || pointers.size > 0) return;
    onTap(e.clientX, e.clientY);
  };
  renderer.domElement.addEventListener("pointerup", endPointer);
  renderer.domElement.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
  renderer.domElement.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoom = Math.max(0.5, Math.min(1.8, zoom * (e.deltaY > 0 ? 1.08 : 0.92)));
    },
    { passive: false }
  );

  let pendingGreet = null;
  function onTap(cx, cy) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...actors.values()].map((a) => a.hit), false);
    if (hits.length) {
      const actor = hits[0].object.userData.actor;
      if (actor.npc) {
        openNpcDialog(actor);
        return;
      }
      if (actor.mine) {
        if (selected === actor) greetFrom(actor, randomLine(), { broadcast: true });
        selected = actor;
        setTalkTarget(null);
        renderMine();
      } else if (selected) {
        setTalkTarget(actor);
        // 他の子をタップ: 自分の子がそばまで歩いて行って、挨拶する
        toast(`${actor.name}（${window.WaketamaSpecies.label(actor.species)}）`);
        selected.other = actor;
        selected.stepToward(actor, 20);
        pendingGreet = { me: selected, other: actor, at: performance.now() };
      }
      return;
    }
    const objHit = things ? raycaster.intersectObjects(things.hitTargets, false)[0] : null;
    if (objHit) {
      onObjectTap(objHit.object.userData.item);
      return;
    }
    const landHit = land ? raycaster.intersectObjects(land.hitTargets, false)[0] : null;
    if (landHit) {
      onLandTap(landHit.object.userData.item);
      return;
    }
    if (!selected || !world) return;
    const g = raycaster.intersectObjects(world.groundTargets, false)[0];
    if (!g) return;
    const half = catalog.worldHalf;
    const x = Math.max(-half, Math.min(half, g.point.x));
    const z = Math.max(-half, Math.min(half, g.point.z));
    selected.setDestination(x, z);
    send({ t: "move", aid: selected.aid, x, z });
    // 自動のときに地面をタップしたら、しばらく（15秒）自分で動かす
    if (autoMode) {
      autoPauseUntil = performance.now() + 15000;
      toast("15秒だけ手動で動かします");
    }
  }

  // --- スタンプ・挨拶・音のボタン ---
  $("stampBar").innerHTML = "";
  for (const kind of catalog.stamps) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stamp";
    b.textContent = STAMP_TEXT[kind] || kind;
    b.addEventListener("click", () => {
      if (!selected) return;
      selected.bubble(STAMP_TEXT[kind], 2000, "stamp");
      send({ t: "stamp", aid: selected.aid, kind });
    });
    $("stampBar").appendChild(b);
  }
  $("greetBtn").addEventListener("click", () => {
    if (selected) greetFrom(selected, randomLine(), { broadcast: true });
  });
  const renderSound = () => ($("soundBtn").textContent = soundOn ? "音: あり" : "音: なし");
  renderSound();
  $("soundBtn").addEventListener("click", () => {
    soundOn = !soundOn;
    store(SOUND_KEY, soundOn ? "1" : "0");
    if (soundOn) unlockAudio();
    renderSound();
  });

  // --- 人格どおりに動かす（0.5秒ごとに、手が空いている子へイベントを渡す） ---
  const GREET_COOLDOWN_MS = 25000;
  let insideStart = null; // いま入っている屋台の輪（入った瞬間だけ案内する）
  setInterval(() => {
    if (document.hidden) return;
    wanderNpcs();
    const now = performance.now();
    autoTick(now);
    const list = [...actors.values()];
    for (const a of list) {
      if (a.busy || a.walking) continue;
      let nearest = null;
      let nd = Infinity;
      for (const b of list) {
        if (b === a) continue;
        const d = a.position.distanceTo(b.position);
        if (d < nd) {
          nd = d;
          nearest = b;
        }
      }
      if (nearest && nd < 3.2 && now - (a.greeted.get(nearest.aid) || -Infinity) > GREET_COOLDOWN_MS) {
        a.greeted.set(nearest.aid, now);
        a.other = nearest;
        // 近づくか・待つか・下がるかは、その子の数値と方針で決まる（wt_core の onApproach）
        a.act("approach", nd).then(() => (nd < 2.4 ? a.act("greet") : null));
        continue;
      }
      if (Math.random() < 0.35) a.act("idle");
      // 自分の子（操作していない子）は、ときどき少しだけ歩き回る。ゲーム中は動かさない
      if (!autoMode && a.mine && a !== selected && !games.running && Math.random() < 0.02 + a.energy / 5000) {
        const half = catalog.worldHalf - 1;
        const x = Math.max(-half, Math.min(half, a.position.x + (Math.random() * 2 - 1) * 2.5));
        const z = Math.max(-half, Math.min(half, a.position.z + (Math.random() * 2 - 1) * 2.5));
        a.setDestination(x, z);
        send({ t: "move", aid: a.aid, x, z });
      }
    }
    // NPC は、自分の子が近くに来たら、決まった台詞で声をかける（25秒に1回まで）
    if (selected) {
      for (const a of list) {
        if (!a.npc || a.busy) continue;
        if (a.position.distanceTo(selected.position) < 2.2 && now - (a.npcGreetAt || -Infinity) > 25000) {
          a.npcGreetAt = now;
          a.other = selected;
          a.faceOther = true;
          const line = a.npc.message && Math.random() < 0.5 ? a.npc.message : catalog.greetings[Math.floor(hashNum(a.aid + Math.floor(now / 25000)) * catalog.greetings.length)];
          a.bubble(line.length > 40 ? `${line.slice(0, 38)}…` : line, 3500, "talk");
          speak(line, a.voice);
          setTimeout(() => (a.faceOther = false), 2500);
        }
      }
    }
    if (pendingGreet && !pendingGreet.me.walking) {
      const { me, other } = pendingGreet;
      pendingGreet = null;
      if (actors.has(other.aid) && me.position.distanceTo(other.position) < 3) greetFrom(me, randomLine(), { broadcast: true });
    }
    if (pendingGreet && now - pendingGreet.at > 15000) pendingGreet = null;

    // 屋台の前の輪に、操作している子が入ったら、ゲームの案内を出す
    if (!autoMode && selected && things && !games.running && $("dialog").hidden) {
      const hit = things.items.find(
        (i) => i.startPoint && Math.hypot(selected.position.x - i.startPoint.x, selected.position.z - i.startPoint.z) < 0.9
      );
      if (hit && insideStart !== hit && $("shopSheet").hidden) hit.shop ? wallet.openShop(hit.obj.shopId, hit.obj.title) : games.offer(hit);
      insideStart = hit || null;
    }
  }, 500);

  // --- 描画 ---
  function resize() {
    // ARの最中は、画面の大きさを端末（WebXR）が決める
    if (renderer.xr.isPresenting) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  // setAnimationLoop: ふだんは requestAnimationFrame と同じ。ARの最中は、端末（WebXR）の描画の合図で回る
  function frame(_time, xrFrame) {
    if (document.hidden && !renderer.xr.isPresenting) return;
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    for (const a of actors.values()) a.update(dt, t);
    games.update(dt, t, xrFrame);
    const view = games.view;
    if (view) {
      // センサーのミニゲーム中は、その場面を映す（部屋は止めずに裏で動かしておく）
      if (view.camera.aspect !== camera.aspect) {
        view.camera.aspect = camera.aspect;
        view.camera.updateProjectionMatrix();
      }
      stage.classList.toggle("ar", !!view.transparent);
      renderer.render(view.scene, view.camera);
      return;
    }
    stage.classList.remove("ar");
    world?.update(t);
    things?.update(t);
    land?.update(t);
    for (let i = effects.length - 1; i >= 0; i--) {
      if (!effects[i].update(dt)) {
        effects[i].dispose();
        effects.splice(i, 1);
      }
    }
    placeCamera(dt);
    placeTalkBox();
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);
  connect();

  // 手元の開発サーバーでだけ、画面の中身を外から確かめられるようにする（自動の画面確認用）
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    window.__metaDebug = {
      actors,
      games,
      camera,
      onTap,
      get things() {
        return things;
      },
      get land() {
        return land;
      },
      sendTalk,
      openTalk,
      setTalkTarget,
      get autoMode() {
        return autoMode;
      },
      autoTick,
      get selected() {
        return selected;
      },
      wallet,
      openAdDetail,
    };
  }
}

// ---------------------------------------------------------------- 起動

showLobby();

// WebGL が使えない端末では、理由を出して止める（真っ黒な画面のまま待たせない）
try {
  const c = document.createElement("canvas");
  if (!(c.getContext("webgl2") || c.getContext("webgl"))) throw new Error("no webgl");
} catch {
  $("noWebgl").hidden = false;
}
