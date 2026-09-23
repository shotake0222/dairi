/**
 * メタバースの「場所」と「時間帯」を組み立てる。
 *
 * どれも three.js の基本図形だけで作る（外部の3D素材を読まない）。スマホで軽く動くことを優先して:
 *   - 影は計算しない（キャラの足元に丸い影を置くだけ）
 *   - 光は2つ（空からの光と、太陽／月）。材質は Lambert（安い）
 *   - 草・花・星などの細かい物は、少数を InstancedMesh でまとめて描く
 *
 * 場所: meadow（草原）/ room（おへや）/ shrine（境内）/ beach（海辺）/ hill（夜空の丘）
 *       sakura（桜の神社）/ garden（和の庭園）/ onsen（温泉街）/ bamboo（竹林）/ momiji（紅葉の山寺）
 *       matsuri（夏祭りの参道）/ snow（雪の里）/ lake（星降る湖）/ forest（森のひろば）/ flower（花畑）
 *       castle（お城の城下町）/ tanabata（七夕の笹かざり）/ paddy（田んぼのあぜ道）/ inari（千本鳥居）
 *       harbor（港町の灯台）/ desert（砂丘のオアシス）/ candy（おかしの国）/ moon（月面ステーション）
 *       undersea（海の底）/ park（ゆうえんち）
 * 時間: morning / day / evening / night
 */

const TIME_LOOK = {
  morning: { sky: 0xcfe6ff, fog: 0xe8f0ff, hemi: [0xffffff, 0xb9d6a0, 0.85], sun: [0xfff1d6, 0.9], sunPos: [-6, 5, 4] },
  day: { sky: 0x8fcfff, fog: 0xcfeaff, hemi: [0xffffff, 0xa6c98a, 1.0], sun: [0xffffff, 1.1], sunPos: [4, 10, 6] },
  evening: { sky: 0xffb38a, fog: 0xffd2b0, hemi: [0xffe0c8, 0x8a6a5a, 0.75], sun: [0xff9a5c, 1.0], sunPos: [-8, 3, -2] },
  // 夜: 空は暗く、でも分身ははっきり見えるように（2026-09-23 修正。以前は光が弱く、夜空の丘で分身が黒く沈んでいた）
  night: { sky: 0x1a2250, fog: 0x283266, hemi: [0xc4ceff, 0x56608f, 1.15], sun: [0xe0e8ff, 0.95], sunPos: [5, 8, 4] },
};

function mat(THREE, color, extra = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}

function scatter(rand, count, half, avoidR = 3.2) {
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 20) {
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    if (Math.hypot(x, z) < avoidR) continue; // 真ん中は空けておく（キャラが集まる場所）
    out.push([x, z]);
  }
  return out;
}

/** 毎回同じ配置にするための乱数（場所ごとに種を固定） */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function tree(THREE, x, z, s = 1, leaf = 0x5fbf6a) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * s, 0.16 * s, 0.9 * s, 8), mat(THREE, 0x8a5a3b));
  trunk.position.y = 0.45 * s;
  const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.7 * s, 1), mat(THREE, leaf, { flatShading: true }));
  crown.position.y = 1.35 * s;
  g.add(trunk, crown);
  g.position.set(x, 0, z);
  return g;
}

function lantern(THREE, x, z, night) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), mat(THREE, 0x6b4a36));
  post.position.y = 0.55;
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.34, 0.3),
    new THREE.MeshLambertMaterial({ color: 0xfff1c8, emissive: night ? 0xffc36b : 0x000000, emissiveIntensity: night ? 0.9 : 0 })
  );
  lamp.position.y = 1.25;
  g.add(post, lamp);
  g.position.set(x, 0, z);
  return g;
}

function ground(THREE, size, color) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(size, 48), mat(THREE, color));
  m.rotation.x = -Math.PI / 2;
  m.name = "ground";
  return m;
}

function stars(THREE, count, radius) {
  const rand = seeded(7);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const th = rand() * Math.PI * 2;
    const ph = Math.acos(rand() * 0.9);
    pos[i * 3] = radius * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = radius * Math.cos(ph) + 2;
    pos[i * 3 + 2] = radius * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, sizeAttenuation: true }));
}

function flowers(THREE, rand, count, half, night) {
  const colors = [0xff8fb0, 0xffe066, 0xffffff, 0xb49bff];
  const geo = new THREE.SphereGeometry(0.07, 6, 4);
  const group = new THREE.Group();
  colors.forEach((c, ci) => {
    const pts = scatter(rand, Math.floor(count / colors.length), half, 2.5);
    const inst = new THREE.InstancedMesh(geo, mat(THREE, c, night ? { emissive: c, emissiveIntensity: 0.15 } : {}), pts.length);
    const m = new THREE.Matrix4();
    pts.forEach(([x, z], i) => inst.setMatrixAt(i, m.makeTranslation(x, 0.07, z)));
    group.add(inst);
    void ci;
  });
  return group;
}

function buildMeadow(THREE, root, night) {
  root.add(ground(THREE, 30, night ? 0x2f5a3a : 0x86cf6a));
  const rand = seeded(11);
  for (const [x, z] of scatter(rand, 16, 13, 7)) root.add(tree(THREE, x, z, 0.8 + rand() * 0.6, night ? 0x2f7a45 : 0x5fbf6a));
  root.add(flowers(THREE, rand, 80, 9, night));
}

function buildRoom(THREE, root, night) {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), mat(THREE, 0xd9b48a));
  floor.rotation.x = -Math.PI / 2;
  floor.name = "ground";
  root.add(floor);
  const wallMat = mat(THREE, night ? 0x8f86b8 : 0xfff3e6);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(20, 6), wallMat);
  back.position.set(0, 3, -10);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(20, 6), wallMat);
  left.position.set(-10, 3, 0);
  left.rotation.y = Math.PI / 2;
  const right = left.clone();
  right.position.x = 10;
  right.rotation.y = -Math.PI / 2;
  root.add(back, left, right);
  // 窓（夜は明かりの色、昼は空の色）
  const win = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 2),
    new THREE.MeshBasicMaterial({ color: night ? 0x2a3470 : 0xbfe6ff })
  );
  win.position.set(-9.98, 3.2, -3);
  win.rotation.y = Math.PI / 2;
  root.add(win);
  const rug = new THREE.Mesh(new THREE.CircleGeometry(4.5, 40), mat(THREE, 0xf2a7b8));
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.01;
  root.add(rug);
  // 小さな机と、クッション
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.12, 24), mat(THREE, 0xb07a4f));
  table.position.set(5.5, 0.55, -5);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 8), mat(THREE, 0x8a5a3b));
  leg.position.set(5.5, 0.25, -5);
  root.add(table, leg);
  [[-5, -6, 0x9fd3ff], [-6.5, 4, 0xffe38a], [6, 5, 0xb9f0b0]].forEach(([x, z, c]) => {
    const cushion = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 10), mat(THREE, c));
    cushion.scale.y = 0.4;
    cushion.position.set(x, 0.22, z);
    root.add(cushion);
  });
}

function torii(THREE, z) {
  const red = mat(THREE, 0xd8443a);
  const g = new THREE.Group();
  for (const sx of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.2, 12), red);
    pillar.position.set(sx * 1.6, 1.6, 0);
    g.add(pillar);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.25, 0.35), mat(THREE, 0x3a2a2a));
  top.position.y = 3.3;
  const beam = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.18, 0.25), red);
  beam.position.y = 2.7;
  g.add(top, beam);
  g.position.z = z;
  return g;
}

function buildShrine(THREE, root, night) {
  root.add(ground(THREE, 30, night ? 0x4a4a55 : 0xd8d2c4));
  const path = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 22), mat(THREE, night ? 0x5c5a64 : 0xbfb6a4));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.01;
  root.add(path);
  root.add(torii(THREE, 6.5));
  const rand = seeded(23);
  for (const [x, z] of scatter(rand, 10, 13, 6)) root.add(tree(THREE, x, z, 1 + rand() * 0.5, night ? 0x234a33 : 0x3f8f55));
  for (const z of [-5, -1, 3]) {
    root.add(lantern(THREE, -2.2, z, night));
    root.add(lantern(THREE, 2.2, z, night));
  }
}

function buildBeach(THREE, root, night) {
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(40, 22), mat(THREE, night ? 0x8a7f6a : 0xf3dfb0));
  sand.rotation.x = -Math.PI / 2;
  sand.position.z = 3;
  sand.name = "ground";
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 20, 40, 10),
    new THREE.MeshLambertMaterial({ color: night ? 0x1f3f7a : 0x4fb3e8, transparent: true, opacity: 0.92 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, 0.02, -17);
  sea.name = "sea";
  root.add(sand, sea);
  // パラソル
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 8), mat(THREE, 0xffffff));
  pole.position.set(5, 1.1, 2);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.6, 12), mat(THREE, 0xff7a7a));
  shade.position.set(5, 2.3, 2);
  root.add(pole, shade);
  const rand = seeded(31);
  for (const [x, z] of scatter(rand, 8, 10, 4)) {
    if (z < -3) continue;
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), mat(THREE, 0xffd6e0));
    shell.scale.y = 0.5;
    shell.position.set(x, 0.05, z);
    root.add(shell);
  }
}

function buildHill(THREE, root, night) {
  // 丘の頂上を y=0（分身が立つ高さ）に合わせる。以前は頂上が y=2.2 にあり、分身が丘の中に埋もれて見えなかった
  // （「夜空の丘が黒すぎて、キャラが見えない」の本当の原因。2026-09-23 修正）
  const hill = new THREE.Mesh(new THREE.SphereGeometry(120, 72, 16, 0, Math.PI * 2, 0, 0.17), mat(THREE, night ? 0x3f7462 : 0x6fbf73));
  hill.position.y = -120;
  hill.name = "ground";
  root.add(hill);
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 24, 16),
    new THREE.MeshBasicMaterial({ color: night ? 0xfff6cf : 0xffffff })
  );
  moon.position.set(-12, 11, -22);
  root.add(moon);
  const rand = seeded(41);
  for (const [x, z] of scatter(rand, 6, 13, 8)) root.add(tree(THREE, x, z, 0.9, night ? 0x1f5a3c : 0x4fa65a));
  root.add(flowers(THREE, rand, 40, 8, night));
}

// ---------------------------------------------------------------- 2026-09-23 追加の10か所（和風中心）

/** ひらひら落ちる粒（花びら・紅葉・雪）。anims に毎フレームの動きを足す */
function fallingPoints(THREE, anims, { color, count = 120, size = 0.12, speed = 0.4, spread = 12, height = 7, sway = 0.6 }) {
  const rand = seeded(97 + count);
  const pos = new Float32Array(count * 3);
  const base = [];
  for (let i = 0; i < count; i++) {
    const x = (rand() * 2 - 1) * spread;
    const z = (rand() * 2 - 1) * spread;
    const y = rand() * height;
    base.push([x, y, z, rand() * 6, 0.6 + rand() * 0.8]);
    pos.set([x, y, z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity: 0.9 }));
  anims.push((t) => {
    const p = geo.attributes.position;
    base.forEach(([x, y, z, ph, sp], i) => {
      const yy = height - ((height - y + t * speed * sp) % height);
      p.setXYZ(i, x + Math.sin(t * 0.8 + ph) * sway, yy, z + Math.cos(t * 0.6 + ph) * sway * 0.6);
    });
    p.needsUpdate = true;
  });
  return pts;
}

/** 立ちのぼる湯気 */
function steam(THREE, anims, x, z, count = 18) {
  const rand = seeded(Math.round(x * 13 + z * 7 + 101));
  const pos = new Float32Array(count * 3);
  const base = [];
  for (let i = 0; i < count; i++) base.push([x + (rand() - 0.5) * 1.2, z + (rand() - 0.5) * 1.2, rand() * 3]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.5, transparent: true, opacity: 0.35, depthWrite: false }));
  anims.push((t) => {
    const p = geo.attributes.position;
    base.forEach(([bx, bz, ph], i) => {
      const k = (t * 0.35 + ph) % 3;
      p.setXYZ(i, bx + Math.sin(t + ph) * 0.2, 0.3 + k * 0.9, bz);
    });
    p.needsUpdate = true;
  });
  return pts;
}

/** 屋根つきの建物（拝殿・家・お寺） */
function hall(THREE, { x, z, w = 4, d = 3, h = 2, wall = 0xf2e6d0, roof = 0x3a3440, rot = 0 }) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(THREE, wall));
  body.position.y = h / 2;
  const top = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.8, 4), mat(THREE, roof, { flatShading: true }));
  top.rotation.y = Math.PI / 4;
  top.scale.z = d / w;
  top.position.y = h + h * 0.4;
  g.add(body, top);
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  return g;
}

function stoneLantern(THREE, x, z, night) {
  const g = new THREE.Group();
  const grey = mat(THREE, 0xa7a39a);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.2, 8), grey);
  base.position.y = 0.1;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.7, 8), grey);
  post.position.y = 0.55;
  const light = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.3, 0.34),
    new THREE.MeshLambertMaterial({ color: 0xe8e2d0, emissive: night ? 0xffc36b : 0x000000, emissiveIntensity: night ? 0.8 : 0 })
  );
  light.position.y = 1.05;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.25, 4), grey);
  cap.position.y = 1.32;
  cap.rotation.y = Math.PI / 4;
  g.add(base, post, light, cap);
  g.position.set(x, 0, z);
  return g;
}

function chochin(THREE, x, y, z, color = 0xff5a4a) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.7 }));
  m.scale.y = 1.25;
  m.position.set(x, y, z);
  return m;
}

/** 外周に並べる（真ん中と置き場所を空ける） */
function ring(rand, count, rMin, rMax) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.3;
    const r = rMin + rand() * (rMax - rMin);
    out.push([Math.sin(a) * r, Math.cos(a) * r]);
  }
  return out;
}

function buildSakura(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x4c4a5c : 0xd9d0c2));
  const path = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 24), mat(THREE, night ? 0x5c5a66 : 0xc4b8a4));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.01;
  root.add(path);
  root.add(torii(THREE, 7.5));
  root.add(hall(THREE, { x: 0, z: -12, w: 6, d: 4, h: 2.4, wall: 0xf6efe2, roof: 0x5a3a2e }));
  const rand = seeded(61);
  for (const [x, z] of ring(rand, 14, 10, 14)) root.add(tree(THREE, x, z, 1.1 + rand() * 0.4, night ? 0xc27aa0 : 0xf6b3cf));
  for (const z of [-7, -3, 1, 5]) {
    root.add(stoneLantern(THREE, -2, z, night));
    root.add(stoneLantern(THREE, 2, z, night));
  }
  root.add(fallingPoints(THREE, anims, { color: 0xffc4dc, count: 160, size: 0.13, speed: 0.35 }));
}

function buildGarden(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x2f5040 : 0x7fb56a));
  const gravel = new THREE.Mesh(new THREE.CircleGeometry(4.6, 40), mat(THREE, night ? 0x8a8a90 : 0xe8e2d4));
  gravel.rotation.x = -Math.PI / 2;
  gravel.position.y = 0.01;
  root.add(gravel);
  const pond = new THREE.Mesh(new THREE.CircleGeometry(3.2, 36), new THREE.MeshLambertMaterial({ color: night ? 0x24406a : 0x5fa8d8, transparent: true, opacity: 0.92 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(-9.5, 0.02, -8.5);
  root.add(pond);
  // 赤い太鼓橋
  const bridge = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.18, 8, 24, Math.PI), mat(THREE, 0xd8443a));
  bridge.position.set(-9.5, 0, -8.5);
  bridge.rotation.y = Math.PI / 4;
  root.add(bridge);
  const rand = seeded(71);
  // 松（濃い緑の段々）
  for (const [x, z] of ring(rand, 9, 10.5, 14)) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.4, 8), mat(THREE, 0x6b4a36));
    trunk.position.y = 0.7;
    g.add(trunk);
    for (let k = 0; k < 3; k++) {
      const layer = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 1.1 - k * 0.25, 0.35, 10), mat(THREE, night ? 0x1f4a33 : 0x2f6b45, { flatShading: true }));
      layer.position.y = 1.2 + k * 0.45;
      g.add(layer);
    }
    g.position.set(x, 0, z);
    root.add(g);
  }
  for (const [x, z] of [[-4.6, -2.5], [4.6, -2.5], [-3.6, 3.6], [3.6, 3.6]]) root.add(stoneLantern(THREE, x, z, night));
  // 飛び石
  for (let i = 0; i < 6; i++) {
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.08, 10), mat(THREE, 0x9a968c));
    st.position.set(-1.5 + i * 0.6, 0.04, 6 + Math.sin(i) * 0.4);
    root.add(st);
  }
  void anims;
}

function buildOnsen(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x5a5460 : 0xb8ad9c));
  const street = new THREE.Mesh(new THREE.PlaneGeometry(4, 26), mat(THREE, night ? 0x6a6470 : 0xcfc4b0));
  street.rotation.x = -Math.PI / 2;
  street.position.y = 0.01;
  root.add(street);
  const walls = [0xe8d6b8, 0xd9c4a0, 0xf0e2c8];
  for (let i = 0; i < 4; i++) {
    const z = -9 + i * 5;
    root.add(hall(THREE, { x: -11, z, w: 3.4, d: 3, h: 2.2, wall: walls[i % 3], roof: 0x3a3440, rot: Math.PI / 2 }));
    root.add(hall(THREE, { x: 11, z, w: 3.4, d: 3, h: 2.2, wall: walls[(i + 1) % 3], roof: 0x44384a, rot: -Math.PI / 2 }));
    root.add(chochin(THREE, -9.2, 2.2, z, 0xffb35a));
    root.add(chochin(THREE, 9.2, 2.2, z, 0xffb35a));
  }
  // 足湯（真ん中の奥）
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 0.3, 28), mat(THREE, 0x8a8a8a));
  pool.position.set(0, 0.15, -11);
  const water = new THREE.Mesh(new THREE.CircleGeometry(1.55, 28), new THREE.MeshLambertMaterial({ color: 0x9fe0e8, emissive: 0x3a8a9a, emissiveIntensity: 0.25 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, 0.31, -11);
  root.add(pool, water);
  root.add(steam(THREE, anims, 0, -11, 24));
  root.add(steam(THREE, anims, -12, 2, 12));
  root.add(steam(THREE, anims, 12, -6, 12));
}

function buildBamboo(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x33442e : 0x8a9a5a));
  const path = new THREE.Mesh(new THREE.PlaneGeometry(3, 26), mat(THREE, night ? 0x55504a : 0xbfae8a));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.01;
  root.add(path);
  const rand = seeded(83);
  const geo = new THREE.CylinderGeometry(0.08, 0.1, 7, 6);
  const m = mat(THREE, night ? 0x3f7a4a : 0x6fbf5a);
  const count = 150;
  const inst = new THREE.InstancedMesh(geo, m, count);
  const mtx = new THREE.Matrix4();
  let n = 0;
  while (n < count) {
    const x = (rand() * 2 - 1) * 16;
    const z = (rand() * 2 - 1) * 16;
    const r = Math.hypot(x, z);
    if (r < 10) continue;
    mtx.makeTranslation(x, 3.5, z);
    inst.setMatrixAt(n++, mtx);
  }
  root.add(inst);
  for (const z of [-6, 0, 6]) {
    root.add(stoneLantern(THREE, -2.2, z, night));
    root.add(stoneLantern(THREE, 2.2, z, night));
  }
  root.add(fallingPoints(THREE, anims, { color: 0xa8d88a, count: 50, size: 0.1, speed: 0.25 }));
}

function buildMomiji(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x4a3e38 : 0xb8966a));
  root.add(hall(THREE, { x: 0, z: -12, w: 6.5, d: 4, h: 2.6, wall: 0xf2e6d0, roof: 0x2e2a30 }));
  const rand = seeded(89);
  const leaves = [0xe0452f, 0xf28a2e, 0xf2c23a, 0xc93a3a];
  for (const [x, z] of ring(rand, 16, 10, 14)) root.add(tree(THREE, x, z, 1 + rand() * 0.5, leaves[Math.floor(rand() * leaves.length)]));
  for (const [x, z] of [[-4, -8], [4, -8]]) root.add(stoneLantern(THREE, x, z, night));
  root.add(fallingPoints(THREE, anims, { color: 0xf07a3a, count: 120, size: 0.14, speed: 0.3 }));
}

function buildMatsuri(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x4a4450 : 0xc8bca8));
  root.add(torii(THREE, -11));
  const stripe = [0xff5a5a, 0x5a8aff, 0xffc84a];
  for (let i = 0; i < 4; i++) {
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.2), mat(THREE, 0xb07a4f));
      counter.position.y = 0.45;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 1.6), mat(THREE, stripe[(i + (sx > 0 ? 1 : 0)) % 3]));
      roof.position.y = 2.1;
      const pole1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.1, 6), mat(THREE, 0x6b4a36));
      pole1.position.set(-1.1, 1.05, 0.6);
      const pole2 = pole1.clone();
      pole2.position.x = 1.1;
      g.add(counter, roof, pole1, pole2);
      g.position.set(sx * 10.5, 0, -8 + i * 5);
      g.rotation.y = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
      root.add(g);
    }
  }
  // 提灯の列（両側の上に）
  for (let z = -12; z <= 12; z += 1.6) {
    root.add(chochin(THREE, -8.8, 2.9, z, z % 3.2 === 0 ? 0xffffff : 0xff4a3a));
    root.add(chochin(THREE, 8.8, 2.9, z, z % 3.2 === 0 ? 0xffffff : 0xff4a3a));
  }
  void anims;
}

function buildSnow(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0xb8c4dc : 0xf6f8ff));
  const rand = seeded(107);
  for (const [x, z] of ring(rand, 14, 10, 14)) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.8, 8), mat(THREE, 0x6b4a36));
    trunk.position.y = 0.4;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.4, 10), mat(THREE, 0xeaf2ff, { flatShading: true }));
    cone.position.y = 1.9;
    g.add(trunk, cone);
    g.position.set(x, 0, z);
    root.add(g);
  }
  // かまくら・雪だるま
  const kamakura = new THREE.Mesh(new THREE.SphereGeometry(1.8, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, 0xffffff));
  kamakura.position.set(-11, 0, -9);
  root.add(kamakura);
  for (const [x, z] of [[11, -9], [-11, 9]]) {
    const b1 = new THREE.Mesh(new THREE.SphereGeometry(0.6, 16, 12), mat(THREE, 0xffffff));
    b1.position.set(x, 0.55, z);
    const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12), mat(THREE, 0xffffff));
    b2.position.set(x, 1.35, z);
    root.add(b1, b2);
  }
  root.add(fallingPoints(THREE, anims, { color: 0xffffff, count: 220, size: 0.1, speed: 0.5, sway: 0.4 }));
}

function buildLake(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x355e4c : 0x7fc07a));
  const lake = new THREE.Mesh(new THREE.CircleGeometry(16, 48, 0, Math.PI), new THREE.MeshLambertMaterial({ color: night ? 0x2a4a8a : 0x5fb0e0, transparent: true, opacity: 0.94 }));
  lake.rotation.x = -Math.PI / 2; // 半円が奥（z < -9.5）に広がる。遊ぶ場所（真ん中）は草地のまま
  lake.position.set(0, 0.02, -9.5);
  root.add(lake);
  // 湖に映る光（夜は星のきらめき）
  root.add(fallingPoints(THREE, anims, { color: night ? 0xfff6b0 : 0xffffff, count: 40, size: 0.16, speed: 0.05, spread: 10, height: 0.3, sway: 1.2 }));
  const boat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 0.7), mat(THREE, 0xa8743f));
  boat.position.set(4, 0.2, -16);
  root.add(boat);
  const rand = seeded(113);
  for (const [x, z] of ring(rand, 10, 11, 14)) if (z > -8) root.add(tree(THREE, x, z, 1, night ? 0x2f6a48 : 0x4fa65a));
}

function buildForest(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x2e4a34 : 0x6aa85a));
  const rand = seeded(127);
  for (const [x, z] of ring(rand, 26, 10, 15)) root.add(tree(THREE, x, z, 1.2 + rand() * 0.8, night ? 0x2a6a40 : [0x3f8f4a, 0x4fa65a, 0x2f7a45][Math.floor(rand() * 3)]));
  // きのこと丸太
  for (const [x, z, c] of [[-8.5, 4, 0xe04a3a], [8.8, 5.5, 0xf2c23a], [-9.5, -5, 0xe04a3a]]) {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.35, 8), mat(THREE, 0xfff6e8));
    stem.position.set(x, 0.18, z);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, c));
    cap.position.set(x, 0.33, z);
    root.add(stem, cap);
  }
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.6, 12), mat(THREE, 0x8a5a3b));
  log.rotation.z = Math.PI / 2;
  log.position.set(0, 0.3, 9.5);
  root.add(log);
  root.add(flowers(THREE, rand, 40, 9, night));
  root.add(fallingPoints(THREE, anims, { color: 0xfff6c0, count: 40, size: 0.08, speed: 0.08, sway: 1 }));
}

function buildFlower(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x3a5a3a : 0x92d27a));
  const rand = seeded(131);
  root.add(flowers(THREE, rand, 360, 13, night));
  // 風車
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.1, 5, 10), mat(THREE, 0xf2ead8));
  tower.position.y = 2.5;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.2, 10), mat(THREE, 0xc0543a));
  roof.position.y = 5.6;
  const blades = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.6, 0.05), mat(THREE, 0xffffff));
    b.position.y = 1.3;
    const arm = new THREE.Group();
    arm.add(b);
    arm.rotation.z = (i * Math.PI) / 2;
    blades.add(arm);
  }
  blades.position.set(0, 4.8, 1);
  g.add(tower, roof, blades);
  g.position.set(-11, 0, -11);
  root.add(g);
  anims.push((t) => (blades.rotation.z = t * 0.6));
  root.add(fallingPoints(THREE, anims, { color: 0xfff0a0, count: 30, size: 0.12, speed: 0.1, sway: 1.4 }));
}

// ---------------------------------------------------------------- 2026-09-23 さらに追加の10か所

/** 松（濃い緑の段々） */
function pine(THREE, x, z, night, s = 1) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.2 * s, 1.4 * s, 8), mat(THREE, 0x6b4a36));
  trunk.position.y = 0.7 * s;
  g.add(trunk);
  for (let k = 0; k < 3; k++) {
    const layer = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * s, (1.1 - k * 0.25) * s, 0.35 * s, 10), mat(THREE, night ? 0x1f4a33 : 0x2f6b45, { flatShading: true }));
    layer.position.y = (1.2 + k * 0.45) * s;
    g.add(layer);
  }
  g.position.set(x, 0, z);
  return g;
}

/** 遠くの山並み（霧にかすむ） */
function mountains(THREE, rand, color, count = 9, r = 27) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rand() * 0.4;
    const h = 6 + rand() * 7;
    const m = new THREE.Mesh(new THREE.ConeGeometry(5 + rand() * 4, h, 7), mat(THREE, color, { flatShading: true }));
    m.position.set(Math.sin(a) * r, h / 2 - 0.5, Math.cos(a) * r);
    g.add(m);
  }
  return g;
}

/** ぐるぐる泳ぐ・まわる物（anims で回す） */
function orbit(anims, obj, { r, y, speed, phase = 0, bob = 0 }) {
  anims.push((t) => {
    const a = t * speed + phase;
    obj.position.set(Math.sin(a) * r, y + Math.sin(t * 1.7 + phase) * bob, Math.cos(a) * r);
    obj.rotation.y = a + (speed > 0 ? Math.PI / 2 : -Math.PI / 2);
  });
}

function buildCastle(THREE, root, night) {
  root.add(ground(THREE, 30, night ? 0x4c4a52 : 0xcfc2a8));
  const rand = seeded(137);
  // 天守（石垣の上に3層）
  const castle = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.6, 2.4, 4), mat(THREE, 0x9a968c, { flatShading: true }));
  base.rotation.y = Math.PI / 4;
  base.position.y = 1.2;
  castle.add(base);
  const tiers = [
    { w: 4.4, h: 1.5 },
    { w: 3.4, h: 1.3 },
    { w: 2.4, h: 1.2 },
  ];
  let y = 2.4;
  for (const t of tiers) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(t.w, t.h, t.w * 0.8), mat(THREE, 0xf7f4ec));
    wall.position.y = y + t.h / 2;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(t.w * 0.85, 0.9, 4), mat(THREE, night ? 0x2a3040 : 0x3a4658, { flatShading: true }));
    roof.rotation.y = Math.PI / 4;
    roof.scale.z = 0.8;
    roof.position.y = y + t.h + 0.35;
    castle.add(wall, roof);
    y += t.h + 0.55;
  }
  for (const sx of [-0.5, 0.5]) {
    const fish = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.45, 6), mat(THREE, 0xf2c23a, night ? { emissive: 0xf2a23a, emissiveIntensity: 0.4 } : {}));
    fish.position.set(sx, y + 0.1, 0);
    fish.rotation.z = sx > 0 ? -0.5 : 0.5;
    castle.add(fish);
  }
  castle.position.set(0, 0, -15);
  root.add(castle);
  // 城下町の家並みと松
  const walls = [0xf0e2c8, 0xe8d6b8, 0xd9c4a0];
  for (let i = 0; i < 3; i++) {
    root.add(hall(THREE, { x: -12, z: -4 + i * 5, w: 3.2, d: 2.8, h: 2, wall: walls[i % 3], roof: 0x3a3440, rot: Math.PI / 2 }));
    root.add(hall(THREE, { x: 12, z: -4 + i * 5, w: 3.2, d: 2.8, h: 2, wall: walls[(i + 1) % 3], roof: 0x44384a, rot: -Math.PI / 2 }));
  }
  for (const [x, z] of [[-8, -11], [8, -11], [-11, 11], [11, 11], [-4, -12], [4, -12]]) root.add(pine(THREE, x, z, night, 1 + rand() * 0.3));
  for (const [x, z] of [[-3, -9], [3, -9]]) root.add(stoneLantern(THREE, x, z, night));
}

function buildTanabata(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x2f4a3c : 0x7fb56a));
  const rand = seeded(139);
  const colors = [0xff5a7a, 0x5aa9ff, 0xffd23f, 0x7fdc8a, 0xb58cff, 0xffffff];
  // 笹かざり（竹に短冊）
  for (const [x, z] of ring(rand, 8, 10.5, 13)) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 5, 6), mat(THREE, 0x6fbf5a));
    pole.position.y = 2.5;
    g.add(pole);
    for (let k = 0; k < 14; k++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 4), mat(THREE, night ? 0x3f8a4a : 0x5fae52));
      leaf.position.set((rand() - 0.5) * 1.4, 2.6 + rand() * 2.4, (rand() - 0.5) * 1.4);
      leaf.rotation.set(rand() * 2, 0, (rand() - 0.5) * 2);
      g.add(leaf);
      const card = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.4), new THREE.MeshLambertMaterial({ color: colors[k % colors.length], side: THREE.DoubleSide, emissive: night ? colors[k % colors.length] : 0x000000, emissiveIntensity: night ? 0.25 : 0 }));
      card.position.set((rand() - 0.5) * 1.2, 2.2 + rand() * 2.2, (rand() - 0.5) * 1.2);
      card.rotation.y = rand() * Math.PI;
      g.add(card);
      anims.push((t) => (card.rotation.z = Math.sin(t * 1.5 + k + x) * 0.25));
    }
    g.position.set(x, 0, z);
    root.add(g);
  }
  // 天の川（空を横切る光の帯）
  const count = 700;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const off = (rand() + rand() + rand() - 1.5) * 3.2;
    pos.set([u * 34, 14 + Math.cos(u * 1.2) * 8 + off * 0.4, -10 + off + u * 6], i * 3);
    c.setHSL(0.6 + rand() * 0.2, 0.6, 0.75 + rand() * 0.25);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  root.add(new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, opacity: 0.9, fog: false })));
  for (const [x, z] of [[-4.5, -9], [4.5, -9]]) root.add(lantern(THREE, x, z, night));
}

function buildPaddy(THREE, root, night) {
  root.add(ground(THREE, 34, night ? 0x3a4a30 : 0x9aa860));
  const rand = seeded(149);
  root.add(mountains(THREE, rand, night ? 0x2a3a4a : 0x6f8fa0));
  // 田んぼ（水を張った四角と、苗の列）
  const water = new THREE.MeshLambertMaterial({ color: night ? 0x3a5a7a : 0x9fcfd8, transparent: true, opacity: 0.9 });
  const sprout = mat(THREE, night ? 0x4f8a3a : 0x7fcf4a);
  const sproutGeo = new THREE.ConeGeometry(0.06, 0.35, 4);
  const spots = [];
  for (let gx = -3; gx <= 3; gx++) {
    for (let gz = -3; gz <= 3; gz++) {
      const x = gx * 4.6;
      const z = gz * 4.6;
      if (Math.hypot(x, z) < 10.5 || Math.hypot(x, z) > 17) continue;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), water);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, 0.02, z);
      root.add(p);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) spots.push([x - 1.5 + i, z - 1.5 + j]);
    }
  }
  const inst = new THREE.InstancedMesh(sproutGeo, sprout, spots.length);
  const m = new THREE.Matrix4();
  spots.forEach(([x, z], i) => inst.setMatrixAt(i, m.makeTranslation(x, 0.18, z)));
  root.add(inst);
  // かかし
  const scare = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6), mat(THREE, 0x8a5a3b));
  post.position.y = 0.9;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), mat(THREE, 0x8a5a3b));
  arm.rotation.z = Math.PI / 2;
  arm.position.y = 1.3;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), mat(THREE, 0xf6efe2));
  head.position.y = 1.85;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.2, 12), mat(THREE, 0xe8c86a));
  hat.position.y = 2.05;
  scare.add(post, arm, head, hat);
  scare.position.set(-9.5, 0, -8.5);
  root.add(scare);
  root.add(hall(THREE, { x: 11, z: -11, w: 3.4, d: 3, h: 2, wall: 0xe8d6b8, roof: 0x7a6a4a, rot: -Math.PI / 4 }));
}

function buildInari(THREE, root, night) {
  root.add(ground(THREE, 30, night ? 0x4a4450 : 0xd8d0c0));
  // 千本鳥居（奥の半分をぐるりと囲む、朱色の鳥居のトンネル）
  const n = 26;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI * 0.62 + (i / (n - 1)) * Math.PI * 1.24;
    const t = torii(THREE, 0);
    t.scale.setScalar(0.62);
    t.position.set(Math.sin(a) * 11.5, 0, -Math.cos(a) * 11.5);
    t.rotation.y = -a + Math.PI / 2;
    root.add(t);
  }
  root.add(hall(THREE, { x: 0, z: -15.5, w: 5.5, d: 3.6, h: 2.3, wall: 0xf6efe2, roof: 0xb8402e }));
  // きつねの像（白い体に、赤い前かけ）
  for (const sx of [-1, 1]) {
    const g = new THREE.Group();
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(THREE, 0xa7a39a));
    stand.position.y = 0.4;
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), mat(THREE, 0xfafafa));
    body.scale.y = 1.3;
    body.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mat(THREE, 0xfafafa));
    head.position.set(0, 1.75, 0.08);
    const bib = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.3, 3), mat(THREE, 0xd8443a));
    bib.rotation.x = Math.PI;
    bib.position.set(0, 1.45, 0.2);
    g.add(stand, body, head, bib);
    for (const ex of [-0.1, 0.1]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 4), mat(THREE, 0xfafafa));
      ear.position.set(ex, 1.98, 0.05);
      g.add(ear);
    }
    g.position.set(sx * 3, 0, -9.8);
    root.add(g);
  }
  for (const [x, z] of [[-11, 9], [11, 9]]) root.add(stoneLantern(THREE, x, z, night));
  for (const [x, z] of [[-13, 4], [13, 4], [-12.5, 12], [12.5, 12]]) root.add(tree(THREE, x, z, 1.2, night ? 0x234a33 : 0x3f8f55));
}

function buildHarbor(THREE, root, night, anims) {
  const land = new THREE.Mesh(new THREE.PlaneGeometry(40, 24), mat(THREE, night ? 0x6a6470 : 0xcfc4b0));
  land.rotation.x = -Math.PI / 2;
  land.position.z = 4;
  land.name = "ground";
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(40, 22, 40, 10), new THREE.MeshLambertMaterial({ color: night ? 0x1f3f7a : 0x3f9fd8, transparent: true, opacity: 0.94 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(0, -0.05, -19);
  sea.name = "sea";
  root.add(land, sea);
  // 桟橋と、つないだ船
  const pier = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 10), mat(THREE, 0x9a7a55));
  pier.position.set(-6, 0.05, -12.5);
  root.add(pier);
  for (const [x, z, c] of [[-3.6, -13, 0xffffff], [-8.6, -15, 0xff7a5a], [4, -16, 0x5aa9ff]]) {
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 2.6), mat(THREE, c));
    hull.position.set(x, 0.15, z);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.9), mat(THREE, 0xf6efe2));
    cabin.position.set(x, 0.65, z + 0.3);
    root.add(hull, cabin);
    anims.push((t) => {
      hull.position.y = 0.15 + Math.sin(t * 1.2 + x) * 0.05;
      cabin.position.y = 0.65 + Math.sin(t * 1.2 + x) * 0.05;
    });
  }
  // 灯台（紅白のしま）
  const lh = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.9 - i * 0.1, 1 - i * 0.1, 1.2, 16), mat(THREE, i % 2 ? 0xd8443a : 0xffffff));
    seg.position.y = 0.6 + i * 1.2;
    lh.add(seg);
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), new THREE.MeshLambertMaterial({ color: 0xfff6c0, emissive: 0xffd86b, emissiveIntensity: night ? 1 : 0.3 }));
  lamp.position.y = 6.5;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.6, 0.6, 16), mat(THREE, 0x3a3440));
  cap.position.y = 7.1;
  lh.add(lamp, cap);
  if (night) {
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1.2, 12, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    beam.rotation.z = Math.PI / 2;
    beam.position.x = 6;
    const pivot = new THREE.Group();
    pivot.position.y = 6.5;
    pivot.add(beam);
    lh.add(pivot);
    anims.push((t) => (pivot.rotation.y = t * 0.6));
  }
  lh.position.set(10, 0, -11);
  root.add(lh);
  // 木箱と倉庫
  for (const [x, z] of [[-11, 3], [-10.2, 3.4], [-10.6, 2.4]]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mat(THREE, 0xb07a4f));
    box.position.set(x, 0.35, z);
    root.add(box);
  }
  root.add(hall(THREE, { x: -12, z: 10, w: 4, d: 3, h: 2.4, wall: 0xd9c4a0, roof: 0x4a5a7a, rot: Math.PI / 4 }));
  root.add(hall(THREE, { x: 12, z: 10, w: 4, d: 3, h: 2.4, wall: 0xf0e2c8, roof: 0x7a4a3a, rot: -Math.PI / 4 }));
  // かもめ
  for (let i = 0; i < 3; i++) {
    const gull = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.6, 3), mat(THREE, 0xffffff));
    gull.rotation.z = Math.PI / 2;
    root.add(gull);
    orbit(anims, gull, { r: 8 + i * 2, y: 6 + i, speed: 0.3 + i * 0.05, phase: i * 2, bob: 0.3 });
  }
}

function buildDesert(THREE, root, night) {
  root.add(ground(THREE, 34, night ? 0x8a7a5a : 0xf0d49a));
  const rand = seeded(151);
  // 砂丘
  for (const [x, z] of ring(rand, 9, 14, 20)) {
    const dune = new THREE.Mesh(new THREE.SphereGeometry(4 + rand() * 2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, night ? 0x9a8a62 : 0xe8c47a));
    dune.scale.y = 0.35;
    dune.position.set(x, 0, z);
    root.add(dune);
  }
  // オアシス（奥の池とヤシ）
  const pond = new THREE.Mesh(new THREE.CircleGeometry(3, 32), new THREE.MeshLambertMaterial({ color: night ? 0x2a5a8a : 0x4fc0d8 }));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(0, 0.02, -12.5);
  root.add(pond);
  const palm = (x, z, s = 1) => {
    const g = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * s, 0.18 * s, 0.6 * s, 8), mat(THREE, 0x9a7a4a));
      seg.position.set(i * 0.05 * s, (0.3 + i * 0.55) * s, 0);
      g.add(seg);
    }
    for (let k = 0; k < 6; k++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.28 * s, 1.8 * s, 4), mat(THREE, night ? 0x2f6a3a : 0x4fae52, { flatShading: true }));
      const a = (k / 6) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.7 * s + 0.3 * s, 3.4 * s, Math.sin(a) * 0.7 * s);
      leaf.rotation.set(Math.sin(a) * 1.2, 0, -Math.cos(a) * 1.2);
      g.add(leaf);
    }
    g.position.set(x, 0, z);
    return g;
  };
  for (const [x, z, s] of [[-3.8, -13, 1.1], [3.6, -12, 0.95], [-1.5, -15.5, 1.2], [11, 8, 1], [-11.5, 7, 0.9]]) root.add(palm(x, z, s));
  // サボテン
  for (const [x, z] of [[-11, -4], [10.5, -6], [12, 2], [-12.5, 12]]) {
    const g = new THREE.Group();
    const c = mat(THREE, night ? 0x3f7a4a : 0x5faa5a);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.28, 1.8, 10), c);
    trunk.position.y = 0.9;
    const arm1 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.7, 8), c);
    arm1.position.set(0.35, 1.1, 0);
    const arm2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.6, 8), c);
    arm2.position.set(-0.35, 0.9, 0);
    g.add(trunk, arm1, arm2);
    g.position.set(x, 0, z);
    root.add(g);
  }
  return { sky: night ? null : 0xa8dcff, fog: night ? null : 0xf8e8c8 };
}

function buildCandy(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x6a4a6a : 0xffd6e8));
  const rand = seeded(157);
  const pastel = [0xff8fb8, 0x8fd0ff, 0xfff08f, 0xa8f0b0, 0xd8b0ff, 0xffb88f];
  // ぺろぺろキャンディの木
  for (const [x, z] of ring(rand, 12, 10.5, 14)) {
    const g = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8), mat(THREE, 0xffffff));
    stick.position.y = 1.1;
    const candy = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.2, 24), mat(THREE, pastel[Math.floor(rand() * pastel.length)]));
    candy.rotation.x = Math.PI / 2;
    candy.position.y = 2.6;
    const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.08, 8, 24), mat(THREE, 0xffffff));
    swirl.position.set(0, 2.6, 0.11);
    g.add(stick, candy, swirl);
    g.position.set(x, 0, z);
    g.rotation.y = Math.atan2(-x, -z);
    root.add(g);
  }
  // ケーキのおうち
  const cake = new THREE.Group();
  const layers = [
    [3, 1.2, 0xf6d7a8],
    [2.3, 1.0, 0xffb3cf],
    [1.6, 0.9, 0xfff4e8],
  ];
  let y = 0;
  for (const [r, h, c] of layers) {
    const l = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 28), mat(THREE, c));
    l.position.y = y + h / 2;
    const cream = new THREE.Mesh(new THREE.TorusGeometry(r, 0.14, 8, 28), mat(THREE, 0xffffff));
    cream.rotation.x = Math.PI / 2;
    cream.position.y = y + h;
    cake.add(l, cream);
    y += h;
  }
  const berry = new THREE.Mesh(new THREE.SphereGeometry(0.4, 14, 10), mat(THREE, 0xe8304a));
  berry.position.y = y + 0.35;
  cake.add(berry);
  cake.position.set(0, 0, -14);
  root.add(cake);
  // ガムドロップの丘
  for (const [x, z] of [[-12, -9], [12, -9], [-13, 5], [13, 5]]) {
    const gum = new THREE.Mesh(new THREE.SphereGeometry(1.4, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, pastel[Math.floor(rand() * pastel.length)]));
    gum.position.set(x, 0, z);
    root.add(gum);
  }
  // キャンディケイン
  for (const sx of [-1, 1]) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 10), mat(THREE, 0xff4a5a));
    pole.position.y = 1.2;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.12, 8, 16, Math.PI), mat(THREE, 0xffffff));
    hook.position.set(0.35 * sx, 2.4, 0);
    g.add(pole, hook);
    g.position.set(sx * 4, 0, -10.5);
    root.add(g);
  }
  root.add(fallingPoints(THREE, anims, { color: 0xffffff, count: 60, size: 0.1, speed: 0.2, sway: 0.8 }));
  return { sky: night ? null : 0xffe6f5, fog: night ? null : 0xfff0f8 };
}

function buildMoon(THREE, root, night, anims) {
  root.add(ground(THREE, 32, 0xb8b8c4));
  const rand = seeded(163);
  // クレーター
  for (const [x, z] of ring(rand, 12, 9.5, 16)) {
    const r = 0.8 + rand() * 1.6;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.2, 8, 24), mat(THREE, 0xa0a0ac));
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(x, 0.05, z);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(r, 24), mat(THREE, 0x8c8c98));
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(x, 0.02, z);
    root.add(rim, hole);
  }
  // 空にうかぶ地球
  const earth = new THREE.Mesh(new THREE.SphereGeometry(3, 28, 20), new THREE.MeshLambertMaterial({ color: 0x3f8fe0, emissive: 0x1a3a7a, emissiveIntensity: 0.5, fog: false }));
  earth.position.set(14, 16, -30);
  const land = new THREE.Mesh(new THREE.SphereGeometry(3.02, 12, 8, 0, 1.6, 0.6, 1.2), new THREE.MeshLambertMaterial({ color: 0x5fbf6a, emissive: 0x2a5a2a, emissiveIntensity: 0.4, fog: false }));
  land.position.copy(earth.position);
  root.add(earth, land);
  anims.push((t) => (land.rotation.y = t * 0.05));
  // 基地（ドームと、つながった筒）
  const dome = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xcfe8ff, transparent: true, opacity: 0.6, emissive: 0x4a7aaa, emissiveIntensity: 0.3 }));
  dome.position.set(0, 0, -15);
  root.add(dome);
  for (const sx of [-1, 1]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 5, 16), mat(THREE, 0xeeeeee));
    tube.rotation.z = Math.PI / 2;
    tube.position.set(sx * 5, 0.7, -15);
    const pod = new THREE.Mesh(new THREE.SphereGeometry(1.4, 18, 12), mat(THREE, 0xf2f2f2));
    pod.position.set(sx * 8.3, 1.1, -15);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ color: sx > 0 ? 0xff5a5a : 0x5aff9a }));
    light.position.set(sx * 8.3, 2.55, -15);
    root.add(tube, pod, light);
    anims.push((t) => (light.visible = Math.sin(t * 3 + sx) > 0));
  }
  // 旗とロケット
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6), mat(THREE, 0xdddddd));
  pole.position.set(-10, 1.1, 8);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshLambertMaterial({ color: 0xff8fb8, side: THREE.DoubleSide }));
  flag.position.set(-9.55, 1.9, 8);
  root.add(pole, flag);
  const rocket = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 3.4, 16), mat(THREE, 0xffffff));
  body.position.y = 2.2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.2, 16), mat(THREE, 0xd8443a));
  nose.position.y = 4.5;
  rocket.add(body, nose);
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.8), mat(THREE, 0xd8443a));
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 0.7, 0.9, Math.sin(a) * 0.7);
    fin.rotation.y = -a;
    rocket.add(fin);
  }
  rocket.position.set(11, 0, 7);
  root.add(rocket);
  return { sky: 0x070a1e, fog: 0x141a3a };
}

function buildUndersea(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x6a6a5a : 0xe8d9a8));
  const rand = seeded(167);
  // サンゴ
  const corals = [0xff6f91, 0xffa94d, 0xb58cff, 0xff5a5a, 0xffd23f];
  for (const [x, z] of ring(rand, 12, 10, 14)) {
    const g = new THREE.Group();
    const c = mat(THREE, corals[Math.floor(rand() * corals.length)]);
    for (let k = 0; k < 5; k++) {
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 1 + rand() * 1.2, 6), c);
      br.position.set((rand() - 0.5) * 0.8, 0.6, (rand() - 0.5) * 0.8);
      br.rotation.set((rand() - 0.5) * 0.9, 0, (rand() - 0.5) * 0.9);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), c);
      tip.position.set(br.position.x + Math.sin(br.rotation.z) * -0.6, 1.2 + rand() * 0.4, br.position.z + Math.sin(br.rotation.x) * 0.6);
      g.add(br, tip);
    }
    g.position.set(x, 0, z);
    root.add(g);
  }
  // ゆれる海草
  for (const [x, z] of ring(rand, 18, 9.5, 15)) {
    const weed = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4 + rand() * 1.5, 0.05), mat(THREE, 0x3fae6a));
    weed.geometry.translate(0, 1.2, 0);
    weed.position.set(x, 0, z);
    root.add(weed);
    const ph = rand() * 6;
    anims.push((t) => (weed.rotation.z = Math.sin(t * 1.1 + ph) * 0.25));
  }
  // 岩と宝箱
  for (const [x, z, s] of [[-12, -6, 1.2], [12, -3, 1], [-8, 12, 0.9]]) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), mat(THREE, 0x7a8a9a, { flatShading: true }));
    rock.position.set(x, s * 0.5, z);
    root.add(rock);
  }
  const chest = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.8), mat(THREE, 0xa8743f));
  chest.position.set(0, 0.35, -13);
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 12, 1, false, 0, Math.PI), mat(THREE, 0xc98f4a));
  lid.rotation.z = Math.PI / 2;
  lid.position.set(0, 0.7, -13);
  root.add(chest, lid);
  // 泳ぐさかな
  const fishCols = [0xffa94d, 0xffd23f, 0x6fb8ff, 0xff6f91];
  for (let i = 0; i < 7; i++) {
    const fish = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), mat(THREE, fishCols[i % fishCols.length]));
    body.scale.set(1, 0.7, 1.6);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 4), mat(THREE, fishCols[(i + 1) % fishCols.length]));
    tail.rotation.x = -Math.PI / 2;
    tail.position.z = -0.5;
    fish.add(body, tail);
    root.add(fish);
    orbit(anims, fish, { r: 10 + (i % 3) * 2, y: 2.5 + (i % 4) * 0.9, speed: (i % 2 ? 1 : -1) * (0.25 + i * 0.03), phase: i, bob: 0.3 });
  }
  // のぼる泡
  const count = 60;
  const pos = new Float32Array(count * 3);
  const base = [];
  for (let i = 0; i < count; i++) base.push([(rand() * 2 - 1) * 14, (rand() * 2 - 1) * 14, rand() * 8, 0.5 + rand()]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  root.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xe8f8ff, size: 0.14, transparent: true, opacity: 0.8 })));
  anims.push((t) => {
    const p = geo.attributes.position;
    base.forEach(([x, z, ph, sp], i) => p.setXYZ(i, x + Math.sin(t + ph) * 0.2, (t * sp * 0.6 + ph) % 8, z));
    p.needsUpdate = true;
  });
  return { sky: night ? 0x0a2a4a : 0x2a8ac8, fog: night ? 0x0f3050 : 0x4aa0d0 };
}

function buildPark(THREE, root, night, anims) {
  root.add(ground(THREE, 30, night ? 0x2f5a3a : 0x92cf70));
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(9, 40), mat(THREE, night ? 0x6a6470 : 0xe8dcc8));
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.01;
  root.add(plaza);
  const bright = [0xff5a7a, 0x5aa9ff, 0xffd23f, 0x7fdc8a, 0xb58cff, 0xff9f40];
  const glow = (c) => new THREE.MeshLambertMaterial({ color: c, emissive: night ? c : 0x000000, emissiveIntensity: night ? 0.5 : 0 });
  // 観覧車
  const wheel = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.12, 8, 48), glow(0xffffff));
  wheel.add(rim);
  const cars = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 4.5, 6), mat(THREE, 0xdddddd));
    spoke.position.set(Math.cos(a) * 2.25, Math.sin(a) * 2.25, 0);
    spoke.rotation.z = a - Math.PI / 2;
    wheel.add(spoke);
    const car = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), glow(bright[i % bright.length]));
    root.add(car);
    cars.push([car, a]);
  }
  wheel.position.set(0, 5.6, -15);
  root.add(wheel);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 6.2, 8), mat(THREE, 0xdddddd));
    leg.position.set(sx * 1.4, 2.8, -15);
    leg.rotation.z = sx * 0.24;
    root.add(leg);
  }
  anims.push((t) => {
    wheel.rotation.z = t * 0.15;
    for (const [car, a] of cars) {
      const aa = a + t * 0.15;
      car.position.set(Math.cos(aa) * 4.5, 5.6 + Math.sin(aa) * 4.5 - 0.5, -15);
    }
  });
  // メリーゴーランド
  const carousel = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.3, 24), mat(THREE, 0xf6e6c8));
  floor.position.y = 0.15;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.8, 1.4, 24), glow(0xff7a9a));
  roof.position.y = 3.3;
  const center = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.8, 12), mat(THREE, 0xffd23f));
  center.position.y = 1.6;
  carousel.add(floor, roof, center);
  const horses = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), mat(THREE, bright[i]));
    h.scale.set(1, 0.8, 1.5);
    h.position.set(Math.cos(a) * 1.7, 1, Math.sin(a) * 1.7);
    h.rotation.y = -a;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6), mat(THREE, 0xf2c23a));
    pole.position.set(Math.cos(a) * 1.7, 1.6, Math.sin(a) * 1.7);
    horses.add(h, pole);
    const ph = i;
    anims.push((t) => (h.position.y = 1 + Math.sin(t * 2 + ph) * 0.2));
  }
  carousel.add(horses);
  carousel.position.set(11.5, 0, -8);
  root.add(carousel);
  anims.push((t) => (horses.rotation.y = t * 0.6));
  // 風船の束と、旗のガーランド
  for (let i = 0; i < 7; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), glow(bright[i % bright.length]));
    b.scale.y = 1.2;
    const bx = -11 + (i % 3) * 0.5;
    const bz = -7 + Math.floor(i / 3) * 0.5;
    root.add(b);
    anims.push((t) => b.position.set(bx + Math.sin(t + i) * 0.1, 3 + (i % 3) * 0.5 + Math.sin(t * 1.3 + i) * 0.15, bz));
  }
  const cart = hall(THREE, { x: -11.5, z: -9, w: 2, d: 1.4, h: 1.4, wall: 0xfff0f4, roof: 0xff7a9a });
  root.add(cart);
  for (let i = 0; i < 14; i++) {
    const a = -Math.PI * 0.8 + (i / 13) * Math.PI * 1.6;
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.4, 3), glow(bright[i % bright.length]));
    f.rotation.x = Math.PI;
    f.position.set(Math.sin(a) * 10.5, 3.4 + Math.cos(i * 0.9) * 0.1, -Math.cos(a) * 10.5);
    root.add(f);
  }
  for (const [x, z] of [[-12, 9], [12, 9], [-13, 2], [13, 2]]) root.add(tree(THREE, x, z, 1, night ? 0x2f7a45 : 0x5fbf6a));
}

const PLACE_BUILDERS = {
  meadow: buildMeadow,
  room: buildRoom,
  shrine: buildShrine,
  beach: buildBeach,
  hill: buildHill,
  sakura: buildSakura,
  garden: buildGarden,
  onsen: buildOnsen,
  bamboo: buildBamboo,
  momiji: buildMomiji,
  matsuri: buildMatsuri,
  snow: buildSnow,
  lake: buildLake,
  forest: buildForest,
  flower: buildFlower,
  castle: buildCastle,
  tanabata: buildTanabata,
  paddy: buildPaddy,
  inari: buildInari,
  harbor: buildHarbor,
  desert: buildDesert,
  candy: buildCandy,
  moon: buildMoon,
  undersea: buildUndersea,
  park: buildPark,
};

/**
 * 場所と時間帯を組み立てて返す。
 * @returns {{ root: THREE.Group, update: (t: number) => void, groundTargets: THREE.Object3D[] }}
 */
export function buildWorld(THREE, scene, place, time) {
  const look = TIME_LOOK[time] || TIME_LOOK.day;
  const night = time === "night";
  const root = new THREE.Group();

  scene.background = new THREE.Color(look.sky);
  scene.fog = place === "room" ? null : new THREE.Fog(look.fog, 18, 42);

  const hemi = new THREE.HemisphereLight(look.hemi[0], look.hemi[1], look.hemi[2]);
  const sun = new THREE.DirectionalLight(look.sun[0], look.sun[1]);
  sun.position.set(...look.sunPos);
  root.add(hemi, sun);

  const anims = [];
  // 場所によっては空と霧の色を変える（海の底・月面・おかしの国など）。返り値の { sky, fog } で上書きする
  const extra = (PLACE_BUILDERS[place] || buildMeadow)(THREE, root, night, anims) || {};
  if (extra.sky != null) scene.background = new THREE.Color(extra.sky);
  if (extra.fog != null && scene.fog) scene.fog.color = new THREE.Color(extra.fog);
  if (night && place !== "room") root.add(stars(THREE, 260, 34));

  // 夜のあいだだけ、ふわふわ漂う光（ほたる）
  let fireflies = null;
  if (night && place !== "room") {
    const rand = seeded(53);
    const count = 24;
    const pos = new Float32Array(count * 3);
    const base = [];
    for (let i = 0; i < count; i++) {
      const [x, z] = scatter(rand, 1, 8, 1.5)[0] || [0, 0];
      base.push([x, 0.6 + rand() * 1.4, z, rand() * 6]);
      pos.set([x, 1, z], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    fireflies = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xfff27a, size: 0.12 }));
    fireflies.userData.base = base;
    root.add(fireflies);
  }

  scene.add(root);
  const sea = root.getObjectByName("sea");
  const groundTargets = [];
  root.traverse((o) => {
    if (o.name === "ground") groundTargets.push(o);
  });

  return {
    root,
    groundTargets,
    update(t) {
      for (const a of anims) a(t);
      if (sea) {
        const p = sea.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const y = p.getY(i);
          p.setZ(i, Math.sin(x * 0.6 + t * 1.3) * 0.05 + Math.cos(y * 0.8 + t) * 0.04);
        }
        p.needsUpdate = true;
      }
      if (fireflies) {
        const p = fireflies.geometry.attributes.position;
        fireflies.userData.base.forEach(([x, y, z, ph], i) => {
          p.setXYZ(i, x + Math.sin(t * 0.7 + ph) * 0.4, y + Math.sin(t * 1.1 + ph) * 0.25, z + Math.cos(t * 0.6 + ph) * 0.4);
        });
        p.needsUpdate = true;
      }
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
      });
    },
  };
}

/** 文字を描いたテクスチャ（スクリーン・名札・吹き出しで使う） */
export function textCanvas(lines, opts = {}) {
  const w = opts.width || 512;
  const h = opts.height || 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    const r = opts.radius ?? 24;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = opts.color || "#1c1630";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const size = opts.fontSize || 44;
  ctx.font = `700 ${size}px -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`;
  const list = Array.isArray(lines) ? lines : [lines];
  const lh = size * 1.35;
  const top = h / 2 - ((list.length - 1) * lh) / 2;
  list.forEach((line, i) => ctx.fillText(String(line), w / 2, top + i * lh, w - 24));
  return canvas;
}

/** 長い文を、スクリーンの幅で折り返す（日本語なので文字数で切る） */
export function wrapText(text, perLine, maxLines) {
  const chars = [...String(text || "")];
  const lines = [];
  // 行頭に来てはいけない文字（句読点・閉じかっこ）は、前の行へぶら下げる（禁則）
  const noStart = "。、，．）」』！？ー…";
  let i = 0;
  while (i < chars.length && lines.length < maxLines) {
    let end = Math.min(chars.length, i + perLine);
    while (end < chars.length && noStart.includes(chars[end]) && end - i < perLine + 2) end += 1;
    lines.push(chars.slice(i, end).join(""));
    i = end;
  }
  return lines;
}
