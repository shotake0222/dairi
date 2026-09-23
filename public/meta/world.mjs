/**
 * メタバースの「場所」と「時間帯」を組み立てる。
 *
 * どれも three.js の基本図形だけで作る（外部の3D素材を読まない）。スマホで軽く動くことを優先して:
 *   - 影は計算しない（キャラの足元に丸い影を置くだけ）
 *   - 光は2つ（空からの光と、太陽／月）。材質は Lambert（安い）
 *   - 草・花・星などの細かい物は、少数を InstancedMesh でまとめて描く
 *
 * 場所: meadow（草原）/ room（おへや）/ shrine（境内）/ beach（海辺）/ hill（夜空の丘）
 * 時間: morning / day / evening / night
 */

const TIME_LOOK = {
  morning: { sky: 0xcfe6ff, fog: 0xe8f0ff, hemi: [0xffffff, 0xb9d6a0, 0.85], sun: [0xfff1d6, 0.9], sunPos: [-6, 5, 4] },
  day: { sky: 0x8fcfff, fog: 0xcfeaff, hemi: [0xffffff, 0xa6c98a, 1.0], sun: [0xffffff, 1.1], sunPos: [4, 10, 6] },
  evening: { sky: 0xffb38a, fog: 0xffd2b0, hemi: [0xffe0c8, 0x8a6a5a, 0.75], sun: [0xff9a5c, 1.0], sunPos: [-8, 3, -2] },
  night: { sky: 0x141a3a, fog: 0x1c2248, hemi: [0x8a96d8, 0x20243a, 0.55], sun: [0xbfd0ff, 0.45], sunPos: [5, 8, -4] },
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
  const hill = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 16, 0, Math.PI * 2, 0, 0.35), mat(THREE, night ? 0x24483a : 0x6fbf73));
  hill.position.y = -37.8;
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

const PLACE_BUILDERS = { meadow: buildMeadow, room: buildRoom, shrine: buildShrine, beach: buildBeach, hill: buildHill };

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

  (PLACE_BUILDERS[place] || buildMeadow)(THREE, root, night);
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
