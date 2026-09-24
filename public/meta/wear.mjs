/**
 * お店で買える物の見た目（three.js の基本図形だけで作る）。
 *
 *   makeWear(THREE, { shape, color })   頭のかざり（原点＝頭のてっぺん）
 *   spawnEffect(THREE, scene, pos, kind) 演出（花火・ハート・紙ふぶき・シャボン玉）。update(dt) が false を返したら終わり
 *
 * 形の種類は src/economy.ts の WEAR_SHAPES / EFFECT_KINDS と同じ。
 */

const TAU = Math.PI * 2;

function lambert(THREE, color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}

function starShape(THREE, outer, inner) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / 10) * TAU + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}

export function makeWear(THREE, wear) {
  const g = new THREE.Group();
  if (!wear || !wear.shape) return g;
  const c = new THREE.Color(wear.color || "#ff7aa8");
  const mat = lambert(THREE, c);
  switch (wear.shape) {
    case "ribbon": {
      for (const sx of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.2, 12), mat);
        wing.rotation.z = (sx * Math.PI) / 2;
        wing.position.x = sx * 0.1;
        g.add(wing);
      }
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), mat);
      g.add(knot);
      g.position.set(0.18, -0.02, 0.05);
      g.rotation.z = -0.35;
      break;
    }
    case "flower": {
      const center = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), lambert(THREE, 0x8a5a2b));
      center.scale.z = 0.5;
      g.add(center);
      for (let i = 0; i < 7; i++) {
        const petal = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat);
        const a = (i / 7) * TAU;
        petal.scale.set(1, 0.6, 0.3);
        petal.position.set(Math.cos(a) * 0.1, Math.sin(a) * 0.1, -0.01);
        petal.rotation.z = a;
        g.add(petal);
      }
      g.position.set(0.2, -0.04, 0.08);
      g.rotation.set(0, 0.4, -0.3);
      break;
    }
    case "leaf": {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.14, 6), lambert(THREE, 0x4f9a3a));
      stem.position.y = 0.07;
      g.add(stem);
      for (const sx of [-1, 1]) {
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), mat);
        leaf.scale.set(1, 0.18, 0.55);
        leaf.position.set(sx * 0.08, 0.15, 0);
        leaf.rotation.z = sx * 0.4;
        g.add(leaf);
      }
      break;
    }
    case "star": {
      const geo = new THREE.ExtrudeGeometry(starShape(THREE, 0.13, 0.055), { depth: 0.04, bevelEnabled: false });
      geo.translate(0, 0, -0.02);
      const star = new THREE.Mesh(geo, lambert(THREE, c, { emissive: c, emissiveIntensity: 0.35 }));
      star.position.set(0.14, 0.06, 0.06);
      star.rotation.z = -0.3;
      g.add(star);
      break;
    }
    case "strawhat": {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.03, 28), mat);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 10, 0, TAU, 0, Math.PI / 2), mat);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 24, 1, true), lambert(THREE, 0xd8443a, { side: THREE.DoubleSide }));
      band.position.y = 0.035;
      g.add(brim, crown, band);
      g.position.y = -0.06;
      g.rotation.x = -0.08;
      break;
    }
    case "tophat": {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 24), mat);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.32, 24), mat);
      tube.position.y = 0.16;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.172, 0.172, 0.06, 24, 1, true), lambert(THREE, 0xd8443a, { side: THREE.DoubleSide }));
      band.position.y = 0.05;
      g.add(brim, tube, band);
      g.position.y = -0.04;
      g.rotation.z = 0.12;
      break;
    }
    case "crown": {
      const gold = lambert(THREE, c, { emissive: c, emissiveIntensity: 0.25 });
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.2, 0.1, 24, 1, true), new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
      ring.position.y = 0.05;
      g.add(ring);
      const gems = [0xe8304a, 0x3f7bff, 0x3fbf5a];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 6), gold);
        spike.position.set(Math.cos(a) * 0.19, 0.16, Math.sin(a) * 0.19);
        g.add(spike);
        if (i % 2 === 0) {
          const gem = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), lambert(THREE, gems[i / 2]));
          gem.position.set(Math.cos(a) * 0.205, 0.05, Math.sin(a) * 0.205);
          g.add(gem);
        }
      }
      g.position.y = -0.04;
      break;
    }
    case "halo": {
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 10, 32), new THREE.MeshBasicMaterial({ color: c }));
      halo.rotation.x = Math.PI / 2;
      halo.position.y = 0.2;
      g.add(halo);
      g.userData.float = true;
      break;
    }
    // ---- 2026-09-24 追加の形 ----
    case "cat":
    case "bunny": {
      const inner = lambert(THREE, new THREE.Color(wear.shape === "cat" ? "#ffb3c8" : "#ffd0dc"));
      for (const sx of [-1, 1]) {
        const ear = new THREE.Group();
        if (wear.shape === "cat") {
          const outer = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 4), mat);
          outer.rotation.y = Math.PI / 4;
          const pink = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.12, 4), inner);
          pink.rotation.y = Math.PI / 4;
          pink.position.set(0, -0.02, 0.035);
          ear.add(outer, pink);
          ear.position.set(sx * 0.17, 0.05, 0);
          ear.rotation.z = -sx * 0.25;
        } else {
          const outer = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.28, 4, 10), mat);
          const pink = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.22, 4, 8), inner);
          pink.position.z = 0.035;
          ear.add(outer, pink);
          ear.position.set(sx * 0.1, 0.18, -0.02);
          ear.rotation.z = -sx * 0.18;
        }
        g.add(ear);
      }
      g.position.y = -0.03;
      break;
    }
    case "beret": {
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 10), mat);
      top.scale.set(1, 0.32, 1);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.06, 6), mat);
      stem.position.y = 0.09;
      g.add(top, stem);
      g.position.set(0.04, 0.0, 0);
      g.rotation.z = -0.22;
      break;
    }
    case "cap": {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 10, 0, TAU, 0, Math.PI / 2), mat);
      const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20, 1, false, -Math.PI / 2, Math.PI), mat);
      visor.scale.z = 1.3;
      visor.position.set(0, 0.0, 0.14);
      const button = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), lambert(THREE, 0xffffff));
      button.position.y = 0.22;
      g.add(dome, visor, button);
      g.position.y = -0.06;
      break;
    }
    case "witch": {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.025, 28), mat);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.5, 20), mat);
      cone.position.set(0, 0.25, -0.02);
      cone.rotation.x = -0.25;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.05, 20, 1, true), lambert(THREE, 0xb58cff, { side: THREE.DoubleSide }));
      band.position.y = 0.03;
      g.add(brim, cone, band);
      g.position.y = -0.05;
      break;
    }
    case "santa": {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.36, 18), mat);
      cone.position.set(0.04, 0.16, 0);
      cone.rotation.z = -0.5;
      const fur = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 24), lambert(THREE, 0xffffff));
      fur.rotation.x = Math.PI / 2;
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), lambert(THREE, 0xffffff));
      pom.position.set(0.2, 0.26, 0);
      g.add(cone, fur, pom);
      g.position.y = -0.04;
      break;
    }
    case "oni": {
      for (const sx of [-1, 1]) {
        const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 10), mat);
        horn.position.set(sx * 0.12, 0.06, 0.03);
        horn.rotation.z = -sx * 0.3;
        g.add(horn);
      }
      break;
    }
    case "kanzashi": {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 6), lambert(THREE, 0x8a5a2b));
      stick.rotation.z = 1.1;
      g.add(stick);
      for (let k = 0; k < 3; k++) {
        const fl = new THREE.Group();
        for (let i = 0; i < 5; i++) {
          const petal = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), mat);
          const a = (i / 5) * TAU;
          petal.scale.set(1, 0.7, 0.35);
          petal.position.set(Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0);
          fl.add(petal);
        }
        const heart = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), lambert(THREE, 0xffe066));
        fl.add(heart);
        fl.position.set(0.1 + k * 0.03, 0.02 - k * 0.07, 0.05);
        g.add(fl);
      }
      g.position.set(0.12, -0.05, 0.02);
      break;
    }
    case "headphones": {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.025, 8, 24, Math.PI), mat);
      band.position.y = -0.12;
      g.add(band);
      for (const sx of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 16), mat);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(sx * 0.25, -0.14, 0);
        const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14), lambert(THREE, 0x2a2440));
        pad.rotation.z = Math.PI / 2;
        pad.position.set(sx * 0.215, -0.14, 0);
        g.add(cup, pad);
      }
      break;
    }
    case "glasses": {
      const frame = lambert(THREE, c);
      for (const sx of [-1, 1]) {
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.012, 8, 24), frame);
        rim.position.set(sx * 0.1, 0, 0);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.07, 20), new THREE.MeshBasicMaterial({ color: 0xdff4ff, transparent: true, opacity: 0.35 }));
        lens.position.set(sx * 0.1, 0, 0.002);
        g.add(rim, lens);
      }
      const bridge = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.06, 6), frame);
      bridge.rotation.z = Math.PI / 2;
      g.add(bridge);
      // 目の高さ・顔の前に出す（頭のてっぺんより下）
      g.userData.face = true;
      break;
    }
    default:
      break;
  }
  return g;
}

function heartCanvas() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#ff5a8a";
  g.font = "56px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("♥", 32, 36);
  return c;
}

/** 演出を1回出す。戻り値の update(dt) が false を返したら、dispose() して捨てる */
export function spawnEffect(THREE, scene, pos, kind) {
  const root = new THREE.Group();
  root.position.copy(pos);
  scene.add(root);
  const parts = [];
  let life = 0;
  let total = 2.4;
  const colors = [0xff5a7a, 0xffd23f, 0x5aa9ff, 0x7fdc8a, 0xb58cff, 0xff9f40];

  if (kind === "hanabi") {
    total = 2.6;
    const count = 90;
    const pos3 = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const vel = [];
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const th = Math.random() * TAU;
      const ph = Math.acos(Math.random() * 2 - 1);
      const sp = 2.2 + Math.random() * 1.2;
      vel.push([Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp]);
      c.setHex(colors[i % colors.length]);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos3, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.position.y = 3.2;
    root.add(pts);
    parts.push({
      update(t) {
        const p = geo.attributes.position;
        const k = Math.max(0, t - 0.35);
        for (let i = 0; i < count; i++) {
          const [vx, vy, vz] = vel[i];
          p.setXYZ(i, vx * k, vy * k - 1.6 * k * k, vz * k);
        }
        p.needsUpdate = true;
        pts.position.y = t < 0.35 ? 0.8 + (t / 0.35) * 2.4 : 3.2;
        mat.opacity = t < 0.35 ? 0.9 : Math.max(0, 1 - (t - 1.4) / 1.2);
        mat.size = t < 0.35 ? 0.3 : 0.16;
      },
    });
  } else if (kind === "hearts") {
    const tex = new THREE.CanvasTexture(heartCanvas());
    for (let i = 0; i < 9; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      const ox = (Math.random() - 0.5) * 1.2;
      const oz = (Math.random() - 0.5) * 1.2;
      const delay = Math.random() * 0.8;
      spr.scale.setScalar(0.35);
      root.add(spr);
      parts.push({
        update(t) {
          const k = Math.max(0, t - delay);
          spr.position.set(ox + Math.sin(k * 3 + i) * 0.15, 1 + k * 1.1, oz);
          spr.material.opacity = k <= 0 ? 0 : Math.max(0, 1 - k / 1.6);
        },
      });
    }
  } else if (kind === "confetti") {
    const geo = new THREE.PlaneGeometry(0.08, 0.12);
    for (let i = 0; i < 70; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide, transparent: true }));
      const ox = (Math.random() - 0.5) * 2.4;
      const oz = (Math.random() - 0.5) * 2.4;
      const sp = 0.8 + Math.random() * 0.7;
      const spin = (Math.random() - 0.5) * 12;
      root.add(m);
      parts.push({
        update(t) {
          m.position.set(ox + Math.sin(t * 2 + i) * 0.2, 3.2 - t * sp * 1.3, oz);
          m.rotation.set(t * spin, t * spin * 0.7, 0);
          m.material.opacity = Math.max(0, 1 - Math.max(0, t - 1.6) / 0.8);
        },
      });
    }
  } else if (kind === "sakura" || kind === "snow" || kind === "stars") {
    total = 3;
    const cols = kind === "sakura" ? [0xffb3cf, 0xffc8dc, 0xff9ec0] : kind === "snow" ? [0xffffff, 0xeaf4ff] : [0xffe14d, 0xfff3a0, 0xffd23f];
    const geo = kind === "stars" ? new THREE.OctahedronGeometry(0.06, 0) : kind === "snow" ? new THREE.SphereGeometry(0.045, 6, 5) : new THREE.CircleGeometry(0.06, 5);
    for (let i = 0; i < 60; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, transparent: true }));
      const ox = (Math.random() - 0.5) * 3;
      const oz = (Math.random() - 0.5) * 3;
      const sp = 0.6 + Math.random() * 0.6;
      const ph = Math.random() * TAU;
      const delay = Math.random() * 0.8;
      root.add(m);
      parts.push({
        update(t) {
          const k = Math.max(0, t - delay);
          m.visible = t > delay;
          m.position.set(ox + Math.sin(k * 1.6 + ph) * (kind === "snow" ? 0.15 : 0.35), 3.4 - k * sp * 1.2, oz + Math.cos(k * 1.3 + ph) * 0.2);
          m.rotation.set(k * 3 + ph, k * 2, 0);
          m.material.opacity = Math.max(0, 1 - Math.max(0, k - 1.8) / 0.8);
        },
      });
    }
  } else if (kind === "notes") {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g2 = c.getContext("2d");
    g2.font = "52px sans-serif";
    g2.textAlign = "center";
    g2.textBaseline = "middle";
    g2.fillStyle = "#7c5cff";
    g2.fillText("♪", 32, 34);
    const tex = new THREE.CanvasTexture(c);
    for (let i = 0; i < 10; i++) {
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, color: new THREE.Color(colors[i % colors.length]) }));
      const a = (i / 10) * TAU;
      const delay = (i / 10) * 0.8;
      spr.scale.setScalar(0.32);
      root.add(spr);
      parts.push({
        update(t) {
          const k = Math.max(0, t - delay);
          spr.position.set(Math.cos(a + k) * (0.5 + k * 0.2), 1 + k * 0.9, Math.sin(a + k) * (0.5 + k * 0.2));
          spr.material.opacity = k <= 0 ? 0 : Math.max(0, 1 - k / 1.7);
        },
      });
    }
  } else {
    // bubbles
    for (let i = 0; i < 14; i++) {
      const b = new THREE.Mesh(
        new THREE.SphereGeometry(0.08 + Math.random() * 0.08, 14, 10),
        new THREE.MeshLambertMaterial({ color: 0xbfefff, transparent: true, opacity: 0.55, emissive: 0x4ab8e8, emissiveIntensity: 0.25, depthWrite: false })
      );
      const ox = (Math.random() - 0.5) * 1.4;
      const oz = (Math.random() - 0.5) * 1.4;
      const delay = Math.random() * 0.9;
      root.add(b);
      parts.push({
        update(t) {
          const k = Math.max(0, t - delay);
          b.position.set(ox + Math.sin(k * 2 + i) * 0.2, 0.6 + k * 1.2, oz + Math.cos(k * 2 + i) * 0.1);
          b.visible = k > 0;
          b.material.opacity = Math.max(0, 0.55 - Math.max(0, k - 1.2) * 0.5);
        },
      });
    }
  }

  return {
    update(dt) {
      life += dt;
      for (const p of parts) p.update(life);
      return life < total;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          o.material.map?.dispose?.();
          o.material.dispose?.();
        }
      });
    },
  };
}
