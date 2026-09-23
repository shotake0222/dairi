/**
 * 部屋に置く物（管理画面で決めたもの）を、空間に立てる。
 *
 *   board    看板（文字・画像）。広告なら「広告」の札を必ず付ける。タップで詳しく・リンクへ
 *   video    動画スクリーン（音なし・くり返し）
 *   members  いまいる子の紹介
 *   treasure / quiz / rally  ミニゲームの屋台。タップするか、前の光る輪に分身が入ると始まる
 *
 * 置き場所は決まった7か所（src/metaverse.ts の SLOTS）で、どれも空間の真ん中を向く。
 */

import { textCanvas, wrapText } from "./world.mjs";

const GAME_COLORS = { treasure: 0xffc94d, quiz: 0x6fb8ff, rally: 0x7fdc8a };
const GAME_ICON = { treasure: "★", quiz: "○×", rally: "旗" };

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
