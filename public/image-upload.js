/**
 * 画像のアップロード欄（広告・ランドマーク・看板）。
 *
 *   WaketamaImageUpload.attach(input, { endpoint: "/api/admin/media" })
 *
 * 「画像のURL」の入力欄の下に「📷 画像を選ぶ」ボタン・小さな見本・「外す」を足す。
 * 選んだ画像は**この端末で縮めて**（長い辺1600px・WebP、使えない端末では JPEG）送り、
 * 返ってきた URL（/img/…）を入力欄へ自動で入れる。入力欄には今までどおり https:// のURLを貼ってもよい。
 *
 * - 撮った写真に入っている位置情報など（Exif）は、描き直すときに落ちる（そのまま送らない）
 * - 入力欄へ入れたあと input / change を出すので、プレビューなど今までの仕組みがそのまま動く
 * - ボタンの上へ画像をドラッグしても、欄を選んで貼り付けても（Ctrl+V / ⌘V）アップロードできる
 */
(function () {
  "use strict";

  var MAX_SIDE = 1600;
  /** サーバーの上限（1.5MB）より少し小さく */
  var MAX_BYTES = 1400000;

  function injectStyle() {
    if (document.getElementById("wtImgUpStyle")) return;
    var st = document.createElement("style");
    st.id = "wtImgUpStyle";
    st.textContent =
      ".wtImgUp{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-weight:400}" +
      ".wtImgUp button{font:inherit;font-size:13px;padding:7px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.18);background:#fff;color:inherit;cursor:pointer;width:auto}" +
      ".wtImgUp button.pick{background:#ff8a3d;border-color:transparent;color:#fff;font-weight:700}" +
      ".wtImgUp button:disabled{opacity:.55;cursor:wait}" +
      ".wtImgUp.drag button.pick{outline:3px dashed #ff8a3d;outline-offset:2px}" +
      ".wtImgUp img{width:64px;height:48px;object-fit:cover;border-radius:8px;border:1px solid rgba(0,0,0,.12);background:#f4f1ec}" +
      ".wtImgUp .st{font-size:12px;color:#7a7066;flex-basis:100%}" +
      ".wtImgUp .st.err{color:#c0392b}" +
      "@media (prefers-color-scheme:dark){.wtImgUp button{background:#2a2622;border-color:rgba(255,255,255,.2)}.wtImgUp .st{color:#b8ada2}}";
    document.head.appendChild(st);
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, type, quality);
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  /** 縮めて WebP（だめなら JPEG）にする。上限に収まるまで画質→大きさの順に下げる */
  async function shrink(file) {
    var src;
    try {
      src = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      src = await loadImage(file);
    }
    var w0 = src.width, h0 = src.height;
    if (!w0 || !h0) throw new Error("decode");
    var side = MAX_SIDE;
    var webpOk = true;
    for (var round = 0; round < 4; round++) {
      var scale = Math.min(1, side / Math.max(w0, h0));
      var w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(src, 0, 0, w, h);
      var qualities = [0.86, 0.76, 0.66, 0.56];
      for (var i = 0; i < qualities.length; i++) {
        var blob = webpOk ? await toBlob(canvas, "image/webp", qualities[i]) : null;
        if (webpOk && (!blob || blob.type !== "image/webp")) webpOk = false;
        if (!webpOk) {
          // JPEG は透明を持てないので、白い地に描き直す
          if (i === 0) {
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(src, 0, 0, w, h);
          }
          blob = await toBlob(canvas, "image/jpeg", qualities[i]);
        }
        if (blob && blob.size <= MAX_BYTES) return { blob: blob, width: w, height: h };
      }
      side = Math.round(side * 0.72);
    }
    throw new Error("too_large");
  }

  function attach(input, opts) {
    if (!input || input.dataset.wtImgUp) return;
    input.dataset.wtImgUp = "1";
    opts = opts || {};
    var endpoint = opts.endpoint || "/api/admin/media";
    injectStyle();
    if (!input.placeholder || input.placeholder === "https://…") input.placeholder = "アップロードすると自動で入ります（https:// のURLも可）";

    var row = document.createElement("div");
    row.className = "wtImgUp";
    var pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pick";
    pick.textContent = "📷 画像を選ぶ";
    var file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.hidden = true;
    var thumb = document.createElement("img");
    thumb.alt = "";
    thumb.hidden = true;
    var clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "外す";
    clear.hidden = true;
    var status = document.createElement("span");
    status.className = "st";
    status.textContent = "JPEG・PNG・WebP。この端末で小さくしてから送ります（写真の位置情報は送りません）";
    row.appendChild(pick);
    row.appendChild(thumb);
    row.appendChild(clear);
    row.appendChild(file);
    row.appendChild(status);
    input.insertAdjacentElement("afterend", row);

    function showThumb() {
      var v = (input.value || "").trim();
      var ok = /^\/img\/[a-f0-9]{24}\.(webp|jpg|png)$/.test(v) || /^https:\/\//.test(v);
      thumb.hidden = !ok;
      clear.hidden = !v;
      if (ok && thumb.getAttribute("src") !== v) thumb.src = v;
    }
    thumb.onerror = function () { thumb.hidden = true; };

    function setValue(v) {
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      showThumb();
    }

    function say(text, isErr) {
      status.textContent = text;
      status.className = "st" + (isErr ? " err" : "");
    }

    async function upload(f) {
      if (!f) return;
      if (!/^image\//.test(f.type || "") && !/\.(jpe?g|png|webp|heic|heif|gif)$/i.test(f.name || "")) {
        say("画像のファイルを選んでください", true);
        return;
      }
      pick.disabled = true;
      say("小さくしています……");
      try {
        var out = await shrink(f);
        say("送っています……（" + Math.round(out.blob.size / 1000) + "KB）");
        var res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": out.blob.type },
          body: out.blob,
          credentials: "same-origin",
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.url) throw new Error(data.error || "アップロードできませんでした（" + res.status + "）");
        setValue(data.url);
        say("アップロードしました（" + out.width + "×" + out.height + "・" + Math.round(out.blob.size / 1000) + "KB）");
        if (typeof opts.onUploaded === "function") opts.onUploaded(data.url);
      } catch (e) {
        var msg = e && e.message;
        if (msg === "decode") msg = "この画像は読み込めませんでした。JPEG・PNG で保存し直してお試しください";
        else if (msg === "too_large") msg = "画像が大きすぎて小さくできませんでした";
        say(msg || "アップロードできませんでした", true);
      } finally {
        pick.disabled = false;
      }
    }

    pick.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      var f = file.files && file.files[0];
      file.value = "";
      upload(f);
    });
    clear.addEventListener("click", function () {
      setValue("");
      say("画像を外しました");
    });
    input.addEventListener("input", showThumb);
    input.addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length && /^image\//.test(items[0].type)) {
        e.preventDefault();
        upload(items[0]);
      }
    });
    ["dragenter", "dragover"].forEach(function (t) {
      row.addEventListener(t, function (e) { e.preventDefault(); row.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (t) {
      row.addEventListener(t, function () { row.classList.remove("drag"); });
    });
    row.addEventListener("drop", function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      upload(f);
    });

    // 入力欄の値をスクリプトで入れ替えたとき（保存済みのものを開いたとき）に、見本を合わせ直す口
    input.wtImgRefresh = showThumb;
    showThumb();
    return { refresh: showThumb };
  }

  window.WaketamaImageUpload = { attach: attach };
})();
