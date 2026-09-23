/*
 * 管理画面「NPC・運営の分身」「広告・ランドマーク」「招待・申し込み」タブ。
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
  function toLocal(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fromLocal(v) {
    if (!v) return null;
    var t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  function yen(n) {
    return n == null ? "—" : Number(n).toLocaleString() + "円";
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
  function post(path, body, method) {
    return api(path, { method: method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function speciesLabel(k) {
    return window.WaketamaSpecies && k ? window.WaketamaSpecies.label(k) : k || "";
  }

  // ---------------------------------------------------------------- 確認待ちの印
  async function refreshBadges() {
    try {
      var b = await api("/api/admin/badges");
      $("badgeOrders").hidden = !b.pendingOrders;
      $("badgeOrders").textContent = b.pendingOrders;
      $("badgeApps").hidden = !b.pendingApplications;
      $("badgeApps").textContent = b.pendingApplications;
    } catch (e) {
      /* 管理画面の他の機能は使える */
    }
  }
  refreshBadges();

  // ================================================================ NPC・運営の分身
  var npcData = null;
  var npcEditing = null;

  /** この端末で育てる: 持ち主の印をこの端末に置いて、会話の画面を開く */
  function growHere(c) {
    try {
      localStorage.setItem("sodatsukake_token_" + c.characterId, c.ownerToken);
      var list = JSON.parse(localStorage.getItem("sodatsukake_myCharacters") || "[]");
      list = list.filter(function (x) { return x && x.cid !== c.characterId; });
      list.unshift({ cid: c.characterId, name: c.name, species: c.species, color: c.color, lastVisit: Date.now() });
      localStorage.setItem("sodatsukake_myCharacters", JSON.stringify(list.slice(0, 24)));
    } catch (e) {
      alert("この端末に保存できませんでした");
      return;
    }
    window.open("/chat?cid=" + encodeURIComponent(c.characterId), "_blank", "noopener");
  }

  window.loadNpcPanel = async function () {
    var chars = await api("/api/admin/characters");
    table("acTable", ["分身", "姿", "成長", "NPC", "メモ", ""], chars.characters, function (c) {
      var tr = el("tr");
      tr.appendChild(el("td", c.name));
      tr.appendChild(el("td", speciesLabel(c.species) + (c.color ? "・" + c.color : "")));
      tr.appendChild(el("td", (c.growthStage || "") + "（" + (c.interactionCount || 0) + "回）"));
      tr.appendChild(el("td", c.npcCount ? c.npcCount + "か所" : "—"));
      tr.appendChild(el("td", c.label || ""));
      var act = el("td");
      act.style.whiteSpace = "nowrap";
      var grow = el("button", "この端末で育てる", { type: "button" });
      grow.addEventListener("click", function () { growHere(c); });
      var asNpc = el("button", "NPCとして置く", { type: "button" });
      asNpc.style.marginLeft = "6px";
      asNpc.addEventListener("click", function () {
        startNpcEdit({ characterId: c.characterId });
        $("npcChar").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      var del = el("button", "消す", { type: "button" });
      del.style.marginLeft = "6px";
      del.addEventListener("click", async function () {
        if (!confirm("「" + c.name + "」を消しますか？（会話・性格も消えます。置いていた NPC も外れます）")) return;
        await post("/api/admin/characters", { characterId: c.characterId }, "DELETE");
        loadNpcPanel();
      });
      act.appendChild(grow);
      act.appendChild(asNpc);
      act.appendChild(del);
      tr.appendChild(act);
      return tr;
    });

    npcData = await api("/api/admin/npcs");
    options($("npcChar"), npcData.characters.map(function (c) { return { id: c.characterId, label: c.name + "（" + speciesLabel(c.species) + "）" }; }), npcEditing && npcEditing.characterId);
    options($("npcArea"), npcData.areas.map(function (a) { return { id: a.id, label: a.name }; }), npcEditing && npcEditing.areaId);
    options($("npcSpot"), npcData.spots.map(function (p) { return { id: p.id, label: p.label }; }), "center");
    var areaName = {};
    npcData.areas.forEach(function (a) { areaName[a.id] = a.name; });
    table("npcTable", ["NPC", "エリア", "役目・ひとこと", "位置", "出す", ""], npcData.npcs, function (n) {
      var tr = el("tr");
      if (!n.active) tr.className = "offRow";
      tr.appendChild(el("td", (n.ad ? "【広告】" : "") + (n.name || "") + "（" + speciesLabel(n.species) + "）"));
      tr.appendChild(el("td", areaName[n.areaId] || n.areaId));
      var msg = el("td", (n.role ? "［" + n.role + "］" : "") + n.message);
      msg.className = "wrap";
      tr.appendChild(msg);
      tr.appendChild(el("td", "x " + n.homeX + " / z " + n.homeZ + (n.radius ? "・" + n.radius + "m" : "・立ったまま")));
      tr.appendChild(el("td", n.active ? "出す" : "隠す"));
      var act = el("td");
      act.style.whiteSpace = "nowrap";
      var edit = el("button", "直す", { type: "button" });
      edit.addEventListener("click", function () { startNpcEdit(n); });
      var open = el("a", "エリアを開く", { href: "/meta?room=" + encodeURIComponent(n.areaId), target: "_blank", rel: "noopener" });
      open.style.margin = "0 6px";
      var del = el("button", "外す", { type: "button" });
      del.addEventListener("click", async function () {
        if (!confirm("この NPC を外しますか？（分身そのものは消えません）")) return;
        await post("/api/admin/npcs", { id: n.id }, "DELETE");
        loadNpcPanel();
      });
      act.appendChild(edit);
      act.appendChild(open);
      act.appendChild(del);
      tr.appendChild(act);
      return tr;
    });
  };

  function startNpcEdit(n) {
    npcEditing = n || null;
    if (n && n.characterId) $("npcChar").value = n.characterId;
    if (n && n.areaId) $("npcArea").value = n.areaId;
    $("npcRole").value = (n && n.role) || "";
    $("npcMessage").value = (n && n.message) || "";
    $("npcLink").value = (n && n.linkUrl) || "";
    $("npcRadius").value = n && n.radius !== undefined ? n.radius : 1.5;
    $("npcSort").value = (n && n.sortOrder) || 100;
    $("npcTalk").checked = !n || n.talk !== false;
    $("npcAd").checked = !!(n && n.ad);
    $("npcActive").checked = !n || n.active !== false;
    if (n && n.homeX !== undefined && npcData) {
      var hit = npcData.spots.find(function (s) { return s.x === n.homeX && s.z === n.homeZ; });
      $("npcSpot").value = hit ? hit.id : "center";
    }
    $("npcStatus").textContent = n && n.id ? "直しています: " + (n.name || "") : "";
  }

  function initNpc() {
    if (!$("acCreate")) return;
    $("acCreate").addEventListener("click", async function () {
      $("acStatus").textContent = "作っています…";
      try {
        var r = await post("/api/admin/characters", { count: Number($("acCount").value || 1), name: $("acName").value, label: $("acLabel").value });
        $("acStatus").textContent = r.created.length + "体を作りました";
        loadNpcPanel();
      } catch (e) {
        $("acStatus").textContent = e.message;
      }
    });
    $("npcNew").addEventListener("click", function () { startNpcEdit(null); });
    $("npcSave").addEventListener("click", async function () {
      var spot = npcData.spots.find(function (s) { return s.id === $("npcSpot").value; }) || { x: 0, z: 0 };
      $("npcStatus").textContent = "保存しています…";
      try {
        var r = await post("/api/admin/npcs", {
          id: npcEditing && npcEditing.id,
          characterId: $("npcChar").value,
          areaId: $("npcArea").value,
          role: $("npcRole").value,
          message: $("npcMessage").value,
          linkUrl: $("npcLink").value,
          homeX: spot.x,
          homeZ: spot.z,
          radius: Number($("npcRadius").value || 0),
          talk: $("npcTalk").checked,
          ad: $("npcAd").checked,
          active: $("npcActive").checked,
          sortOrder: Number($("npcSort").value || 100),
        });
        npcEditing = r.npc;
        $("npcStatus").textContent = "保存しました（いまエリアにいる人の画面にも出ます）";
        loadNpcPanel();
      } catch (e) {
        $("npcStatus").textContent = e.message;
      }
    });
    $("npcRefresh").addEventListener("click", async function () {
      $("npcStatus").textContent = "取り直しています…";
      var r = await post("/api/admin/npcs/refresh", {});
      $("npcStatus").textContent = r.refreshed + "体の性格を最新にしました";
    });
  }

  // ================================================================ 広告・ランドマーク
  var landMeta = null;
  var areas = [];
  var placeEditing = null;

  async function ensureLandMeta() {
    if (!landMeta) landMeta = await api("/api/admin/land/settings");
    if (!areas.length) {
      var r = await api("/api/admin/meta/rooms");
      areas = r.rooms.filter(function (x) { return x.id !== "r-game-test"; }).map(function (x) { return { id: x.id, label: x.name + (x.state !== "open" ? "（" + x.state + "）" : "") }; });
    }
  }

  function showSub(name) {
    document.querySelectorAll("#landTabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.sub === name); });
    document.querySelectorAll("#panel-land [data-subpanel]").forEach(function (s) { s.hidden = s.dataset.subpanel !== name; });
    if (name === "orders") loadOrders();
    if (name === "ads") loadAds();
    if (name === "plots") loadPlots();
    if (name === "place") loadPlacements();
    if (name === "settings") loadLandSettings();
  }

  window.loadLandPanel = async function () {
    refreshBadges();
    await ensureLandMeta();
    var current = document.querySelector("#landTabs button.on");
    showSub(current ? current.dataset.sub : "orders");
  };

  function contentSummary(c, kind) {
    if (!c) return "";
    var lines = [];
    if (kind === "landmark") lines.push("形: " + c.model + "・色: " + c.color + "・銘板: " + (c.plaque || ""));
    if (c.title) lines.push("見出し: " + c.title);
    if (c.text) lines.push("本文: " + c.text);
    if (c.detail) lines.push("説明: " + c.detail);
    if (c.imageUrl) lines.push("画像: " + c.imageUrl);
    if (c.linkUrl) lines.push("リンク: " + c.linkUrl);
    if (c.qrUrl) lines.push("QR: " + c.qrUrl);
    if (c.couponCode) lines.push("クーポン: " + c.couponCode + " " + (c.couponNote || "") + (c.couponUntil ? "（〜" + fmt(c.couponUntil) + "）" : ""));
    lines.push("提供: " + (c.sponsor || ""));
    return lines.join("\n");
  }

  async function loadOrders() {
    var r = await api("/api/admin/land/orders" + ($("orderFilter").value ? "?status=" + $("orderFilter").value : ""));
    var box = $("orderList");
    box.innerHTML = "";
    if (!r.orders.length) box.appendChild(el("p", "申込はありません", { class: "lead" }));
    r.orders.forEach(function (o) {
      var card = el("div");
      card.className = "card";
      card.appendChild(el("h4", o.statusLabel + "｜" + o.areaName + "・" + o.spotLabel + "（" + (o.kind === "landmark" ? "ランドマーク" : "広告") + "・" + o.unitDays * o.quantity + "日）"));
      card.appendChild(el("div", "申込 " + fmt(o.createdAt) + "／目安 " + yen(o.suggestedPrice) + (o.price != null ? "／金額 " + yen(o.price) : ""), { class: "meta" }));
      var body = el("div", contentSummary(o.content, o.kind));
      body.style.whiteSpace = "pre-line";
      body.style.margin = "6px 0";
      card.appendChild(body);
      card.appendChild(el("div", "連絡先: " + o.contactName + " / " + o.contactEmail + (o.company ? " / " + o.company : "") + (o.note ? "\n要望: " + o.note : ""), { class: "meta" }));
      if (o.adminNote) card.appendChild(el("div", "メモ: " + o.adminNote, { class: "meta" }));
      if (o.rejectReason) card.appendChild(el("div", "見送りの理由: " + o.rejectReason, { class: "meta" }));
      var acts = el("div");
      acts.className = "acts";
      function btn(label, fn, primary) {
        var b = el("button", label, { type: "button" });
        if (primary) b.style.cssText = "background:var(--brand);color:#fff;border-color:transparent";
        b.addEventListener("click", async function () {
          try {
            await fn();
            loadOrders();
            refreshBadges();
          } catch (e) {
            alert(e.message);
          }
        });
        acts.appendChild(b);
      }
      if (o.status === "pending" || o.status === "approved") {
        btn(o.status === "pending" ? "承認（金額・決済リンク）" : "金額・決済リンクを直す", async function () {
          var price = prompt("金額（円）", String(o.price != null ? o.price : o.suggestedPrice != null ? o.suggestedPrice : ""));
          if (price === null) return;
          var pay = prompt("決済リンク（https://。空なら既定のリンク）", o.paymentUrl || (landMeta && landMeta.settings.defaultPaymentUrl) || "");
          if (pay === null) return;
          await post("/api/admin/land/orders", { id: o.id, action: "approve", price: Number(price), paymentUrl: pay });
        }, o.status === "pending");
        btn("支払い済みにする（掲載開始）", async function () {
          var start = prompt("掲載を始める日時（空なら今から。例: 2026-10-01 10:00）", "");
          if (start === null) return;
          await post("/api/admin/land/orders", { id: o.id, action: "paid", startsAt: start ? new Date(start.replace(" ", "T")).getTime() : null });
        }, o.status === "approved");
        btn("見送る", async function () {
          var reason = prompt("見送りの理由（申込者の状況ページに出ます）", "");
          if (reason === null) return;
          await post("/api/admin/land/orders", { id: o.id, action: "reject", reason: reason });
        });
      }
      if (o.status === "paid" || o.status === "approved") {
        btn("取り消す（掲載中なら終える）", async function () {
          if (!confirm("この申込を取り消しますか？")) return;
          await post("/api/admin/land/orders", { id: o.id, action: "cancel" });
        });
      }
      btn("メモ", async function () {
        var note = prompt("運営のメモ（申込者には見えません）", o.adminNote || "");
        if (note === null) return;
        await post("/api/admin/land/orders", { id: o.id, action: "note", adminNote: note });
      });
      card.appendChild(acts);
      box.appendChild(card);
    });
  }

  async function loadAds() {
    var r = await api("/api/admin/land/ads");
    var stateLabel = { live: "表示中", upcoming: "これから", ended: "終了" };
    table("adTable", ["広告", "場所", "クーポン", "直近30日", "状態", ""], r.ads, function (a) {
      var tr = el("tr");
      if (a.state === "ended") tr.className = "offRow";
      tr.appendChild(el("td", (a.ad ? "【広告】" : a.kind === "landmark" ? "［ランドマーク］" : "") + (a.title || "（見出しなし）") + (a.sponsor ? "／提供: " + a.sponsor : "")));
      tr.appendChild(el("td", a.areaName + "・" + (a.where === "plot" ? "区画 " : "置き場所 ") + a.spot));
      tr.appendChild(el("td", a.couponCode ? a.couponCode + (a.couponUntil ? "（〜" + fmt(a.couponUntil) + "）" : "") : "—"));
      var st = el("td");
      [["詳細", a.stats.views], ["リンク", a.stats.clicks], ["クーポン", a.stats.coupons]].forEach(function (x) {
        st.appendChild(el("span", x[0] + " " + x[1], { class: "stat" }));
      });
      tr.appendChild(st);
      tr.appendChild(el("td", (stateLabel[a.state] || a.state) + (a.endsAt ? "（〜" + fmt(a.endsAt) + "）" : "")));
      var act = el("td");
      if (a.where === "plot") {
        var edit = el("button", "直す", { type: "button" });
        edit.addEventListener("click", async function () {
          showSub("place");
          var list = (await api("/api/admin/land/placements")).placements;
          var p = list.find(function (x) { return x.id === a.placementId; });
          if (p) startPlaceEdit(p);
        });
        act.appendChild(edit);
      } else {
        act.appendChild(el("span", "メタバース管理で直す", { class: "meta" }));
      }
      tr.appendChild(act);
      return tr;
    });
  }

  async function loadPlots() {
    options($("plotArea"), areas, $("plotArea").value || (areas[0] && areas[0].id));
    var r = await api("/api/admin/land/plots?area=" + encodeURIComponent($("plotArea").value));
    table("plotTable", ["区画", "売る物", "広告（1単位）", "ランドマーク（1単位）", "メモ", "いま"], r.plots, function (p) {
      var tr = el("tr");
      tr.dataset.spot = p.spot;
      tr.appendChild(el("td", p.label));
      var saleTd = el("td");
      var sel = document.createElement("select");
      options(sel, landMeta.saleKinds, p.sale);
      sel.className = "pSale";
      saleTd.appendChild(sel);
      tr.appendChild(saleTd);
      function num(cls, v) {
        var td = el("td");
        var i = document.createElement("input");
        i.type = "number";
        i.min = "0";
        i.className = cls;
        i.style.width = "8em";
        i.value = v == null ? "" : v;
        i.placeholder = "要相談";
        td.appendChild(i);
        return td;
      }
      tr.appendChild(num("pAd", p.adPrice));
      tr.appendChild(num("pLm", p.landmarkPrice));
      var noteTd = el("td");
      var note = document.createElement("input");
      note.className = "pNote";
      note.maxLength = 60;
      note.value = p.note || "";
      noteTd.appendChild(note);
      tr.appendChild(noteTd);
      tr.appendChild(el("td", p.current ? (p.current.kind === "landmark" ? "ランドマーク" : "広告") + "「" + p.current.title + "」" + (p.current.endsAt ? "〜" + fmt(p.current.endsAt) : "") : p.upcoming ? "予約 " + p.upcoming + "件" : "空き"));
      return tr;
    });
  }

  async function loadPlacements() {
    options($("plEdArea"), areas, $("plEdArea").value || (areas[0] && areas[0].id));
    options($("plEdSpot"), landMeta.spots.map(function (s) { return { id: s.id, label: s.label }; }), $("plEdSpot").value);
    options($("plEdModel"), landMeta.models, $("plEdModel").value || "tower");
    options($("plEdColor"), landMeta.colors, $("plEdColor").value || "gold");
    var r = await api("/api/admin/land/placements");
    var areaName = {};
    areas.forEach(function (a) { areaName[a.id] = a.label; });
    var stateLabel = { live: "表示中", upcoming: "これから", ended: "終了" };
    table("placeTable", ["物", "場所", "期間", "出どころ", "状態", ""], r.placements, function (p) {
      var tr = el("tr");
      if (p.state === "ended") tr.className = "offRow";
      tr.appendChild(el("td", (p.kind === "landmark" ? "［ランドマーク］" + (p.content.plaque || "") : "【広告】" + (p.content.title || "")) + "／提供: " + p.content.sponsor));
      tr.appendChild(el("td", (areaName[p.areaId] || p.areaId) + "・" + p.spot));
      tr.appendChild(el("td", fmt(p.startsAt) + " 〜 " + (p.endsAt ? fmt(p.endsAt) : "無期限")));
      tr.appendChild(el("td", p.source === "order" ? "申込" : "運営"));
      tr.appendChild(el("td", stateLabel[p.state] || p.state));
      var act = el("td");
      act.style.whiteSpace = "nowrap";
      var edit = el("button", "直す", { type: "button" });
      edit.addEventListener("click", function () { startPlaceEdit(p); });
      act.appendChild(edit);
      if (p.state !== "ended") {
        var end = el("button", "いますぐ終える", { type: "button" });
        end.style.marginLeft = "6px";
        end.addEventListener("click", async function () {
          if (!confirm("いますぐ表示を終えますか？")) return;
          await post("/api/admin/land/placements/end", { id: p.id });
          loadPlacements();
        });
        act.appendChild(end);
      }
      var del = el("button", "消す", { type: "button" });
      del.style.marginLeft = "6px";
      del.addEventListener("click", async function () {
        if (!confirm("記録ごと消しますか？")) return;
        await post("/api/admin/land/placements", { id: p.id }, "DELETE");
        loadPlacements();
      });
      act.appendChild(del);
      tr.appendChild(act);
      return tr;
    });
  }

  function startPlaceEdit(p) {
    placeEditing = p || null;
    var c = (p && p.content) || {};
    if (p) {
      $("plEdArea").value = p.areaId;
      $("plEdSpot").value = p.spot;
      $("plEdKind").value = p.kind;
    }
    $("plEdSponsor").value = c.sponsor || "";
    $("plEdTitle").value = c.title || "";
    $("plEdText").value = c.text || "";
    $("plEdImage").value = c.imageUrl || "";
    if (c.model) $("plEdModel").value = c.model;
    if (c.color) $("plEdColor").value = c.color;
    $("plEdPlaque").value = c.plaque || "";
    $("plEdLink").value = c.linkUrl || "";
    $("plEdQr").value = c.qrUrl || "";
    $("plEdCoupon").value = c.couponCode || "";
    $("plEdCouponNote").value = c.couponNote || "";
    $("plEdCouponUntil").value = c.couponUntil ? toLocal(c.couponUntil).slice(0, 10) : "";
    $("plEdStart").value = toLocal(p && p.startsAt);
    $("plEdEnd").value = toLocal(p && p.endsAt);
    $("plEdDetail").value = c.detail || "";
    $("plEdStatus").textContent = p ? "直しています" : "";
  }

  async function loadLandSettings() {
    landMeta = await api("/api/admin/land/settings");
    var s = landMeta.settings;
    $("lsOpen").checked = s.salesOpen;
    $("lsShow").checked = s.showForSale;
    $("lsAdDays").value = s.adUnitDays;
    $("lsLmDays").value = s.landmarkUnitDays;
    $("lsMax").value = s.maxUnits;
    $("lsPay").value = s.defaultPaymentUrl;
    $("lsNote").value = s.paymentNote;
  }

  function initLand() {
    if (!$("landTabs")) return;
    document.querySelectorAll("#landTabs button").forEach(function (b) {
      b.addEventListener("click", function () { showSub(b.dataset.sub); });
    });
    $("orderFilter").addEventListener("change", loadOrders);
    $("plotArea").addEventListener("change", loadPlots);
    $("plotSave").addEventListener("click", async function () {
      var plots = Array.prototype.map.call(document.querySelectorAll("#plotTable tbody tr[data-spot]"), function (tr) {
        var ad = tr.querySelector(".pAd").value;
        var lm = tr.querySelector(".pLm").value;
        return { spot: tr.dataset.spot, sale: tr.querySelector(".pSale").value, adPrice: ad === "" ? null : Number(ad), landmarkPrice: lm === "" ? null : Number(lm), note: tr.querySelector(".pNote").value };
      });
      try {
        await post("/api/admin/land/plots", { areaId: $("plotArea").value, plots: plots });
        $("plotStatus").textContent = "保存しました";
        loadPlots();
      } catch (e) {
        $("plotStatus").textContent = e.message;
      }
    });
    $("plEdNew").addEventListener("click", function () { startPlaceEdit(null); });
    $("plEdSave").addEventListener("click", async function () {
      var until = $("plEdCouponUntil").value ? new Date($("plEdCouponUntil").value + "T23:59:59").getTime() : null;
      try {
        await post("/api/admin/land/placements", {
          id: placeEditing && placeEditing.id,
          areaId: $("plEdArea").value,
          spot: $("plEdSpot").value,
          kind: $("plEdKind").value,
          startsAt: fromLocal($("plEdStart").value),
          endsAt: fromLocal($("plEdEnd").value),
          content: {
            sponsor: $("plEdSponsor").value, title: $("plEdTitle").value, text: $("plEdText").value, imageUrl: $("plEdImage").value,
            model: $("plEdModel").value, color: $("plEdColor").value, plaque: $("plEdPlaque").value, linkUrl: $("plEdLink").value,
            qrUrl: $("plEdQr").value, couponCode: $("plEdCoupon").value, couponNote: $("plEdCouponNote").value, couponUntil: until,
            detail: $("plEdDetail").value,
          },
        });
        $("plEdStatus").textContent = "保存しました（いまエリアにいる人の画面にも出ます）";
        placeEditing = null;
        loadPlacements();
      } catch (e) {
        $("plEdStatus").textContent = e.message;
      }
    });
    $("lsSave").addEventListener("click", async function () {
      try {
        await post("/api/admin/land/settings", {
          salesOpen: $("lsOpen").checked,
          showForSale: $("lsShow").checked,
          adUnitDays: Number($("lsAdDays").value),
          landmarkUnitDays: Number($("lsLmDays").value),
          maxUnits: Number($("lsMax").value),
          defaultPaymentUrl: $("lsPay").value,
          paymentNote: $("lsNote").value,
        });
        $("lsStatus").textContent = "保存しました";
        landMeta = null;
        await ensureLandMeta();
      } catch (e) {
        $("lsStatus").textContent = e.message;
      }
    });
  }

  // ================================================================ 招待・申し込み
  window.loadEntryPanel = async function () {
    refreshBadges();
    var r = await api("/api/admin/invites");
    options($("invChar"), [{ id: "", label: "（新しい分身のときは不要）" }].concat(r.characters.map(function (c) { return { id: c.characterId, label: c.name + "（" + speciesLabel(c.species) + "）" }; })), $("invChar").value);
    var stateLabel = { usable: "使える", used_up: "使い切り", expired: "期限切れ", stopped: "停止中" };
    table("invTable", ["リンク", "種類", "使った／回数", "期限", "メモ", "状態", ""], r.invites, function (i) {
      var tr = el("tr");
      if (i.state !== "usable") tr.className = "offRow";
      var url = r.origin + "/i/" + i.code;
      tr.appendChild(el("td", url, { class: "mono" }));
      tr.appendChild(el("td", i.kind === "handover" ? "引き渡し" : i.source === "application" ? "申し込み" : "新しい分身"));
      tr.appendChild(el("td", i.used + " / " + i.maxUses));
      tr.appendChild(el("td", i.expiresAt ? fmt(i.expiresAt) : "なし"));
      tr.appendChild(el("td", i.label));
      tr.appendChild(el("td", stateLabel[i.state] || i.state));
      var act = el("td");
      act.style.whiteSpace = "nowrap";
      var copy = el("button", "コピー", { type: "button" });
      copy.addEventListener("click", function () {
        navigator.clipboard.writeText(url).then(function () { copy.textContent = "コピーしました"; });
      });
      var toggle = el("button", i.active ? "止める" : "戻す", { type: "button" });
      toggle.style.marginLeft = "6px";
      toggle.addEventListener("click", async function () {
        await post("/api/admin/invites/active", { code: i.code, active: !i.active });
        loadEntryPanel();
      });
      act.appendChild(copy);
      act.appendChild(toggle);
      tr.appendChild(act);
      return tr;
    });

    var a = await api("/api/admin/applications");
    $("apOpen").checked = a.settings.open;
    $("apAuto").checked = a.settings.autoApprove;
    $("apNote").value = a.settings.note;
    var box = $("appList");
    box.innerHTML = "";
    if (!a.applications.length) box.appendChild(el("p", "申し込みはありません", { class: "lead" }));
    var label = { pending: "確認中", approved: "承認", rejected: "見送り" };
    a.applications.forEach(function (x) {
      var card = el("div");
      card.className = "card";
      card.appendChild(el("h4", (label[x.status] || x.status) + "｜" + x.nickname));
      card.appendChild(el("div", "申し込み " + fmt(x.createdAt) + (x.contact ? "／連絡先 " + x.contact : "") + (x.purpose ? "\n" + x.purpose : ""), { class: "meta" }));
      if (x.inviteCode) card.appendChild(el("div", a.origin + "/i/" + x.inviteCode, { class: "mono" }));
      if (x.status === "pending") {
        var acts = el("div");
        acts.className = "acts";
        var ok = el("button", "承認（招待リンクを出す）", { type: "button" });
        ok.style.cssText = "background:var(--brand);color:#fff;border-color:transparent";
        ok.addEventListener("click", async function () {
          var r2 = await post("/api/admin/applications", { id: x.id, action: "approve" });
          alert("承認しました。申込者の状況ページに「はじめる」ボタンが出ます。\n連絡先へ知らせる場合のリンク: " + a.origin + "/i/" + r2.inviteCode);
          loadEntryPanel();
          refreshBadges();
        });
        var ng = el("button", "見送る", { type: "button" });
        ng.addEventListener("click", async function () {
          var reason = prompt("理由（申込者の状況ページに出ます。空でも可）", "");
          if (reason === null) return;
          await post("/api/admin/applications", { id: x.id, action: "reject", reason: reason });
          loadEntryPanel();
          refreshBadges();
        });
        acts.appendChild(ok);
        acts.appendChild(ng);
        card.appendChild(acts);
      }
      box.appendChild(card);
    });
  };

  function initEntry() {
    if (!$("invCreate")) return;
    $("invCreate").addEventListener("click", async function () {
      $("invStatus").textContent = "作っています…";
      try {
        var r = await post("/api/admin/invites", {
          kind: $("invKind").value,
          characterId: $("invChar").value,
          count: Number($("invCount").value || 1),
          maxUses: Number($("invMax").value || 1),
          expiresAt: fromLocal($("invExpires").value),
          label: $("invLabel").value,
        });
        $("invStatus").textContent = r.invites.length + "本作りました";
        $("invCreated").textContent = r.invites.map(function (i) { return r.origin + "/i/" + i.code; }).join("\n");
        $("invCreated").style.whiteSpace = "pre-line";
        loadEntryPanel();
      } catch (e) {
        $("invStatus").textContent = e.message;
      }
    });
    $("apSave").addEventListener("click", async function () {
      await post("/api/admin/applications/settings", { open: $("apOpen").checked, autoApprove: $("apAuto").checked, note: $("apNote").value });
      $("apStatus").textContent = "保存しました";
    });
  }

  initNpc();
  initLand();
  initEntry();
})();
