/**
 * メタバースの中の分身1体。
 *
 * 見た目は種族・色の3Dモデル（glb.mjs）、**動きは人格の数値（compact）と実機の検証機と同じエンジン**
 * （wt_core.mjs。tools/device/web/wt_core.mjs の写し）で決める。ロボット・玩具・アバターで
 * 「同じ人格なら同じ振る舞い」になる、という主張をここでも崩さないため、規則は書き足さない。
 *
 * エンジンが出す指示（"body_sway ±6.2 deg / 2460ms" 等）を、ここで体の動きに翻訳する（MetaDriver）。
 * 指示はその場で角度を跳ばさず、目標値として置き、毎フレーム少しずつ寄せる（カクつかせない）。
 *
 * 位置の扱い:
 *   - 自分の子の位置は、この端末が決めて部屋へ送る（行き先だけ。途中の座標は送らない）
 *   - 他の人の子は、届いた行き先へ、その子の歩く速さで向かって見せる
 *   - エンジンの「近づく（drive forward）」は、自分の子のときだけ本当に位置を動かす
 */

import { Driver, Persona, dispatch } from "./wt_core.mjs";
import { loadCharacter } from "./glb.mjs";
import { textCanvas, wrapText } from "./world.mjs";
import { makeWear } from "./wear.mjs";

const TAU = Math.PI * 2;

function allNumbers(text) {
  const m = String(text).match(/-?\d+(\.\d+)?/g);
  return m ? m.map(Number) : [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** エンジンの指示 → 体の目標値 */
class MetaDriver extends Driver {
  constructor(actor) {
    super();
    this.a = actor;
  }
  async servo(name, value) {
    const a = this.a;
    const v = String(value);
    if (name === "body_sway") {
      const [amp = 4, period = 2400] = allNumbers(v);
      a.swayAmp = (amp * Math.PI) / 180;
      a.swayPeriod = Math.max(600, period);
      await sleep(a.swayPeriod);
    } else if (name === "arm") {
      // 腕の無い子もいるので、体ごと左右にぴょこっと傾けて「手を振る」に見せる
      a.target.roll = 0.28;
      await sleep(170);
      a.target.roll = -0.28;
      await sleep(170);
      a.target.roll = 0;
      await sleep(80);
    } else if (name === "head") {
      if (v.startsWith("nod")) {
        const times = v.includes("fast") ? 2 : 1;
        for (let i = 0; i < times; i++) {
          a.target.pitch = 0.3;
          await sleep(v.includes("fast") ? 100 : 150);
          a.target.pitch = 0;
          await sleep(v.includes("fast") ? 100 : 150);
        }
      } else if (v.startsWith("shake")) {
        for (const d of [-0.25, 0.25, -0.15, 0]) {
          a.target.yawOffset = d;
          await sleep(120);
        }
      } else if (v.startsWith("tilt") || v.startsWith("turn")) {
        a.target.roll = v.startsWith("turn") ? 0 : 0.18;
        a.faceOther = true;
        await sleep(500);
        a.target.roll = 0;
      } else {
        a.faceOther = true;
        await sleep(300);
      }
    } else if (name === "gaze") {
      a.faceOther = true;
      await sleep(v.startsWith("glance") ? 200 : Math.min(2500, allNumbers(v)[0] || 800));
    } else if (name === "drive") {
      const nums = allNumbers(v);
      if (v.startsWith("forward")) {
        a.target.lean = 0.18;
        if (a.mine && a.other) a.stepToward(a.other, Math.min(1.2, (nums[0] || 0.5) * 1.5));
      } else {
        a.target.lean = -0.14;
        if (a.mine && a.other) a.stepAway(a.other, Math.min(1.0, nums[0] || 0.4));
      }
      await sleep(450);
      a.target.lean = 0;
    } else if (name === "body") {
      if (v.startsWith("bounce")) {
        for (const d of [0.14, -0.04, 0.06, 0]) {
          a.target.hop = d;
          await sleep(100);
        }
      } else {
        a.target.hop = -0.03;
        await sleep(300);
        a.target.hop = 0;
      }
    }
  }
  async led(name, value) {
    // 頬・口の明るさ。モデルに表情の差し替えは無いので、足元の影の濃さで「うれしさ」を少しだけ出す
    const pct = allNumbers(value)[0] ?? 50;
    this.a.glow = Math.max(0, Math.min(1, pct / 100));
  }
  async wait(ms) {
    await sleep(Math.min(ms, 8000));
  }
}

export class Actor {
  /**
   * @param {object} THREE
   * @param {object} data 部屋から届いた公開情報（aid, name, species, color, voice, compact, x, z）
   * @param {{ mine: boolean, scene: THREE.Scene }} opts
   */
  constructor(THREE, data, opts) {
    this.THREE = THREE;
    this.aid = data.aid;
    this.name = data.name;
    this.species = data.species;
    this.color = data.color;
    this.voice = data.voice;
    this.mine = !!opts.mine;
    /** 運営が置いた NPC（役目・メッセージつき） */
    this.npc = opts.npc || null;
    this.persona = null;
    try {
      this.persona = new Persona(data.compact);
    } catch {
      this.persona = null;
    }
    // 歩く速さ: 「近づく速さ」の数値から。速い子はとことこ、遅い子はのんびり
    const approach = this.persona ? this.persona.approachMps : 0.6;
    this.speed = Math.max(0.5, Math.min(1.5, 0.55 + approach * 0.9));
    this.energy = this.persona ? this.persona.energy : 50;
    this.comfort = this.persona ? this.persona.distanceM : 1.3;

    this.group = new THREE.Group();
    this.body = new THREE.Group(); // 揺れ・傾きはこちら（位置と向きは group）
    this.group.add(this.body);
    this.group.position.set(data.x, 0, data.z);
    this.dest = new THREE.Vector3(data.x, 0, data.z);
    this.heading = Math.random() * TAU;
    this.group.rotation.y = this.heading;

    this.swayAmp = 0.05;
    this.swayPeriod = 2400;
    this.target = { roll: 0, pitch: 0, lean: 0, hop: 0, yawOffset: 0 };
    this.cur = { roll: 0, pitch: 0, lean: 0, hop: 0, yawOffset: 0 };
    this.glow = 0.5;
    this.faceOther = false;
    this.other = null;
    this.busy = false;
    this.alive = true;
    this.greeted = new Map(); // aid -> 最後に挨拶した時刻

    // 足元の丸い影（光の計算をしない代わり）
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    this.shadow = shadow;
    this.group.add(shadow);

    // 名札
    const labelText = this.npc && this.npc.role ? `${this.name}（${this.npc.role}）` : this.name;
    const labelBg = this.mine ? "rgba(139,108,255,0.92)" : this.npc ? "rgba(255,196,64,0.95)" : "rgba(255,255,255,0.9)";
    this.label = this.makeSprite([labelText], { width: 512, height: 112, fontSize: 46, bg: labelBg, color: this.mine ? "#ffffff" : "#1c1630" }, 1.5);
    this.label.position.y = 1.55;
    this.group.add(this.label);

    // 当たり判定（タップ用。見えない球）
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.6;
    hit.userData.actor = this;
    this.hit = hit;
    this.group.add(hit);

    opts.scene.add(this.group);
    /** 頭のてっぺんの高さ（モデルを読んでから決まる）と、身につけている物 */
    this.headTop = 0.95;
    this.wear = data.wear || null;
    this.wearMesh = null;
    this.ready = this.loadModel().then(() => this.setWear(this.wear));
  }

  /** 頭のかざりを付け替える（null で外す）。お店で買った物（wear.mjs） */
  setWear(wear) {
    this.wear = wear || null;
    if (this.wearMesh) {
      this.body.remove(this.wearMesh);
      this.wearMesh.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      this.wearMesh = null;
    }
    // 帽子をかぶると名札が隠れないよう、少し上げる
    this.label.position.y = Math.max(1.55, this.headTop + (this.wear ? 0.62 : 0.4));
    if (!this.wear || !this.alive) return;
    const g = makeWear(this.THREE, this.wear);
    // 形ごとに決めた位置（makeWear の中）に、頭のてっぺんの高さを足す
    if (g.userData.face) g.position.set(0, this.headTop * 0.58, (this.faceZ || 0.42) + 0.02);
    else g.position.y += this.headTop - 0.06;
    this.wearMesh = g;
    this.body.add(g);
  }

  async loadModel() {
    const THREE = this.THREE;
    const model = await loadCharacter(THREE, this.species, this.color);
    if (!this.alive) return;
    if (model) {
      // モデルは中心が原点・幅1.3前後。足元が地面に付くように持ち上げ、少し小さくする
      const box = new THREE.Box3().setFromObject(model);
      const s = 0.78;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      this.body.add(model);
      this.headTop = (box.max.y - box.min.y) * s;
      // 顔の前の位置（メガネを掛ける所）。くちばしなどの出っぱりを見込んで少し手前
      this.faceZ = Math.max(0.25, box.max.z * s * 0.92);
    } else {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 14), new THREE.MeshLambertMaterial({ color: 0xffb3d0 }));
      ball.position.y = 0.45;
      this.body.add(ball);
    }
  }

  makeSprite(lines, opts, width) {
    const THREE = this.THREE;
    const tex = new THREE.CanvasTexture(textCanvas(lines, opts));
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    spr.scale.set(width, (width * opts.height) / opts.width, 1);
    spr.renderOrder = 10;
    return spr;
  }

  /** 頭の上に、しばらく吹き出しを出す（挨拶・スタンプ） */
  bubble(text, ms = 2600, kind = "say") {
    if (this.bubbleSprite) {
      this.group.remove(this.bubbleSprite);
      this.bubbleSprite.material.map.dispose();
      this.bubbleSprite.material.dispose();
    }
    // 長い言葉（分身どうしの会話）は折り返して、吹き出しを縦に伸ばす
    const lines = kind === "stamp" || String(text).length <= 12 ? [text] : wrapText(String(text), 13, 4);
    const height = 150 + (lines.length - 1) * 62;
    const spr = this.makeSprite(lines, { width: 512, height, fontSize: kind === "stamp" ? 78 : 44, bg: kind === "talk" ? "rgba(255,248,214,0.97)" : "rgba(255,255,255,0.96)", color: kind === "stamp" ? "#e8457a" : "#1c1630", radius: 60 }, 1.7);
    spr.position.y = 2.2 + (lines.length - 1) * 0.1;
    this.bubbleSprite = spr;
    this.group.add(spr);
    const mine = spr;
    setTimeout(() => {
      if (this.bubbleSprite === mine) {
        this.group.remove(mine);
        mine.material.map.dispose();
        mine.material.dispose();
        this.bubbleSprite = null;
      }
    }, ms);
  }

  setDestination(x, z) {
    this.dest.set(x, 0, z);
  }

  get position() {
    return this.group.position;
  }

  stepToward(other, dist) {
    const d = other.position.clone().sub(this.position);
    const len = d.length();
    const go = Math.max(0, Math.min(dist, len - this.comfort));
    if (go <= 0.05) return;
    d.normalize().multiplyScalar(go);
    this.dest.copy(this.position).add(d);
    this.onMoved?.(this.dest.x, this.dest.z);
  }

  stepAway(other, dist) {
    const d = this.position.clone().sub(other.position).normalize().multiplyScalar(dist);
    this.dest.copy(this.position).add(d);
    this.onMoved?.(this.dest.x, this.dest.z);
  }

  /** エンジンにイベントを渡して、その子らしく動かす（重ならないように1つずつ） */
  async act(event, arg) {
    if (!this.persona || this.busy) return false;
    this.busy = true;
    try {
      await dispatch(this.persona, new MetaDriver(this), event, arg);
    } finally {
      this.busy = false;
      this.faceOther = false;
    }
    return true;
  }

  get walking() {
    return this.position.distanceTo(this.dest) > 0.05;
  }

  /** 毎フレーム */
  update(dt, t) {
    const pos = this.position;
    const toDest = this.dest.clone().sub(pos);
    const dist = toDest.length();
    let walking = false;
    if (dist > 0.05) {
      walking = true;
      const step = Math.min(dist, this.speed * dt);
      toDest.normalize();
      pos.addScaledVector(toDest, step);
      this.heading = Math.atan2(toDest.x, toDest.z);
    } else if (this.faceOther && this.other) {
      const d = this.other.position.clone().sub(pos);
      this.heading = Math.atan2(d.x, d.z);
    }
    // 向きはなめらかに
    let dy = this.heading - this.group.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.group.rotation.y += dy * Math.min(1, dt * 8);

    // エンジンが置いた目標へ寄せる
    for (const k of Object.keys(this.cur)) this.cur[k] += (this.target[k] - this.cur[k]) * Math.min(1, dt * 12);

    const sway = walking ? 0 : Math.sin((t * 1000 * TAU) / this.swayPeriod) * this.swayAmp;
    // 歩くときは、元気な子ほど高く跳ねる
    const hopWalk = walking ? Math.abs(Math.sin(t * (8 + this.energy / 12))) * (0.05 + this.energy / 1200) : 0;
    this.body.rotation.z = sway + this.cur.roll;
    this.body.rotation.x = this.cur.pitch + this.cur.lean;
    this.body.rotation.y = this.cur.yawOffset;
    this.body.position.y = this.cur.hop + hopWalk;
    this.shadow.material.opacity = 0.12 + this.glow * 0.1;
  }

  dispose(scene) {
    this.alive = false;
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.isSprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}
