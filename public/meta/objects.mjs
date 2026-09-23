/**
 * 部屋に置く物（管理画面で決めたもの）を、空間に立てる。
 *
 *   board    看板（文字・画像）。広告なら「広告」の札を必ず付ける。タップで詳しく・リンクへ
 *   video    動画スクリーン（音なし・くり返し）
 *   members  いまいる子の紹介
 *   treasure / quiz / rally  ミニゲームの屋台。タップするか、前の光る輪に分身が入ると始まる
 *   tilt / shake / … / nenne  センサー・XRのミニゲームの屋台（遊ぶ画面は sensorgames.mjs / sensorgames2.mjs）
 *   shop     お店（通貨で買い物。中身は wallet.mjs が開く）
 *
 * 置き場所は決まった7か所（src/metaverse.ts の SLOTS）で、どれも空間の真ん中を向く。
 */

import { textCanvas, wrapText } from "./world.mjs";

const GAME_COLORS = {
  treasure: 0xffc94d,
  quiz: 0x6fb8ff,
  rally: 0x7fdc8a,
  // センサー・XRのミニゲーム（sensorgames.mjs）
  tilt: 0xff9f5a,
  shake: 0xff6f91,
  balance: 0x9ad06a,
  voice: 0xc58bff,
  arhunt: 0x4fd1c5,
  skycatch: 0x6d7cff,
  rhythm: 0xff7ad9,
  hotcold: 0xff5a4f,
  daruma: 0xe8a33d,
  xr: 0x39c0ff,
  // あとから足した10種類（sensorgames2.mjs）
  fishing: 0x3f9fd8,
  pour: 0xff9f40,
  maze: 0x8bd450,
  balloon: 0xff5a7a,
  tower: 0xffb13d,
  colorhunt: 0xa45cff,
  hanetsuki: 0xd9434b,
  taiko: 0xa8432a,
  sled: 0x7fb8e8,
  nenne: 0x6a7bd8,
};
const GAME_ICON = {
  treasure: "★",
  quiz: "○×",
  rally: "旗",
  tilt: "傾",
  shake: "振",
  balance: "揺",
  voice: "声",
  arhunt: "AR",
  skycatch: "☆",
  rhythm: "♪",
  hotcold: "熱",
  daruma: "鬼",
  xr: "XR",
  fishing: "釣",
  pour: "注",
  maze: "迷",
  balloon: "風",
  tower: "積",
  colorhunt: "色",
  hanetsuki: "羽",
  taiko: "鼓",
  sled: "橇",
  nenne: "眠",
};
/** センサーを使うゲームか（屋台に「スマホを動かす」の札を付ける） */
const SENSOR_TYPES = new Set([
  "tilt", "shake", "balance", "voice", "arhunt", "skycatch", "rhythm", "hotcold", "daruma", "xr",
  "fishing", "pour", "maze", "balloon", "tower", "colorhunt", "hanetsuki", "taiko", "sled", "nenne",
]);

function canvasTexture(THREE, canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function sprite(THREE, lines, opts, width) {
  const mat = new THREE.SpriteMaterial({ map: canvasTexture(THREE, textCanvas(lines, opts)), depthTest: true, transparent: true });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(width, (width * opts.height) / opts.width, 1);
  return spr;
}

/** 看板・動画・紹介の「板」（枠と脚つき） */
function panel(THREE, w, h) {
  const group = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x2a2440 });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.1), dark);
  frame.position.y = h / 2 + 0.9;
  group.add(frame);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), dark);
    post.position.set(sx * (w / 2 - 0.25), 0.5, 0);
    group.add(post);
  }
  const face = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), face);
  plane.position.set(0, h / 2 + 0.9, 0.06);
  group.add(plane);
  return { group, plane, face };
}

export function buildObjects(THREE, scene, objects, catalog, hooks) {
  const items = [];
  const slotOf = (id) => catalog.slots.find((s) => s.id === id) || catalog.slots[0];

  for (const obj of objects || []) {
    const slot = slotOf(obj.slot);
    const root = new THREE.Group();
    root.position.set(slot.x, 0, slot.z);
    root.rotation.y = Math.atan2(-slot.x, -slot.z); // 真ん中を向く
    scene.add(root);
    const item = { obj, root, hits: [], textures: [], update: null, refreshMembers: null, startPoint: null, video: null };

    if (obj.type === "board" || obj.type === "members" || obj.type === "video") {
      const w = 3.6;
      const h = 2.1;
      const { group, plane, face } = panel(THREE, w, h);
      root.add(group);
      plane.userData.item = item;
      item.hits.push(plane);
      const draw = (lines, size = 58) => {
        face.map?.dispose();
        face.map = canvasTexture(THREE, textCanvas(lines, { width: 1024, height: 600, fontSize: size, bg: "#fffdf7", radius: 8, color: "#2a2440" }));
        face.needsUpdate = true;
      };

      if (obj.type === "board") {
        if (obj.imageUrl) {
          draw(["読み込み中…"]);
          new THREE.TextureLoader().setCrossOrigin("anonymous").load(
            obj.imageUrl,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace;
              face.map?.dispose();
              face.map = tex;
              face.needsUpdate = true;
            },
            undefined,
            () => draw([obj.title, ...wrapText(obj.text, 14, 4)])
          );
        } else {
          draw([obj.title, ...wrapText(obj.text, 14, 5)].filter(Boolean));
        }
        // 広告は、広告だと分かる表示を必ず付ける（ステルスマーケティング規制）。付け外しの設定は持たせない
        if (obj.ad) {
          const tag = sprite(THREE, ["広告"], { width: 256, height: 110, fontSize: 60, bg: "rgba(40,36,64,0.92)", color: "#ffffff", radius: 30 }, 0.7);
          tag.position.set(-w / 2 + 0.35, h + 1.05, 0.12);
          group.add(tag);
        }
        if (obj.imageUrl || obj.linkUrl) {
          const title = sprite(THREE, [obj.title], { width: 768, height: 120, fontSize: 56, bg: "rgba(255,255,255,0.94)", color: "#2a2440", radius: 40 }, 2.4);
          title.position.set(0, h + 1.35, 0.1);
          group.add(title);
        }
      } else if (obj.type === "members") {
        item.refreshMembers = (names) => {
          const list = names.slice(0, 5);
          if (names.length > 5) list.push(`ほか${names.length - 5}体`);
          draw([obj.title || "いまいる子", ...list], 54);
        };
        item.refreshMembers([]);
      } else if (obj.type === "video") {
        const video = document.createElement("video");
        video.src = obj.videoUrl;
        video.crossOrigin = "anonymous";
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.play().catch(() => undefined);
        const tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        face.map = tex;
        face.needsUpdate = true;
        item.video = video;
        if (obj.title) {
          const title = sprite(THREE, [obj.title], { width: 768, height: 120, fontSize: 56, bg: "rgba(255,255,255,0.94)", color: "#2a2440", radius: 40 }, 2.4);
          title.position.set(0, h + 1.35, 0.1);
          group.add(title);
        }
      }
    } else if (obj.type === "shop") {
      // お店: カウンター・しまの日よけ・看板・前の輪（入るかタップすると、お店が開く）
      const wood = new THREE.MeshLambertMaterial({ color: 0xc98f5a });
      const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 0.8), wood);
      counter.position.y = 0.45;
      const top = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.95), new THREE.MeshLambertMaterial({ color: 0xf6e6c8 }));
      top.position.y = 0.94;
      root.add(counter, top);
      for (const sx of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), wood);
        pole.position.set(sx * 1.1, 1.1, -0.3);
        root.add(pole);
      }
      const c = document.createElement("canvas");
      c.width = 256;
      c.height = 64;
      const g2 = c.getContext("2d");
      for (let i = 0; i < 8; i++) {
        g2.fillStyle = i % 2 ? "#ffffff" : "#ff6f91";
        g2.fillRect(i * 32, 0, 32, 64);
      }
      const awning = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.9), new THREE.MeshLambertMaterial({ map: canvasTexture(THREE, c), side: THREE.DoubleSide }));
      awning.position.set(0, 2.1, 0.05);
      awning.rotation.x = -0.6;
      root.add(awning);
      const icon = sprite(THREE, ["🛍"], { width: 256, height: 256, fontSize: 130, bg: "rgba(255,255,255,0.96)", color: "#2a2440", radius: 128 }, 0.8);
      icon.position.y = 2.95;
      const label = sprite(THREE, [obj.title], { width: 768, height: 120, fontSize: 58, bg: "rgba(255,111,145,0.95)", color: "#ffffff", radius: 40 }, 2.3);
      label.position.y = 2.55;
      label.position.z = 0.5;
      root.add(icon, label);
      for (const m of [counter, top, icon, label, awning]) {
        m.userData.item = item;
        item.hits.push(m);
      }
      const start = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.75, 36),
        new THREE.MeshBasicMaterial({ color: 0xff6f91, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
      );
      start.rotation.x = -Math.PI / 2;
      start.position.set(0, 0.02, 1.7);
      root.add(start);
      const ry = root.rotation.y;
      item.startPoint = new THREE.Vector3(slot.x + Math.sin(ry) * 1.7, 0, slot.z + Math.cos(ry) * 1.7);
      item.shop = true;
      item.update = (t) => {
        icon.position.y = 2.95 + Math.sin(t * 2 + slot.x) * 0.06;
        start.material.opacity = 0.55 + Math.sin(t * 3) * 0.25;
      };
    } else {
      // ミニゲームの屋台: 丸い台・アーチ・名前・前の光る輪
      const color = GAME_COLORS[obj.type] || 0xffffff;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.2, 0.25, 32), new THREE.MeshLambertMaterial({ color: 0xfaf6ee }));
      base.position.y = 0.12;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.06, 8, 40), new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.26;
      const arch = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.09, 10, 32, Math.PI), new THREE.MeshLambertMaterial({ color }));
      arch.position.y = 0.25;
      const icon = sprite(THREE, [GAME_ICON[obj.type] || "?"], { width: 256, height: 256, fontSize: 130, bg: "rgba(255,255,255,0.96)", color: "#2a2440", radius: 128 }, 0.9);
      icon.position.y = 1.55;
      const label = sprite(THREE, [obj.title], { width: 768, height: 120, fontSize: 58, bg: "rgba(255,255,255,0.94)", color: "#2a2440", radius: 40 }, 2.3);
      label.position.y = 2.35;
      root.add(base, ring, arch, icon, label);
      if (SENSOR_TYPES.has(obj.type)) {
        const tag = sprite(THREE, ["📱 スマホで"], { width: 384, height: 110, fontSize: 56, bg: "rgba(40,36,64,0.9)", color: "#ffffff", radius: 50 }, 1.1);
        tag.position.y = 0.85;
        tag.position.z = 0.9;
        root.add(tag);
      }
      base.userData.item = item;
      icon.userData.item = item;
      label.userData.item = item;
      item.hits.push(base, icon, label);

      // 前（真ん中側）に、入ると始まる輪
      const start = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.75, 36),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
      );
      start.rotation.x = -Math.PI / 2;
      start.position.set(0, 0.02, 2.0);
      root.add(start);
      // 輪の位置（空間の座標）。行列がまだ更新されていないので、向きから直接求める
      const ry = root.rotation.y;
      item.startPoint = new THREE.Vector3(slot.x + Math.sin(ry) * 2, 0, slot.z + Math.cos(ry) * 2);
      item.update = (t) => {
        icon.position.y = 1.55 + Math.sin(t * 2 + slot.x) * 0.08;
        start.material.opacity = 0.55 + Math.sin(t * 3) * 0.25;
      };
    }
    items.push(item);
  }

  return {
    items,
    hitTargets: items.flatMap((i) => i.hits),
    update(t) {
      for (const i of items) i.update?.(t);
    },
    refreshMembers(names) {
      for (const i of items) i.refreshMembers?.(names);
    },
    dispose() {
      for (const i of items) {
        if (i.video) {
          i.video.pause();
          i.video.removeAttribute("src");
          i.video.load();
        }
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
