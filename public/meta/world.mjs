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
  (PLACE_BUILDERS[place] || buildMeadow)(THREE, root, night, anims);
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
