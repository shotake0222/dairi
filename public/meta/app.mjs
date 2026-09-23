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

const MY_CHARACTERS_KEY = "sodatsukake_myCharacters";
const SOUND_KEY = "sodatsukake_metaSound";
const CAMERA_KEY = "sodatsukake_metaCamera";
const NOTICE_KEY = "sodatsukake_metaNoticeSeen";

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
  $("noticeBox").hidden = load(NOTICE_KEY) === "1";

  const chosen = () =>
    [...picker.querySelectorAll("input:checked")].map((el) => chars.find((c) => c.cid === el.value)).filter(Boolean);

  const go = (room) => {
    const list = chosen();
    if (list.length === 0) {
      toast("いっしょに行く子を選んでね");
      return;
    }
    store(NOTICE_KEY, "1");
    unlockAudio();
    $("lobby").hidden = true;
    history.replaceState(null, "", `/meta?room=${encodeURIComponent(room.id)}${fromCid ? `&cid=${encodeURIComponent(fromCid)}` : ""}`);
    enterRoom(room, catalog, list);
  };

  $("roomList").innerHTML = "";
  for (const r of rooms) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `roomCard place-${r.place} time-${r.time}`;
    const games = r.objects.filter((o) => ["treasure", "quiz", "rally"].includes(o.type)).map((o) => o.title);
    b.innerHTML = `<b>${escapeHtml(r.name)}</b><span>${escapeHtml(labelOf(catalog.places, r.place))}・${escapeHtml(labelOf(catalog.times, r.time))}</span>${
      games.length ? `<em>あそべる: ${escapeHtml(games.join("・"))}</em>` : ""
    }`;
    b.addEventListener("click", () => go(r));
    $("roomList").appendChild(b);
  }

  // リンクで部屋が決まっているとき（一覧に出していない部屋も含む）
  if (roomId) {
    try {
      const { room } = await api(`/api/meta/rooms/${encodeURIComponent(roomId)}`);
      $("directRoom").hidden = false;
      $("directName").textContent = room.name;
      $("directGo").addEventListener("click", () => go(room));
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
  const renderer = new THREE.WebGLRenderer({ antialias: dpr < 2, powerPreference: "low-power" });
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 120);
  let world = null;
  let things = null;
  let config = room;

  const actors = new Map(); // aid -> Actor
  let mine = [];
  let selected = null;
  let ws = null;
  let closedByUs = false;

  // --- ミニゲーム ---
  const games = new GameRunner({
    THREE,
    scene,
    roomId: room.id,
    catalog,
    me: () => selected,
    get avoid() {
      return (things?.items || []).map((i) => ({ x: i.root.position.x, z: i.root.position.z }));
    },
    hud: (text) => {
      $("gameHud").hidden = !text;
      $("gameHud").textContent = text || "";
      $("quitGame").hidden = !text;
    },
    dialog,
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
    const portrait = Math.min(1.4, Math.max(1, Math.sqrt(0.75 / Math.max(0.3, camera.aspect))));
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
    refreshPeople();
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
        renderMine();
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
        for (const a of msg.actors || []) addActor(a);
        selected = actors.get(mine[0]) || null;
        if (msg.config) applyConfig({ ...config, ...msg.config });
        (msg.notices || []).forEach((n) => toast(n));
        renderMine();
        refreshPeople();
        break;
      }
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
      case "error":
        toast(msg.message || "うまくいきませんでした");
        if (msg.code === "join_failed" || msg.code === "full") {
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
    if (["treasure", "quiz", "rally"].includes(o.type)) {
      if (!games.running) games.offer(item);
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
      if (actor.mine) {
        if (selected === actor) greetFrom(actor, randomLine(), { broadcast: true });
        selected = actor;
        renderMine();
      } else if (selected) {
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
    if (!selected || !world) return;
    const g = raycaster.intersectObjects(world.groundTargets, false)[0];
    if (!g) return;
    const half = catalog.worldHalf;
    const x = Math.max(-half, Math.min(half, g.point.x));
    const z = Math.max(-half, Math.min(half, g.point.z));
    selected.setDestination(x, z);
    send({ t: "move", aid: selected.aid, x, z });
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
    const now = performance.now();
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
      if (a.mine && a !== selected && !games.running && Math.random() < 0.02 + a.energy / 5000) {
        const half = catalog.worldHalf - 1;
        const x = Math.max(-half, Math.min(half, a.position.x + (Math.random() * 2 - 1) * 2.5));
        const z = Math.max(-half, Math.min(half, a.position.z + (Math.random() * 2 - 1) * 2.5));
        a.setDestination(x, z);
        send({ t: "move", aid: a.aid, x, z });
      }
    }
    if (pendingGreet && !pendingGreet.me.walking) {
      const { me, other } = pendingGreet;
      pendingGreet = null;
      if (actors.has(other.aid) && me.position.distanceTo(other.position) < 3) greetFrom(me, randomLine(), { broadcast: true });
    }
    if (pendingGreet && now - pendingGreet.at > 15000) pendingGreet = null;

    // 屋台の前の輪に、操作している子が入ったら、ゲームの案内を出す
    if (selected && things && !games.running && $("dialog").hidden) {
      const hit = things.items.find(
        (i) => i.startPoint && Math.hypot(selected.position.x - i.startPoint.x, selected.position.z - i.startPoint.z) < 0.9
      );
      if (hit && insideStart !== hit) games.offer(hit);
      insideStart = hit || null;
    }
  }, 500);

  // --- 描画 ---
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;
    for (const a of actors.values()) a.update(dt, t);
    world?.update(t);
    things?.update(t);
    games.update(dt, t);
    placeCamera(dt);
    renderer.render(scene, camera);
  }
  frame();
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
      get selected() {
        return selected;
      },
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
