/**
 * キャラクターの3Dモデル（public/characters/*.glb）を読む、最小の読み込み器。
 *
 * three.js 本体に付いている GLTFLoader は使っていない。理由は2つ:
 *   - 外部CDNから追加で読むと、回線の細い端末・CDNが塞がれた環境でメタバースだけ動かなくなる
 *   - わけたまのモデルは「骨なし・テクスチャなし・頂点色だけ」の決まった形なので、
 *     必要な読み取りは50行ほどで済む（tools/characters/make_characters.py と、初期の30体がこの形）
 *
 * 読めるもの: POSITION / COLOR_0（uint8 正規化・float）/ indices、ノードの matrix・TRS・子
 * 読めないもの: テクスチャ・骨・アニメーション（使っていない）
 */

const cache = new Map();

function componentArray(gltf, bin, accessorIndex) {
  const acc = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[acc.bufferView];
  const offset = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const count = acc.count * size;
  const Ctor = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array,
  }[acc.componentType];
  // byteStride が付いていない前提（trimesh の書き出しは詰めて並べる）
  return { array: new Ctor(bin.buffer, bin.byteOffset + offset, count), size, normalized: !!acc.normalized, type: acc.componentType };
}

function parse(THREE, buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("glb ではありません");
  let offset = 12;
  let gltf = null;
  let bin = null;
  while (offset < buffer.byteLength) {
    const length = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const body = new Uint8Array(buffer, offset + 8, length);
    if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004e4942) bin = body;
    offset += 8 + length;
  }
  if (!gltf || !bin) throw new Error("glb の中身が足りません");

  const meshes = (gltf.meshes || []).map((mesh) =>
    mesh.primitives.map((prim) => {
      const geo = new THREE.BufferGeometry();
      const pos = componentArray(gltf, bin, prim.attributes.POSITION);
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos.array), 3));
      if (prim.attributes.COLOR_0 !== undefined) {
        const col = componentArray(gltf, bin, prim.attributes.COLOR_0);
        const n = col.array.length / col.size;
        const rgb = new Float32Array(n * 3);
        const scale = col.type === 5121 ? 1 / 255 : col.type === 5123 ? 1 / 65535 : 1;
        const c = new THREE.Color();
        for (let i = 0; i < n; i++) {
          // 頂点色はsRGBで入っている。three.js は線形で計算するので変換しておく（しないと色が白っぽくなる）
          c.setRGB(col.array[i * col.size] * scale, col.array[i * col.size + 1] * scale, col.array[i * col.size + 2] * scale, THREE.SRGBColorSpace);
          rgb[i * 3] = c.r;
          rgb[i * 3 + 1] = c.g;
          rgb[i * 3 + 2] = c.b;
        }
        geo.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
      }
      if (prim.indices !== undefined) {
        const idx = componentArray(gltf, bin, prim.indices);
        geo.setIndex(new THREE.BufferAttribute(idx.array instanceof Uint32Array ? new Uint32Array(idx.array) : new Uint16Array(idx.array), 1));
      }
      geo.computeVertexNormals();
      return geo;
    })
  );

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const buildNode = (index) => {
    const node = gltf.nodes[index];
    const obj = new THREE.Group();
    if (node.matrix) {
      obj.applyMatrix4(new THREE.Matrix4().fromArray(node.matrix));
    } else {
      if (node.translation) obj.position.fromArray(node.translation);
      if (node.rotation) obj.quaternion.fromArray(node.rotation);
      if (node.scale) obj.scale.fromArray(node.scale);
    }
    if (node.mesh !== undefined) {
      for (const geo of meshes[node.mesh]) obj.add(new THREE.Mesh(geo, material));
    }
    for (const child of node.children || []) obj.add(buildNode(child));
    return obj;
  };

  const root = new THREE.Group();
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene ? scene.nodes : gltf.nodes.map((_, i) => i);
  for (const i of roots) root.add(buildNode(i));
  return root;
}

/**
 * 種族・色のモデルを読み、複製を返す（同じ姿は1回だけ取りに行く）。
 * 読めなかったときは null（呼び出し側で丸い仮の姿に差し替える）。
 */
export async function loadCharacter(THREE, species, color) {
  const key = `${species}_${color}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      fetch(`/characters/${encodeURIComponent(key)}.glb`)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(String(res.status)))))
        .then((buf) => parse(THREE, buf))
        .catch(() => null)
    );
  }
  const base = await cache.get(key);
  return base ? base.clone(true) : null;
}
