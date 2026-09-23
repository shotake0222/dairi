/**
 * センサーを使うミニゲーム（あとから足した10種類）。土台（SensorGame）と最初の10種類は sensorgames.mjs。
 * 定義（名前・使うセンサー・設定の範囲）は src/metaverse.ts の SENSOR_GAMES。
 *
 *   fishing    ふりふり釣りぼり  加速度＋振動    ふって投げ、ウキがしずんだら、ふり上げて釣る
 *   pour       ぴったりジュース  ジャイロ        かたむけてそそぎ、コップの線にぴったり合わせる
 *   maze       かたむけ迷路      ジャイロ        かたむけて迷路の中を転がし、旗まで
 *   balloon    ふーふー風船      マイク          息をふきかけてふくらませる。割れる手前で止める
 *   tower      つみつみタワー    ジャイロ        かたむきで位置を合わせ、タップで落として積む
 *   colorhunt  カメラで色さがし  カメラ          お題の色の物を、身のまわりから探して映す
 *   hanetsuki  はねつき          加速度          羽根に合わせてふり、羽子板で打ち返す
 *   taiko      わだいこ          加速度＋タッチ  赤い「ドン」はタップ、青い「カッ」はふる
 *   sled       そりすべり        ジャイロ        かたむけて曲がり、旗の門をくぐる
 *   nenne      ねんねタイム      マイク＋加速度  しずかに、動かさずに、分身が眠るまで待つ
 *
 * 決まりは最初の10種類と同じ:
 *   - センサーが使えないとき（パソコン・許可しなかった）は、画面の操作で遊べる
 *   - **センサーの値・カメラの映像・声は、この端末の中だけで使う。** 点数も送らない
 */

import { SensorGame, skyDome } from "./sensorgames.mjs";
import { CameraFeed, Mic, vibrate } from "./sensors.mjs";

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** 自己ベストの見せ方（どれも大きいほど良い） */
export const SENSOR_BEST_2 = {
  fishing: (v) => `残り${v}秒`,
  pour: (v) => `残り${v}秒`,
  maze: (v) => `残り${v}秒`,
  balloon: (v) => `残り${v}秒`,
  tower: (v) => `のこり幅${v}%`,
  colorhunt: (v) => `残り${v}秒`,
  hanetsuki: (v) => `ぴったり${v}回`,
  taiko: (v) => `${v}%`,
  sled: (v) => `残り${v}秒`,
  nenne: (v) => `しずか${v}%`,
};

/** 草と空の、ありふれた外の場面 */
function outdoor(game, { sky = 0xbfe6ff, grass = 0x9ed67a, size = 40 } = {}) {
  const THREE = game.THREE;
  game.scene.background = new THREE.Color(sky);
  game.lights();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshLambertMaterial({ color: grass }));
  ground.rotation.x = -Math.PI / 2;
  game.scene.add(ground);
  return ground;
}

// ---------------------------------------------------------------- 11. ふりふり釣りぼり

class FishingGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 3;
    this.sensor = await this.motion({ shakeThreshold: 11 });
    if (this.sensor) this.sensor.onShake = () => this.act();
    this.btn = this.button(this.sensor ? "ふる！（ボタンでもOK）" : "なげる", { down: () => this.act(), wide: true });
    this.api.hint(this.sensor ? "端末をふって糸を投げよう。ウキがしずんだら、すばやくふり上げる！" : "ボタンで投げて、ウキがしずんだらもう一度押す", 3600);
    outdoor(this, { sky: 0xc4ecff, grass: 0x92cf70 });
    const pond = new THREE.Mesh(new THREE.CircleGeometry(4.2, 40), new THREE.MeshLambertMaterial({ color: 0x3f9fd8 }));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(0, 0.02, -4);
    this.scene.add(pond);
    const rim = new THREE.Mesh(new THREE.RingGeometry(4.2, 4.6, 40), new THREE.MeshLambertMaterial({ color: 0xc9b48a }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(0, 0.03, -4);
    this.scene.add(rim);
    for (let i = 0; i < 5; i++) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(rand(0.25, 0.4), 16), new THREE.MeshLambertMaterial({ color: 0x5fae52 }));
      pad.rotation.x = -Math.PI / 2;
      const a = rand(0, TAU);
      pad.position.set(Math.cos(a) * rand(2.4, 3.6), 0.04, -4 + Math.sin(a) * rand(2.4, 3.6));
      this.scene.add(pad);
    }
    this.hero = this.avatar(0.7);
    this.hero.position.set(0, 0, 1.1);
    this.hero.rotation.y = Math.PI;
    this.scene.add(this.hero);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.6, 6), new THREE.MeshLambertMaterial({ color: 0x8a5a2b }));
    rod.position.set(0.35, 0.9, 0.6);
    rod.rotation.x = -0.9;
    this.scene.add(rod);
    this.rod = rod;
    this.tip = new THREE.Vector3(0.35, 1.45, -0.05);
    this.bobber = new THREE.Group();
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8, 0, TAU, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xff4f4f }));
    const bottom = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8, 0, TAU, Math.PI / 2, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    this.bobber.add(top, bottom);
    this.bobber.visible = false;
    this.scene.add(this.bobber);
    this.lineGeo = new THREE.BufferGeometry().setFromPoints([this.tip.clone(), this.tip.clone()]);
    this.line = new THREE.Line(this.lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.scene.add(this.line);
    this.fish = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), new THREE.MeshLambertMaterial({ color: 0xffa94d }));
    this.fish.scale.set(1.5, 0.8, 0.7);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.26, 4), new THREE.MeshLambertMaterial({ color: 0xff8a3d }));
    tail.rotation.z = Math.PI / 2;
    tail.position.x = -0.28;
    this.fish.add(tail);
    this.fish.visible = false;
    this.scene.add(this.fish);
    this.state = "ready";
    this.caught = 0;
    this.stateAt = performance.now();
    this.camera.position.set(0, 3.4, 5.4 * this.fit(0.7));
    this.camera.lookAt(0, 0.2, -2.6);
    this.timer(this.o.seconds || 90);
  }

  setState(state) {
    this.state = state;
    this.stateAt = performance.now();
  }

  /** ふった（ボタンを押した）。いまの状態で意味が変わる */
  act() {
    if (this.ended) return;
    if (this.state === "ready") {
      // 釣り上げた直後の、同じひとふりで投げ直さない
      if (performance.now() - this.stateAt < 300) return;
      this.target = new this.THREE.Vector3(rand(-2.2, 2.2), 0.05, rand(-5.5, -2.8));
      this.setState("cast");
      this.sfx(520, 120, 0.05, "triangle");
      this.btn.textContent = this.sensor ? "ウキを見て…" : "ひく！";
      return;
    }
    if (this.state === "wait" || this.state === "nibble") {
      this.api.hint(this.state === "nibble" ? "はやすぎた！ さかなが逃げちゃった" : "まだだよ。ウキがしずむまで待とう", 1300);
      this.reel(false);
      return;
    }
    if (this.state === "bite") this.reel(true);
  }

  reel(ok) {
    if (ok) {
      this.caught += 1;
      this.fish.visible = true;
      this.fish.position.copy(this.bobber.position);
      this.fish.material.color.setHex(pick([0xffa94d, 0xff6f91, 0x6fb8ff, 0xffd23f, 0xb58cff]));
      this.sfx(880, 80, 0.07, "triangle");
      setTimeout(() => this.sfx(1320, 120, 0.07, "triangle"), 90);
      vibrate(40);
      this.cheer(`釣れた！ ${this.caught}ひき`);
      if (this.caught >= this.goal) {
        setTimeout(() => this.finish({ clear: true, score: this.left, summary: `${this.goal}ひき釣り上げた！ のこり${this.left}秒` }), 700);
      }
    }
    this.setState("reel");
    this.bobber.userData.from = this.bobber.position.clone();
  }

  update(dt, t) {
    const now = performance.now();
    const since = (now - this.stateAt) / 1000;
    const b = this.bobber;
    if (this.state === "cast") {
      const u = Math.min(1, since / 0.7);
      b.visible = true;
      b.position.lerpVectors(this.tip, this.target, u);
      b.position.y += Math.sin(u * Math.PI) * 1.6;
      if (u >= 1) {
        this.setState("wait");
        this.biteAt = now + rand(1800, 4800);
        this.nibbles = this.level >= 2 ? Math.floor(rand(0, this.level)) : 0;
        this.nextNibble = now + rand(700, 1400);
        this.sfx(300, 60, 0.04, "sine");
      }
    } else if (this.state === "wait" || this.state === "nibble") {
      b.position.y = 0.05 + Math.sin(t * 2.4) * 0.02;
      if (this.nibbles > 0 && now > this.nextNibble && this.state === "wait") {
        // ちょんちょん（まだ食べていない）。ここで引くと逃げる
        this.nibbles -= 1;
        this.setState("nibble");
        vibrate(15);
      } else if (this.state === "nibble") {
        b.position.y = 0.02 - Math.abs(Math.sin(since * 20)) * 0.04;
        if (since > 0.35) {
          this.state = "wait";
          this.nextNibble = now + rand(700, 1400);
          this.biteAt = Math.max(this.biteAt, now + 600);
        }
      } else if (now > this.biteAt) {
        this.setState("bite");
        vibrate([180, 60, 180]);
        this.sfx(740, 90, 0.08, "square");
        this.api.hint(this.sensor ? "今だ！ ふり上げて！" : "今だ！ 押して！", 900);
      }
    } else if (this.state === "bite") {
      b.position.y = -0.08 - Math.abs(Math.sin(since * 14)) * 0.06;
      const window = [1.5, 1.1, 0.8][this.level - 1];
      if (since > window) {
        this.api.hint("にげられちゃった…", 1100);
        this.reel(false);
      }
    } else if (this.state === "reel") {
      const u = Math.min(1, since / 0.6);
      const from = b.userData.from || this.tip;
      b.position.lerpVectors(from, this.tip, u);
      b.position.y += Math.sin(u * Math.PI) * 1.2;
      if (this.fish.visible) {
        this.fish.position.copy(b.position).add(new this.THREE.Vector3(0, -0.25, 0));
        this.fish.rotation.z = Math.sin(t * 20) * 0.5;
      }
      if (u >= 1) {
        b.visible = false;
        this.fish.visible = false;
        this.setState("ready");
        this.btn.textContent = this.sensor ? "ふる！（ボタンでもOK）" : "なげる";
      }
    }
    const pts = this.lineGeo.attributes.position;
    pts.setXYZ(0, this.tip.x, this.tip.y, this.tip.z);
    const end = b.visible ? b.position : this.tip;
    pts.setXYZ(1, end.x, end.y, end.z);
    pts.needsUpdate = true;
    this.rod.rotation.x = this.state === "bite" ? -0.8 + Math.sin(t * 30) * 0.05 : this.state === "reel" ? -0.5 : -0.9;
    this.hopUpdate(this.hero, t);
    this.api.hud(`釣った ${this.caught} / ${this.goal}ひき　のこり ${this.left}秒`);
    if (this.caught < this.goal && this.timeUp()) this.finish({ clear: false, summary: `${this.goal}ひき中 ${this.caught}ひき 釣ったよ` });
  }
}

// ---------------------------------------------------------------- 12. ぴったりジュース

const JUICES = [0xff9f40, 0xff6f91, 0x8bd450, 0xb58cff, 0xffd23f];

class PourGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 3;
    this.sensor = await this.orientation();
    this.hold = false;
    this.button(this.sensor ? "そそぐ（かたむけてもOK）" : "押している間そそぐ", { down: () => (this.hold = true), up: () => (this.hold = false), wide: true });
    this.api.hint(this.sensor ? "端末を右へかたむけると、そそげるよ。線にぴったりで止めてね" : "ボタンを押している間そそげるよ。線にぴったりで止めてね", 3600);
    this.scene.background = new THREE.Color(0xffefd9);
    this.lights(0xfff4e0, 0xc9a27a, 1.2);
    const table = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 3), new THREE.MeshLambertMaterial({ color: 0xc98f5a }));
    table.position.y = -0.15;
    this.scene.add(table);
    this.hero = this.avatar(0.6);
    this.hero.position.set(-1.7, 0, 0.2);
    this.hero.rotation.y = 0.6;
    this.scene.add(this.hero);
    // コップ（透明な筒）と中身
    this.cupH = 1.4;
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.42, this.cupH, 28, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xddeeff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
    );
    glass.position.y = this.cupH / 2;
    glass.renderOrder = 2;
    this.scene.add(glass);
    this.liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.4, 1, 28), new THREE.MeshLambertMaterial({ color: JUICES[0] }));
    this.scene.add(this.liquid);
    this.markLine = new THREE.Mesh(new THREE.TorusGeometry(0.49, 0.018, 6, 36), new THREE.MeshBasicMaterial({ color: 0xff3d6e }));
    this.markLine.rotation.x = Math.PI / 2;
    this.scene.add(this.markLine);
    // 上のびん（かたむきに合わせて傾く）と、そそぐ流れ
    this.bottle = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.9, 20), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
    body.position.x = -0.3;
    body.rotation.z = Math.PI / 2;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.3, 14), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    neck.position.x = 0.28;
    neck.rotation.z = Math.PI / 2;
    this.bottle.add(body, neck);
    this.bottle.position.set(-0.55, this.cupH + 0.75, 0);
    this.scene.add(this.bottle);
    this.stream = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), new THREE.MeshLambertMaterial({ color: JUICES[0] }));
    this.stream.visible = false;
    this.scene.add(this.stream);
    this.gauge = this.meter("ジュース");
    this.done = 0;
    this.misses = 0;
    this.newCup();
    this.camera.position.set(0.3, 1.9, 4.4 * this.fit(0.7));
    this.camera.lookAt(0, 1.0, 0);
    this.timer(this.o.seconds || 60);
  }

  newCup() {
    this.fill = 0;
    this.poured = false;
    this.quietFor = 0;
    this.targetFill = rand(0.5, 0.82);
    const c = JUICES[(this.done + this.misses) % JUICES.length];
    this.liquid.material.color.setHex(c);
    this.stream.material.color.setHex(c);
    this.markLine.position.y = this.targetFill * this.cupH;
    this.gauge.mark(this.targetFill);
  }

  update(dt, t) {
    const control = this.sensor ? Math.max(0, this.sensor.tilt(30).x) : 0;
    let flow = this.hold ? 0.62 : Math.max(0, control - 0.18) * 1.1;
    flow *= 0.7 + this.level * 0.18;
    this.bottle.rotation.z = -clamp(flow * 1.1 + (this.hold ? 0.2 : control * 0.6), 0, 1.3);
    if (flow > 0.02) {
      this.fill += flow * 0.32 * dt;
      this.poured = true;
      this.quietFor = 0;
      this.stream.visible = true;
      const top = this.cupH + 0.6;
      const bottom = Math.max(0.02, this.fill * this.cupH);
      this.stream.scale.set(clamp(flow, 0.4, 1.4), top - bottom, clamp(flow, 0.4, 1.4));
      this.stream.position.set(0, (top + bottom) / 2, 0);
      if (Math.random() < dt * 8) this.sfx(rand(300, 420), 40, 0.015, "sine");
    } else {
      this.stream.visible = false;
      if (this.poured) this.quietFor += dt;
    }
    const h = Math.max(0.001, Math.min(1, this.fill) * this.cupH);
    this.liquid.scale.y = h;
    this.liquid.position.y = h / 2;
    const tol = [0.08, 0.055, 0.035][this.level - 1];
    const diff = this.fill - this.targetFill;
    this.gauge.set(this.fill, Math.abs(diff) < tol ? "#5ccf8a" : diff > 0 ? "#ff5a4f" : "#ffb13d");
    if (this.fill > 1) {
      this.misses += 1;
      this.api.hint("こぼれちゃった！ 新しいコップ", 1200);
      vibrate([60, 40, 60]);
      this.sfx(200, 200, 0.06, "sawtooth");
      this.newCup();
    } else if (this.quietFor > 0.9) {
      if (Math.abs(diff) < tol) {
        this.done += 1;
        this.cheer(Math.abs(diff) < tol / 2 ? "ぴったり！" : "いいね！");
        this.sfx(1180, 120, 0.07, "triangle");
        vibrate(30);
        if (this.done >= this.goal) {
          this.finish({ clear: true, score: this.left, summary: `${this.goal}杯ぴったり！ のこり${this.left}秒` });
          return;
        }
        this.newCup();
      } else if (diff > 0) {
        this.misses += 1;
        this.api.hint("入れすぎ！ 新しいコップ", 1200);
        this.newCup();
      } else {
        this.quietFor = -99; // もう少し足せる。次にそそぐまで判定しない
        this.api.hint("もうちょっと！", 900);
      }
    }
    this.hopUpdate(this.hero, t);
    this.api.hud(`ぴったり ${this.done} / ${this.goal}杯　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}杯中 ${this.done}杯 ぴったり` });
  }
}

// ---------------------------------------------------------------- 13. かたむけ迷路

/** 穴掘り法で迷路を作る。walls[y][x] = { n, s, e, w }（true が壁） */
function makeMaze(n) {
  const cells = [];
  for (let y = 0; y < n; y++) {
    cells.push([]);
    for (let x = 0; x < n; x++) cells[y].push({ n: true, s: true, e: true, w: true, seen: false });
  }
  const stack = [[0, 0]];
  cells[0][0].seen = true;
  const dirs = [
    ["n", 0, -1, "s"],
    ["s", 0, 1, "n"],
    ["e", 1, 0, "w"],
    ["w", -1, 0, "e"],
  ];
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const next = dirs.filter(([, dx, dy]) => cells[y + dy]?.[x + dx] && !cells[y + dy][x + dx].seen);
    if (!next.length) {
      stack.pop();
      continue;
    }
    const [d, dx, dy, back] = pick(next);
    cells[y][x][d] = false;
    cells[y + dy][x + dx][back] = false;
    cells[y + dy][x + dx].seen = true;
    stack.push([x + dx, y + dy]);
  }
  return cells;
}

class MazeGame extends SensorGame {
  async start() {
    this.permission();
    this.goal = this.o.goal || 2;
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.api.hint(this.sensor ? "端末をかたむけて、旗まで転がそう（始めたときの持ち方が「まっすぐ」）" : "画面をなぞった方向へ転がるよ", 3400);
    this.scene.background = new this.THREE.Color(0xd6f0ff);
    this.lights();
    this.cleared = 0;
    this.world = null;
    this.hero = this.avatar(0.42);
    this.scene.add(this.hero);
    this.build();
    this.timer(this.o.seconds || 90);
  }

  build() {
    const THREE = this.THREE;
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((m) => {
        m.geometry?.dispose?.();
        m.material?.dispose?.();
      });
    }
    const n = 4 + this.level + Math.min(2, this.cleared);
    const cs = 1.1;
    this.n = n;
    this.cs = cs;
    this.maze = makeMaze(n);
    const w = new THREE.Group();
    const half = (n * cs) / 2;
    this.half = half;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(n * cs + 0.3, 0.2, n * cs + 0.3), new THREE.MeshLambertMaterial({ color: 0xa8dd86 }));
    floor.position.y = -0.1;
    w.add(floor);
    const mat = new THREE.MeshLambertMaterial({ color: [0xf2d6a2, 0xe8b9d8, 0xb8d4f5][this.cleared % 3] });
    const t = 0.14;
    const addWall = (x, z, ww, dd) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(ww, 0.45, dd), mat);
      m.position.set(x, 0.22, z);
      w.add(m);
    };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = this.maze[y][x];
        const cx = -half + x * cs + cs / 2;
        const cz = -half + y * cs + cs / 2;
        if (c.n) addWall(cx, cz - cs / 2, cs + t, t);
        if (c.w) addWall(cx - cs / 2, cz, t, cs + t);
        if (y === n - 1 && c.s) addWall(cx, cz + cs / 2, cs + t, t);
        if (x === n - 1 && c.e) addWall(cx + cs / 2, cz, t, cs + t);
      }
    }
    // ゴールの旗（右下のマス）
    const gx = -half + (n - 1) * cs + cs / 2;
    const gz = -half + (n - 1) * cs + cs / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    pole.position.set(gx, 0.45, gz);
    w.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), new THREE.MeshLambertMaterial({ color: 0xff5a7a, side: THREE.DoubleSide }));
    flag.position.set(gx + 0.2, 0.78, gz);
    w.add(flag);
    this.flag = flag;
    this.goalPos = { x: gx, z: gz };
    this.scene.add(w);
    this.world = w;
    this.hero.position.set(-half + cs / 2, 0, -half + cs / 2);
    this.vel = new THREE.Vector2(0, 0);
  }

  /** 壁の手前で止める（軸ごとに動かして、マスの壁を見る） */
  moveAxis(axis, d) {
    const p = this.hero.position;
    const r = 0.26;
    const cs = this.cs;
    const key = axis === "x" ? "x" : "z";
    p[key] += d;
    const cx = clamp(Math.floor((p.x + this.half) / cs), 0, this.n - 1);
    const cy = clamp(Math.floor((p.z + this.half) / cs), 0, this.n - 1);
    const c = this.maze[cy][cx];
    const left = -this.half + cx * cs;
    const top = -this.half + cy * cs;
    const vi = axis === "x" ? "x" : "y";
    if (axis === "x") {
      if (p.x > left + cs - r && c.e) {
        p.x = left + cs - r;
        this.vel[vi] *= -0.3;
      } else if (p.x < left + r && c.w) {
        p.x = left + r;
        this.vel[vi] *= -0.3;
      }
    } else if (p.z > top + cs - r && c.s) {
      p.z = top + cs - r;
      this.vel[vi] *= -0.3;
    } else if (p.z < top + r && c.n) {
      p.z = top + r;
      this.vel[vi] *= -0.3;
    }
  }

  update(dt, t) {
    const tilt = this.sensor ? this.sensor.tilt(24) : { x: this.touch.vector.x, y: -this.touch.vector.y };
    const acc = 9 * (0.8 + this.level * 0.15);
    this.vel.x += tilt.x * acc * dt;
    this.vel.y += -tilt.y * acc * dt;
    this.vel.multiplyScalar(Math.max(0, 1 - 2.2 * dt));
    if (this.vel.length() > 4.2) this.vel.setLength(4.2);
    // すり抜けないよう、小刻みに動かす
    const steps = Math.ceil((this.vel.length() * dt) / 0.08) || 1;
    for (let i = 0; i < steps; i++) {
      this.moveAxis("x", (this.vel.x * dt) / steps);
      this.moveAxis("z", (this.vel.y * dt) / steps);
    }
    const speed = this.vel.length();
    if (speed > 0.2) this.hero.rotation.y = Math.atan2(this.vel.x, this.vel.y);
    this.hero.userData.body.position.y = Math.abs(Math.sin(t * 10)) * Math.min(0.06, speed * 0.02);
    this.flag.rotation.y = Math.sin(t * 3) * 0.3;
    const p = this.hero.position;
    if (Math.hypot(p.x - this.goalPos.x, p.z - this.goalPos.z) < 0.4) {
      this.cleared += 1;
      this.sfx(1180, 120, 0.07, "triangle");
      vibrate(40);
      if (this.cleared >= this.goal) {
        this.finish({ clear: true, score: this.left, summary: `迷路を${this.goal}つぬけた！ のこり${this.left}秒` });
        return;
      }
      this.cheer(`ゴール！ つぎの迷路（${this.cleared + 1} / ${this.goal}）`);
      this.build();
    }
    const k = this.fit(0.8) * (this.half / 3.3);
    this.camera.position.set(0, 9.5 * k, 3.6 * k);
    this.camera.lookAt(0, 0, 0.3);
    this.api.hud(`迷路 ${this.cleared} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}つ中 ${this.cleared}つ ぬけたよ` });
  }
}

// ---------------------------------------------------------------- 14. ふーふー風船

const BALLOONS = [0xff5a7a, 0x5aa9ff, 0xffd23f, 0x7fdc8a, 0xb58cff, 0xff9f40];

class BalloonGame extends SensorGame {
  async start() {
    const THREE = this.THREE;
    this.goal = this.o.goal || 3;
    this.mic = new Mic();
    try {
      await this.mic.start();
      this.cleanups.push(() => this.mic.stop());
      this.hasMic = true;
    } catch {
      this.hasMic = false;
    }
    this.hold = false;
    this.button(this.hasMic ? "ふくらませる（息でもOK）" : "押している間ふくらむ", { down: () => (this.hold = true), up: () => (this.hold = false), wide: true });
    this.api.hint(this.hasMic ? "マイクに「ふーっ」と息をふきかけよう。線をこえたら止めて、割れる前に！" : "マイクが使えないので、ボタンでふくらませてね。線をこえたら止めて！", 3800);
    this.scene.background = new THREE.Color(0xdff3ff);
    this.lights();
    const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 32), new THREE.MeshLambertMaterial({ color: 0xa6d98a }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.hero = this.avatar(0.7);
    this.hero.position.set(-0.9, 0, 0);
    this.hero.rotation.y = 0.8;
    this.scene.add(this.hero);
    this.balloon = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), new THREE.MeshLambertMaterial({ color: BALLOONS[0] }));
    this.scene.add(this.balloon);
    this.knot = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.14, 8), new THREE.MeshLambertMaterial({ color: BALLOONS[0] }));
    this.scene.add(this.knot);
    this.gauge = this.meter("おおきさ");
    this.low = [0.68, 0.76, 0.84][this.level - 1];
    this.gauge.mark(this.low);
    this.flying = [];
    this.done = 0;
    this.popped = 0;
    this.newBalloon();
    this.camera.position.set(0, 1.6, 4.6 * this.fit(0.7));
    this.camera.lookAt(0.2, 1.1, 0);
    this.timer(this.o.seconds || 60);
  }

  newBalloon() {
    this.size = 0.08;
    this.quiet = 0;
    const c = BALLOONS[(this.done + this.popped) % BALLOONS.length];
    this.balloon.material.color.setHex(c);
    this.knot.material.color.setHex(c);
    this.balloon.visible = true;
  }

  update(dt, t) {
    const v = this.hasMic ? this.mic.level() : 0;
    const blowing = this.hold || v > 0.22;
    const rate = this.hold ? 0.32 : clamp(v, 0, 1) * 0.55;
    if (blowing) {
      this.size += rate * (0.8 + this.level * 0.15) * dt;
      this.quiet = 0;
    } else {
      this.size = Math.max(0.08, this.size - 0.015 * this.level * dt);
      this.quiet += dt;
    }
    const s = 0.2 + this.size * 0.9;
    const wob = blowing ? Math.sin(t * 30) * 0.015 : 0;
    this.balloon.scale.set(s * (1 + wob), s * 1.15, s * (1 - wob));
    this.balloon.position.set(0.5, 0.9 + s * 1.15, 0);
    this.knot.position.set(0.5, 0.9 - 0.02, 0);
    this.knot.rotation.x = Math.PI;
    const over = this.size >= this.low;
    this.gauge.set(this.size, this.size > 0.93 ? "#ff5a4f" : over ? "#5ccf8a" : "#8b6cff");
    if (this.size >= 1) {
      this.popped += 1;
      this.balloon.visible = false;
      this.sfx(160, 160, 0.1, "sawtooth");
      vibrate([80, 30, 80]);
      this.api.hint("パーン！ 割れちゃった。つぎの風船", 1300);
      setTimeout(() => !this.ended && this.newBalloon(), 700);
      this.size = 0.08;
    } else if (over && this.quiet > 0.8 && this.balloon.visible) {
      // むすんで、空へ
      this.done += 1;
      const THREE = this.THREE;
      const fly = new THREE.Mesh(this.balloon.geometry, this.balloon.material.clone());
      fly.scale.copy(this.balloon.scale);
      fly.position.copy(this.balloon.position);
      this.scene.add(fly);
      this.flying.push(fly);
      this.sfx(1040, 120, 0.07, "triangle");
      vibrate(30);
      this.cheer(`できた！ ${this.done}こ`);
      if (this.done >= this.goal) {
        this.finish({ clear: true, score: this.left, summary: `風船を${this.goal}こ ふくらませた！ のこり${this.left}秒` });
        return;
      }
      this.newBalloon();
    }
    for (const f of this.flying) {
      f.position.y += dt * 1.4;
      f.position.x += Math.sin(t + f.id) * dt * 0.3;
    }
    this.hopUpdate(this.hero, t);
    this.api.hud(`風船 ${this.done} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}こ中 ${this.done}こ ふくらませたよ` });
  }
}

// ---------------------------------------------------------------- 15. つみつみタワー

const BLOCKS = [0xff9f5a, 0x6fb8ff, 0x9ad06a, 0xff7ad9, 0xffd23f, 0xb58cff];

class TowerGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 8;
    this.sensor = await this.orientation();
    this.touch = this.pad();
    this.dragX = 0;
    this.touch.onDrag = (dx) => (this.dragX = clamp(this.dragX + dx * 0.012, -2.4, 2.4));
    this.touch.onTap = () => this.drop();
    this.button("おとす！", { down: () => this.drop(), wide: true });
    this.api.hint(this.sensor ? "端末をかたむけて位置を合わせ、タップで落とそう" : "画面をなぞって位置を合わせ、タップで落とそう", 3400);
    this.scene.background = new THREE.Color(0xc9ecff);
    this.lights();
    const ground = new THREE.Mesh(new THREE.CircleGeometry(20, 32), new THREE.MeshLambertMaterial({ color: 0x9ed67a }));
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
    this.bh = 0.34;
    this.depth = 1.4;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, this.bh, this.depth), new THREE.MeshLambertMaterial({ color: 0xc9a27a }));
    base.position.y = this.bh / 2;
    this.scene.add(base);
    this.stack = [{ x: 0, w: 1.8, mesh: base }];
    // 分身はタワーの横で応援（積み終わったら、てっぺんに乗る）
    this.hero = this.avatar(0.55);
    this.hero.position.set(-2.1, 0, 0.9);
    this.hero.rotation.y = 0.5;
    this.scene.add(this.hero);
    this.falling = [];
    this.perfect = 0;
    this.spawn();
    this.camY = 1.5;
  }

  spawn() {
    const THREE = this.THREE;
    const top = this.stack[this.stack.length - 1];
    const color = BLOCKS[this.stack.length % BLOCKS.length];
    this.cur = new THREE.Mesh(new THREE.BoxGeometry(1, this.bh, this.depth), new THREE.MeshLambertMaterial({ color }));
    this.cur.scale.x = top.w;
    this.curW = top.w;
    this.cur.position.y = this.stack.length * this.bh + this.bh / 2 + 1.1;
    this.scene.add(this.cur);
    this.dropping = false;
  }

  drop() {
    if (this.ended || this.dropping || !this.cur) return;
    this.dropping = true;
    this.vy = 0;
    this.sfx(440, 60, 0.05, "triangle");
  }

  land() {
    const THREE = this.THREE;
    const top = this.stack[this.stack.length - 1];
    const x = this.cur.position.x;
    let dx = x - top.x;
    if (Math.abs(dx) < 0.07) {
      dx = 0;
      this.perfect += 1;
      this.cheer("ぴったり！");
      vibrate(30);
    }
    const overlap = this.curW - Math.abs(dx);
    if (overlap <= 0.02) {
      this.falling.push({ mesh: this.cur, v: 0, spin: Math.sign(dx) || 1 });
      this.cur = null;
      this.sfx(180, 300, 0.07, "sawtooth");
      vibrate([80, 40, 120]);
      const n = this.stack.length - 1;
      setTimeout(() => this.finish({ clear: false, summary: `${this.goal}段中 ${n}段つんだよ` }), 900);
      return;
    }
    const nx = top.x + dx / 2;
    this.cur.scale.x = overlap;
    this.cur.position.set(nx, this.stack.length * this.bh + this.bh / 2, 0);
    if (dx !== 0) {
      // はみ出した分は落ちる
      const cut = new THREE.Mesh(new THREE.BoxGeometry(1, this.bh, this.depth), this.cur.material);
      cut.scale.x = Math.abs(dx);
      cut.position.set(nx + Math.sign(dx) * (overlap / 2 + Math.abs(dx) / 2), this.cur.position.y, 0);
      this.scene.add(cut);
      this.falling.push({ mesh: cut, v: 0, spin: Math.sign(dx) });
      this.sfx(620, 70, 0.05, "square");
    }
    this.stack.push({ x: nx, w: overlap, mesh: this.cur });
    this.cur = null;
    const built = this.stack.length - 1;
    if (built >= this.goal) {
      const pct = Math.round((overlap / 1.8) * 100);
      this.hero.position.set(nx, this.stack.length * this.bh, 0);
      this.finish({ clear: true, score: pct, summary: `${this.goal}段つめた！ のこり幅${pct}%（ぴったり${this.perfect}回）` });
      return;
    }
    this.spawn();
  }

  update(dt, t) {
    if (this.cur && !this.dropping) {
      const control = this.sensor ? this.sensor.tilt(25).x * 2.4 : this.dragX;
      const sway = Math.sin(t * (1.2 + this.level * 0.35)) * [0, 0.45, 0.85][this.level - 1];
      this.cur.position.x = clamp(control + sway, -2.6, 2.6);
    } else if (this.cur && this.dropping) {
      this.vy += 18 * dt;
      this.cur.position.y -= this.vy * dt;
      const landY = this.stack.length * this.bh + this.bh / 2;
      if (this.cur.position.y <= landY) this.land();
    }
    for (const f of this.falling) {
      f.v += 14 * dt;
      f.mesh.position.y -= f.v * dt;
      f.mesh.position.x += f.spin * dt * 0.8;
      f.mesh.rotation.z -= f.spin * dt * 2;
    }
    this.hopUpdate(this.hero, t);
    const want = Math.max(1.5, this.stack.length * this.bh + 0.6);
    this.camY += (want - this.camY) * Math.min(1, dt * 3);
    const k = this.fit(0.75);
    this.camera.position.set(0, this.camY + 1.6, 6.2 * k);
    this.camera.lookAt(0, this.camY, 0);
    this.api.hud(`${this.stack.length - 1} / ${this.goal}段`);
  }
}

// ---------------------------------------------------------------- 16. カメラで色さがし

/** お題の色。h は色相（度）、判定は HSV で行う */
const COLOR_TARGETS = [
  { id: "red", label: "赤", css: "#ff3b3b", test: (h, s, v) => s > 0.45 && v > 0.3 && (h < 14 || h > 340) },
  { id: "orange", label: "オレンジ", css: "#ff9a2e", test: (h, s, v) => s > 0.5 && v > 0.45 && h >= 14 && h < 40 },
  { id: "yellow", label: "黄色", css: "#ffd83b", test: (h, s, v) => s > 0.45 && v > 0.5 && h >= 40 && h < 70 },
  { id: "green", label: "緑", css: "#3fbf5a", test: (h, s, v) => s > 0.3 && v > 0.2 && h >= 75 && h < 165 },
  { id: "blue", label: "青", css: "#3b7bff", test: (h, s, v) => s > 0.35 && v > 0.2 && h >= 190 && h < 255 },
  { id: "purple", label: "むらさき", css: "#a45cff", test: (h, s, v) => s > 0.3 && v > 0.2 && h >= 255 && h < 320 },
  { id: "white", label: "白", css: "#ffffff", test: (h, s, v) => s < 0.14 && v > 0.8 },
  { id: "black", label: "黒", css: "#222222", test: (h, s, v) => v < 0.18 },
];

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}

class ColorHuntGame extends SensorGame {
  async start() {
    const THREE = this.THREE;
    this.goal = Math.min(COLOR_TARGETS.length, this.o.goal || 4);
    this.queue = [...COLOR_TARGETS].sort(() => Math.random() - 0.5).slice(0, this.goal);
    this.found = 0;
    this.feed = new CameraFeed(this.api.layer.video);
    try {
      await this.feed.start();
      this.cleanups.push(() => this.feed.stop());
      this.transparent = true;
      this.hasCam = true;
    } catch {
      this.hasCam = false;
      this.scene.add(skyDome(THREE, "#ffd9ec", "#fff7fb"));
    }
    this.lights(0xffffff, 0xffffff, 1.4);
    this.companion();
    // 真ん中の枠（ここに映った色を読む）
    this.ring = document.createElement("div");
    this.ring.style.cssText = "width:28vmin;height:28vmin;border-radius:50%;border:6px solid #fff;box-shadow:0 0 0 3px rgba(0,0,0,.35);display:flex;align-items:flex-end;justify-content:center;";
    this.chip = document.createElement("span");
    this.chip.style.cssText = "transform:translateY(60%);padding:6px 14px;border-radius:999px;font-weight:800;font-size:15px;background:#fff;color:#2a2440;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    this.ring.appendChild(this.chip);
    this.api.layer.center.appendChild(this.ring);
    this.hold = 0;
    if (this.hasCam) {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 24;
      this.canvas.height = 24;
      this.ctx2d = this.canvas.getContext("2d", { willReadFrequently: true });
      this.api.hint("お題の色の物を探して、真ん中の丸に映そう", 3400);
    } else {
      this.api.hint("カメラが使えないので、お題と同じ色のボタンを押してね", 3400);
      this.palette = [];
    }
    this.showTarget();
    this.timer(this.o.seconds || 90);
  }

  showTarget() {
    const target = this.queue[this.found];
    this.chip.textContent = `「${target.label}」をさがそう`;
    this.ring.style.borderColor = target.css;
    if (!this.hasCam) {
      for (const b of this.palette) b.remove();
      const choices = [target, ...COLOR_TARGETS.filter((c) => c !== target).sort(() => Math.random() - 0.5).slice(0, 2 + this.level)].sort(() => Math.random() - 0.5);
      this.palette = choices.map((c) => {
        const b = this.button(c.label, { down: () => this.choose(c) });
        b.style.background = c.css;
        b.style.color = c.id === "white" || c.id === "yellow" ? "#2a2440" : "#fff";
        return b;
      });
    }
  }

  choose(c) {
    if (this.ended) return;
    if (c === this.queue[this.found]) this.hit();
    else {
      this.endsAt -= 3000;
      this.api.hint("ちがう色だよ -3秒", 900);
      vibrate(60);
    }
  }

  hit() {
    const target = this.queue[this.found];
    this.found += 1;
    this.sfx(1100 + this.found * 60, 110, 0.07, "triangle");
    vibrate(35);
    this.cheer(`${target.label}、見つけた！`);
    if (this.found >= this.goal) {
      this.finish({ clear: true, score: this.left, summary: `${this.goal}色ぜんぶ見つけた！ のこり${this.left}秒` });
      return;
    }
    this.hold = 0;
    this.showTarget();
  }

  /** 映像の真ん中を小さく読んで、平均の色を出す（読んだ画素はすぐ捨てる） */
  sample() {
    const video = this.api.layer.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh) * 0.18;
    this.ctx2d.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, 24, 24);
    const d = this.ctx2d.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return { r: r / n / 255, g: g / n / 255, b: b / n / 255 };
  }

  update(dt, t) {
    this.hopUpdate(this.buddy, t);
    if (this.hasCam && !this.ended) {
      const c = this.sample();
      if (c) {
        const { h, s, v } = rgbToHsv(c.r, c.g, c.b);
        this.ring.style.background = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.35)`;
        const target = this.queue[this.found];
        if (target.test(h, s, v)) {
          this.hold += dt;
          this.chip.textContent = `「${target.label}」…そのまま！`;
          if (this.hold > [0.4, 0.6, 1.0][this.level - 1]) this.hit();
        } else if (this.hold > 0) {
          this.hold = 0;
          this.chip.textContent = `「${target.label}」をさがそう`;
        }
      }
    }
    if (this.ended) return;
    this.api.hud(`色 ${this.found} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `${this.goal}色中 ${this.found}色 見つけたよ` });
  }
}

// ---------------------------------------------------------------- 17. はねつき

class HanetsukiGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 10;
    this.sensor = await this.motion({ shakeThreshold: 10 });
    if (this.sensor) this.sensor.onShake = () => this.swing();
    this.touch = this.pad();
    this.touch.onDown = () => this.swing();
    this.api.hint(this.sensor ? "羽根が手元に来たら、端末をふって打ち返そう（タップでもOK）" : "羽根が手元に来たら、画面をタップして打ち返そう", 3400);
    outdoor(this, { sky: 0xfff0e0, grass: 0xe8d8b0 });
    // 正月らしく、赤い毛せんと門松ふうの竹
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 7), new THREE.MeshLambertMaterial({ color: 0xd9434b }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = 0.01;
    this.scene.add(mat);
    for (const sx of [-2.6, 2.6]) {
      for (const [dx, h] of [[0, 1.6], [0.18, 1.3], [-0.16, 1.1]]) {
        const bamboo = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h, 10), new THREE.MeshLambertMaterial({ color: 0x5fae52 }));
        bamboo.position.set(sx + dx, h / 2, 0);
        this.scene.add(bamboo);
      }
    }
    this.me = this.avatar(0.7);
    this.me.position.set(0, 0, 2.4);
    this.me.rotation.y = Math.PI;
    this.scene.add(this.me);
    this.hero = this.me;
    this.partner = this.avatar(0.7, "punikoro", this.api.me.color === "peach" ? "sky" : "peach");
    this.partner.position.set(0, 0, -2.4);
    this.scene.add(this.partner);
    // 羽子板
    this.paddle = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.42, 0.04), new THREE.MeshLambertMaterial({ color: 0xf7d9a8 }));
    this.paddle.position.set(0.45, 0.8, 2.3);
    this.scene.add(this.paddle);
    // 羽根（黒い玉に、色つきの羽）
    this.hane = new THREE.Group();
    this.hane.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshLambertMaterial({ color: 0x222222 })));
    const cols = [0xff5a7a, 0x5aa9ff, 0xffd23f, 0x7fdc8a];
    for (let i = 0; i < 4; i++) {
      const f = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.22, 4), new THREE.MeshLambertMaterial({ color: cols[i] }));
      const a = (i / 4) * TAU;
      f.position.set(Math.cos(a) * 0.05, 0.13, Math.sin(a) * 0.05);
      f.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
      this.hane.add(f);
    }
    this.scene.add(this.hane);
    this.count = 0;
    this.great = 0;
    this.cool = 0;
    this.flight = [1.7, 1.35, 1.05][this.level - 1];
    this.window = [0.3, 0.24, 0.18][this.level - 1];
    // 最初は相手から
    this.serve(performance.now() / 1000 + 1.2);
    const k = this.fit(0.7);
    this.camera.position.set(2.8 * k, 2.4, 5.4 * k);
    this.camera.lookAt(0, 0.9, 0);
  }

  /** 相手が打つ → at 秒に自分の手元へ届く */
  serve(arriveAt) {
    this.from = this.partner.position.clone().setY(1.0);
    this.to = new this.THREE.Vector3(0.45, 0.9, 2.3);
    this.arriveAt = arriveAt;
    this.leaveAt = arriveAt - this.flight;
    this.toMe = true;
    this.hit = false;
  }

  swing() {
    if (this.ended || this.over) return;
    const now = performance.now() / 1000;
    if (now < this.cool) return;
    this.cool = now + 0.4;
    this.paddle.userData.swingAt = now;
    if (!this.toMe || this.hit) return;
    const d = now - this.arriveAt;
    if (Math.abs(d) <= this.window) {
      this.hit = true;
      this.count += 1;
      const great = Math.abs(d) < this.window / 2;
      if (great) this.great += 1;
      this.sfx(great ? 1320 : 990, 60, 0.07, "triangle");
      vibrate(great ? 35 : 20);
      this.cheer(great ? `ぴったり！ ${this.count}` : `${this.count}`);
      if (this.count >= this.goal) {
        this.finish({ clear: true, score: this.great, summary: `${this.goal}回つづいた！（ぴったり${this.great}回）` });
        return;
      }
      // 打ち返した羽根は相手へ飛び、相手が打ち返す
      this.from = this.hane.position.clone();
      this.to = this.partner.position.clone().setY(1.0);
      this.leaveAt = now;
      this.arriveAt = now + this.flight;
      this.toMe = false;
    } else if (d < 0) {
      this.api.hint("はやい！", 500);
    }
  }

  update(dt, t) {
    const now = performance.now() / 1000;
    const u = clamp((now - this.leaveAt) / (this.arriveAt - this.leaveAt), 0, 1.4);
    const pos = this.hane.position;
    pos.lerpVectors(this.from, this.to, Math.min(u, 1));
    pos.y += Math.sin(Math.min(u, 1) * Math.PI) * 1.8;
    if (u > 1) {
      // 手元を過ぎた（落ちていく）
      pos.y = Math.max(0.05, this.to.y - (u - 1) * 4);
      pos.z = this.to.z + (u - 1) * (this.toMe ? 1 : -1);
    }
    this.hane.rotation.x = this.toMe ? Math.PI : 0;
    if (!this.toMe && u >= 1) {
      this.partner.userData.hopUntil = performance.now() + 300;
      this.sfx(700, 50, 0.04, "triangle");
      this.serve(now + this.flight * (this.level >= 3 ? rand(0.85, 1.1) : 1));
    } else if (this.toMe && !this.hit && now - this.arriveAt > this.window && !this.over) {
      this.over = true;
      this.sfx(200, 300, 0.07, "sawtooth");
      vibrate([80, 40, 120]);
      const n = this.count;
      setTimeout(() => this.finish({ clear: false, summary: `${n}回つづいたよ（落としたので、顔に墨をぬられちゃった）` }), 800);
    }
    const sw = now - (this.paddle.userData.swingAt || -9);
    this.paddle.rotation.x = sw < 0.25 ? -Math.sin((sw / 0.25) * Math.PI) * 1.2 : 0;
    this.hopUpdate(this.me, t);
    this.hopUpdate(this.partner, t);
    this.api.hud(`つづいた ${this.count} / ${this.goal}回`);
  }
}

// ---------------------------------------------------------------- 18. わだいこ

class TaikoGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.total = this.o.goal || 20;
    this.sensor = await this.motion({ shakeThreshold: 10 });
    if (this.sensor) this.sensor.onShake = () => this.hit("ka");
    this.touch = this.pad();
    this.touch.onDown = () => this.hit("don");
    this.button("ドン", { down: () => this.hit("don") });
    this.button(this.sensor ? "カッ（ふってもOK）" : "カッ", { down: () => this.hit("ka") });
    this.api.hint(this.sensor ? "赤い「ドン」は画面をタップ、青い「カッ」は端末をふる！" : "赤い「ドン」は画面かドンのボタン、青い「カッ」はカッのボタン！", 3600);
    this.scene.background = new THREE.Color(0x3a1f2a);
    this.lights(0xffe0c0, 0x5a2a3a, 1.25);
    this.judgeZ = 1.4;
    // 流れるレーン（縦長の画面でも見やすいよう、奥から手前へ流す）
    const lane = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.05, 16), new THREE.MeshLambertMaterial({ color: 0x5a3a2a }));
    lane.position.set(0, 0.02, -5.5);
    this.scene.add(lane);
    for (const sx of [-0.7, 0.7]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 16), new THREE.MeshLambertMaterial({ color: 0xf2c23a }));
      edge.position.set(sx, 0.05, -5.5);
      this.scene.add(edge);
    }
    const judge = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    judge.position.set(0, 0.1, this.judgeZ);
    judge.rotation.x = -Math.PI / 2;
    this.scene.add(judge);
    this.judge = judge;
    // 太鼓と分身（レーンの手前の横）
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.7, 28), new THREE.MeshLambertMaterial({ color: 0xa8432a }));
    drum.position.set(1.15, 0.35, 1.7);
    this.scene.add(drum);
    const skin = new THREE.Mesh(new THREE.CircleGeometry(0.5, 28), new THREE.MeshLambertMaterial({ color: 0xf5e6c8 }));
    skin.rotation.x = -Math.PI / 2;
    skin.position.set(1.15, 0.71, 1.7);
    this.scene.add(skin);
    this.drum = drum;
    this.hero = this.avatar(0.55);
    this.hero.position.set(-1.3, 0, 1.6);
    this.hero.rotation.y = 0.3;
    this.scene.add(this.hero);
    this.bpm = [90, 110, 130][this.level - 1];
    const beat = 60 / this.bpm;
    this.beat = beat;
    this.speed = 4.2 + this.level * 0.6;
    const steps = this.level === 1 ? [2, 2, 1, 1, 2] : this.level === 2 ? [1, 1, 1, 0.5, 0.5, 2] : [1, 0.5, 0.5, 1, 0.5, 0.5, 1];
    const t0 = performance.now() / 1000 + 3;
    this.notes = [];
    let at = t0;
    for (let i = 0; i < this.total; i++) {
      const kind = this.level === 1 ? (i % 4 === 3 ? "ka" : "don") : Math.random() < 0.4 ? "ka" : "don";
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 24), new THREE.MeshLambertMaterial({ color: kind === "don" ? 0xff4f3f : 0x3fa8ff }));
      m.visible = false;
      this.scene.add(m);
      this.notes.push({ at, kind, mesh: m, judged: false });
      at += steps[i % steps.length] * beat;
    }
    this.hits = 0;
    this.great = 0;
    const k = this.fit(0.62);
    this.camera.position.set(0, 3.0 * k, 5.2 * k);
    this.camera.lookAt(0, 0.2, -2.2);
  }

  hit(kind) {
    if (this.ended) return;
    const now = performance.now() / 1000;
    this.hero.userData.hopUntil = performance.now() + 200;
    this.drum.userData.hitAt = now;
    this.sfx(kind === "don" ? 140 : 1400, kind === "don" ? 90 : 40, 0.09, kind === "don" ? "sine" : "square");
    let best = null;
    for (const n of this.notes) {
      if (n.judged) continue;
      const d = Math.abs(n.at - now);
      if (d < 0.25 && (!best || d < Math.abs(best.at - now))) best = n;
    }
    if (!best) return;
    if (best.kind !== kind) {
      this.api.hint(best.kind === "don" ? "ドン（タップ）だよ" : "カッ（ふる）だよ", 500);
      return;
    }
    best.judged = true;
    best.mesh.visible = false;
    const great = Math.abs(best.at - now) < 0.1;
    this.hits += 1;
    if (great) this.great += 1;
    this.api.hint(great ? "良！" : "可", 400);
    vibrate(great ? 30 : 15);
  }

  update(dt, t) {
    const now = performance.now() / 1000;
    for (const n of this.notes) {
      if (n.judged) continue;
      const z = this.judgeZ - (n.at - now) * this.speed;
      n.mesh.visible = z > -13;
      n.mesh.position.set(0, 0.1, z);
      if (now - n.at > 0.25) {
        n.judged = true;
        n.mesh.visible = false;
        this.api.hint("不可", 300);
      }
    }
    const since = now - (this.drum.userData.hitAt || -9);
    this.drum.scale.setScalar(since < 0.12 ? 1.05 : 1);
    this.judge.scale.setScalar(1 + Math.max(0, Math.sin(((now % this.beat) / this.beat) * Math.PI)) * 0.05);
    this.hopUpdate(this.hero, t);
    const done = this.notes.filter((n) => n.judged).length;
    this.api.hud(`ヒット ${this.hits} / ${this.total}　（のこり ${this.total - done}）`);
    if (done >= this.total) {
      const pct = Math.round((this.hits / this.total) * 100);
      const clear = this.hits / this.total >= 0.7;
      this.finish({ clear, score: clear ? pct : undefined, summary: `${this.total}こ中 ${this.hits}こ ヒット（良${this.great}）` });
    }
  }
}

// ---------------------------------------------------------------- 19. そりすべり

class SledGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.goal = this.o.goal || 10;
    this.sensor = await this.orientation();
    this.push = 0;
    if (!this.sensor) {
      this.button("◀ ひだり", { down: () => (this.push = -1), up: () => (this.push = 0) });
      this.button("みぎ ▶", { down: () => (this.push = 1), up: () => (this.push = 0) });
    }
    this.api.hint(this.sensor ? "端末を左右にかたむけて曲がり、旗の門をくぐろう" : "ボタンで左右に曲がって、旗の門をくぐろう", 3400);
    this.scene.background = new THREE.Color(0xdbeeff);
    this.scene.fog = new THREE.Fog(0xdbeeff, 14, 42);
    this.lights(0xffffff, 0xb0c8e0, 1.25);
    this.snow = new THREE.Mesh(new THREE.PlaneGeometry(40, 120), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    this.snow.rotation.x = -Math.PI / 2;
    this.scene.add(this.snow);
    this.hero = this.avatar(0.6);
    this.hero.rotation.y = Math.PI;
    this.scene.add(this.hero);
    const sled = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 1.0), new THREE.MeshLambertMaterial({ color: 0xd9434b }));
    sled.position.y = 0.05;
    this.hero.add(sled);
    this.hero.userData.body.position.y = 0.1;
    // 両わきの木（使い回す）
    this.trees = [];
    for (let i = 0; i < 24; i++) {
      const tree = new THREE.Group();
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 8), new THREE.MeshLambertMaterial({ color: 0x3f8f5a }));
      leaf.position.y = 1.3;
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.6, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      cap.position.y = 2.1;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.5, 6), new THREE.MeshLambertMaterial({ color: 0x8a5a2b }));
      trunk.position.y = 0.25;
      tree.add(leaf, cap, trunk);
      tree.position.set((i % 2 ? 1 : -1) * rand(6, 9), 0, -i * 3);
      this.scene.add(tree);
      this.trees.push(tree);
    }
    this.width = [2.8, 2.2, 1.7][this.level - 1];
    this.gates = [];
    this.nextGateZ = -10;
    this.passed = 0;
    this.missed = 0;
    this.x = 0;
    this.vx = 0;
    this.z = 0;
    this.speed = 5 + this.level;
    this.timer(this.o.seconds || 60);
  }

  addGate() {
    const THREE = this.THREE;
    const g = new THREE.Group();
    const gx = rand(-3.4, 3.4);
    const col = this.gates.length % 2 ? 0x3f7bff : 0xff4f5a;
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 8), new THREE.MeshLambertMaterial({ color: col }));
      pole.position.set(sx * (this.width / 2), 0.65, 0);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3), new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide }));
      flag.position.set(sx * (this.width / 2) - sx * 0.2, 1.1, 0);
      g.add(pole, flag);
    }
    g.position.set(gx, 0, this.nextGateZ);
    this.scene.add(g);
    this.gates.push({ g, x: gx, z: this.nextGateZ, done: false });
    this.nextGateZ -= rand(8, 11) - this.level;
  }

  update(dt, t) {
    const control = this.sensor ? clamp(this.sensor.tilt(22).x, -1, 1) : this.push;
    this.speed = Math.min(12, this.speed + dt * 0.08);
    this.vx += (control * 9 - this.vx * 2.5) * dt;
    this.x = clamp(this.x + this.vx * dt, -5, 5);
    this.z -= this.speed * dt;
    this.hero.position.set(this.x, 0, this.z);
    this.hero.rotation.z = -this.vx * 0.04;
    this.hero.rotation.y = Math.PI - this.vx * 0.05;
    while (this.nextGateZ > this.z - 40) this.addGate();
    for (const gate of this.gates) {
      if (gate.done || gate.z < this.z) continue;
      if (this.z <= gate.z) {
        gate.done = true;
        if (Math.abs(this.x - gate.x) < this.width / 2) {
          this.passed += 1;
          this.sfx(980 + this.passed * 30, 90, 0.07, "triangle");
          vibrate(20);
          this.cheer(`くぐった！ ${this.passed}`);
          if (this.passed >= this.goal) {
            this.finish({ clear: true, score: this.left, summary: `門を${this.goal}こ くぐった！ のこり${this.left}秒` });
            return;
          }
        } else {
          this.missed += 1;
          this.api.hint("おしい！", 600);
        }
      }
    }
    // 通り過ぎた門は片づける
    this.gates = this.gates.filter((gate) => {
      if (gate.z > this.z + 8) {
        this.scene.remove(gate.g);
        gate.g.traverse((m) => {
          m.geometry?.dispose?.();
          m.material?.dispose?.();
        });
        return false;
      }
      return true;
    });
    for (const tree of this.trees) if (tree.position.z > this.z + 6) tree.position.z -= 72;
    this.snow.position.z = this.z - 30;
    const k = this.fit(0.75);
    this.camera.position.set(this.x * 0.6, 3.1, this.z + 5.2 * k);
    this.camera.lookAt(this.x * 0.8, 0.6, this.z - 5);
    this.api.hud(`門 ${this.passed} / ${this.goal}　のこり ${this.left}秒`);
    if (this.timeUp()) this.finish({ clear: false, summary: `門を${this.passed}こ くぐったよ（目標${this.goal}こ）` });
  }
}

// ---------------------------------------------------------------- 20. ねんねタイム

class NenneGame extends SensorGame {
  async start() {
    this.permission();
    const THREE = this.THREE;
    this.need = this.o.seconds || 30;
    this.mic = new Mic();
    try {
      await this.mic.start();
      this.cleanups.push(() => this.mic.stop());
      this.hasMic = true;
    } catch {
      this.hasMic = false;
    }
    this.sensor = await this.motion({ shakeThreshold: 99 });
    this.touch = this.pad();
    this.touch.onDown = () => this.disturb("さわったら起きちゃった");
    const how = [this.hasMic ? "しずかに" : null, this.sensor ? "端末を動かさずに" : null, "画面にさわらずに"].filter(Boolean).join("、");
    this.api.hint(`${how}、分身が眠るまで待ってね`, 3800);
    this.scene.background = new THREE.Color(0x1c2250);
    this.scene.add(new THREE.HemisphereLight(0x9fb4ff, 0x2a2440, 1.0));
    const lamp = new THREE.PointLight(0xffd59a, 1.6, 8);
    lamp.position.set(1.4, 1.6, 1.2);
    this.scene.add(lamp);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshLambertMaterial({ color: 0x8a6a4a }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const futon = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 1.3), new THREE.MeshLambertMaterial({ color: 0xf7f0ff }));
    futon.position.y = 0.08;
    this.scene.add(futon);
    const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.14, 0.7), new THREE.MeshLambertMaterial({ color: 0xffd6e8 }));
    pillow.position.set(-0.7, 0.23, 0);
    this.scene.add(pillow);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 20, 14), new THREE.MeshBasicMaterial({ color: 0xfff3b0 }));
    moon.position.set(-2.4, 3, -3);
    this.scene.add(moon);
    // 横になって、頭を枕へ（体の「上」が -x を向く）。顔は手前を向いたまま
    this.hero = this.avatar(0.6);
    this.hero.position.set(0.35, 0.36, 0);
    this.hero.rotation.z = Math.PI / 2;
    this.hero.children[1].visible = false;
    this.scene.add(this.hero);
    this.blanket = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 1.25), new THREE.MeshLambertMaterial({ color: 0x8fb8ff }));
    this.blanket.position.set(0.58, 0.58, 0.05);
    this.scene.add(this.blanket);
    this.zzz = this.label("💤", { width: 0.6, bg: "rgba(0,0,0,0)", color: "#ffffff" });
    this.zzz.position.set(-0.4, 1.1, 0);
    this.zzz.visible = false;
    this.scene.add(this.zzz);
    this.sleep = 0;
    this.quiet = 0;
    this.total = 0;
    this.lastDisturb = 0;
    this.gauge = this.meter("ねむけ");
    this.noise = this.meter(this.hasMic ? "物音" : "ゆれ");
    this.noise.mark(0.5);
    this.limit = this.need * 2.5 + 10;
    this.camera.position.set(0.3, 1.9, 2.9 * this.fit(0.7));
    this.camera.lookAt(0, 0.45, 0);
  }

  disturb(text) {
    if (this.ended) return;
    const now = performance.now();
    if (now - this.lastDisturb < 900) return;
    this.lastDisturb = now;
    this.sleep = Math.max(0, this.sleep - (0.12 + this.level * 0.08));
    this.hero.userData.hopUntil = now + 400;
    this.api.hint(`びくっ！ ${text}`, 900);
    vibrate(40);
    this.sfx(520, 90, 0.04, "square");
  }

  update(dt, t) {
    this.total += dt;
    const v = this.hasMic ? this.mic.level() : 0;
    const shake = this.sensor ? clamp(this.sensor.level / 2.4, 0, 1) : 0;
    const loud = Math.max(v, shake);
    this.noise.set(loud, loud > 0.5 ? "#ff5a4f" : loud > 0.25 ? "#ffb13d" : "#5ccf8a");
    const limit = [0.6, 0.5, 0.42][this.level - 1];
    if (v > limit) this.disturb("物音で起きちゃった");
    else if (shake > limit) this.disturb("ゆれで起きちゃった");
    else {
      this.sleep = Math.min(1, this.sleep + dt / this.need);
      this.quiet += dt;
    }
    this.gauge.set(this.sleep, "#8b9cff");
    this.zzz.visible = this.sleep > 0.5;
    this.zzz.position.y = 1.1 + ((t * 0.4) % 0.5);
    this.zzz.material.opacity = 1 - ((t * 0.4) % 0.5) * 1.6;
    // ねむいほど、ゆっくり息をする
    const breathe = Math.sin(t * (3 - this.sleep * 1.8)) * 0.02;
    this.blanket.position.y = 0.58 + breathe;
    this.hopUpdate(this.hero, t);
    const left = Math.max(0, Math.ceil(this.limit - this.total));
    this.api.hud(`ねむけ ${Math.round(this.sleep * 100)}%　のこり ${left}秒`);
    if (this.sleep >= 1) {
      const pct = Math.round((this.quiet / Math.max(1, this.total)) * 100);
      this.sfx(660, 300, 0.04, "sine");
      this.finish({ clear: true, score: pct, summary: `ぐっすり眠ったよ。しずか${pct}%` });
    } else if (this.total >= this.limit) {
      this.finish({ clear: false, summary: `ねむけ${Math.round(this.sleep * 100)}%。もう少しで眠れそうだったね` });
    }
  }
}

export const SENSOR_GAME_CLASSES_2 = {
  fishing: FishingGame,
  pour: PourGame,
  maze: MazeGame,
  balloon: BalloonGame,
  tower: TowerGame,
  colorhunt: ColorHuntGame,
  hanetsuki: HanetsukiGame,
  taiko: TaikoGame,
  sled: SledGame,
  nenne: NenneGame,
};
