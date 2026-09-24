/**
 * 管理画面「広告・ランドマーク」のプレビュー。
 *
 * メタバースの画面と**同じ部品**（world.mjs の場所、objects.mjs の置く物、land.mjs の区画の広告・ランドマーク）で、
 * 選んだエリア・区画に置いたときの見え方を描く。書いた中身を保存する前に、どう見えるかを確かめるためのもの。
 *
 *   window.WaketamaLandPreview.render(canvas, { room, catalog, placement })
 *     room: エリアの設定（place・time・objects）  placement: { spot, kind, content }
 */

import * as THREE from "/vendor/three.module.min.js";
import { buildWorld } from "/meta/world.mjs";
import { buildObjects } from "/meta/objects.mjs";
import { buildPlacements } from "/meta/land.mjs";

let renderer = null;
let current = null; // { scene, camera, world, things, land, canvas }
let raf = 0;

function disposeCurrent() {
  if (!current) return;
  current.world?.dispose?.();
  current.things?.dispose?.();
  current.land?.dispose?.();
  current = null;
}

function loop() {
  raf = 0;
  if (!current || !renderer) return;
  // 画面に出ていないあいだは描かない（ほかのタブを見ているとき）
  if (current.canvas.offsetParent === null) return;
  const t = performance.now() / 1000;
  current.world?.update?.(t);
  current.things?.update?.(t);
  current.land?.update?.(t);
  renderer.render(current.scene, current.camera);
  raf = requestAnimationFrame(loop);
}

function render(canvas, { room, catalog, placement }) {
  if (!renderer || renderer.domElement !== canvas) {
    renderer?.dispose?.();
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const w = canvas.clientWidth || canvas.width;
  const h = Math.round((w * 380) / 560);
  renderer.setSize(w, h, false);

  disposeCurrent();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 120);
  const world = buildWorld(THREE, scene, room.place, room.time);
  const things = buildObjects(THREE, scene, room.objects || [], catalog);
  const land = buildPlacements(THREE, scene, placement ? [{ id: "preview", ...placement }] : [], [], catalog);

  // 区画の正面（空間の真ん中側）から、少し見上げるように撮る
  const spot = (catalog.landSpots || []).find((s) => s.id === placement?.spot) || { x: 0, z: -8 };
  const toCenter = new THREE.Vector3(-spot.x, 0, -spot.z).normalize();
  const landmark = placement?.kind === "landmark";
  const dist = landmark ? 7 : 4.6;
  camera.position.set(spot.x + toCenter.x * dist, landmark ? 3.4 : 2.4, spot.z + toCenter.z * dist);
  camera.lookAt(spot.x, landmark ? 2.4 : 1.9, spot.z);
  // カメラと区画のあいだにある内側の看板・屋台は、見えなくする（区画の物が隠れないように）
  const a = new THREE.Vector2(camera.position.x, camera.position.z);
  const b = new THREE.Vector2(spot.x, spot.z);
  for (const item of things.items || []) {
    const p = new THREE.Vector2(item.root.position.x, item.root.position.z);
    const ab = b.clone().sub(a);
    const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
    if (a.clone().add(ab.multiplyScalar(t)).distanceTo(p) < 3.2) item.root.visible = false;
  }

  current = { scene, camera, world, things, land, canvas };
  if (!raf) raf = requestAnimationFrame(loop);
}

window.WaketamaLandPreview = { render };
window.dispatchEvent(new Event("waketama-land-preview-ready"));
