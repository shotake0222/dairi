/**
 * センサー・XRを使うミニゲーム（最初の10種類。あとから足した10種類は sensorgames2.mjs）。
 * 定義（名前・使うセンサー・設定の範囲）は src/metaverse.ts の SENSOR_GAMES。
 *
 *   tilt      かたむけコロコロ      ジャイロ        端末をかたむけて分身を転がし、コインを集める
 *   shake     ふりふりダッシュ      加速度          ふるほど速く走る。制限時間内にゴール
 *   balance   ゆらゆらバランス      ジャイロ        丸太の上の分身を、かたむきで支える
 *   voice     こえでジャンプ        マイク          声を出すとジャンプ。転がってくる箱をとびこえる
 *   arhunt    カメラでARさがし      カメラ＋ジャイロ カメラの映像に浮かぶ星を、見回してタップ
 *   skycatch  ぐるっと星キャッチ    ジャイロ        分身の目線で見回し、流れ星を真ん中に合わせる
 *   rhythm    ふりふりリズム        加速度          輪がちぢむのに合わせて、ふる（またはタップ）
 *   hotcold   ホット＆コールド      向き＋振動      かくれた宝の方角をさがす。近いほど震える
 *   daruma    だるまさんがころんだ  加速度          足ぶみで進み、鬼がふり向いたら止まる
 *   xr        ARでおでかけ          WebXR          現実の床に分身を出し、シャボン玉を割る
 *
 * どのゲームも:
 *   - 部屋の3D空間とは別の小さな場面（scene）で遊ぶ。自分の分身（同じ種族・色のモデル）が主役
 *   - センサーが使えないとき（パソコン・許可しなかった）は、画面の操作で遊べる（fallback）
 *   - **センサーの値・カメラの映像・声は、この端末の中だけで使う。** 点数も送らない（games.mjs と同じ）
 */

import { loadCharacter } from "./glb.mjs";
import { textCanvas } from "./world.mjs";
import { CameraFeed, LookControl, Mic, Motion, Orientation, TouchPad, beep, requestMotionPermission, vibrate } from "./sensors.mjs";

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** 自己ベストの見せ方（どれも大きいほど良い） */
export const SENSOR_BEST = {
  tilt: (v) => `残り${v}秒`,
  shake: (v) => `残り${v}秒`,
  balance: (v) => `安定度${v}%`,
  voice: (v) => `残り${v}秒`,
  arhunt: (v) => `残り${v}秒`,
  skycatch: (v) => `残り${v}秒`,
  rhythm: (v) => `${v}%`,
  hotcold: (v) => `残り${v}秒`,
  daruma: (v) => `残り${v}秒`,
  xr: (v) => `残り${v}秒`,
};

// ---------------------------------------------------------------- 共通

export class SensorGame {
  /**
   * @param {object} api GameRunner から渡される口
   *   THREE, me{species,color,name,voice}, layer{root,touch,ctrl,meter,center,video,info},
   *   hud(text), hint(text), end(result), sound(), speak(text), aspect(), renderer
   * @param {object} o 置く物の設定（goal, seconds, level, clearMessage…）
   */
  constructor(api, o) {
    this.api = api;
    this.o = o;
    this.THREE = api.THREE;
    this.level = clamp(Number(o.level) || 2, 1, 3);
    this.scene = new api.THREE.Scene();
    this.camera = new api.THREE.PerspectiveCamera(60, api.aspect(), 0.05, 300);
    this.scene.add(this.camera);
    this.cleanups = [];
    this.ended = false;
    this.transparent = false;
    this.endsAt = 0;
    this.startedAt = performance.now();
  }

  get view() {
    return { scene: this.scene, camera: this.camera, transparent: this.transparent };
  }

  /** ジャイロ・加速度の許可を求める（タップの中で最初に呼ぶこと。iOS の決まり） */
  permission() {
    this.motionAllowed = requestMotionPermission();
    return this.motionAllowed;
  }

  async orientation() {
    if (!(await this.motionAllowed)) return null;
    const o = new Orientation();
    this.cleanups.push(() => o.stop());
    return (await o.ready()) ? o : null;
  }

  async motion(opts) {
    if (!(await this.motionAllowed)) return null;
    const m = new Motion(opts);
    this.cleanups.push(() => m.stop());
    return (await m.ready()) ? m : null;
  }

  pad() {
    const p = new TouchPad(this.api.layer.touch);
    this.cleanups.push(() => p.stop());
    return p;
  }

  /** 下の操作ボタン（押している間 / 押した瞬間） */
  button(label, { down, up, wide } = {}) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `gameBtn${wide ? " wide" : ""}`;
    b.textContent = label;
    const onDown = (e) => {
      e.preventDefault();
      b.classList.add("on");
      down?.();
    };
    const onUp = () => {
      b.classList.remove("on");
      up?.();
    };
    b.addEventListener("pointerdown", onDown);
    b.addEventListener("pointerup", onUp);
    b.addEventListener("pointercancel", onUp);
    b.addEventListener("pointerleave", onUp);
    this.api.layer.ctrl.appendChild(b);
    return b;
  }

  /** メーター（0〜1 の棒。mark は目安の線） */
  meter(label) {
    const wrap = document.createElement("div");
    wrap.className = "gameMeter";
    wrap.innerHTML = `<span></span><i><b></b><em></em></i>`;
    wrap.querySelector("span").textContent = label;
    this.api.layer.meter.appendChild(wrap);
    const bar = wrap.querySelector("b");
    const mark = wrap.querySelector("em");
    return {
      set(v, color) {
        bar.style.width = `${clamp(v, 0, 1) * 100}%`;
        if (color) bar.style.background = color;
      },
      mark(v) {
        mark.style.left = `${clamp(v, 0, 1) * 100}%`;
        mark.hidden = false;
      },
      el: wrap,
    };
  }

  lights(sky = 0xcfeaff, ground = 0x88b070, intensity = 1.15) {
    const THREE = this.THREE;
    this.scene.add(new THREE.HemisphereLight(sky, ground, intensity));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(3, 8, 5);
    this.scene.add(sun);
  }

  /**
   * 自分の分身のモデル（読み込みは後から差し込む。待たずに遊び始められる）。
   * species / color を渡すと、別の子（はねつきのお相手など）になる。
   */
  avatar(scale = 0.78, species, color) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    const body = new THREE.Group();
    group.add(body);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5 * (scale / 0.78), 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    group.add(shadow);
    group.userData.body = body;
    const me = this.api.me;
    loadCharacter(THREE, species || me.species, color || me.color).then((model) => {
      if (this.ended) return;
      if (model) {
        const box = new THREE.Box3().setFromObject(model);
        model.scale.setScalar(scale);
        model.position.y = -box.min.y * scale;
        body.add(model);
      } else {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45 * (scale / 0.78), 20, 14), new THREE.MeshLambertMaterial({ color: 0xffb3d0 }));
        ball.position.y = 0.45 * (scale / 0.78);
        body.add(ball);
      }
    });
    return group;
  }

  /** 見回すゲームで、画面の右下にいっしょにいる分身 */
  companion() {
    // カメラのすぐ前（0.5m）に小さく置く。遠くに置くと、下を向いたときに地面に埋まる
    const a = this.avatar(0.035);
    a.rotation.y = -0.5;
    a.children[1].visible = false; // 影は要らない
    this.camera.add(a);
    this.buddy = a;
    this.placeBuddy();
    return a;
  }

  /** 画面の縦横比に合わせて、右下の角に収める */
  placeBuddy() {
    if (!this.buddy) return;
    const z = 0.5;
    const halfH = Math.tan((this.camera.fov * Math.PI) / 360) * z;
    const halfW = halfH * this.camera.aspect;
    this.buddy.position.set(halfW - 0.032, -halfH + 0.008, -z);
  }

  /** 縦長の画面では横が狭いので、カメラを少し引く倍率（横長・正方形なら 1） */
  fit(base = 0.75) {
    return Math.max(1, base / Math.max(0.3, this.camera.aspect));
  }

  cheer(text = "やった！") {
    const b = this.buddy || this.hero;
    if (b) b.userData.hopUntil = performance.now() + 500;
    this.api.hint(text, 900);
  }

  hopUpdate(group, t) {
    if (!group) return;
    if (group === this.buddy) this.placeBuddy();
    const body = group.userData.body;
    const until = group.userData.hopUntil || 0;
    body.position.y = performance.now() < until ? Math.abs(Math.sin(t * 16)) * 0.12 * (group === this.buddy ? 0.1 : 1) : 0;
  }

  label(text, { color = "#2a2440", bg = "rgba(255,255,255,0.95)", width = 1.4 } = {}) {
    const THREE = this.THREE;
    const tex = new THREE.CanvasTexture(textCanvas([text], { width: 512, height: 150, fontSize: 80, bg, color, radius: 60 }));
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(width, (width * 150) / 512, 1);
    spr.renderOrder = 10;
    return spr;
  }

  timer(seconds) {
    this.endsAt = performance.now() + seconds * 1000;
  }

  get left() {
    return Math.max(0, Math.ceil((this.endsAt - performance.now()) / 1000));
  }

  timeUp() {
    return this.endsAt > 0 && performance.now() >= this.endsAt;
  }

  sfx(freq, ms, vol, type) {
    if (this.api.sound()) beep(freq, ms, vol, type);
  }

  finish(result) {
    if (this.ended) return;
    this.api.end(result);
  }

  /** 片づけ（GameRunner.stop から呼ばれる。自分からは呼ばない） */
  dispose() {
    this.ended = true;
    for (const c of this.cleanups.splice(0)) {
      try {
        c();
      } catch {
        /* noop */
      }
    }
    this.scene.traverse((n) => {
      n.geometry?.dispose?.();
      const mats = n.material ? (Array.isArray(n.material) ? n.material : [n.material]) : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
  }
}

/** 空間のあちこちに散らす（真ん中と、互いに近すぎる所を避ける） */
export function scatter(count, half, minCenter = 1.4, minGap = 1.2) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 80) {
    const x = rand(-half, half);
    const z = rand(-half, half);
    if (Math.hypot(x, z) < minCenter) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < minGap)) continue;
    out.push({ x, z });
  }
  return out;
}

/** 空の丸天井（上から下へのグラデーション） */
export function skyDome(THREE, top, bottom) {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.SphereGeometry(90, 24, 16), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false }));
}

// ---------------------------------------------------------------- 1. かたむけコロコロ

class TiltGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.api.hint(this.sensor ? "端末をかたむけて転がそう（始めたときの持ち方が「まっすぐ」）" : "画面をなぞった方向へ転がるよ", 3200);
    this.scene.background = new THREE.Color(0xbfe6ff);
    this.lights();
    const half = 5.5;
    this.half = half;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.3, half * 2), new THREE.MeshLambertMaterial({ color: 0x9ed67a }));
    floor.position.y = -0.15;
    this.scene.add(floor);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0xf2e3c6 });
    for (const [w, d, x, z] of [
      [half * 2 + 0.4, 0.4, 0, -half - 0.2],
      [half * 2 + 0.4, 0.4, 0, half + 0.2],
      [0.4, half * 2, -half - 0.2, 0],
      [0.4, half * 2, half + 0.2, 0],
    ]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.5, d), wallMat);
      wall.position.set(x, 0.1, z);
      this.scene.add(wall);
    }
    this.hero = this.avatar(0.62);
    this.scene.add(this.hero);
    this.vel = new THREE.Vector2(0, 0);
    const coinGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 20);
    const coinMat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0xffa000, emissiveIntensity: 0.4 });
    this.goal = this.o.goal || 8;
    this.coins = scatter(this.goal, half - 0.8).map((p, i) => {
      const c = new THREE.Mesh(coinGeo, coinMat);
      c.rotation.x = Math.PI / 2;
      c.position.set(p.x, 0.45, p.z);
      c.userData.phase = i;
      this.scene.add(c);
      return c;
    });
    this.got = 0;
    // むずかしい: 転がるトゲ玉（ぶつかると、はね返されて2秒へる）
    this.spikes = [];
    if (this.level >= 3) {
      for (let i = 0; i < 2; i++) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), new THREE.MeshLambertMaterial({ color: 0x6a5a8a }));
        s.position.set(rand(-3, 3), 0.4, i ? -3.5 : 3.5);
        s.userData.v = new THREE.Vector2(rand(1.5, 2.5) * (Math.random() < 0.5 ? -1 : 1), rand(1, 2));
        this.scene.add(s);
        this.spikes.push(s);
      }
    }
    this.timer(this.o.seconds || 45);
  }

  update(dt, t) {
    const THREE = this.THREE;
    const tilt = this.sensor ? this.sensor.tilt(24) : { x: this.touch.vector.x, y: -this.touch.vector.y };
    const acc = 13 * (0.75 + this.level * 0.18);
    this.vel.x += tilt.x * acc * dt;
    this.vel.y += -tilt.y * acc * dt;
    this.vel.multiplyScalar(Math.max(0, 1 - 1.5 * dt));
    if (this.vel.length() > 7) this.vel.setLength(7);
    const p = this.hero.position;
    p.x += this.vel.x * dt;
    p.z += this.vel.y * dt;
    const lim = this.half - 0.45;
    if (Math.abs(p.x) > lim) {
      p.x = Math.sign(p.x) * lim;
      this.vel.x *= -0.5;
    }
    if (Math.abs(p.z) > lim) {
      p.z = Math.sign(p.z) * lim;
      this.vel.y *= -0.5;
    }
    const speed = this.vel.length();
    if (speed > 0.25) {
      const heading = Math.atan2(this.vel.x, this.vel.y);
      this.hero.rotation.y += wrapAngle(heading - this.hero.rotation.y) * Math.min(1, dt * 8);
    }
    const body = this.hero.userData.body;
    body.rotation.x = clamp(speed * 0.06, 0, 0.35);
    body.position.y = Math.abs(Math.sin(t * (6 + speed * 2))) * Math.min(0.12, speed * 0.03);

    const reach = this.level === 1 ? 0.85 : 0.7;
    for (const c of this.coins) {
      if (!c.visible) continue;
      c.rotation.z = t * 3 + c.userData.phase;
      if (Math.hypot(c.position.x - p.x, c.position.z - p.z) < reach) {
        c.visible = false;
        this.got += 1;
        this.sfx(980 + this.got * 40, 90, 0.07, "triangle");
        vibrate(20);
        if (this.got >= this.goal) {
          this.finish({ clear: true, score: this.left, summary: `コインをぜんぶ集めた！ のこり${this.left}秒` });
          return;
        }
      }
    }
    for (const s of this.spikes) {
      const v = s.userData.v;
      s.position.x += v.x * dt;
      s.position.z += v.y * dt;
      if (Math.abs(s.position.x) > lim) v.x *= -1;
      if (Math.abs(s.position.z) > lim) v.y *= -1;
      s.rotation.x += dt * 2;
      if (Math.hypot(s.position.x - p.x, s.position.z - p.z) < 0.8 && !(s.userData.cool > t)) {
        s.userData.cool = t + 1.2;
        this.vel.set(p.x - s.position.x, p.z - s.position.z).setLength(6);
        this.endsAt -= 2000;
        this.api.hint("いたっ！ -2秒", 900);
        vibrate([40, 40, 40]);
      }
    }
    const k = this.fit(0.8);
    this.camera.position.set(0, 11.5 * k, 7.2 * k);
    this.camera.lookAt(0, 0, 0.6);
    this.api.hud(`コイン ${this.got} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}枚中 ${this.got}枚あつめたよ` });
    void THREE;
  }
}

// ---------------------------------------------------------------- 2. ふりふりダッシュ

class ShakeGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 30;
    this.speed = 0;
    this.dist = 0;
    this.sensor = await this.motion({ shakeThreshold: 12 });
    if (this.sensor) this.sensor.onShake = (m) => this.kick(clamp(m / 16, 0.8, 1.6));
    this.button(this.sensor ? "ふる！（ボタンでもOK）" : "連打で走る！", { down: () => this.kick(0.9), wide: true });
    this.api.hint(this.sensor ? "端末をしっかりふると、速く走るよ" : "ボタンを連打して走ろう", 3000);

    this.scene.background = new THREE.Color(0xaee0ff);
    this.scene.fog = new THREE.Fog(0xaee0ff, 18, 60);
    this.lights();
    const len = this.goal + 30;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(40, len + 40), new THREE.MeshLambertMaterial({ color: 0x8fcf6c }));
    grass.rotation.x = -Math.PI / 2;
    grass.position.z = -len / 2 + 10;
    this.scene.add(grass);
    // 走路（白い線を描いた画像をくり返す）
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#e07b52";
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 4, 64);
    g.fillRect(60, 0, 4, 64);
    g.fillRect(0, 0, 64, 3);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, len / 2);
    tex.colorSpace = THREE.SRGBColorSpace;
    const track = new THREE.Mesh(new THREE.PlaneGeometry(2.4, len), new THREE.MeshLambertMaterial({ map: tex }));
    track.rotation.x = -Math.PI / 2;
    track.position.set(0, 0.01, -len / 2 + 5);
    this.scene.add(track);
    for (let m = 10; m < this.goal; m += 10) {
      const s = this.label(`${m}m`, { width: 1 });
      s.position.set(-1.9, 0.6, -m);
      this.scene.add(s);
    }
    // ゴールのアーチ
    const archMat = new THREE.MeshLambertMaterial({ color: 0xff6f91 });
    for (const sx of [-1.5, 1.5]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 10), archMat);
      pole.position.set(sx, 1.3, -this.goal);
      this.scene.add(pole);
    }
    const banner = this.label("GOAL", { width: 2.6, bg: "rgba(255,111,145,0.95)", color: "#ffffff" });
    banner.position.set(0, 2.5, -this.goal);
    this.scene.add(banner);

    this.hero = this.avatar(0.7);
    this.hero.rotation.y = Math.PI;
    this.scene.add(this.hero);
    // ペースメーカー（この速さで走れば、ちょうど時間内に着く）
    this.pacer = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.pacer.position.set(0.8, 0.3, 0);
    this.scene.add(this.pacer);
    this.pace = this.goal / ((this.o.seconds || 20) * 0.95);
    this.timer(this.o.seconds || 20);
  }

  kick(power) {
    if (this.ended) return;
    this.speed = Math.min(9, this.speed + 1.35 * power);
    this.sfx(520 + this.speed * 40, 50, 0.04, "square");
  }

  update(dt, t) {
    this.speed *= Math.exp(-dt * (0.75 + this.level * 0.3));
    this.dist = Math.min(this.goal, this.dist + this.speed * dt);
    this.hero.position.z = -this.dist;
    const body = this.hero.userData.body;
    const run = Math.min(1, this.speed / 3);
    body.position.y = Math.abs(Math.sin(t * (8 + this.speed * 1.6))) * 0.16 * run;
    body.rotation.x = run * 0.25;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    this.pacer.position.z = -Math.min(this.goal, elapsed * this.pace);
    this.pacer.position.y = 0.3 + Math.abs(Math.sin(t * 7)) * 0.2;
    const z = this.hero.position.z;
    this.camera.position.set(2.6, 2.3, z + 5);
    this.camera.lookAt(0, 0.8, z - 3.5);
    this.api.hud(`${this.dist.toFixed(1)} / ${this.goal}m　のこり ${this.left}秒`);
    if (this.dist >= this.goal) {
      this.finish({ clear: true, score: this.left, summary: `ゴール！ のこり${this.left}秒` });
      return;
    }
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}mのうち ${this.dist.toFixed(1)}m 走ったよ` });
  }
}

// ---------------------------------------------------------------- 3. ゆらゆらバランス

class BalanceGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.sensor = await this.orientation();
    this.push = 0;
    if (!this.sensor) {
      this.button("◀ ささえる", { down: () => (this.push = -1), up: () => (this.push = 0) });
      this.button("ささえる ▶", { down: () => (this.push = 1), up: () => (this.push = 0) });
    }
    this.api.hint(this.sensor ? "たおれそうな方と反対へ、端末をかたむけて支えよう" : "たおれそうな方と反対のボタンを押して支えよう", 3200);
    this.scene.background = new THREE.Color(0xc9ecff);
    this.lights();
    const water = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshLambertMaterial({ color: 0x4aa8e0 }));
    water.rotation.x = -Math.PI / 2;
    this.water = water;
    this.scene.add(water);
    for (const sx of [-6, 6]) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(6, 0.6, 40), new THREE.MeshLambertMaterial({ color: 0x8fcf6c }));
      bank.position.set(sx * 1.4, 0.1, 0);
      this.scene.add(bank);
    }
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12, 16), new THREE.MeshLambertMaterial({ color: 0xa8743f }));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = Math.PI / 2;
    log.position.y = 0.3;
    this.scene.add(log);
    this.pivot = new THREE.Group();
    this.pivot.position.y = 0.56;
    this.scene.add(this.pivot);
    this.hero = this.avatar(0.7);
    this.hero.children[1].visible = false;
    this.pivot.add(this.hero);
    this.lean = rand(-0.05, 0.05);
    this.vel = 0;
    this.safe = 0;
    this.total = 0;
    this.phase = Math.random() * TAU;
    this.gauge = this.meter("ぐらつき");
    this.gauge.mark(0.5);
    this.camera.position.set(0, 1.7, 4.6);
    this.camera.lookAt(0, 1.0, 0);
    this.timer(this.o.seconds || 30);
  }

  update(dt, t) {
    if (this.fallen) {
      this.pivot.position.y -= dt * 3;
      this.pivot.rotation.z += Math.sign(this.pivot.rotation.z || 1) * dt * 2;
      return;
    }
    const control = this.sensor ? clamp(this.sensor.tilt(22).x, -1, 1) : this.push;
    const unstable = 1.3 + this.level * 0.55;
    // 始めの3秒は風を弱く（持ち方に慣れる間）
    const ramp = Math.min(1, 0.3 + this.total / 3);
    const wind = (Math.sin(t * 0.8 + this.phase) * 0.28 * this.level + Math.sin(t * 2.3) * 0.12 * this.level) * ramp;
    // 支える向き: 端末を右へかたむける（右のボタン）と、分身を右へ押し戻す
    const acc = Math.sin(this.lean) * unstable + wind + control * (3.2 + this.level * 0.4) - this.vel * 1.7;
    this.vel += acc * dt;
    this.lean += this.vel * dt;
    this.pivot.rotation.z = -this.lean;
    this.total += dt;
    if (Math.abs(this.lean) < 0.25) this.safe += dt;
    const shake = Math.abs(this.lean) / 0.9;
    this.gauge.set(shake, shake > 0.7 ? "#ff5a4f" : shake > 0.4 ? "#ffb13d" : "#5ccf8a");
    if (Math.abs(this.lean) > 0.9) {
      this.fallen = true;
      this.sfx(200, 400, 0.08, "sawtooth");
      vibrate([80, 40, 120]);
      const sec = Math.floor(this.total);
      setTimeout(() => this.finish({ clear: false, summary: `ドボン！ ${sec}秒がんばったよ` }), 900);
      return;
    }
    this.api.hud(`落ちずに のこり ${this.left}秒`);
    if (this.timeUp()) {
      const pct = Math.round((this.safe / Math.max(1, this.total)) * 100);
      this.finish({ clear: true, score: pct, summary: `わたりきった！ 安定度${pct}%` });
    }
  }
}

// ---------------------------------------------------------------- 4. こえでジャンプ

class VoiceGame extends SensorGame {
  async start() {
    const THREE = this.THREE;
    this.goal = this.o.goal || 10;
    this.mic = new Mic();
    try {
      await this.mic.start();
      this.cleanups.push(() => this.mic.stop());
      this.hasMic = true;
    } catch {
      this.hasMic = false;
    }
    this.touch = this.pad();
    this.touch.onDown = () => this.jump(0.6);
    this.api.hint(this.hasMic ? "「えいっ！」と声を出すとジャンプ（画面を押してもOK）" : "マイクが使えないので、画面を押してジャンプしてね", 3200);
    this.level_ = this.meter("こえ");
    this.level_.mark(0.35);

    this.scene.background = new THREE.Color(0xffe3b8);
    this.lights(0xfff1d6, 0xb08a5a);
    const ground = new THREE.Mesh(new THREE.BoxGeometry(30, 0.4, 4), new THREE.MeshLambertMaterial({ color: 0xe0b574 }));
    ground.position.y = -0.2;
    this.scene.add(ground);
    this.hero = this.avatar(0.7);
    this.hero.position.x = -1.5;
    this.hero.rotation.y = Math.PI / 2;
    this.scene.add(this.hero);
    this.vy = 0;
    this.boxes = [];
    this.cleared = 0;
    this.misses = 0;
    this.nextBox = performance.now() + 1600;
    this.boxSpeed = 2.2 + this.level * 0.6;
    this.timer(this.o.seconds || 60);
  }

  jump(power) {
    if (this.ended) return;
    if (this.hero.position.y > 0.001) return;
    this.vy = 4.6 + power * 2.2;
    this.sfx(660, 80, 0.05, "triangle");
  }

  update(dt) {
    const THREE = this.THREE;
    const v = this.hasMic ? this.mic.level() : 0;
    this.level_.set(v, v > 0.35 ? "#8b6cff" : "#b9aee8");
    if (v > 0.35) this.jump(v);
    const p = this.hero.position;
    this.vy -= 13 * dt;
    p.y = Math.max(0, p.y + this.vy * dt);
    if (p.y === 0) this.vy = 0;
    const now = performance.now();
    if (now > this.nextBox) {
      const tall = this.level >= 3 && Math.random() < 0.35;
      const h = tall ? 0.8 : 0.5;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, h, 0.6), new THREE.MeshLambertMaterial({ color: tall ? 0xc0694a : 0xd9975b }));
      box.position.set(8, h / 2, 0);
      box.userData = { h, passed: false, hit: false };
      this.scene.add(box);
      this.boxes.push(box);
      this.nextBox = now + rand(1500, 2900) / (0.8 + this.level * 0.2);
    }
    for (const b of this.boxes) {
      if (b.userData.hit) {
        b.position.y += dt * 3;
        b.rotation.z += dt * 6;
        b.position.x += dt * 2;
        continue;
      }
      b.position.x -= this.boxSpeed * dt;
      b.rotation.z += dt * this.boxSpeed * 1.5;
      if (!b.userData.passed && Math.abs(b.position.x - p.x) < 0.5 && p.y < b.userData.h - 0.05) {
        b.userData.hit = true;
        this.misses += 1;
        this.api.hint("ぶつかった！", 700);
        vibrate(60);
        this.sfx(180, 150, 0.06, "square");
      } else if (!b.userData.passed && b.position.x < p.x - 0.5) {
        b.userData.passed = true;
        this.cleared += 1;
        this.cheer(`${this.cleared}こ！`);
        if (this.cleared >= this.goal) {
          this.finish({ clear: true, score: this.left, summary: `${this.goal}こ とびこえた！ のこり${this.left}秒` });
          return;
        }
      }
    }
    this.boxes = this.boxes.filter((b) => {
      const keep = b.position.x > -9 && b.position.y < 6;
      if (!keep) {
        this.scene.remove(b);
        b.geometry.dispose();
        b.material.dispose();
      }
      return keep;
    });
    this.hero.userData.body.rotation.z = p.y > 0 ? -0.2 : 0;
    const k = this.fit(0.62);
    this.camera.position.set(0.6, 1.8, 7.5 * k);
    this.camera.lookAt(0.6, 0.9, 0);
    this.api.hud(`とびこえた ${this.cleared} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.cleared}こ とびこえたよ` });
  }
}

// ---------------------------------------------------------------- 5. カメラでARさがし

class ArHuntGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 8;
    this.feed = new CameraFeed(this.api.layer.video);
    try {
      await this.feed.start();
      this.cleanups.push(() => this.feed.stop());
      this.transparent = true;
    } catch {
      this.scene.add(skyDome(THREE, "#6fb8ff", "#e8f4ff"));
    }
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.look = new LookControl(THREE, this.sensor, this.touch);
    this.touch.onTap = (x, y) => this.tap(x, y);
    this.api.hint(
      `${this.transparent ? "" : "カメラが使えないので空の中で遊ぶよ。"}${this.sensor ? "端末を動かして見回し、" : "画面をなぞって見回し、"}星をタップ`,
      3400
    );
    this.lights(0xffffff, 0xffffff, 1.4);
    this.companion();
    const mat = new THREE.MeshBasicMaterial({ color: 0xffe14d });
    const geo = new THREE.OctahedronGeometry(this.level >= 3 ? 0.16 : 0.2, 0);
    this.stars = [];
    for (let i = 0; i < this.goal; i++) {
      const yaw = (i / this.goal) * TAU + rand(-0.3, 0.3);
      const pitch = rand(-0.3, 0.55);
      const s = new THREE.Mesh(geo, mat);
      s.userData = { yaw, pitch, r: rand(2.6, 3.6), drift: this.level === 1 ? 0 : rand(-0.12, 0.12) * this.level };
      const halo = this.label("✦", { width: 0.6, bg: "rgba(0,0,0,0)", color: "#fff6b0" });
      s.add(halo);
      this.scene.add(s);
      this.stars.push(s);
    }
    this.got = 0;
    this.ray = new THREE.Raycaster();
    this.arrow = document.createElement("div");
    this.arrow.className = "gameArrow";
    this.arrow.textContent = "➤";
    this.api.layer.center.appendChild(this.arrow);
    this.timer(this.o.seconds || 45);
  }

  tap(cx, cy) {
    const THREE = this.THREE;
    const rect = this.api.layer.touch.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    // 小さい星でも押しやすいように、当たりは広めに（光の輪ごと）
    this.ray.params.Points = { threshold: 0.3 };
    let best = null;
    let bestD = Infinity;
    for (const s of this.stars) {
      if (!s.visible) continue;
      const d = this.ray.ray.distanceToPoint(s.position);
      if (d < 0.42 && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    if (!best) return;
    best.visible = false;
    this.got += 1;
    this.sfx(1100 + this.got * 50, 90, 0.07, "triangle");
    vibrate(25);
    this.cheer(`★ ${this.got}`);
    if (this.got >= this.goal) this.finish({ clear: true, score: this.left, summary: `星をぜんぶ集めた！ のこり${this.left}秒` });
  }

  update(dt, t) {
    const THREE = this.THREE;
    this.look.apply(this.camera);
    let nearest = null;
    let nd = Infinity;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    for (const s of this.stars) {
      const u = s.userData;
      u.yaw += u.drift * dt;
      s.position.set(Math.sin(u.yaw) * Math.cos(u.pitch) * u.r, Math.sin(u.pitch) * u.r + Math.sin(t * 2 + u.yaw) * 0.08, -Math.cos(u.yaw) * Math.cos(u.pitch) * u.r);
      s.rotation.y = t * 2;
      if (!s.visible) continue;
      const ang = fwd.angleTo(s.position.clone().normalize());
      if (ang < nd) {
        nd = ang;
        nearest = s;
      }
    }
    // いちばん近い星が画面の外なら、その方向に矢印を出す
    if (nearest && nd > 0.5) {
      const v = nearest.position.clone().project(this.camera);
      let ax = v.x;
      let ay = v.y;
      if (v.z > 1) {
        ax = -ax;
        ay = -ay;
      }
      this.arrow.hidden = false;
      this.arrow.style.transform = `rotate(${-Math.atan2(ay, ax)}rad) translateX(38vmin)`;
    } else this.arrow.hidden = true;
    this.hopUpdate(this.buddy, t);
    this.api.hud(`星 ${this.got} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.got}こ 見つけたよ` });
  }
}

// ---------------------------------------------------------------- 6. ぐるっと星キャッチ

class SkyCatchGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 10;
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.look = new LookControl(THREE, this.sensor, this.touch);
    this.api.hint(this.sensor ? "端末を動かして見回し、流れ星を真ん中の輪に入れよう" : "画面をなぞって見回し、流れ星を真ん中の輪に入れよう", 3400);
    this.scene.add(skyDome(THREE, "#070a24", "#2a2f6a"));
    const pts = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const yaw = Math.random() * TAU;
      const pitch = Math.asin(Math.random() * 0.98);
      pts.set([Math.sin(yaw) * Math.cos(pitch) * 70, Math.sin(pitch) * 70, Math.cos(yaw) * Math.cos(pitch) * 70], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.35, sizeAttenuation: true })));
    const hill = new THREE.Mesh(new THREE.CircleGeometry(60, 40), new THREE.MeshBasicMaterial({ color: 0x14203a }));
    hill.rotation.x = -Math.PI / 2;
    this.scene.add(hill);
    this.camera.position.set(0, 1.0, 0);
    this.lights(0x8899ff, 0x223344, 0.8);
    this.companion();
    this.reticle = document.createElement("div");
    this.reticle.className = "gameReticle";
    this.api.layer.center.appendChild(this.reticle);
    this.meteors = [];
    this.caught = 0;
    this.aim = (this.level === 1 ? 10 : this.level === 2 ? 7.5 : 5.5) * (Math.PI / 180);
    this.timer(this.o.seconds || 45);
  }

  spawn() {
    const THREE = this.THREE;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.4, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0.45 }));
    tail.rotation.z = Math.PI / 2;
    tail.position.x = 0.75;
    m.add(tail);
    const camYaw = new THREE.Euler().setFromQuaternion(this.camera.quaternion, "YXZ").y;
    m.userData = {
      yaw: camYaw + rand(-1.6, 1.6),
      pitch: rand(0.12, 0.85),
      speed: rand(0.12, 0.22) * (0.7 + this.level * 0.3) * (Math.random() < 0.5 ? -1 : 1),
      life: rand(5, 8),
      hold: 0,
    };
    this.scene.add(m);
    this.meteors.push(m);
  }

  update(dt, t) {
    const THREE = this.THREE;
    this.look.apply(this.camera);
    if (this.meteors.length < this.level) this.spawn();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    let aiming = 0;
    for (const m of this.meteors) {
      const u = m.userData;
      u.yaw += u.speed * dt;
      u.life -= dt;
      const r = 12;
      const dir = new THREE.Vector3(-Math.sin(u.yaw) * Math.cos(u.pitch), Math.sin(u.pitch), -Math.cos(u.yaw) * Math.cos(u.pitch));
      m.position.copy(this.camera.position).addScaledVector(dir, r);
      m.lookAt(this.camera.position);
      m.rotation.z = u.speed > 0 ? 0 : Math.PI;
      if (fwd.angleTo(dir) < this.aim) {
        u.hold += dt;
        aiming = Math.max(aiming, u.hold / 0.35);
        if (u.hold >= 0.35) {
          u.life = -1;
          u.caught = true;
          this.caught += 1;
          this.sfx(1320, 120, 0.07, "triangle");
          vibrate(30);
          this.cheer(`キャッチ！ ${this.caught}`);
        }
      } else u.hold = Math.max(0, u.hold - dt * 2);
    }
    this.meteors = this.meteors.filter((m) => {
      if (m.userData.life > 0) return true;
      this.scene.remove(m);
      m.traverse((n) => {
        n.geometry?.dispose();
        n.material?.dispose();
      });
      return false;
    });
    this.reticle.style.setProperty("--p", String(clamp(aiming, 0, 1)));
    this.reticle.classList.toggle("on", aiming > 0);
    this.hopUpdate(this.buddy, t);
    this.api.hud(`流れ星 ${this.caught} / ${this.goal}　のこり ${this.left}秒`);
    if (this.caught >= this.goal) {
      this.finish({ clear: true, score: this.left, summary: `流れ星を${this.goal}こ つかまえた！ のこり${this.left}秒` });
      return;
    }
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.caught}こ つかまえたよ` });
  }
}

// ---------------------------------------------------------------- 7. ふりふりリズム

class RhythmGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.total = this.o.goal || 16;
    this.sensor = await this.motion({ shakeThreshold: 10 });
    if (this.sensor) this.sensor.onShake = () => this.hit();
    this.touch = this.pad();
    this.touch.onDown = () => this.hit();
    this.api.hint(this.sensor ? "輪が白い輪に重なった瞬間に、端末をふる（タップでもOK）" : "輪が白い輪に重なった瞬間に、画面をタップ", 3400);
    this.scene.background = new THREE.Color(0x2a1f4a);
    this.lights(0xffd6ff, 0x3a2a6a, 1.2);
    const stage = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.4, 0.3, 40), new THREE.MeshLambertMaterial({ color: 0x5a4a9a }));
    stage.position.y = -0.15;
    this.scene.add(stage);
    this.hero = this.avatar(0.8);
    this.scene.add(this.hero);
    const target = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.04, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    target.position.y = 0.75;
    this.scene.add(target);
    this.target = target;
    this.bpm = [84, 100, 118][this.level - 1];
    const beat = 60 / this.bpm;
    this.beat = beat;
    // 何拍目で叩くか（やさしいほど間があく）
    const steps = this.level === 1 ? [2] : this.level === 2 ? [2, 1, 1, 2] : [1, 1, 0.5, 0.5, 1, 2];
    const t0 = performance.now() / 1000 + 2.5;
    this.notes = [];
    let at = t0;
    for (let i = 0; i < this.total; i++) {
      this.notes.push({ at, ring: null, judged: false });
      at += steps[i % steps.length] * beat;
    }
    this.hits = 0;
    this.great = 0;
    this.nextTick = t0 - 2 * beat;
    this.camera.position.set(0, 1.4, 4.3);
    this.camera.lookAt(0, 0.8, 0);
  }

  hit() {
    if (this.ended) return;
    const now = performance.now() / 1000;
    let best = null;
    for (const n of this.notes) {
      if (n.judged) continue;
      const d = Math.abs(n.at - now);
      if (d < 0.32 && (!best || d < Math.abs(best.at - now))) best = n;
    }
    if (!best) return;
    best.judged = true;
    const great = Math.abs(best.at - now) < 0.13;
    this.hits += 1;
    if (great) this.great += 1;
    this.api.hint(great ? "ぴったり！" : "いいね！", 500);
    this.sfx(great ? 1320 : 990, 80, 0.07, "triangle");
    vibrate(great ? 35 : 20);
    this.hero.userData.hopUntil = performance.now() + 300;
    if (best.ring) best.ring.visible = false;
  }

  update(dt, t) {
    const THREE = this.THREE;
    const now = performance.now() / 1000;
    if (now >= this.nextTick) {
      this.sfx(440, 30, 0.025, "sine");
      this.nextTick += this.beat;
    }
    const lead = 2 * this.beat;
    for (const n of this.notes) {
      const k = (n.at - now) / lead; // 1 → 0 で重なる
      if (!n.ring && k <= 1 && !n.judged) {
        n.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 48), new THREE.MeshBasicMaterial({ color: 0xff7ad9, transparent: true }));
        n.ring.position.y = 0.75;
        this.scene.add(n.ring);
      }
      if (n.ring && n.ring.visible) {
        const s = 0.7 + Math.max(-0.2, k) * 1.8;
        n.ring.scale.setScalar(s / 1);
        n.ring.material.opacity = clamp(1 - Math.abs(k) * 0.5, 0.2, 1);
      }
      if (!n.judged && now - n.at > 0.32) {
        n.judged = true;
        if (n.ring) n.ring.visible = false;
        this.api.hint("おしい", 400);
      }
    }
    this.target.scale.setScalar(1 + Math.max(0, Math.sin(((now % this.beat) / this.beat) * Math.PI)) * 0.04);
    this.hopUpdate(this.hero, t);
    this.hero.rotation.y = Math.sin(t * 2) * 0.3;
    const done = this.notes.filter((n) => n.judged).length;
    this.api.hud(`ヒット ${this.hits} / ${this.total}　（のこり ${this.total - done}）`);
    if (done >= this.total) {
      const pct = Math.round((this.hits / this.total) * 100);
      const clear = this.hits / this.total >= 0.7;
      this.finish({ clear, score: clear ? pct : undefined, summary: `${this.total}こ中 ${this.hits}こ ヒット（ぴったり${this.great}）` });
    }
  }
}

// ---------------------------------------------------------------- 8. ホット＆コールド

class HotColdGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 3;
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.look = new LookControl(THREE, this.sensor, this.touch);
    this.api.hint(this.sensor ? "その場でぐるっと向きを変えて、宝の方角をさがそう（近いほど震える）" : "画面をなぞって向きを変え、宝の方角をさがそう", 3600);
    this.sky = skyDome(THREE, "#7fb4ff", "#e8f4ff");
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0x7fb4ff, 6, 40);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 40), new THREE.MeshLambertMaterial({ color: 0x8fcf6c }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    // 目じるしの木（どちらを向いているか分かるように）
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + rand(-0.1, 0.1);
      const r = rand(9, 16);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.2, 8), new THREE.MeshLambertMaterial({ color: 0x8a5a33 }));
      const top = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2, 10), new THREE.MeshLambertMaterial({ color: [0x3f9a5a, 0x5ab06a, 0x2f7a4a][i % 3] }));
      trunk.position.set(Math.sin(a) * r, 0.6, -Math.cos(a) * r);
      top.position.set(Math.sin(a) * r, 2.0, -Math.cos(a) * r);
      this.scene.add(trunk, top);
    }
    this.lights();
    this.camera.position.set(0, 1.2, 0);
    this.companion();
    this.temp = this.meter("あつさ");
    this.found = 0;
    this.hold = 0;
    this.nextPulse = 0;
    this.tol = (this.level === 1 ? 16 : this.level === 2 ? 11 : 7) * (Math.PI / 180);
    this.newTarget(0);
    this.timer(this.o.seconds || 90);
  }

  newTarget(fromYaw) {
    this.targetYaw = wrapAngle(fromYaw + (Math.random() < 0.5 ? -1 : 1) * rand(1.2, Math.PI));
    this.hold = 0;
  }

  showChest(yaw) {
    const THREE = this.THREE;
    const chest = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.5), new THREE.MeshLambertMaterial({ color: 0xc98b3a }));
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.12, 0.52), new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0xffa000, emissiveIntensity: 0.4 }));
    lid.position.y = 0.3;
    chest.add(box, lid);
    chest.position.set(-Math.sin(yaw) * 3, 0.25, -Math.cos(yaw) * 3);
    chest.lookAt(0, 0.25, 0);
    this.scene.add(chest);
    setTimeout(() => this.scene.remove(chest), 1600);
  }

  update(dt, t) {
    const THREE = this.THREE;
    const yaw = this.look.apply(this.camera);
    const diff = Math.abs(wrapAngle(yaw - this.targetYaw));
    const c = 1 - diff / Math.PI; // 1 = ぴったり
    const cold = new THREE.Color(0x7fb4ff);
    const hot = new THREE.Color(0xff6a4a);
    const col = cold.lerp(hot, c * c);
    this.scene.fog.color.copy(col);
    this.temp.set(c, `#${col.getHexString()}`);
    const now = performance.now();
    if (now > this.nextPulse) {
      const gap = 1300 - c * c * 1150;
      this.nextPulse = now + gap;
      vibrate(Math.round(20 + c * 50));
      this.sfx(260 + c * c * 900, 60, 0.035 + c * 0.03, "sine");
    }
    if (diff < this.tol) {
      this.hold += dt;
      this.api.hint("このへん…！", 400);
      if (this.hold > 1.0) {
        this.found += 1;
        this.showChest(this.targetYaw);
        this.sfx(1320, 200, 0.08, "triangle");
        vibrate([60, 40, 60]);
        this.cheer(`宝を見つけた！ ${this.found}`);
        if (this.found >= this.goal) {
          this.finish({ clear: true, score: this.left, summary: `宝を${this.goal}こ見つけた！ のこり${this.left}秒` });
          return;
        }
        this.newTarget(this.targetYaw);
      }
    } else this.hold = Math.max(0, this.hold - dt);
    this.hopUpdate(this.buddy, t);
    this.api.hud(`宝 ${this.found} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.found}こ 見つけたよ` });
  }
}

// ---------------------------------------------------------------- 9. だるまさんがころんだ

const CHANT = ["だ", "る", "ま", "さ", "ん", "が", "こ", "ろ", "ん", "だ"];

class DarumaGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.sensor = await this.motion({ shakeThreshold: 40, stepThreshold: 2.4 });
    if (this.sensor) this.sensor.onStep = () => this.step(0.5);
    this.holding = false;
    this.button(this.sensor ? "すすむ（押している間）" : "押している間すすむ", { down: () => (this.holding = true), up: () => (this.holding = false), wide: true });
    this.api.hint(this.sensor ? "端末を持って足ぶみすると進むよ。鬼がふり向いたら、ぴたっと止まって！" : "ボタンを押すと進むよ。鬼がふり向いたら、指をはなして！", 3800);
    this.scene.background = new THREE.Color(0xffe6c7);
    this.scene.fog = new THREE.Fog(0xffe6c7, 20, 60);
    this.lights();
    this.distance = 14 + this.level * 3;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, this.distance + 30), new THREE.MeshLambertMaterial({ color: 0xa6d98a }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -this.distance / 2;
    this.scene.add(ground);
    // 鬼（木のそばに立っている、まるい子）
    this.oni = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.6, 1.0, 6, 16), new THREE.MeshLambertMaterial({ color: 0xff7a6a }));
    body.position.y = 1.1;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.62, 20, 14), new THREE.MeshLambertMaterial({ color: 0xffd9c2 }));
    face.position.set(0, 1.9, 0);
    const eyes = this.label("◉　◉", { width: 0.8, bg: "rgba(0,0,0,0)", color: "#2a2440" });
    eyes.position.set(0, 1.95, 0.62);
    eyes.material.depthTest = true;
    this.oniEyes = eyes;
    for (const sx of [-0.3, 0.3]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 8), new THREE.MeshLambertMaterial({ color: 0xffe14d }));
      horn.position.set(sx, 2.55, 0);
      this.oni.add(horn);
    }
    this.oni.add(body, face, eyes);
    this.oni.position.z = -this.distance;
    this.oni.rotation.y = Math.PI; // 後ろを向いている
    this.scene.add(this.oni);
    const tree = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 3, 10), new THREE.MeshLambertMaterial({ color: 0x8a5a33 }));
    tree.position.set(1.4, 1.5, -this.distance - 0.5);
    this.scene.add(tree);
    this.hero = this.avatar(0.7);
    this.hero.rotation.y = Math.PI;
    this.scene.add(this.hero);
    this.pos = 0;
    this.target = 0;
    this.startChant();
    this.timer(this.o.seconds || 90);
  }

  startChant() {
    this.phase = "chant";
    const dur = rand(2.0, 4.6) / (0.8 + this.level * 0.15);
    this.phaseStart = performance.now();
    this.phaseEnd = this.phaseStart + dur * 1000;
    this.oni.rotation.y = Math.PI;
  }

  step(len) {
    if (this.ended) return;
    if (this.phase === "look" && performance.now() - this.phaseStart > 300) return this.caught();
    this.target = Math.min(this.distance - 1.1, this.target + len);
  }

  caught() {
    if (this.ended || this.phase === "out") return;
    this.phase = "out";
    this.api.hint("うごいた！ 見つかった〜", 1600);
    this.sfx(180, 400, 0.08, "square");
    vibrate([100, 50, 100]);
    setTimeout(() => this.finish({ clear: false, summary: `鬼まで あと${(this.distance - 1.1 - this.pos).toFixed(1)}m だったよ` }), 1100);
  }

  update(dt, t) {
    const now = performance.now();
    if (this.phase === "out") return;
    if (this.holding) {
      if (this.phase === "look" && now - this.phaseStart > 300) return this.caught();
      this.target = Math.min(this.distance - 1.1, this.target + 1.3 * dt);
    }
    const before = this.pos;
    this.pos += (this.target - this.pos) * Math.min(1, dt * 6);
    const moving = this.pos - before > 0.002;
    this.hero.position.z = -this.pos;
    this.hero.userData.body.position.y = moving ? Math.abs(Math.sin(t * 12)) * 0.1 : 0;

    if (this.phase === "chant") {
      const k = (now - this.phaseStart) / (this.phaseEnd - this.phaseStart);
      const n = clamp(Math.ceil(k * CHANT.length), 0, CHANT.length);
      this.api.hud(`${CHANT.slice(0, n).join("")}　　（のこり ${this.left}秒）`);
      if (k >= 1) {
        this.phase = "turn";
        this.phaseStart = now;
      }
    } else if (this.phase === "turn") {
      const k = clamp((now - this.phaseStart) / 250, 0, 1);
      this.oni.rotation.y = Math.PI * (1 - k);
      if (k >= 1) {
        this.phase = "look";
        this.phaseStart = now;
        this.phaseEnd = now + rand(1.2, 2.2 + this.level * 0.3) * 1000;
        this.sfx(880, 120, 0.06, "square");
        vibrate(40);
      }
    } else if (this.phase === "look") {
      this.api.hud(`👀 じーっ……　（のこり ${this.left}秒）`);
      const still = 1.1 + (3 - this.level) * 0.35;
      if (this.sensor && now - this.phaseStart > 350 && this.sensor.level > still) return this.caught();
      if (now > this.phaseEnd) this.startChant();
    }
    const z = this.hero.position.z;
    this.camera.position.set(0.6, 2.4, z + 4.6);
    this.camera.lookAt(0, 1.0, z - 5);
    if (this.pos >= this.distance - 1.15) {
      this.finish({ clear: true, score: this.left, summary: `鬼にタッチ！ のこり${this.left}秒` });
      return;
    }
    if (this.timeUp()) this.finish({ clear: false, summary: `時間切れ。鬼まで あと${(this.distance - 1.1 - this.pos).toFixed(1)}m` });
  }
}

// ---------------------------------------------------------------- 10. ARでおでかけ（WebXR）

class XrGame extends SensorGame {
  async start() {
    // iOS の許可はタップの中で最初に（iOS には WebXR のARが無いので、カメラの映像で遊ぶ方になる）
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 10;
    this.popped = 0;
    this.bubbles = [];
    let supported = false;
    try {
      supported = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-ar"));
    } catch {
      supported = false;
    }
    if (supported) {
      try {
        await this.startXr();
        return;
      } catch (e) {
        console.warn("[xr] 開始できませんでした", e);
      }
    }
    await this.startFallback();
    void THREE;
  }

  /** 本物のAR（Android の Chrome など）。床を見つけて、タップした所に分身を出す */
  async startXr() {
    const THREE = this.THREE;
    const renderer = this.api.renderer;
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: this.api.layer.root },
    });
    this.session = session;
    this.xr = true;
    this.transparent = true;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(session);
    this.refSpace = await session.requestReferenceSpace("local");
    const viewer = await session.requestReferenceSpace("viewer");
    this.hitSource = await session.requestHitTestSource({ space: viewer });
    this.cleanups.push(() => {
      this.hitSource?.cancel?.();
      if (!this.sessionEnded) session.end().catch(() => undefined);
      renderer.xr.enabled = false;
    });
    session.addEventListener("end", () => {
      this.sessionEnded = true;
      if (!this.ended) this.finish({ clear: false, summary: `ARを終了しました（${this.goal}こ中 ${this.popped}こ）` });
    });
    session.addEventListener("select", (e) => this.onSelect(e));
    this.lights(0xffffff, 0x999999, 1.3);
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.11, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);
    this.api.hint("床をうつして、輪が出たらタップ。そこに分身が出てくるよ", 5000);
    this.api.hud("床をさがしています…");
  }

  onSelect(e) {
    const THREE = this.THREE;
    if (!this.hero) {
      if (!this.reticle.visible) return;
      this.hero = this.avatar(0.28);
      this.hero.position.setFromMatrixPosition(this.reticle.matrix);
      this.scene.add(this.hero);
      this.reticle.visible = false;
      this.spawnBubbles(this.hero.position, 0.12, 1.2);
      this.counter = this.label(`0 / ${this.goal}`, { width: 0.3 });
      this.counter.position.set(0, 0.5, 0);
      this.hero.add(this.counter);
      this.timer(this.o.seconds || 60);
      return;
    }
    const pose = e.frame.getPose(e.inputSource.targetRaySpace, this.refSpace);
    if (!pose) return;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));
    this.popAlong(new THREE.Ray(origin, dir), 0.09);
  }

  spawnBubbles(center, radius, spread) {
    const THREE = this.THREE;
    const mat = new THREE.MeshLambertMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55, emissive: 0x3aa8d8, emissiveIntensity: 0.3 });
    for (let i = 0; i < this.goal; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(radius * rand(0.8, 1.2), 16, 12), mat);
      const a = rand(0, TAU);
      const r = rand(spread * 0.3, spread);
      b.userData = { base: new THREE.Vector3(center.x + Math.cos(a) * r, center.y + rand(spread * 0.2, spread * 1.1), center.z + Math.sin(a) * r), phase: rand(0, TAU) };
      b.position.copy(b.userData.base);
      this.scene.add(b);
      this.bubbles.push(b);
    }
  }

  popAlong(ray, reach) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.bubbles) {
      if (!b.visible) continue;
      const d = ray.distanceToPoint(b.position);
      const r = b.geometry.parameters.radius + reach;
      if (d < r && d < bestD) {
        best = b;
        bestD = d;
      }
    }
    if (!best) return;
    best.visible = false;
    this.popped += 1;
    this.sfx(900 + this.popped * 60, 70, 0.07, "sine");
    vibrate(20);
    this.cheer(`パチン！ ${this.popped}`);
    if (this.counter) {
      this.hero.remove(this.counter);
      this.counter.material.map.dispose();
      this.counter = this.label(`${this.popped} / ${this.goal}`, { width: this.xr ? 0.3 : 0.9 });
      this.counter.position.set(0, this.xr ? 0.5 : 1.5, 0);
      this.hero.add(this.counter);
    }
    if (this.popped >= this.goal) this.finish({ clear: true, score: this.left, summary: `シャボン玉をぜんぶ割った！ のこり${this.left}秒` });
  }

  /** ARに対応していない端末: カメラの映像の上に分身とシャボン玉を出す */
  async startFallback() {
    const THREE = this.THREE;
    this.feed = new CameraFeed(this.api.layer.video);
    try {
      await this.feed.start();
      this.cleanups.push(() => this.feed.stop());
      this.transparent = true;
    } catch {
      this.scene.add(skyDome(THREE, "#8fd0ff", "#f4fbff"));
      const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 40), new THREE.MeshLambertMaterial({ color: 0xa6d98a }));
      ground.rotation.x = -Math.PI / 2;
      this.scene.add(ground);
    }
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.look = new LookControl(THREE, this.sensor, this.touch);
    this.touch.onTap = (x, y) => {
      const rect = this.api.layer.touch.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
      this.popAlong(ray.ray, 0.2);
    };
    this.api.hint(
      `この端末はARに対応していないので、${this.transparent ? "カメラの映像" : "空の中"}で遊ぶよ。見回して、シャボン玉をタップ`,
      3800
    );
    this.lights(0xffffff, 0xaaaaaa, 1.3);
    this.camera.position.set(0, 1.3, 0);
    this.hero = this.avatar(0.7);
    this.hero.position.set(0, 0, -2.4);
    this.hero.lookAt(0, 0, 0);
    this.scene.add(this.hero);
    this.counter = this.label(`0 / ${this.goal}`, { width: 0.9 });
    this.counter.position.set(0, 1.5, 0);
    this.hero.add(this.counter);
    this.spawnBubbles(new THREE.Vector3(0, 0.2, -2.4), 0.2, 2.2);
    this.timer(this.o.seconds || 60);
  }

  update(dt, t, frame) {
    if (this.xr && frame && !this.hero && this.hitSource) {
      const results = frame.getHitTestResults(this.hitSource);
      if (results.length) {
        const pose = results[0].getPose(this.refSpace);
        this.reticle.visible = true;
        this.reticle.matrix.fromArray(pose.transform.matrix);
        this.api.hud("輪が出た所をタップ");
      } else this.reticle.visible = false;
    }
    if (this.look) this.look.apply(this.camera);
    for (const b of this.bubbles) {
      const u = b.userData;
      b.position.set(u.base.x + Math.sin(t * 0.9 + u.phase) * 0.06, u.base.y + Math.sin(t * 1.3 + u.phase) * 0.08, u.base.z + Math.cos(t * 0.7 + u.phase) * 0.06);
    }
    if (this.hero) {
      this.hopUpdate(this.hero, t);
      if (this.endsAt) {
        this.api.hud(`シャボン玉 ${this.popped} / ${this.goal}　のこり ${this.left}秒`);
        if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.popped}こ 割ったよ` });
      }
    }
  }

  dispose() {
    super.dispose();
    this.xr = false;
  }
}

export const SENSOR_GAME_CLASSES = {
  tilt: TiltGame,
  shake: ShakeGame,
  balance: BalanceGame,
  voice: VoiceGame,
  arhunt: ArHuntGame,
  skycatch: SkyCatchGame,
  rhythm: RhythmGame,
  hotcold: HotColdGame,
  daruma: DarumaGame,
  xr: XrGame,
};
