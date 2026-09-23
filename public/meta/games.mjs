/**
 * メタバースのミニゲーム（宝さがし・○×クイズ・スタンプラリー）。
 *
 * どれも「分身を歩かせて遊ぶ」形にしてある。自分の分身が主役で、クリアするとその子が
 * 自分の声で喜ぶ（人格の数値どおりの身振りつき）。
 *
 * **この端末の中だけで遊ぶ。** 点数・結果はサーバーへ送らない（入退室の記録を持たない方針と同じ）。
 * 自己ベストだけ、この端末に覚えておく。同じ部屋の他の子には、ゲームの星や旗は見えない。
 */

import { textCanvas } from "./world.mjs";

const BEST_KEY = (roomId, objId) => `sodatsukake_metaBest_${roomId}_${objId}`;

function loadBest(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
function saveBest(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* noop */
  }
}

/** 散らばらせる位置（屋台や真ん中の屋台前と重なりすぎないように、外周寄りに） */
function spots(count, half, avoid, rand = Math.random) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 60) {
    const x = (rand() * 2 - 1) * (half - 0.8);
    const z = (rand() * 2 - 1) * (half - 0.8);
    if (avoid.some((p) => Math.hypot(p.x - x, p.z - z) < 1.8)) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < 1.6)) continue;
    out.push({ x, z });
  }
  return out;
}

function labelSprite(THREE, text, color = "#2a2440", width = 1.2) {
  const tex = new THREE.CanvasTexture(textCanvas([text], { width: 256, height: 160, fontSize: 110, bg: "rgba(255,255,255,0.95)", color, radius: 70 }));
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  spr.scale.set(width, (width * 160) / 256, 1);
  return spr;
}

/**
 * ゲームの進行役。1度に1つだけ動かす。
 * ctx: { THREE, scene, roomId, catalog, me(): Actor|null, avoid: {x,z}[], hud, dialog, celebrate(text), onEnd() }
 */
export class GameRunner {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = null;
  }

  get running() {
    return !!this.active;
  }

  /** 屋台に来たときの案内。始めるかどうかを聞く */
  offer(item) {
    if (this.active) return;
    const o = item.obj;
    const best = loadBest(BEST_KEY(this.ctx.roomId, o.id));
    const desc = {
      treasure: `${o.seconds}秒で、星を${o.count}こ集めよう。分身を歩かせて、星にふれると拾えます。`,
      rally: `空間のあちこちにある旗（${o.points}本）を、ぜんぶまわろう。`,
      quiz: `問題は${o.questions?.length || 0}問。答えの場所（○か×）へ、分身を歩かせてね。`,
    }[o.type];
    const bestText =
      best === null ? "" : o.type === "treasure" ? `自己ベスト: 残り${best}秒` : o.type === "rally" ? `自己ベスト: ${best}秒` : `自己ベスト: ${best}問正解`;
    this.ctx.dialog({
      title: o.title,
      body: [o.text, desc, bestText].filter(Boolean).join("\n"),
      actions: [
        { label: "はじめる", primary: true, run: () => this.start(item) },
        { label: "やめておく", run: () => undefined },
      ],
    });
  }

  start(item) {
    const me = this.ctx.me();
    if (!me) {
      this.ctx.dialog({ title: item.obj.title, body: "遊ぶ分身を下のボタンから選んでね", actions: [{ label: "とじる" }] });
      return;
    }
    this.stop();
    const o = item.obj;
    const game = { item, obj: o, objects: [], startedAt: performance.now(), done: false };
    this.active = game;
    if (o.type === "treasure") this.startTreasure(game);
    else if (o.type === "rally") this.startRally(game);
    else if (o.type === "quiz") this.startQuiz(game);
  }

  stop() {
    const g = this.active;
    if (!g) return;
    for (const obj of g.objects) {
      this.ctx.scene.remove(obj);
      obj.traverse?.((n) => {
        n.geometry?.dispose?.();
        if (n.material) {
          n.material.map?.dispose?.();
          n.material.dispose?.();
        }
      });
    }
    clearInterval(g.timer);
    this.active = null;
    this.ctx.hud(null);
  }

  finish(result) {
    const g = this.active;
    if (!g || g.done) return;
    g.done = true;
    const o = g.obj;
    const key = BEST_KEY(this.ctx.roomId, o.id);
    const best = loadBest(key);
    let improved = false;
    if (result.clear && result.score !== undefined) {
      const better = o.type === "rally" ? best === null || result.score < best : best === null || result.score > best;
      if (better) {
        saveBest(key, result.score);
        improved = best !== null;
      }
    }
    if (result.clear) this.ctx.celebrate();
    this.stop();
    const lines = [result.summary];
    if (result.clear && o.clearMessage) lines.push(o.clearMessage);
    if (improved) lines.push("自己ベスト更新！");
    this.ctx.dialog({
      title: result.clear ? "クリア！" : "おしまい",
      body: lines.filter(Boolean).join("\n"),
      actions: [
        { label: "もう一回", primary: true, run: () => this.start(g.item) },
        { label: "とじる" },
      ],
    });
    this.ctx.onEnd?.();
  }

  // ---- 宝さがし ----
  startTreasure(game) {
    const { THREE, scene, catalog } = this.ctx;
    const o = game.obj;
    const geo = new THREE.OctahedronGeometry(0.28, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffd23f, emissive: 0xffb300, emissiveIntensity: 0.45 });
    const places = spots(o.count, catalog.worldHalf, this.ctx.avoid);
    game.stars = places.map((p, i) => {
      const star = new THREE.Mesh(geo, mat);
      star.position.set(p.x, 0.6, p.z);
      star.userData.phase = i;
      scene.add(star);
      game.objects.push(star);
      return star;
    });
    game.found = 0;
    game.total = game.stars.length;
    game.endsAt = performance.now() + o.seconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((game.endsAt - performance.now()) / 1000));
      this.ctx.hud(`★ ${game.found} / ${game.total}　のこり ${left}秒`);
      if (left <= 0) this.finish({ clear: false, summary: `${game.total}こ中 ${game.found}こ見つけたよ` });
    };
    tick();
    game.timer = setInterval(tick, 250);
    game.update = (t) => {
      const me = this.ctx.me();
      for (const s of game.stars) {
        if (!s.visible) continue;
        s.rotation.y = t * 2 + s.userData.phase;
        s.position.y = 0.6 + Math.sin(t * 3 + s.userData.phase) * 0.1;
        if (me && Math.hypot(me.position.x - s.position.x, me.position.z - s.position.z) < 0.85) {
          s.visible = false;
          game.found += 1;
          me.bubble("★", 700, "stamp");
          if (game.found >= game.total) {
            const left = Math.max(0, Math.ceil((game.endsAt - performance.now()) / 1000));
            this.finish({ clear: true, score: left, summary: `ぜんぶ見つけた！ のこり${left}秒` });
            return;
          }
        }
      }
    };
  }

  // ---- スタンプラリー ----
  startRally(game) {
    const { THREE, scene, catalog } = this.ctx;
    const o = game.obj;
    const places = spots(o.points, catalog.worldHalf, this.ctx.avoid);
    game.flags = places.map((p, i) => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      pole.position.y = 0.75;
      const flagMat = new THREE.MeshLambertMaterial({ color: 0x7fdc8a, side: THREE.DoubleSide });
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.38), flagMat);
      flag.position.set(0.3, 1.3, 0);
      const num = labelSprite(THREE, String(i + 1), "#2a8a4a", 0.55);
      num.position.y = 1.9;
      g.add(pole, flag, num);
      g.position.set(p.x, 0, p.z);
      g.userData = { flagMat, visited: false, flag };
      scene.add(g);
      game.objects.push(g);
      return g;
    });
    game.visited = 0;
    const tick = () => {
      const sec = Math.floor((performance.now() - game.startedAt) / 1000);
      this.ctx.hud(`旗 ${game.visited} / ${game.flags.length}　${sec}秒`);
    };
    tick();
    game.timer = setInterval(tick, 500);
    game.update = (t) => {
      const me = this.ctx.me();
      for (const f of game.flags) {
        f.userData.flag.rotation.y = Math.sin(t * 2 + f.position.x) * 0.3;
        if (f.userData.visited || !me) continue;
        if (Math.hypot(me.position.x - f.position.x, me.position.z - f.position.z) < 1.0) {
          f.userData.visited = true;
          f.userData.flagMat.color.set(0xffc94d);
          game.visited += 1;
          me.bubble(`${game.visited}こめ！`, 900, "stamp");
          tick();
          if (game.visited >= game.flags.length) {
            const sec = Math.max(1, Math.floor((performance.now() - game.startedAt) / 1000));
            this.finish({ clear: true, score: sec, summary: `ぜんぶまわった！ ${sec}秒` });
            return;
          }
        }
      }
    };
  }

  // ---- ○×クイズ ----
  startQuiz(game) {
    const { THREE, scene } = this.ctx;
    const o = game.obj;
    const sp = game.item.startPoint;
    // 屋台の前、左右に○と×の場所を置く（屋台から真ん中へ向かう線の、左と右）
    const toCenter = new THREE.Vector3(-sp.x, 0, -sp.z).normalize();
    const side = new THREE.Vector3(toCenter.z, 0, -toCenter.x);
    const mid = sp.clone().addScaledVector(toCenter, 1.8);
    const zone = (dir, color, mark) => {
      const center = mid.clone().addScaledVector(side, dir * 1.9);
      const disk = new THREE.Mesh(
        new THREE.CircleGeometry(1.4, 36),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false })
      );
      disk.rotation.x = -Math.PI / 2;
      disk.position.set(center.x, 0.03, center.z);
      const label = labelSprite(THREE, mark, mark === "○" ? "#2f6fd6" : "#d6452f", 1.1);
      label.position.set(center.x, 1.6, center.z);
      scene.add(disk, label);
      game.objects.push(disk, label);
      return { center, disk };
    };
    game.zones = { o: zone(1, 0x6fb8ff, "○"), x: zone(-1, 0xff8a7a, "×") };
    game.index = 0;
    game.correct = 0;
    const ask = () => {
      const q = o.questions[game.index];
      game.phase = "ask";
      game.deadline = performance.now() + 12000;
      game.tick = () => {
        if (game.phase !== "ask") return;
        const left = Math.max(0, Math.ceil((game.deadline - performance.now()) / 1000));
        this.ctx.hud(`Q${game.index + 1}/${o.questions.length}　${q.q}　（のこり${left}秒）`);
        if (left <= 0) judge();
      };
      game.tick();
    };
    const judge = () => {
      const q = o.questions[game.index];
      game.phase = "answer";
      const me = this.ctx.me();
      let chose = null;
      if (me) {
        for (const key of ["o", "x"]) {
          const z = game.zones[key].center;
          if (Math.hypot(me.position.x - z.x, me.position.z - z.z) < 1.6) chose = key;
        }
      }
      const ok = chose === q.a;
      if (ok) {
        game.correct += 1;
        me?.bubble("せいかい！", 1400, "stamp");
      } else {
        me?.bubble(chose ? "ざんねん" : "…？", 1400, "stamp");
      }
      const answerText = q.a === "o" ? "○" : "×";
      this.ctx.hud(`${ok ? "せいかい！" : chose ? "ざんねん" : "どちらにも入らなかった"}　答えは ${answerText}${q.note ? `：${q.note}` : ""}`);
      setTimeout(() => {
        if (this.active !== game) return;
        game.index += 1;
        if (game.index >= o.questions.length) {
          const all = game.correct === o.questions.length;
          this.finish({ clear: all, score: game.correct, summary: `${o.questions.length}問中 ${game.correct}問せいかい` });
        } else ask();
      }, 3200);
    };
    game.timer = setInterval(() => game.tick?.(), 250);
    ask();
    game.update = (t) => {
      for (const key of ["o", "x"]) game.zones[key].disk.material.opacity = 0.45 + Math.sin(t * 3 + (key === "o" ? 0 : 1.5)) * 0.12;
    };
  }

  update(dt, t) {
    this.active?.update?.(t);
  }
}
