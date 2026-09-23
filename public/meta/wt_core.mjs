/**
 * わけたま検証機 — 振る舞いエンジン（JavaScript版）。
 *
 * tools/device/common/wt_core.py を1:1で移植したもの。**規則は増やさない、減らさない。**
 * 対象はブラウザ（メタバースのアバター）と Node（selftest からの突き合わせ）の両方。
 *
 * 同じ規則が Python / C++ / JS の3箇所に書かれている以上、写し間違いは人の目では
 * 見つからない前提で扱う。この移植も tools/device/selftest.py が Node で実行し、
 * Python版と1手順ずつ突き合わせている（§8 wt_core.py ↔ web/wt_core.mjs）。
 *
 * **Python版との違い: すべての Driver 呼び出しが await 付き。**
 * Python版はシングルスレッドの実機で、`hw.servo()` や `hw.sleep_ms()` が
 * ブロッキングで「そのぶん時間がかかる」ことを前提にできる。
 * ブラウザのメインスレッドは実時間の sleep で止められない（止めると画面が固まる）ので、
 * `d.servo()` / `d.led()` / `d.wait()` をすべて `await` 付きの呼び出しにして、
 * 「1つの動作が終わってから次へ進む」という同じ順序保証を Promise で作っている。
 * **判断ロジック・出す指示・出す値・出す順番は Python 版と完全に同じ。**
 * テスト用の Collector は実待ちをしない（await しても即座に進む）ので、
 * 判定用の手順比較には実時間が絡まない。実アバター用の Driver
 * （web/wt_avatar.mjs）は、この await を使って複数ステップの動きを
 * 正しい順番でアニメーションさせる。
 *
 * 並びの出所は tools/device/contract.json。変えるときは向こうを先に直すこと。
 */

export const VERSION = "wt-core-js/1.0";
export const CONTRACT_VERSION = 1;

export const EVENTS = Object.freeze(["idle", "approach", "greet", "change", "silence"]);

/** 最小形（compact）を、意味のある名前で読めるようにしただけのもの。 */
export class Persona {
  constructor(data) {
    if (data.v !== CONTRACT_VERSION) {
      throw new Error(`未対応の形式です: v=${data.v}`);
    }
    const [m0, m1, m2, m3, m4, m5] = data.m;
    const [p0, p1] = data.p;
    const [e0, e1] = data.e;
    const [t0, t1, t2, t3, t4, t5] = data.t;

    this.id = data.id || "";
    this.name = data.n || "";
    // m: 動き
    this.energy = m0;
    this.gestureRate = m1;
    this.idleVariance = m2;
    this.responseDelayMs = m3;
    this.gazeHoldMs = m4;
    this.posture = m5;
    // p: 間合い
    this.distanceM = p0;
    this.approachMps = p1;
    // e: 表情
    this.smile = e0;
    this.blinkPerMin = e1;
    // t: 性格6軸
    this.warmth = t0;
    this.curiosity = t1;
    this.cheerfulness = t2;
    this.caution = t3;
    this.independence = t4;
    this.humor = t5;
    this.policies = data.c || [];
  }

  has(code) {
    return this.policies.includes(code);
  }
}

/**
 * 出力の口。実機では継承して Three.js のオブジェクトや、GPIO を触る。
 * 3つに絞ってあるのは、新しい対象へ載せるときに「この3つだけ書けば動く」と
 * 言い切れるようにするため（tools/device/common/wt_core.py と同じ約束）。
 */
export class Driver {
  /** @returns {Promise<void>|void} */
  servo(_name, _value) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<void>|void} */
  led(_name, _value) {
    throw new Error("not implemented");
  }

  /** @returns {Promise<void>|void} 実機・実アバターでは実時間待つ。テストでは即戻ってよい */
  wait(_ms) {
    throw new Error("not implemented");
  }

  /** 人が読むための一言。機械は使わない。既定では捨てる。 */
  note(_text) {}
}

/** 動きを実行せずに集める。テスト・比較・記録に使う。実待ちはしない。 */
export class Collector extends Driver {
  constructor() {
    super();
    this.actions = [];
    this.notes = [];
    this.totalWaitMs = 0;
  }

  servo(name, value) {
    this.actions.push(["servo", name, value]);
  }

  led(name, value) {
    this.actions.push(["led", name, value]);
  }

  wait(ms) {
    const rounded = Math.round(ms);
    this.actions.push(["wait", "", rounded]);
    this.totalWaitMs += rounded;
  }

  note(text) {
    this.notes.push(text);
  }
}

// --- 数の書式（Pythonの round() / "%s" % と表記を揃える） --------------------
// JS の Math.round は 0.5 を常に切り上げる点で Python の round() と挙動が違うが、
// このエンジンが扱う値はどれも正なので、この単純な実装で一致する。

function round1(v) {
  return Math.round(v * 10) / 10;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

/** Python の str(round(x, n)) と同じ書き方（末尾の0を落とすが、小数点以下は1桁残す）。 */
function fmtShort(v, decimals) {
  const r = decimals === 1 ? round1(v) : round2(v);
  let s = r.toFixed(decimals);
  if (s.includes(".")) {
    s = s.replace(/0+$/, "");
    if (s.endsWith(".")) s += "0";
  }
  return s;
}

// --- イベント → 動き ----------------------------------------------------------
// どの関数も「人格と状況だけ」から手順を決める。時計も乱数も見ない。
// wt_core.py と完全に同じ判断。wait() だけ await している。

/** 待機。ここが一番その子らしさが出る。置物にしないこと。 */
export async function onIdle(p, d) {
  const amplitude = fmtShort(p.idleVariance / 100.0 * 12, 1);
  const periodMs = Math.trunc(4000 - p.energy * 20);
  await d.servo("body_sway", `±${amplitude} deg / ${periodMs}ms`);
  await d.led("cheek", `${Math.trunc(p.smile)}%`);
  await d.wait(Math.trunc(60000 / Math.max(1, p.blinkPerMin)));
}

/** 人が近づいた。踏み込むか、待つか、下がるか。 */
export async function onApproach(p, d, distanceM) {
  if (distanceM > p.distanceM) {
    const forward = (p.independence >= 55 || p.has("prefer_novel_options")) && !p.has("confirm_before_change");
    if (forward) {
      const step = fmtShort(Math.min(p.approachMps, distanceM - p.distanceM), 2);
      await d.servo("drive", `forward ${step}m/s`);
    } else {
      await d.servo("head", "tilt toward");
      d.note("（自分からは寄らない）");
    }
  } else if (p.caution >= 60) {
    await d.servo("drive", `back ${(p.distanceM - distanceM).toFixed(2)}m`);
  } else {
    await d.servo("head", "face");
  }
}

/** 話しかけられた。間の取り方と身振りの量に差が出る。 */
export async function onGreet(p, d) {
  await d.wait(p.responseDelayMs);
  const gestures = Math.max(0, Math.trunc(p.gestureRate / 25));
  for (let i = 0; i < gestures; i++) {
    await d.servo("arm", `wave ${i + 1}/${gestures}`);
  }
  await d.servo("gaze", `hold ${p.gazeHoldMs}ms`);
  await d.led("mouth", `smile ${Math.min(100, p.smile + Math.floor(p.cheerfulness / 4))}%`);
  if (p.has("keep_light_and_playful")) {
    await d.servo("body", "bounce");
  }
}

/** 予定の変更。方針コードがそのまま分岐になる。 */
export async function onChange(p, d) {
  if (p.has("confirm_before_change")) {
    await d.servo("head", "shake slight");
    d.note("→ まず確かめる（confirm_before_change）");
  } else if (p.has("prefer_novel_options")) {
    await d.servo("head", "nod fast");
    d.note("→ 乗る（prefer_novel_options）");
  } else {
    await d.servo("head", "nod");
    d.note("→ ふつうに受ける");
  }
}

/**
 * 沈黙が続いた。自分から切り出すか、待つか。
 * docs/TEXT_TO_BEHAVIOR.md §6 の表にあって、実装は wt_core.py が最初だったイベント。
 */
export async function onSilence(p, d, seconds) {
  const patienceS = 3 + (100 - p.energy) / 20.0;
  if (seconds < patienceS) {
    await d.servo("gaze", `hold ${p.gazeHoldMs}ms`);
    return;
  }
  if (p.has("take_initiative") || (p.curiosity >= 65 && !p.has("follow_the_lead"))) {
    await d.servo("head", "turn toward");
    await d.led("mouth", `smile ${Math.min(100, p.smile + 10)}%`);
    await d.servo("arm", "beckon");
    d.note("→ 自分から切り出す");
  } else if (p.has("follow_the_lead") || p.caution >= 60) {
    await d.servo("body", "settle");
    await d.led("cheek", `${Math.max(0, p.smile - 10)}%`);
    d.note("→ 待つ");
  } else {
    await d.servo("gaze", "glance");
    d.note("→ ちらと見るだけ");
  }
}

/** イベント名で振り分ける。未知の名前は false を返す（落とさない）。 */
export async function dispatch(p, d, event, arg) {
  switch (event) {
    case "idle":
      await onIdle(p, d);
      return true;
    case "approach":
      await onApproach(p, d, arg === undefined || arg === null ? 2.0 : Number(arg));
      return true;
    case "greet":
      await onGreet(p, d);
      return true;
    case "change":
      await onChange(p, d);
      return true;
    case "silence":
      await onSilence(p, d, arg === undefined || arg === null ? 10.0 : Number(arg));
      return true;
    default:
      return false;
  }
}

/** 動かさずに手順だけ取る。比較・記録・アバターの予約実行に使う。 */
export async function plan(p, event, arg) {
  const c = new Collector();
  const ok = await dispatch(p, c, event, arg);
  return ok ? c : null;
}

// --- 2体の比較（検証機の本体はこれ） -------------------------------------------

export const COMPARE_ROWS = Object.freeze([
  ["動きの大きさ", "energy"],
  ["身振りの頻度", "gestureRate"],
  ["待機の揺らぎ", "idleVariance"],
  ["返すまでの間(ms)", "responseDelayMs"],
  ["目線を保つ(ms)", "gazeHoldMs"],
  ["心地よい距離(m)", "distanceM"],
  ["近づく速さ(m/s)", "approachMps"],
]);

function sameSeq(a, b) {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row[0] === b[i][0] && row[1] === b[i][1] && row[2] === b[i][2]);
}

/**
 * 性格の違う2体を並べて、差が出ているかを機械で判定する。
 * docs/EDGE_DEVICE_TEST.md §3 の合格基準を、wt_core.py の compare() と同じ式で実装。
 */
export async function compare(a, b, events = EVENTS) {
  const rows = COMPARE_ROWS.map(([label, attr]) => [label, a[attr], b[attr]]);

  const onlyA = a.policies.filter((c) => !b.policies.includes(c));
  const onlyB = b.policies.filter((c) => !a.policies.includes(c));

  const seqA = {};
  const seqB = {};
  const differing = [];
  for (const ev of events) {
    const pa = await plan(a, ev);
    const pb = await plan(b, ev);
    seqA[ev] = pa ? pa.actions : [];
    seqB[ev] = pb ? pb.actions : [];
    if (!sameSeq(seqA[ev], seqB[ev])) differing.push(ev);
  }

  const delayA = Math.max(1, a.responseDelayMs);
  const delayB = Math.max(1, b.responseDelayMs);
  const delayRatio = round2(Math.max(delayA, delayB) / Math.min(delayA, delayB));

  const DELAY_RATIO_MIN = 1.5; // docs/EDGE_DEVICE_TEST.md §3 参照。実測は1.9〜2.3倍に散らばる

  const gestA = Math.trunc(a.gestureRate / 25);
  const gestB = Math.trunc(b.gestureRate / 25);

  const checks = [
    ["返すまでの間が1.5倍以上ちがう", delayRatio >= DELAY_RATIO_MIN, `${delayRatio.toFixed(2)}倍`],
    ["身振りの回数がちがう", gestA !== gestB, `${gestA}回 vs ${gestB}回`],
    ["近づく判断が分かれる", !sameSeq(seqA.approach || [], seqB.approach || []), ""],
    ["方針コードに重ならない差がある", onlyA.length > 0 && onlyB.length > 0, `A:${onlyA.length}件 B:${onlyB.length}件`],
    ["半分以上のイベントで手順がちがう", differing.length * 2 >= events.length, `${differing.length}/${events.length}`],
  ];

  return {
    a: a.name || a.id,
    b: b.name || b.id,
    rows,
    onlyA,
    onlyB,
    differingEvents: differing,
    checks,
    pass: checks.every((c) => c[1]),
  };
}
