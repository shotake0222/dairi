/**
 * 吹き出しの中の「視線で選ぶ」入力（メタバース用の小さな版。本格的な文字入力は /eyes）。
 *
 * 6つの枠（2行×3列）に言葉を並べ、見ている枠を1.2秒見続けると選ばれる。
 * 視線はカメラの映像から目の向き（MediaPipe の顔のブレンドシェイプ）を読む。/eyes と同じ仕組み。
 * **映像は端末の中だけで使い、保存も送信もしない。** 使えないとき（カメラが無い・許可しない）は、
 * 枠が順番に光る「スイッチ操作」になり、画面のどこかをタップすると光っている枠が選ばれる。
 */

const PAGES = [
  ["こんにちは！", "元気？", "ありがとう", "すきだよ", "あそぼう！", "つぎへ ▶"],
  ["なにしてるの？", "いい天気だね", "おなかすいた", "ねむいな", "また会おうね", "つぎへ ▶"],
  ["すごい！", "たのしいね", "がんばって", "おやすみ", "ごめんね", "はじめへ ▶"],
];

const DWELL_MS = 1200;

export function openGazePicker(host, { onPick, onClose }) {
  let page = 0;
  let mode = "starting";
  let hovered = -1;
  let dwellStart = 0;
  let raf = 0;
  let scanTimer = 0;
  let stream = null;
  let landmarker = null;
  let closed = false;

  host.innerHTML = `
    <div class="gzHead"><span class="gzMode">視線をじゅんび中…</span><button type="button" class="gzClose">とじる</button></div>
    <div class="gzGrid"></div>
    <video class="gzCam" playsinline muted></video>`;
  const grid = host.querySelector(".gzGrid");
  const modeEl = host.querySelector(".gzMode");
  const video = host.querySelector(".gzCam");
  host.querySelector(".gzClose").addEventListener("click", () => close());

  function render() {
    grid.innerHTML = "";
    PAGES[page].forEach((text, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gzCell";
      b.textContent = text;
      b.style.setProperty("--p", "0");
      b.addEventListener("click", () => choose(i));
      grid.appendChild(b);
    });
  }

  function setActive(i, progress) {
    grid.querySelectorAll(".gzCell").forEach((el, k) => {
      el.classList.toggle("on", k === i);
      el.style.setProperty("--p", k === i ? String(progress) : "0");
    });
  }

  function choose(i) {
    const text = PAGES[page][i];
    if (!text) return;
    if (i === 5) {
      page = (page + 1) % PAGES.length;
      render();
      hovered = -1;
      return;
    }
    onPick(text);
  }

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    clearInterval(scanTimer);
    stream?.getTracks().forEach((t) => t.stop());
    host.innerHTML = "";
    onClose?.();
  }

  function startScan() {
    mode = "scan";
    modeEl.textContent = "スイッチ操作: 光った言葉のときに、この枠の外をタップ";
    let i = 0;
    scanTimer = setInterval(() => {
      hovered = i % 6;
      setActive(hovered, 1);
      i++;
    }, 1100);
    const tap = (e) => {
      if (closed) return document.removeEventListener("pointerdown", tap, true);
      if (host.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (hovered >= 0) choose(hovered);
    };
    document.addEventListener("pointerdown", tap, true);
  }

  async function startGaze() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360, facingMode: "user" }, audio: false });
      video.srcObject = stream;
      await video.play();
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs");
      const fileset = await vision.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
      landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
      if (closed) return;
      mode = "gaze";
      modeEl.textContent = "視線: 選びたい言葉を見つめてね（映像は送りません）";
      loop();
    } catch {
      stream?.getTracks().forEach((t) => t.stop());
      if (!closed) startScan();
    }
  }

  function loop() {
    let last = -1;
    let sx = 0;
    let sy = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!landmarker || video.readyState < 2 || video.currentTime === last) return;
      last = video.currentTime;
      let res;
      try {
        res = landmarker.detectForVideo(video, performance.now());
      } catch {
        return;
      }
      const shapes = res?.faceBlendshapes?.[0]?.categories;
      if (!shapes) {
        setActive(-1, 0);
        return;
      }
      const get = (n) => shapes.find((s) => s.categoryName === n)?.score ?? 0;
      const x = (get("eyeLookInLeft") + get("eyeLookOutRight")) / 2 - (get("eyeLookOutLeft") + get("eyeLookInRight")) / 2;
      const y = (get("eyeLookDownLeft") + get("eyeLookDownRight")) / 2 - (get("eyeLookUpLeft") + get("eyeLookUpRight")) / 2;
      sx = sx * 0.7 + x * 0.3;
      sy = sy * 0.7 + y * 0.3;
      const col = sx < -0.12 ? 0 : sx > 0.12 ? 2 : 1;
      const row = sy > 0.05 ? 1 : 0;
      const zone = row * 3 + col;
      if (zone !== hovered) {
        hovered = zone;
        dwellStart = performance.now();
      }
      const progress = Math.min(1, (performance.now() - dwellStart) / DWELL_MS);
      setActive(hovered, progress);
      if (progress >= 1) {
        dwellStart = performance.now() + 600; // 続けて選ばれないように、少し休む
        choose(hovered);
      }
    };
    tick();
  }

  render();
  startGaze();
  return { close };
}
