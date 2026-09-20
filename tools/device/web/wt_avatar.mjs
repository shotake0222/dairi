/**
 * わけたま検証機 — 「動きの指示」を、Three.js のアバターへ落とす層。
 *
 * tools/device/common/wt_actuate.py（Pico/Pi用）と同じ役目。
 * wt_core.mjs が出すのは ("servo", "arm", "wave 1/2") のような**指示**で、
 * それを実際に「何度まで回すか」「どのボーンを動かすか」に翻訳するのがここ。
 *
 * **物理の検証機との違い（意図的なもの）:**
 *   - 物理版は体サーボ1個で頭と体を兼用している（配線が1本しか無いため）。
 *     アバターには両方あるので、`head` の指示は専用の head ノードへ、
 *     `body_sway`/`bounce`/`settle` は torso ノードへ、別々に割り当てる。
 *   - 物理版は車輪が無く、`drive`（近づく／下がる）を前傾で代用している。
 *     アバターは実際に位置を動かせるので、**本当に近づいたり離れたりする**。
 *     「代用しなくて済む」こと自体が、仮想空間へ持ち出す利点の実例になる。
 *   - `wait()` はブラウザのメインスレッドを止められないので実時間の Promise。
 *     `speed` で倍速にできる（デモ用。1.0が実時間、既定は1.0）。
 *
 * 数値文字列の中身（"±10.2 deg / 2360ms" 等）を読むところは、
 * ESP32版（.ino）・Pico版と同じ「エンジンは文章を出し、実行層が数を拾う」設計を踏襲している。
 */

import { Driver } from "./wt_core.mjs";

const ARM_HOME = 0;
const ARM_UP = -100; // ラジアン度数はThree.js側で deg→rad 変換する
const ARM_DOWN = 20;
const GESTURE_HALF_MS = 180;
const NOD_MS = 140;
const LEAN_FORWARD_M = 0.35; // 「前傾」ではなく実際に踏み出す距離（アバターの利点）
const LEAN_BACK_M = 0.28;

function deg(d) {
  return (d * Math.PI) / 180;
}

/** "wave 1/2" や "±10.2 deg / 2360ms" から最初の数を取り出す（wt_actuate.py の _num と同じ）。 */
function firstNumber(text, fallback = 0) {
  const m = String(text).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : fallback;
}

/** 文中のすべての数を順に取り出す（wt_actuate.py の _nums と同じ）。 */
function allNumbers(text) {
  const matches = String(text).match(/-?\d+(\.\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Three.js のプリミティブだけでアバターを組み立てる。
 * 特定のVRM/リグ済みモデルに依存しないのは、**この検証機が主張したいのは
 * 「どんな見た目でも、この9個のパラメータさえ割り当てれば人格が乗る」**ことだから。
 * 凝った既製モデルを使うと、その主張が見た目の作り込みに埋もれてしまう。
 *
 * @param {typeof import("three")} THREE
 * @param {{ color?: number, guestColor?: number }} [opts]
 */
export function buildAvatar(THREE, opts = {}) {
  const color = opts.color ?? 0x7c5cff;

  const root = new THREE.Group();

  // 体（torso）。待機の揺らぎ・bounce/settle・実際の接近／後退はこれを動かす
  const torsoMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), torsoMat);
  torso.scale.set(1, 1.15, 0.92);
  torso.position.y = 0.55;
  root.add(torso);

  // 頭（head）。nod/shake/tilt/turn/faceはこれを動かす。物理版には無い専用の自由度
  // torsoの子のまま（drive/bounce/swayで体と一緒に動いてほしいので）。
  // torso.scaleは非一様（1, 1.15, 0.92）なので、位置と形の両方が引き伸ばされる分を
  // 逆scaleで打ち消し、位置は「ワールドで欲しい高さ ÷ 1.15」で指定する。
  const headGroup = new THREE.Group();
  headGroup.position.y = 0.45 / 1.15; // torso上端（0.55+0.42×1.15≈1.03）に軽く重なる高さ（world y≈1.0）
  headGroup.scale.set(1, 1 / 1.15, 1 / 0.92);
  torso.add(headGroup);
  const headMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 24), headMat);
  headGroup.add(head);

  // 口。baselineSmile / smile% を色の明るさと縦幅で表す
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x000000 });
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 8, 16, Math.PI), mouthMat);
  mouth.position.set(0, -0.08, 0.27);
  mouth.rotation.x = Math.PI;
  headGroup.add(mouth);

  // 目。gazeHoldMs / blinkRatePerMin を発光の強さと縦スケール（まばたき）で表す
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x99ccff, emissiveIntensity: 0 });
  const eyeGeo = new THREE.SphereGeometry(0.045, 12, 10);
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat.clone());
  eyeL.position.set(-0.11, 0.03, 0.27);
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat.clone());
  eyeR.position.set(0.11, 0.03, 0.27);
  headGroup.add(eyeL, eyeR);

  // 腕（1本だけ。物理版がサーボ1個で手を振るのと合わせている）
  // torsoの子のまま（drive/bounce/swayで体と一緒に動いてほしいので）。
  // ただしtorsoの非一様scaleで腕が歪まないよう、逆scaleを掛けて打ち消す。
  const armPivot = new THREE.Group();
  armPivot.position.set(0.4, 0.15, 0);
  armPivot.scale.set(1, 1 / 1.15, 1 / 0.92);
  torso.add(armPivot);
  const armMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 8), armMat);
  arm.position.y = -0.21;
  armPivot.add(arm);
  armPivot.rotation.z = deg(ARM_HOME);

  return { root, torso, headGroup, mouthMat, eyeL, eyeR, armPivot };
}

/**
 * wt_core の指示を、buildAvatar() が返したノードへ割り当てる。
 * 物理版（RigDriver）と同じ3メソッド構成 + wait が非同期な点だけが違う。
 */
export class AvatarDriver extends Driver {
  /**
   * @param {ReturnType<typeof buildAvatar>} rig
   * @param {{ speed?: number, onAct?: (act: object) => void, clock?: () => number, guestZ?: () => number }} [opts]
   */
  constructor(rig, opts = {}) {
    super();
    this.rig = rig;
    this.speed = opts.speed ?? 1.0;
    this.onAct = opts.onAct ?? null;
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.torsoCenterY = rig.torso.position.y;
    this.torsoBaseZ = rig.torso.position.z;
    this.smile = 50;
    this.substitutions = [];
  }

  /** 人格から基準姿勢を決める。物理版の bind() と同じ役目。 */
  bind(persona) {
    this.smile = persona.smile;
    this.substitutions = [];
    this.rig.headGroup.rotation.set(0, 0, 0);
    this.rig.torso.position.set(0, this.torsoCenterY, this.torsoBaseZ);
    this.rig.torso.rotation.set(0, 0, 0);
    this.rig.armPivot.rotation.z = deg(ARM_HOME);
    this._applyMouth(persona.smile);
    this._applyEye(0);
  }

  async _wait(ms) {
    await sleep(ms / this.speed);
  }

  // --- wt_core.Driver -----------------------------------------------------
  // wt_core.mjs はこの2つも await する。実際に時間がかかる指示（腕を振る、
  // 揺れる等）はここで待ち切ってから返すので、次の指示は前の動きが終わってから来る。

  async servo(name, value) {
    this._log("servo", name, value);
    if (name === "arm") await this._arm(value);
    else if (name === "body_sway") await this._sway(value);
    else if (name === "drive") await this._drive(value);
    else if (name === "head") await this._head(value);
    else if (name === "gaze") await this._gaze(value);
    else if (name === "body") await this._body(value);
  }

  async led(name, value) {
    this._log("led", name, value);
    const pct = Math.max(0, Math.min(100, firstNumber(value, this.smile)));
    if (name === "mouth" || name === "cheek") this._applyMouth(pct);
    else if (name === "eye") this._applyEye(pct);
  }

  async wait(ms) {
    this._log("wait", "", ms);
    await this._wait(ms);
  }

  note(text) {
    this._log("note", "", text);
  }

  // --- 表情の反映 ---------------------------------------------------------

  _applyMouth(pct) {
    const t = Math.max(0, Math.min(100, pct)) / 100;
    this.rig.mouthMat.emissive.setRGB(0.4 * t, 0.2 * t, 0.6 * t);
    this.rig.mouthMat.emissiveIntensity = 0.3 + t * 0.7;
    this.rig.mouthMat.color.setRGB(1, 1 - t * 0.4, 1 - t * 0.5);
  }

  _applyEye(pct) {
    const t = Math.max(0, Math.min(100, pct)) / 100;
    this.rig.eyeL.material.emissiveIntensity = t;
    this.rig.eyeR.material.emissiveIntensity = t;
  }

  // --- 個々の割り当て（wt_actuate.py と対応） ------------------------------

  async _arm(value) {
    await this._waveOnce();
  }

  async _waveOnce() {
    this.rig.armPivot.rotation.z = deg(ARM_UP);
    await this._wait(GESTURE_HALF_MS);
    this.rig.armPivot.rotation.z = deg(ARM_DOWN);
    await this._wait(GESTURE_HALF_MS);
    this.rig.armPivot.rotation.z = deg(ARM_HOME);
  }

  async _sway(value) {
    const nums = allNumbers(value);
    const amplitudeDeg = nums.length ? nums[0] : 4;
    const periodMs = nums.length > 1 ? nums[1] : 2400;
    const half = Math.max(60, periodMs / 2);
    this.rig.torso.rotation.z = deg(amplitudeDeg * 0.6);
    await this._wait(half);
    this.rig.torso.rotation.z = deg(-amplitudeDeg * 0.6);
    await this._wait(half);
  }

  /**
   * 物理版は前傾／後傾で代用しているが、アバターは実際に踏み出せる。
   * ここが「仮想空間には車輪の問題が無い」ことを見せる場所。
   */
  async _drive(value) {
    const forward = String(value).startsWith("forward");
    const dz = forward ? -LEAN_FORWARD_M : LEAN_BACK_M;
    this.rig.torso.position.z = this.torsoBaseZ + dz;
    await this._wait(400);
    this.rig.torso.position.z = this.torsoBaseZ;
  }

  async _head(value) {
    const v = String(value);
    if (v.startsWith("nod")) {
      const fast = v.includes("fast");
      const times = fast ? 2 : 1;
      const gap = fast ? 90 : NOD_MS;
      for (let i = 0; i < times; i++) {
        this.rig.headGroup.rotation.x = deg(14);
        await this._wait(gap);
        this.rig.headGroup.rotation.x = 0;
        await this._wait(gap);
      }
    } else if (v.startsWith("shake")) {
      for (const d of [-10, 10, -6, 0]) {
        this.rig.headGroup.rotation.y = deg(d);
        await this._wait(110);
      }
    } else if (v.startsWith("tilt") || v.startsWith("turn")) {
      this.rig.headGroup.rotation.y = v.startsWith("turn") ? deg(-28) : deg(-12);
      await this._wait(200);
    } else {
      this.rig.headGroup.rotation.set(0, 0, 0);
    }
  }

  async _gaze(value) {
    if (String(value).startsWith("glance")) {
      this._applyEye(100);
      await this._wait(160);
      this._applyEye(0);
      return;
    }
    const ms = firstNumber(value, 800);
    this._applyEye(100);
    await this._wait(ms);
    this._applyEye(0);
  }

  async _body(value) {
    if (String(value).startsWith("bounce")) {
      for (const d of [0.08, -0.05, 0.03, 0]) {
        this.rig.torso.position.y = this.torsoCenterY + d;
        await this._wait(90);
      }
    } else {
      this.rig.torso.position.y = this.torsoCenterY;
      await this._wait(200);
    }
  }

  // --- ログ ---------------------------------------------------------------

  _log(kind, name, value) {
    if (!this.onAct) return;
    this.onAct({ t: "act", o: kind, n: name, v: value, ms: Math.round(this.clock()) });
  }
}
