/*
 * 管理画面「通貨・お店」タブ（中身は src/economy.ts）。
 * admin.html の本体スクリプトにある api() / el() / table() を使う（このファイルはその後に読む）。
 */
(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function fmt(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() + " " + d.getHours() + ":" + pad2(d.getMinutes());
  }
  function post(path, body, method) {
    return api(path, { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function options(select, list, value) {
    select.innerHTML = "";
    list.forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.id;
      o.textContent = x.label;
      if (String(x.id) === String(value)) o.selected = true;
      select.appendChild(o);
    });
  }
  function input(label, value, attrs) {
    var wrap = el("label", label);
    var i = document.createElement(attrs && attrs.tag === "textarea" ? "textarea" : "input");
    Object.keys(attrs || {}).forEach(function (k) {
      if (k !== "tag") i.setAttribute(k, attrs[k]);
    });
    i.value = value == null ? "" : value;
    wrap.appendChild(i);
    return { wrap: wrap, input: i };
  }
  function select(label, list, value) {
    var wrap = el("label", label);
    var s = document.createElement("select");
    options(s, list, value);
    wrap.appendChild(s);
    return { wrap: wrap, input: s };
  }
  function check(label, value) {
    var wrap = el("label");
    wrap.className = "wide";
    wrap.style.cssText = "display:flex;gap:6px;align-items:center";
    var c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !!value;
    c.style.cssText = "width:auto;margin:0";
    wrap.appendChild(c);
    wrap.appendChild(document.createTextNode(" " + label));
    return { wrap: wrap, input: c };
  }
  function button(text, onClick, primary) {
    var b = el("button", text, { type: "button" });
    if (primary) b.style.cssText = "background:var(--brand);color:#fff;border-color:transparent";
    b.addEventListener("click", onClick);
    return b;
  }

  var state = { settings: null, items: [], shops: [], partners: [], kinds: [], shapes: [], effects: [] };
  var KIND_LABEL = { wear: "身につける物", effect: "演出", real: "リアル引換券" };
  var STATUS = { issued: "未使用", used: "使用済み", cancelled: "取り消し", expired: "期限切れ" };

  // ---------------------------------------------------------------- 設定
  var FIELDS = [
    ["ecName", "name"],
    ["ecUnit", "unit"],
    ["ecSymbol", "symbol"],
    ["ecLogin", "loginBonus", true],
    ["ecClear", "clearReward", true],
    ["ecTalk", "talkReward", true],
    ["ecTalkMax", "talkDailyMax", true],
    ["ecCap", "dailyEarnCap", true],
    ["ecMax", "maxBalance", true],
    ["ecVoucherMax", "voucherMonthlyLimit", true],
  ];
  function renderSettings() {
    var s = state.settings;
    FIELDS.forEach(function (f) {
      $(f[0]).value = s[f[1]];
    });
    $("ecEnabled").checked = s.enabled;
    $("ecReal").checked = s.realOpen;
  }
  $("ecSave").addEventListener("click", async function () {
    var body = { enabled: $("ecEnabled").checked, realOpen: $("ecReal").checked };
    FIELDS.forEach(function (f) {
      body[f[1]] = f[2] ? Number($(f[0]).value) : $(f[0]).value;
    });
    try {
      var r = await post("/api/admin/economy/settings", body);
      state.settings = r.settings;
      renderSettings();
      $("ecStatus").textContent = "保存しました";
    } catch (e) {
      $("ecStatus").textContent = e.message;
    }
  });

  // ---------------------------------------------------------------- 集計
  async function loadStats() {
    var host = $("ecStats");
    try {
      var r = await api("/api/admin/economy/stats");
      var s = r.stats;
      var unit = r.settings.unit;
      host.innerHTML = "";
      function card(title, lines) {
        var c = el("div");
        c.className = "card";
        c.appendChild(el("b", title));
        lines.forEach(function (l) {
          c.appendChild(el("div", l, { style: "font-size:12.5px;color:var(--muted)" }));
        });
        host.appendChild(c);
      }
      card("財布", ["財布の数: " + s.wallets, "流通中（残高の合計）: " + s.circulating.toLocaleString() + " " + unit, "これまでに貯まった: " + s.earned.toLocaleString() + "／使った: " + s.spent.toLocaleString()]);
      var kindLabel = { login: "毎日の入室", clear: "クリア", talk: "おしゃべり", grant: "運営の付与・回収", buy: "買い物", refund: "返金" };
      card(
        "直近30日の出入り",
        s.last30.length
          ? s.last30.map(function (k) {
              return (kindLabel[k.kind] || k.kind) + ": " + k.n + "回・" + (k.total > 0 ? "+" : "") + k.total.toLocaleString();
            })
          : ["まだありません"]
      );
      var pname = {};
      r.partners.forEach(function (p) {
        pname[p.id] = p.name;
      });
      card(
        "引換券（提携店ごと）",
        s.vouchers.length
          ? s.vouchers.map(function (v) {
              return (pname[v.partner_id] || v.partner_id) + "・" + (STATUS[v.status] || v.status) + ": " + v.n + "枚（" + v.coins.toLocaleString() + " " + unit + "）";
            })
          : ["まだありません"]
      );
      var iname = {};
      r.items.forEach(function (i) {
        iname[i.id] = i.name;
      });
      card(
        "よく売れた商品（30日）",
        s.topItems.length
          ? s.topItems.map(function (t) {
              return (iname[t.itemId] || t.itemId) + ": " + t.n;
            })
          : ["まだありません"]
      );
    } catch (e) {
      host.textContent = e.message;
    }
  }

  // ---------------------------------------------------------------- 商品
  function renderItems() {
    var sold = {};
    table("ecItems", ["", "名前", "種類", "値段", "在庫", "状態", ""], state.items, function (i) {
      var tr = el("tr");
      tr.appendChild(el("td", i.icon));
      tr.appendChild(el("td", i.name + (i.builtin ? "（最初から）" : "")));
      var kind = KIND_LABEL[i.kind] || i.kind;
      if (i.kind === "real") {
        var p = state.partners.find(function (x) {
          return x.id === i.partnerId;
        });
        kind += "・" + (p ? p.name : "提携店なし");
      }
      tr.appendChild(el("td", kind));
      tr.appendChild(el("td", i.price.toLocaleString()));
      tr.appendChild(el("td", i.stock == null ? "無制限" : String(i.stock)));
      tr.appendChild(el("td", i.active ? "販売中" : "止めている"));
      var td = el("td");
      td.appendChild(button("直す", function () {
        itemForm(i);
      }));
      td.appendChild(button("消す", async function () {
        if (!confirm("「" + i.name + "」を消しますか？（持っている人の持ち物は残ります）")) return;
        await api("/api/admin/economy/items?id=" + encodeURIComponent(i.id), { method: "DELETE" });
        loadEconomyPanel();
      }));
      tr.appendChild(td);
      void sold;
      return tr;
    });
  }

  function itemForm(item) {
    var box = $("ecItemForm");
    box.hidden = false;
    box.innerHTML = "";
    var it = Object.assign({ kind: "wear", price: 50, stock: null, active: true, sortOrder: 100, shape: "ribbon", color: "#ff7aa8", effect: "hanabi", validDays: 30, perPersonMonthly: 1 }, item || {});
    box.appendChild(el("b", item ? "商品を直す" : "商品を足す"));
    var grid = el("div");
    grid.className = "formGrid";
    var kind = select("種類", state.kinds, it.kind);
    if (item) kind.input.disabled = true;
    var name = input("名前", it.name, { maxlength: 24 });
    var price = input("値段", it.price, { type: "number", min: 1 });
    var icon = input("アイコン（絵文字）", it.icon, { maxlength: 4 });
    var desc = input("説明", it.description, { maxlength: 80 });
    var stock = input("在庫（空なら無制限）", it.stock == null ? "" : it.stock, { type: "number", min: 0 });
    var sort = input("並び順", it.sortOrder, { type: "number", min: 0 });
    [kind, name, price, icon, desc, stock, sort].forEach(function (f) {
      grid.appendChild(f.wrap);
    });
    var extra = el("div");
    extra.className = "formGrid";
    var refs = {};
    function renderExtra() {
      extra.innerHTML = "";
      refs = {};
      var k = kind.input.value;
      if (k === "wear") {
        refs.shape = select("形", state.shapes, it.shape);
        refs.color = input("色", it.color, { type: "color" });
      } else if (k === "effect") {
        refs.effect = select("演出の種類", state.effects, it.effect);
      } else {
        if (!state.partners.length) {
          extra.appendChild(el("p", "先に「提携店」を足してください。", { style: "color:#c0392b;font-size:13px" }));
          return;
        }
        refs.partnerId = select("提携店", state.partners.map(function (p) { return { id: p.id, label: p.name + (p.active ? "" : "（停止中）") }; }), it.partnerId);
        refs.validDays = input("有効日数（発行から）", it.validDays, { type: "number", min: 1, max: 365 });
        refs.perPersonMonthly = input("1体が1か月に引き換えられる数", it.perPersonMonthly, { type: "number", min: 1, max: 31 });
        refs.usage = input("店頭での使い方（お客さまと、お店の確認画面に出る）", it.usage, { tag: "textarea", maxlength: 200, rows: 2 });
      }
      Object.keys(refs).forEach(function (key) {
        extra.appendChild(refs[key].wrap);
      });
    }
    kind.input.addEventListener("change", renderExtra);
    renderExtra();
    var active = check("販売する", it.active);
    box.appendChild(grid);
    box.appendChild(extra);
    box.appendChild(active.wrap);
    var status = el("span", "", { style: "font-size:12px;color:var(--muted)" });
    var row = el("div");
    row.className = "row";
    row.appendChild(button("保存する", async function () {
      var body = {
        id: item ? item.id : undefined,
        kind: kind.input.value,
        name: name.input.value,
        price: Number(price.input.value),
        icon: icon.input.value,
        description: desc.input.value,
        stock: stock.input.value === "" ? null : Number(stock.input.value),
        sortOrder: Number(sort.input.value),
        active: active.input.checked,
      };
      Object.keys(refs).forEach(function (key) {
        var v = refs[key].input.value;
        body[key] = ["validDays", "perPersonMonthly"].indexOf(key) >= 0 ? Number(v) : v;
      });
      try {
        await post("/api/admin/economy/items", body);
        box.hidden = true;
        loadEconomyPanel();
      } catch (e) {
        status.textContent = e.message;
      }
    }, true));
    row.appendChild(button("やめる", function () {
      box.hidden = true;
    }));
    row.appendChild(status);
    box.appendChild(row);
    box.scrollIntoView({ block: "nearest" });
  }
  $("ecNewItem").addEventListener("click", function () {
    itemForm(null);
  });

  // ---------------------------------------------------------------- お店
  function renderShops() {
    table("ecShops", ["ID", "名前", "商品", "状態", ""], state.shops, function (s) {
      var tr = el("tr");
      tr.appendChild(el("td", s.id, { class: "mono" }));
      tr.appendChild(el("td", s.name + (s.builtin ? "（最初から）" : "")));
      tr.appendChild(el("td", s.itemIds.map(function (id) {
        var i = state.items.find(function (x) { return x.id === id; });
        return i ? i.name : id;
      }).join("・") || "（なし）"));
      tr.appendChild(el("td", s.active ? "営業中" : "休業中"));
      var td = el("td");
      td.appendChild(button("直す", function () {
        shopForm(s);
      }));
      td.appendChild(button("消す", async function () {
        if (!confirm("「" + s.name + "」を消しますか？（エリアに置いたお店は開かなくなります）")) return;
        await api("/api/admin/economy/shops?id=" + encodeURIComponent(s.id), { method: "DELETE" });
        loadEconomyPanel();
      }));
      tr.appendChild(td);
      return tr;
    });
  }

  function shopForm(shop) {
    var box = $("ecShopForm");
    box.hidden = false;
    box.innerHTML = "";
    var s = Object.assign({ itemIds: [], active: true, sortOrder: 100 }, shop || {});
    box.appendChild(el("b", shop ? "お店を直す" : "お店を足す"));
    var grid = el("div");
    grid.className = "formGrid";
    var name = input("名前", s.name, { maxlength: 24 });
    var desc = input("説明", s.description, { maxlength: 60 });
    var keeper = input("お店の人のひとこと", s.keeper, { maxlength: 60 });
    var sort = input("並び順", s.sortOrder, { type: "number", min: 0 });
    [name, desc, keeper, sort].forEach(function (f) {
      grid.appendChild(f.wrap);
    });
    box.appendChild(grid);
    box.appendChild(el("div", "売る商品", { style: "font-size:12px;color:var(--muted);margin-top:8px" }));
    var list = el("div");
    list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:4px 0 8px";
    var boxes = [];
    state.items.forEach(function (i) {
      var c = check(i.icon + " " + i.name + "（" + i.price + "）", s.itemIds.indexOf(i.id) >= 0);
      c.wrap.className = "";
      c.input.value = i.id;
      boxes.push(c.input);
      list.appendChild(c.wrap);
    });
    box.appendChild(list);
    var active = check("営業する", s.active);
    box.appendChild(active.wrap);
    var status = el("span", "", { style: "font-size:12px;color:var(--muted)" });
    var row = el("div");
    row.className = "row";
    row.appendChild(button("保存する", async function () {
      try {
        await post("/api/admin/economy/shops", {
          id: shop ? shop.id : undefined,
          name: name.input.value,
          description: desc.input.value,
          keeper: keeper.input.value,
          sortOrder: Number(sort.input.value),
          active: active.input.checked,
          itemIds: boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }),
        });
        box.hidden = true;
        loadEconomyPanel();
      } catch (e) {
        status.textContent = e.message;
      }
    }, true));
    row.appendChild(button("やめる", function () {
      box.hidden = true;
    }));
    row.appendChild(status);
    box.appendChild(row);
  }
  $("ecNewShop").addEventListener("click", function () {
    shopForm(null);
  });

  // ---------------------------------------------------------------- 提携店
  function showPin(partner, pin) {
    var box = $("ecPin");
    box.hidden = !pin;
    if (!pin) return;
    box.innerHTML = "";
    box.appendChild(el("div", "「" + partner.name + "」のお店の暗証番号: " + pin, { style: "font-size:18px;font-weight:700" }));
    box.appendChild(el("div", "この番号は二度と表示されません。お店の方に安全な方法でお伝えください。確認画面: " + location.origin + "/redeem", { style: "font-size:12px;color:var(--muted)" }));
  }

  function renderPartners() {
    table("ecPartners", ["名前", "地域", "住所・URL", "状態", ""], state.partners, function (p) {
      var tr = el("tr");
      tr.appendChild(el("td", p.name));
      tr.appendChild(el("td", p.area));
      tr.appendChild(el("td", [p.address, p.url].filter(Boolean).join(" ")));
      tr.appendChild(el("td", p.active ? "提携中" : "停止中"));
      var td = el("td");
      td.appendChild(button("直す", function () {
        partnerForm(p);
      }));
      td.appendChild(button("暗証番号を作り直す", async function () {
        if (!confirm("「" + p.name + "」の暗証番号を作り直しますか？（今の番号は使えなくなります）")) return;
        var r = await post("/api/admin/economy/partners", Object.assign({}, p, { resetPin: true }));
        showPin(r.partner, r.pin);
      }));
      tr.appendChild(td);
      return tr;
    });
    options($("ecVPartner"), [{ id: "", label: "すべての提携店" }].concat(state.partners.map(function (p) { return { id: p.id, label: p.name }; })), $("ecVPartner").value);
  }

  function partnerForm(partner) {
    var box = $("ecPartnerForm");
    box.hidden = false;
    box.innerHTML = "";
    var p = Object.assign({ active: true }, partner || {});
    box.appendChild(el("b", partner ? "提携店を直す" : "提携店を足す"));
    var grid = el("div");
    grid.className = "formGrid";
    var name = input("お店の名前", p.name, { maxlength: 30 });
    var area = input("地域（例: 渋谷）", p.area, { maxlength: 30 });
    var address = input("住所（任意）", p.address, { maxlength: 80 });
    var url = input("お店のURL（任意・https://）", p.url, { placeholder: "https://…" });
    var note = input("メモ（運営用・利用者には出ない）", p.note, { maxlength: 120 });
    [name, area, address, url, note].forEach(function (f) {
      grid.appendChild(f.wrap);
    });
    box.appendChild(grid);
    var active = check("提携中（止めると、そのお店の引換券は売らない。発行済みの券は使える）", p.active);
    box.appendChild(active.wrap);
    var status = el("span", "", { style: "font-size:12px;color:var(--muted)" });
    var row = el("div");
    row.className = "row";
    row.appendChild(button("保存する", async function () {
      try {
        var r = await post("/api/admin/economy/partners", {
          id: partner ? partner.id : undefined,
          name: name.input.value,
          area: area.input.value,
          address: address.input.value,
          url: url.input.value,
          note: note.input.value,
          active: active.input.checked,
        });
        box.hidden = true;
        await loadEconomyPanel();
        showPin(r.partner, r.pin);
      } catch (e) {
        status.textContent = e.message;
      }
    }, true));
    row.appendChild(button("やめる", function () {
      box.hidden = true;
    }));
    row.appendChild(status);
    box.appendChild(row);
  }
  $("ecNewPartner").addEventListener("click", function () {
    partnerForm(null);
  });

  // ---------------------------------------------------------------- 引換券
  async function loadVouchers() {
    try {
      var q = new URLSearchParams();
      if ($("ecVPartner").value) q.set("partner", $("ecVPartner").value);
      if ($("ecVStatus").value) q.set("status", $("ecVStatus").value);
      var r = await api("/api/admin/economy/vouchers?" + q.toString());
      table("ecVouchers", ["番号", "引換券", "提携店", "状態", "発行", "期限", "使用", ""], r.vouchers, function (v) {
        var tr = el("tr");
        tr.appendChild(el("td", v.code, { class: "mono" }));
        tr.appendChild(el("td", v.title + "（" + v.price + "）"));
        tr.appendChild(el("td", v.partnerName));
        tr.appendChild(el("td", STATUS[v.status] || v.status));
        tr.appendChild(el("td", fmt(v.issuedAt)));
        tr.appendChild(el("td", fmt(v.expiresAt)));
        tr.appendChild(el("td", fmt(v.usedAt)));
        var td = el("td");
        if (v.status === "issued" || v.status === "expired") {
          td.appendChild(button("取り消して返金", async function () {
            if (!confirm("引換券 " + v.code + " を取り消して、通貨を返しますか？")) return;
            try {
              await post("/api/admin/economy/vouchers", { code: v.code, refund: true });
              loadVouchers();
            } catch (e) {
              alert(e.message);
            }
          }));
        }
        tr.appendChild(td);
        return tr;
      });
    } catch (e) {
      $("ecVouchers").textContent = e.message;
    }
  }
  $("ecVLoad").addEventListener("click", loadVouchers);

  // ---------------------------------------------------------------- 付与・財布
  async function lookup() {
    var cid = $("ecGCid").value.trim();
    var host = $("ecWallet");
    if (!cid) return;
    try {
      var w = await api("/api/admin/economy/wallet?cid=" + encodeURIComponent(cid));
      host.innerHTML = "";
      host.appendChild(el("div", "残高: " + w.balance.toLocaleString() + " " + w.settings.unit + "（貯まった " + w.earned + "／使った " + w.spent + "／今日 +" + w.todayEarned + "）", { style: "font-weight:700" }));
      host.appendChild(el("div", "持ち物: " + (w.inventory.map(function (i) { return (i.item ? i.item.name : i.itemId) + "×" + i.qty + (i.equipped ? "（つけている）" : ""); }).join("・") || "なし"), { style: "font-size:12.5px" }));
      host.appendChild(el("div", "引換券: " + (w.vouchers.map(function (v) { return v.title + "・" + (STATUS[v.status] || v.status); }).join("／") || "なし"), { style: "font-size:12.5px" }));
      var t = el("table");
      t.id = "ecLedger";
      host.appendChild(t);
      table("ecLedger", ["日時", "内容", "増減", "残高"], w.ledger, function (l) {
        var tr = el("tr");
        tr.appendChild(el("td", fmt(l.at)));
        tr.appendChild(el("td", l.note));
        tr.appendChild(el("td", (l.delta > 0 ? "+" : "") + l.delta));
        tr.appendChild(el("td", l.balance));
        return tr;
      });
    } catch (e) {
      host.textContent = e.message;
    }
  }
  $("ecLookup").addEventListener("click", lookup);
  $("ecGrant").addEventListener("click", async function () {
    try {
      var r = await post("/api/admin/economy/grant", { characterId: $("ecGCid").value.trim(), amount: Number($("ecGAmount").value), note: $("ecGNote").value });
      $("ecGStatus").textContent = (r.delta > 0 ? "+" : "") + r.delta + " → 残高 " + r.balance;
      lookup();
    } catch (e) {
      $("ecGStatus").textContent = e.message;
    }
  });

  // ---------------------------------------------------------------- 読み込み
  window.loadEconomyPanel = async function () {
    try {
      var [settings, items] = await Promise.all([api("/api/admin/economy/settings"), api("/api/admin/economy/items")]);
      state.settings = settings.settings;
      state.items = items.items;
      state.partners = items.partners;
      state.shops = items.shops;
      state.kinds = items.kinds;
      state.shapes = items.shapes;
      state.effects = items.effects;
      renderSettings();
      renderItems();
      renderShops();
      renderPartners();
      loadStats();
      loadVouchers();
    } catch (e) {
      $("ecStatus").textContent = e.message;
    }
  };
})();
