/*
 * パルスサーベイの小さなカード。
 *
 * 会話画面と属性ページの両方に同じものを置くための、共有の部品。
 * ページごとに書くと、同意の扱いや「あとで」の挙動が必ずずれる——
 * そしてズレた側は、たいてい同意を取らずに保存してしまう方に倒れる。
 * だからここ1箇所に閉じ込めてある。
 *
 * 使い方:
 *   <div id="pulse"></div>
 *   <script src="/pulse.js" defer></script>
 *   <script>WaketamaPulse.mount({ slot: "#pulse", cid, token });</script>
 *
 * options:
 *   continuous: true にすると、答えるたびに次の1問を出す（属性ページ向け）。
 *               既定は1問だけ（会話の邪魔をしないため）。
 *   onDepth:    厚みが更新されたときに呼ばれる。
 */
(function () {
  "use strict";

  var STYLE_ID = "waketama-pulse-style";
  var CSS = [
    ".wtPulse{border:1px solid #e4defb;background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0;",
    "font-size:14px;line-height:1.8;color:#1c1630;box-shadow:0 6px 18px rgba(124,92,255,0.06)}",
    ".wtPulse[hidden]{display:none}",
    ".wtPulse .wtTag{font-size:10px;font-weight:700;letter-spacing:.08em;color:#7c5cff;background:#f0ecff;",
    "border-radius:999px;padding:3px 10px;display:inline-block}",
    ".wtPulse h4{margin:9px 0 4px;font-size:15px;line-height:1.6}",
    ".wtPulse .wtWhy{margin:0 0 10px;font-size:12px;color:#6f668f}",
    ".wtPulse .wtOpts{display:flex;flex-wrap:wrap;gap:8px}",
    ".wtPulse button.wtOpt{font:inherit;font-size:13px;padding:9px 14px;border-radius:999px;border:1px solid #e4defb;",
    "background:#faf8ff;color:#1c1630;cursor:pointer}",
    ".wtPulse button.wtOpt[aria-pressed=true]{background:#7c5cff;border-color:#7c5cff;color:#fff;font-weight:700}",
    ".wtPulse .wtRow{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}",
    ".wtPulse .wtSend{font:inherit;font-size:13px;font-weight:700;padding:10px 20px;border-radius:999px;border:none;",
    "background:#7c5cff;color:#fff;cursor:pointer}",
    ".wtPulse .wtSend:disabled{opacity:.4}",
    ".wtPulse .wtLater{font:inherit;font-size:12px;color:#6f668f;background:none;border:none;cursor:pointer;",
    "text-decoration:underline;padding:6px}",
    ".wtPulse .wtMsg{font-size:13px;color:#4c3a99}",
    ".wtPulse .wtBar{height:6px;border-radius:999px;background:#eee9fb;overflow:hidden;margin-top:10px}",
    ".wtPulse .wtBar i{display:block;height:100%;background:linear-gradient(90deg,#a78bfa,#7c5cff)}",
    ".wtPulse .wtDepth{font-size:11px;color:#6f668f;margin-top:6px}",
  ].join("");

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  async function postJson(url, body) {
    var res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    var data = await res.json().catch(function () {
      return {};
    });
    return { ok: res.ok, data: data };
  }

  function mount(options) {
    ensureStyle();
    var slot = typeof options.slot === "string" ? document.querySelector(options.slot) : options.slot;
    if (!slot) return null;
    var cid = options.cid;
    var token = options.token;
    if (!cid || !token) return null; // 持ち主でなければ、そもそも設問を出さない

    var card = el("div", "wtPulse");
    card.hidden = true;
    slot.appendChild(card);

    var state = { item: null, selected: [], depth: null, busy: false };

    function renderDepth() {
      // 置き場所によっては、ページ側が同じ数字をもっと詳しく出している。
      // 同じものが2つ並ぶと、どちらが本物か分からなくなるので出さない。
      if (options.showDepth === false) return null;
      if (!state.depth) return null;
      var wrap = document.createElement("div");
      var bar = el("div", "wtBar");
      var fill = document.createElement("i");
      fill.style.width = Math.max(2, state.depth.score) + "%";
      bar.appendChild(fill);
      wrap.appendChild(bar);
      wrap.appendChild(
        el(
          "div",
          "wtDepth",
          "この分身の厚み " + state.depth.score + " / 100" + (state.depth.sellable ? "（出品できる水準です）" : "")
        )
      );
      return wrap;
    }

    function clear() {
      while (card.firstChild) card.removeChild(card.firstChild);
    }

    function showMessage(text) {
      clear();
      card.hidden = false;
      card.appendChild(el("div", "wtMsg", text));
      var depth = renderDepth();
      if (depth) card.appendChild(depth);
    }

    function renderConsent(consentText) {
      clear();
      card.hidden = false;
      card.appendChild(el("span", "wtTag", "分身に覚えてもらう"));
      card.appendChild(el("h4", null, "あなたのことを、この子に覚えさせてもいい？"));
      card.appendChild(el("p", "wtWhy", consentText || "答えた内容は、この分身との会話にだけ使われます。"));
      var row = el("div", "wtRow");
      var yes = el("button", "wtSend", "覚えてもらう");
      yes.type = "button";
      yes.addEventListener("click", async function () {
        yes.disabled = true;
        var res = await postJson("/api/consent", { characterId: cid, token: token, consent: { profile: true } });
        if (!res.ok) {
          showMessage(res.data.error || "うまく保存できませんでした");
          return;
        }
        load();
      });
      var no = el("button", "wtLater", "いまはやめておく");
      no.type = "button";
      no.addEventListener("click", function () {
        card.hidden = true;
      });
      row.appendChild(yes);
      row.appendChild(no);
      card.appendChild(row);
    }

    function renderItem(item) {
      clear();
      card.hidden = false;
      state.item = item;
      state.selected = [];

      card.appendChild(el("span", "wtTag", item.kind === "psychographic" ? "ひとつだけ教えて" : "あなたのこと"));
      card.appendChild(el("h4", null, item.label));
      if (item.why) card.appendChild(el("p", "wtWhy", item.why));

      var opts = el("div", "wtOpts");
      item.options.forEach(function (label) {
        var btn = el("button", "wtOpt", label);
        btn.type = "button";
        btn.setAttribute("aria-pressed", "false");
        btn.addEventListener("click", function () {
          if (item.type === "single") {
            send([label]);
            return;
          }
          var idx = state.selected.indexOf(label);
          if (idx >= 0) state.selected.splice(idx, 1);
          else if (!item.maxSelections || state.selected.length < item.maxSelections) state.selected.push(label);
          btn.setAttribute("aria-pressed", state.selected.indexOf(label) >= 0 ? "true" : "false");
          sendBtn.disabled = state.selected.length === 0;
        });
        opts.appendChild(btn);
      });
      card.appendChild(opts);

      var row = el("div", "wtRow");
      var sendBtn = el("button", "wtSend", "これで送る");
      sendBtn.type = "button";
      sendBtn.disabled = true;
      if (item.type === "single") sendBtn.hidden = true;
      sendBtn.addEventListener("click", function () {
        send(state.selected.slice());
      });
      row.appendChild(sendBtn);

      var later = el("button", "wtLater", "あとで");
      later.type = "button";
      later.addEventListener("click", async function () {
        await postJson("/api/survey/skip", { characterId: cid, token: token, id: item.id });
        if (options.continuous) load();
        else card.hidden = true;
      });
      row.appendChild(later);

      var stop = el("button", "wtLater", "もう聞かないで");
      stop.type = "button";
      stop.addEventListener("click", async function () {
        // ここで適当な回答を入れて済ませない。答えていないものを答えたことにするのは、
        // 集計にも人格データにも嘘が混ざるということなので、専用の口を叩く。
        await postJson("/api/survey/decline", { characterId: cid, token: token });
        showMessage("わかりました。これ以上は聞きません（属性ページからはいつでも答えられます）");
      });
      row.appendChild(stop);

      card.appendChild(row);
      var depth = renderDepth();
      if (depth) card.appendChild(depth);
    }

    async function send(values) {
      if (state.busy || !state.item) return;
      state.busy = true;
      var res = await postJson("/api/survey/answer", {
        characterId: cid,
        token: token,
        id: state.item.id,
        values: values,
      });
      state.busy = false;
      if (!res.ok) {
        showMessage(res.data.error || "うまく保存できませんでした");
        return;
      }
      showMessage("ありがとう。覚えておくね。");
      if (options.continuous) setTimeout(load, 900);
      else setTimeout(function () { load(true); }, 900);
    }

    async function load(depthOnly) {
      try {
        var res = await fetch(
          "/api/survey/next?cid=" + encodeURIComponent(cid) + "&token=" + encodeURIComponent(token)
        );
        if (!res.ok) {
          card.hidden = true;
          return;
        }
        var data = await res.json();
        state.depth = data.depth || null;
        if (typeof options.onDepth === "function" && state.depth) options.onDepth(state.depth, data);

        if (depthOnly) {
          // 1問だけのモードでは、答えたあとに次を出さない（会話の邪魔をしないため）
          var depth = renderDepth();
          if (depth) {
            clear();
            card.appendChild(el("div", "wtMsg", "ありがとう。覚えておくね。"));
            card.appendChild(depth);
          }
          return;
        }
        if (data.needsConsent) {
          renderConsent(data.consentText);
          return;
        }
        if (!data.item) {
          if (options.continuous) showMessage("いまお聞きすることはありません。ありがとうございました。");
          else card.hidden = true;
          return;
        }
        renderItem(data.item);
      } catch (e) {
        card.hidden = true;
      }
    }

    load();
    return { reload: load, element: card };
  }

  window.WaketamaPulse = { mount: mount };
})();
