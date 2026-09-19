/**
 * 「ホーム画面に追加」の案内。
 *
 * **なぜ画面をまたぐ共通スクリプトにしたか。**
 * 依代（キーホルダー）を無くすと、案内を見ていない人は分身に戻る道が無くなる。
 * いちばん効くのは会話画面（/chat）で、次がホーム（/home）。
 * 2箇所に別々に書くと、片方だけ直して文言も条件も食い違う。実際に、
 * 案内が出るのは /home だけで、依代から来てそのまま /chat に居続ける人には
 * 一度も出ていなかった。
 *
 * 出し分け:
 *   - Chrome系 … `beforeinstallprompt` が来たときだけボタンを出す（＝入れられるときだけ）
 *   - iOS Safari … そのイベントが無い。共有メニューからの手順を文章で出す
 *   - それ以外 … 何も出さない。**入れられない端末に案内を出すのが一番たちが悪い**
 *
 * 出さない条件: すでにホーム画面から開いている／一度閉じた／iOSのSafari以外のブラウザ
 * （Chrome for iOS などは共有メニューの項目が違うので、書いたとおりに操作できない）。
 *
 * 使い方（HTML側）:
 *   <script src="/install-hint.js" defer></script>
 *   window.waketamaInstallHint.mount(document.getElementById("ここ"));
 *   // 第2引数で文面を変えられる: mount(el, { text: "…" })
 */
(function () {
  "use strict";

  const DISMISS_KEY = "sodatsukake_installHintDismissed";

  const STYLE = `
  .wtInstall { display: flex; align-items: flex-start; gap: 12px;
    background: #fff; border: 1px solid #ece8fb; border-radius: 14px; padding: 12px 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif; }
  .wtInstall .t { flex: 1; font-size: 12px; color: #5b4b99; line-height: 1.75; }
  .wtInstall .t strong { color: #43368a; }
  .wtInstall .ic { display: inline-block; border: 1px solid #c8bcff; border-radius: 6px;
    padding: 0 6px; font-size: 11px; color: #7c5cff; white-space: nowrap; }
  .wtInstall button.go { border: none; background: #7c5cff; color: #fff; font-size: 12px;
    font-weight: 700; padding: 9px 16px; border-radius: 999px; cursor: pointer; white-space: nowrap;
    font-family: inherit; align-self: center; }
  .wtInstall button.go:disabled { opacity: .6; }
  .wtInstall button.x { border: none; background: none; color: #b9b0d8; font-size: 18px;
    line-height: 1; cursor: pointer; padding: 0 2px; flex-shrink: 0; }
  `;

  // 見出し（「ホーム画面に追加しておくと安心です」）は下で必ず付くので、
  // ここに同じことを書かない。並べると同じ文が2回出る。
  const DEFAULT_TEXT = "依代（キーホルダー）が手元になくても、ここから分身に会いに来られます。";
  const HEAD = "<strong>ホーム画面に追加しておくと安心です。</strong><br />";

  function injectStyle() {
    if (document.getElementById("wtInstallStyle")) return;
    const s = document.createElement("style");
    s.id = "wtInstallStyle";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function dismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch (e) {
      return false; // 読めないだけなら出す
    }
  }

  function remember() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch (e) {
      /* 覚えられなくても、閉じることはできる */
    }
  }

  /** すでにホーム画面から開かれているか */
  function isStandalone() {
    if (window.navigator.standalone === true) return true;
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  /** iPadOSはUAがMacを名乗るので、タッチできるMacintoshもiPadとして扱う */
  function isIosSafari() {
    const ua = navigator.userAgent || "";
    const ios = /iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return ios && safari;
  }

  function build(inner) {
    const box = document.createElement("div");
    box.className = "wtInstall";
    box.setAttribute("data-install-hint", "");
    box.innerHTML = inner;
    return box;
  }

  function mount(container, opts) {
    if (!container) return null;
    const text = (opts && opts.text) || DEFAULT_TEXT;
    if (isStandalone() || dismissed()) return null;
    injectStyle();

    // --- iOS Safari: ボタンでは追加できないので、手順を出す ---
    if (isIosSafari()) {
      const box = build(
        '<div class="t">' + HEAD +
          '画面下の <span class="ic">共有</span> を押して、「<strong>ホーム画面に追加</strong>」を選んでください。<br />' +
          text +
          "</div>" +
          '<button class="x" type="button" title="閉じる" aria-label="閉じる">×</button>'
      );
      container.appendChild(box);
      box.querySelector(".x").addEventListener("click", function () {
        box.remove();
        remember();
      });
      return box;
    }

    // --- Chrome系: 入れられると分かったときだけ出す ---
    let deferred = null;
    let box = null;

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferred = e;
      if (box || dismissed()) return;
      box = build(
        '<div class="t">' + HEAD + text + "</div>" +
          '<button class="go" type="button">追加する</button>' +
          '<button class="x" type="button" title="閉じる" aria-label="閉じる">×</button>'
      );
      container.appendChild(box);

      box.querySelector(".go").addEventListener("click", async function (ev) {
        if (!deferred) return;
        ev.currentTarget.disabled = true;
        try {
          deferred.prompt();
          await deferred.userChoice;
        } catch (err) {
          /* 閉じられただけなので何もしない */
        }
        deferred = null;
        box.remove();
        box = null;
      });
      box.querySelector(".x").addEventListener("click", function () {
        box.remove();
        box = null;
        remember();
      });
    });

    window.addEventListener("appinstalled", function () {
      if (box) {
        box.remove();
        box = null;
      }
    });
    return null;
  }

  window.waketamaInstallHint = { mount: mount, DISMISS_KEY: DISMISS_KEY };
})();
