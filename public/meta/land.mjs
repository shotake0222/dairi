/**
 * 区画に置いた物（広告・デジタルランドマーク）と、「販売中」の目印を空間に立てる。
 * 中身は運営が承認したもの（src/land.ts）。広告には必ず「広告」、ランドマークには「提供: ○○」を付ける。
 *
 * タップしたときの詳細（QRコード・リンク・クーポン）は app.mjs の openAdDetail で出す。
 */

import { textCanvas, wrapText } from "./world.mjs";

function tex(THREE, canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sprite(THREE, lines, opts, width) {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(THREE, textCanvas(lines, opts)), transparent: true }));
  spr.scale.set(width, (width * opts.height) / opts.width, 1);
  return spr;
}

const mat = (THREE, color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });

/** ランドマークの形 */
function landmarkModel(THREE, model, colorHex) {
  const c = new THREE.Color(colorHex);
  const main = mat(THREE, c);
  const stone = mat(THREE, 0xd8d2c4);
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.25, 20), stone);
  base.position.y = 0.12;
  g.add(base);
  if (model === "tower") {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 0.9), main);
    body.position.y = 1.85;
    const clock = new THREE.Mesh(new THREE.CircleGeometry(0.32, 20), mat(THREE, 0xffffff));
    clock.position.set(0, 2.9, 0.46);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.75, 0.9, 4), mat(THREE, 0x3a3440));
    roof.position.y = 3.9;
    roof.rotation.y = Math.PI / 4;
    g.add(body, clock, roof);
  } else if (model === "torii") {
    for (const sx of [-0.8, 0.8]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.4, 10), main);
      p.position.set(sx, 1.3, 0);
      g.add(p);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.18, 0.26), mat(THREE, 0x3a2a2a));
    top.position.y = 2.55;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.18), main);
    beam.position.y = 2.1;
    g.add(top, beam);
  } else if (model === "tree") {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 1.8, 10), mat(THREE, 0x8a5a3b));
    trunk.position.y = 1.1;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 1), mat(THREE, c, { flatShading: true }));
    crown.position.y = 2.6;
    g.add(trunk, crown);
  } else if (model === "fountain") {
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.8, 0.45, 24), main);
    bowl.position.y = 0.45;
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.85, 24), new THREE.MeshLambertMaterial({ color: 0x8fd6ff, emissive: 0x3a8ab0, emissiveIntensity: 0.3 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.69;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.1, 10), main);
    col.position.y = 1.2;
    const jet = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), new THREE.MeshLambertMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.7 }));
    jet.position.y = 1.85;
    jet.userData.bob = true;
    g.add(bowl, water, col, jet);
  } else if (model === "balloon") {
    const bal = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 16), main);
    bal.scale.y = 1.15;
    bal.position.y = 3.2;
    bal.userData.bob = true;
    const basket = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), mat(THREE, 0x8a5a3b));
    basket.position.y = 1.8;
    basket.userData.bob = true;
    g.add(bal, basket);
  } else if (model === "lantern") {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.6, 8), stone);
    post.position.y = 1.05;
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.8), mat(THREE, c, { emissive: c, emissiveIntensity: 0.45 }));
    light.position.y = 2.15;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.5, 4), stone);
    cap.rotation.y = Math.PI / 4;
    cap.position.y = 2.7;
    g.add(post, light, cap);
  } else if (model === "statue") {
    const ped = new THREE.Mesh(new THREE.BoxGeometry(1, 0.8, 1), stone);
    ped.position.y = 0.6;
    const egg = new THREE.Mesh(new THREE.SphereGeometry(0.6, 20, 16), mat(THREE, c, { emissive: c, emissiveIntensity: 0.15 }));
    egg.scale.y = 1.3;
    egg.position.y = 1.75;
    g.add(ped, egg);
  } else {
    const stele = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.2, 0.35), main);
    stele.position.y = 1.35;
    g.add(stele);
  }
  return g;
}

/**
 * @returns {{ items, hitTargets, update(t), dispose() }}
 */
export function buildPlacements(THREE, scene, placements, plotsForSale, catalog) {
  const spots = catalog.landSpots || [];
  const colors = catalog.landmarkColors || [];
  const items = [];
  const spotOf = (id) => spots.find((s) => s.id === id);

  for (const p of placements || []) {
    const s = spotOf(p.spot);
    if (!s) continue;
    const root = new THREE.Group();
    root.position.set(s.x, 0, s.z);
    root.rotation.y = Math.atan2(-s.x, -s.z);
    scene.add(root);
    const item = { kind: p.kind, placement: p, root, hits: [] };
    const c = p.content || {};
    if (p.kind === "landmark") {
      const hex = (colors.find((x) => x.id === c.color) || { hex: "#e8b93a" }).hex;
      const model = landmarkModel(THREE, c.model, hex);
      root.add(model);
      const plaque = sprite(THREE, [c.plaque || c.title || "", `提供: ${c.sponsor || ""}`], { width: 512, height: 190, fontSize: 52, bg: "rgba(255,253,245,0.95)", color: "#3a3020", radius: 40 }, 1.7);
      plaque.position.y = model.children.some((m) => m.position.y > 3) ? 4.6 : 3.4;
      root.add(plaque);
      model.traverse((m) => {
        if (m.isMesh) {
          m.userData.item = item;
          item.hits.push(m);
        }
      });
      plaque.userData.item = item;
      item.hits.push(plaque);
      item.model = model;
    } else {
      // 広告看板（区画用・小さめ）。「広告」の札は必ず付ける
      const w = 2.4;
      const h = 1.4;
      const dark = mat(THREE, 0x2a2440);
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.08), dark);
      frame.position.y = h / 2 + 0.8;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8), dark);
      post.position.y = 0.45;
      const face = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), face);
      plane.position.set(0, h / 2 + 0.8, 0.05);
      const draw = () => {
        face.map?.dispose();
        face.map = tex(THREE, textCanvas([c.title || "", ...wrapText(c.text || "", 12, 3)].filter(Boolean), { width: 768, height: 450, fontSize: 56, bg: "#fffdf7", radius: 8, color: "#2a2440" }));
        face.needsUpdate = true;
      };
      if (c.imageUrl) {
        draw();
        new THREE.TextureLoader().setCrossOrigin("anonymous").load(
          c.imageUrl,
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            face.map?.dispose();
            face.map = t;
            face.needsUpdate = true;
          },
          undefined,
          draw
        );
      } else draw();
      const tag = sprite(THREE, ["広告"], { width: 256, height: 110, fontSize: 60, bg: "rgba(40,36,64,0.92)", color: "#ffffff", radius: 30 }, 0.55);
      tag.position.set(-w / 2 + 0.25, h + 1.0, 0.1);
      root.add(frame, post, plane, tag);
      if (c.couponCode) {
        const cp = sprite(THREE, ["🎟 クーポンあり"], { width: 420, height: 110, fontSize: 52, bg: "rgba(255,90,90,0.95)", color: "#ffffff", radius: 50 }, 1.2);
        cp.position.set(0.5, h + 1.05, 0.1);
        root.add(cp);
        cp.userData.item = item;
        item.hits.push(cp);
      }
      plane.userData.item = item;
      frame.userData.item = item;
      item.hits.push(plane, frame);
    }
    items.push(item);
  }

  // 販売中の目印（空いている区画。タップで申込ページへ）
  for (const f of plotsForSale || []) {
    const s = spotOf(f.spot);
    if (!s) continue;
    const root = new THREE.Group();
    root.position.set(s.x, 0, s.z);
    scene.add(root);
    const ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.8, 1.0, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })
    );
    ringMesh.rotation.x = -Math.PI / 2;
    ringMesh.position.y = 0.03;
    const sign = sprite(THREE, ["広告 募集中"], { width: 400, height: 110, fontSize: 54, bg: "rgba(255,210,63,0.95)", color: "#3a3020", radius: 40 }, 1.2);
    sign.position.y = 1.2;
    root.add(ringMesh, sign);
    const item = { kind: "forsale", plot: f, root, hits: [sign, ringMesh], ring: ringMesh };
    sign.userData.item = item;
    ringMesh.userData.item = item;
    items.push(item);
  }

  return {
    items,
    hitTargets: items.flatMap((i) => i.hits),
    update(t) {
      for (const i of items) {
        if (i.ring) i.ring.material.opacity = 0.45 + Math.sin(t * 2.5) * 0.25;
        i.model?.traverse((m) => {
          if (m.userData.bob) m.position.y += Math.sin(t * 1.5) * 0.002;
        });
      }
    },
    dispose() {
      for (const i of items) {
        scene.remove(i.root);
        i.root.traverse((o) => {
          o.geometry?.dispose?.();
          const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          for (const m of mats) {
            m.map?.dispose?.();
            m.dispose?.();
          }
        });
      }
    },
  };
}
