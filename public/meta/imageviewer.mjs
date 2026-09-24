/**
 * 広告・看板の画像を、細かいところまで見られる拡大表示。
 *
 *   ピンチ（2本指）… 拡大・縮小      ダブルタップ … 2.5倍 ⇔ 等倍
 *   ドラッグ       … 拡大中の移動    ホイール     … 拡大・縮小（パソコン）
 *
 * 画像はブラウザがそのまま読むだけ（どこにも送らない）。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createImageViewer($) {
  const root = $("imgViewer");
  const img = $("imgViewerImg");
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pointers = new Map();
  let pinch = null;
  let lastTap = 0;

  function apply() {
    img.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  /** 拡大しているときだけ、画像の外へ出すぎないように止める */
  function bound() {
    const w = img.clientWidth * scale;
    const h = img.clientHeight * scale;
    const mx = Math.max(0, (w - innerWidth) / 2);
    const my = Math.max(0, (h - innerHeight) / 2);
    tx = clamp(tx, -mx, mx);
    ty = clamp(ty, -my, my);
  }

  function zoomAt(next, cx, cy) {
    const s = clamp(next, 1, 6);
    // 指の位置を中心に拡大する
    const ox = cx - innerWidth / 2 - tx;
    const oy = cy - innerHeight / 2 - ty;
    tx -= ox * (s / scale - 1);
    ty -= oy * (s / scale - 1);
    scale = s;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    bound();
    apply();
  }

  function open(src, alt) {
    scale = 1;
    tx = 0;
    ty = 0;
    img.src = src;
    img.alt = alt || "";
    apply();
    root.hidden = false;
  }

  function close() {
    root.hidden = true;
    img.removeAttribute("src");
    pointers.clear();
    pinch = null;
  }

  root.addEventListener("pointerdown", (e) => {
    if (e.target === $("imgViewerClose")) return;
    root.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    } else {
      const now = performance.now();
      if (now - lastTap < 300) {
        zoomAt(scale > 1.2 ? 1 : 2.5, e.clientX, e.clientY);
        lastTap = 0;
      } else lastTap = now;
    }
  });
  root.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((pinch.scale * d) / Math.max(1, pinch.d), pinch.cx, pinch.cy);
    } else if (pointers.size === 1 && scale > 1) {
      tx += dx;
      ty += dy;
      bound();
      apply();
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
  };
  root.addEventListener("pointerup", up);
  root.addEventListener("pointercancel", up);
  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
    },
    { passive: false }
  );
  $("imgViewerClose").addEventListener("click", close);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) close();
  });

  return { open, close };
}
