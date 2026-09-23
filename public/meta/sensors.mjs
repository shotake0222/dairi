/**
 * スマホのセンサー（ジャイロ・加速度・マイク・カメラ・振動）を、ミニゲームで使いやすい形にする。
 *
 * 約束（プライバシーポリシー 11-2 と同じ）:
 *   - **どのセンサーの値も、この端末の中だけで使う。** サーバーへは送らない・記録しない
 *   - マイクは「声の大きさ」だけを使う。録音・音声認識はしない
 *   - カメラの映像は画面の背景に映すだけ。保存・送信・解析はしない
 *   - ゲームが終わったら、マイク・カメラはすぐ止める（ブラウザの「使用中」表示が消える）
 *
 * 使えないとき（パソコン、許可しなかった、古い端末）は、どのゲームも画面の操作で遊べるようにしてある。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 画面の向き（縦=0、横=90/-90） */
export function screenAngle() {
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return Number(a) || 0;
}

/**
 * iOS はジャイロ・加速度を使う前に、利用者の許可が要る（タップの中で呼ぶこと）。
 * 許可の仕組みが無い端末（Android・パソコン）では、そのまま true。
 */
export async function requestMotionPermission() {
  const reqs = [];
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    reqs.push(DeviceOrientationEvent.requestPermission());
  }
  if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
    reqs.push(DeviceMotionEvent.requestPermission());
  }
  if (reqs.length === 0) return true;
  const results = await Promise.all(reqs.map((p) => p.catch(() => "denied")));
  return results.every((r) => r === "granted");
}

/** 最初の値が届くまで待つ（届かなければ、その端末には無いとみなす） */
function waitFirst(check, ms = 900) {
  return new Promise((resolve) => {
    const start = performance.now();
    const loop = () => {
      if (check()) return resolve(true);
      if (performance.now() - start > ms) return resolve(false);
      setTimeout(loop, 60);
    };
    loop();
  });
}

/**
 * 端末の傾き・向き（deviceorientation）。
 * tilt(): 始めたときの持ち方を0として、左右 x・前後 y を -1〜1 で返す（前へ倒す＝y が正）
 * quaternion(q): 端末の向きを、3Dのカメラの向きに変換する（ぐるっと見回すゲーム用）
 */
export class Orientation {
  constructor() {
    this.alpha = null;
    this.beta = null;
    this.gamma = null;
    this.zero = null;
    this.alphaZero = 0;
    this.onEvent = (e) => {
      if (e.alpha === null && e.beta === null) return;
      this.alpha = e.alpha ?? 0;
      this.beta = e.beta ?? 0;
      this.gamma = e.gamma ?? 0;
    };
    window.addEventListener("deviceorientation", this.onEvent);
  }

  async ready() {
    const ok = await waitFirst(() => this.beta !== null);
    if (ok) this.calibrate();
    return ok;
  }

  calibrate() {
    this.zero = { beta: this.beta ?? 0, gamma: this.gamma ?? 0 };
    this.alphaZero = this.alpha ?? 0;
  }

  tilt(rangeDeg = 28) {
    if (this.beta === null || !this.zero) return { x: 0, y: 0 };
    const db = this.beta - this.zero.beta;
    const dg = this.gamma - this.zero.gamma;
    const a = screenAngle();
    let sx = dg;
    let sy = db;
    if (a === 90) {
      sx = db;
      sy = -dg;
    } else if (a === -90 || a === 270) {
      sx = -db;
      sy = dg;
    } else if (a === 180) {
      sx = -dg;
      sy = -db;
    }
    // 前へ倒す（画面の上の端が下がる）と beta が減る → y は正
    return { x: clamp(sx / rangeDeg, -1, 1), y: clamp(-sy / rangeDeg, -1, 1) };
  }

  /** 端末の向き → カメラの向き（three.js の旧 DeviceOrientationControls と同じ式） */
  quaternion(THREE, out) {
    if (this.alpha === null) return false;
    const rad = Math.PI / 180;
    const euler = new THREE.Euler(this.beta * rad, (this.alpha - this.alphaZero) * rad, -this.gamma * rad, "YXZ");
    out.setFromEuler(euler);
    out.multiply(new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)));
    out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -screenAngle() * rad));
    return true;
  }

  stop() {
    window.removeEventListener("deviceorientation", this.onEvent);
  }
}

/**
 * 端末の動き（devicemotion）。
 * - ふった瞬間（onShake）: 強い揺れの山を1回と数える
 * - 足ぶみ（onStep）: 弱い揺れの山
 * - level: いまの揺れの大きさ（なめらかにした値。m/s²）。止まっているかの判定に使う
 */
export class Motion {
  constructor({ shakeThreshold = 13, stepThreshold = 2.6 } = {}) {
    this.level = 0;
    this.got = false;
    this.gravity = null;
    this.lastShake = 0;
    this.lastStep = 0;
    this.shakeThreshold = shakeThreshold;
    this.stepThreshold = stepThreshold;
    this.onShake = null;
    this.onStep = null;
    this.onEvent = (e) => {
      let x;
      let y;
      let z;
      if (e.acceleration && e.acceleration.x !== null) {
        ({ x, y, z } = e.acceleration);
      } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) {
        // 重力を低域通過で取り除く
        const g = e.accelerationIncludingGravity;
        if (!this.gravity) this.gravity = { x: g.x, y: g.y, z: g.z };
        const k = 0.9;
        this.gravity.x = this.gravity.x * k + g.x * (1 - k);
        this.gravity.y = this.gravity.y * k + g.y * (1 - k);
        this.gravity.z = this.gravity.z * k + g.z * (1 - k);
        x = g.x - this.gravity.x;
        y = g.y - this.gravity.y;
        z = g.z - this.gravity.z;
      } else {
        return;
      }
      this.got = true;
      const m = Math.hypot(x || 0, y || 0, z || 0);
      this.level = this.level * 0.85 + m * 0.15;
      const now = performance.now();
      if (m > this.shakeThreshold && now - this.lastShake > 170) {
        this.lastShake = now;
        this.onShake?.(m);
      }
      if (m > this.stepThreshold && now - this.lastStep > 280) {
        this.lastStep = now;
        this.onStep?.(m);
      }
    };
    window.addEventListener("devicemotion", this.onEvent);
  }

  ready() {
    return waitFirst(() => this.got);
  }

  stop() {
    window.removeEventListener("devicemotion", this.onEvent);
  }
}

/** 声の大きさ（0〜1）。録音はしない。解析器から大きさだけを読む */
export class Mic {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    const src = this.ac.createMediaStreamSource(this.stream);
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.floor = 0.01;
    return true;
  }

  /** いまの大きさ（周りの音の大きさを差し引いて 0〜1） */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    // 周りの音（床）は、ゆっくりだけ追いかける
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
    return clamp((rms - this.floor * 1.6) * 9, 0, 1);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ac?.close().catch(() => undefined);
    this.stream = null;
    this.analyser = null;
  }
}

/** 外側のカメラの映像を、video 要素に映すだけ */
export class CameraFeed {
  constructor(video) {
    this.video = video;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    this.video.srcObject = this.stream;
    this.video.hidden = false;
    await this.video.play().catch(() => undefined);
    return true;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.video.hidden = true;
    this.stream = null;
  }
}

/** 振動（対応していない端末では何もしない。iPhone の Safari は非対応） */
export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* noop */
  }
}

/** 短い効果音（WebAudio。ファイルを取りに行かない） */
let audioCtx = null;
export function beep(freq = 880, ms = 90, volume = 0.08, type = "sine") {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx ??= new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(volume, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  } catch {
    /* noop */
  }
}

/**
 * 画面の操作（センサーの代わり）。
 * - vector: 押した所からのずれ（-1〜1）。スティック代わり
 * - onDrag(dx, dy): 指を動かした量[px]。見回す操作
 * - onTap(x, y): 軽く触れた
 */
export class TouchPad {
  constructor(el, { radius = 70 } = {}) {
    this.el = el;
    this.radius = radius;
    this.vector = { x: 0, y: 0 };
    this.active = null;
    this.onDrag = null;
    this.onTap = null;
    this.onDown = null;
    this.onUp = null;
    this.handlers = {
      down: (e) => {
        if (this.active) return;
        el.setPointerCapture?.(e.pointerId);
        this.active = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, at: performance.now(), moved: false };
        this.onDown?.(e.clientX, e.clientY);
      },
      move: (e) => {
        const a = this.active;
        if (!a || a.id !== e.pointerId) return;
        const dx = e.clientX - a.x;
        const dy = e.clientY - a.y;
        a.x = e.clientX;
        a.y = e.clientY;
        if (Math.hypot(a.x - a.sx, a.y - a.sy) > 8) a.moved = true;
        this.vector = { x: clamp((a.x - a.sx) / this.radius, -1, 1), y: clamp((a.y - a.sy) / this.radius, -1, 1) };
        this.onDrag?.(dx, dy);
      },
      up: (e) => {
        const a = this.active;
        if (!a || a.id !== e.pointerId) return;
        this.active = null;
        this.vector = { x: 0, y: 0 };
        this.onUp?.();
        if (!a.moved && performance.now() - a.at < 500) this.onTap?.(e.clientX, e.clientY);
      },
    };
    el.addEventListener("pointerdown", this.handlers.down);
    el.addEventListener("pointermove", this.handlers.move);
    el.addEventListener("pointerup", this.handlers.up);
    el.addEventListener("pointercancel", this.handlers.up);
  }

  get pressed() {
    return !!this.active;
  }

  stop() {
    this.el.removeEventListener("pointerdown", this.handlers.down);
    this.el.removeEventListener("pointermove", this.handlers.move);
    this.el.removeEventListener("pointerup", this.handlers.up);
    this.el.removeEventListener("pointercancel", this.handlers.up);
  }
}

/**
 * 見回す操作（ジャイロがあれば端末の向き、無ければ指でなぞる）。
 * ジャイロのときも、指でなぞると左右の向きを足せる（机の上に置いたまま遊ぶ人向け）。
 */
export class LookControl {
  constructor(THREE, orientation, pad) {
    this.THREE = THREE;
    this.o = orientation;
    this.yaw = 0;
    this.pitch = 0;
    this.extraYaw = 0;
    this.q = new THREE.Quaternion();
    this.tmp = new THREE.Quaternion();
    if (pad) {
      pad.onDrag = (dx, dy) => {
        if (this.o) this.extraYaw += dx * 0.006;
        else {
          this.yaw += dx * 0.006;
          this.pitch = clamp(this.pitch - dy * 0.005, -1.2, 1.2);
        }
      };
    }
  }

  /** カメラへ向きを入れる。戻り値は、いま向いている左右の角度（ラジアン） */
  apply(camera) {
    const THREE = this.THREE;
    if (this.o && this.o.quaternion(THREE, this.tmp)) {
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.extraYaw).multiply(this.tmp);
    } else {
      this.q.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    }
    camera.quaternion.copy(this.q);
    const e = new THREE.Euler().setFromQuaternion(this.q, "YXZ");
    return e.y;
  }
}
