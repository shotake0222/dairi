/*
 * 管理画面「メタバース」タブ。部屋（場所・時間帯・視点・置く物）を作る・直す。
 *
 * admin.html の本体スクリプトにある api() / el() を使う（このファイルはその後に読む）。
 * 選択肢（場所・置く物の種類・置き場所）はサーバーが返す定義（src/metaverse.ts の metaverseCatalog）を
 * そのまま並べる。ここで書き写すと、サーバーと食い違ったときに保存できない設定が作れてしまう。
 */
(function () {
  "use strict";

  var catalog = null;
  var editing = null; // { id?: string, objects: [...] }

  function $(id) {
    return document.getElementById(id);
  }

  function options(select, list, value, filter) {
    select.innerHTML = "";
    list.filter(filter || function () { return true; }).forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.id;
      o.textContent = x.label;
      if (x.id === value) o.selected = true;
      select.appendChild(o);
    });
  }

  function labelOf(list, id) {
    var hit = list.find(function (x) { return x.id === id; });
    return hit ? hit.label : id;
  }

  function freeSlot() {
    var used = editing.objects.map(function (o) { return o.slot; });
    var free = catalog.slots.find(function (s) { return used.indexOf(s.id) < 0; });
    return free ? free.id : null;
  }

  function defaultsFor(type) {
    var slot = freeSlot();
    var base = { type: type, slot: slot, title: "", text: "" };
    if (type === "board") return Object.assign(base, { title: "お知らせ", text: "", imageUrl: "", linkUrl: "", ad: false });
    if (type === "video") return Object.assign(base, { title: "", videoUrl: "" });
    if (type === "members") return Object.assign(base, { title: "いまいる子" });
    if (type === "treasure") return Object.assign(base, { title: "宝さがし", text: "星を集めよう", count: 10, seconds: 60, clearMessage: "" });
    if (type === "rally") return Object.assign(base, { title: "スタンプラリー", text: "旗をぜんぶまわろう", points: 4, clearMessage: "" });
    if (type === "quiz") return Object.assign(base, { title: "○×クイズ", text: "○か×の場所へ歩いてね", questions: [{ q: "", a: "o", note: "" }], clearMessage: "" });
    return base;
  }

  // ---- 一覧 ----
  window.loadMetaRooms = async function () {
    var data;
    try {
      data = await api("/api/admin/meta/rooms");
    } catch (e) {
      $("metaRoomTable").textContent = e.message;
      return;
    }
    catalog = data.catalog;
    var rows = (data.builtin || []).concat(data.rooms || []);
    table("metaRoomTable", ["部屋", "場所・時間", "置く物", "一覧", ""], rows, function (r) {
      var tr = el("tr");
      var name = el("td", r.name);
      if (r.builtin) name.appendChild(el("span", "  最初からある部屋", { style: "font-size:11px;color:#9a90c0" }));
      tr.appendChild(name);
      tr.appendChild(el("td", labelOf(catalog.places, r.place) + "・" + labelOf(catalog.times, r.time)));
      var kinds = (r.objects || []).map(function (o) {
        return (o.ad ? "【広告】" : "") + (o.title || labelOf(catalog.objectTypes, o.type));
      });
      var objTd = el("td", kinds.join(" / ") || "なし");
      objTd.className = "wrap";
      tr.appendChild(objTd);
      tr.appendChild(el("td", r.listed ? "出す" : "リンクのみ"));
      var act = el("td");
      var open = el("a", "開く", { href: "/meta?room=" + encodeURIComponent(r.id), target: "_blank", rel: "noopener" });
      open.style.marginRight = "8px";
      act.appendChild(open);
      if (r.builtin) {
        var copy = el("button", "これを元に作る", { type: "button" });
        copy.addEventListener("click", function () {
          startEdit(Object.assign({}, r, { id: undefined, name: r.name + "（コピー）", listed: true }));
        });
        act.appendChild(copy);
      } else {
        var edit = el("button", "直す", { type: "button" });
        edit.addEventListener("click", function () { startEdit(r); });
        var del = el("button", "消す", { type: "button" });
        del.style.marginLeft = "6px";
        del.addEventListener("click", async function () {
          if (!confirm("「" + r.name + "」を消しますか？（いま入っている人は、次に入り直したときに入れなくなります）")) return;
          await api("/api/admin/meta/rooms", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: r.id }),
          });
          loadMetaRooms();
        });
        act.appendChild(edit);
        act.appendChild(del);
      }
      tr.appendChild(act);
      return tr;
    });
  };

  // ---- 編集 ----
  function startEdit(room) {
    editing = {
      id: room && room.id,
      objects: JSON.parse(JSON.stringify((room && room.objects) || [])),
    };
    $("metaEditor").hidden = false;
    $("metaEditorTitle").textContent = editing.id ? "部屋を直す" : "部屋を作る";
    $("metaName").value = (room && room.name) || "";
    options($("metaPlace"), catalog.places, (room && room.place) || "meadow");
    options($("metaTime"), catalog.times, (room && room.time) || "day");
    options($("metaCamera"), catalog.cameras, (room && room.camera) || "overview");
    options($("metaAddType"), catalog.objectTypes, "board");
    $("metaListed").checked = room ? room.listed !== false : true;
    $("metaStatus").textContent = "";
    $("metaOpenLink").hidden = !editing.id;
    if (editing.id) $("metaOpenLink").href = "/meta?room=" + encodeURIComponent(editing.id);
    renderObjects();
    $("metaEditor").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function field(label, value, onInput, opts) {
    opts = opts || {};
    var wrap = el("label");
    wrap.textContent = label;
    var input = document.createElement(opts.textarea ? "textarea" : "input");
    if (!opts.textarea) input.type = opts.type || "text";
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.value = value === undefined || value === null ? "" : value;
    input.addEventListener("input", function () {
      onInput(opts.type === "number" ? Number(input.value) : input.value);
    });
    wrap.appendChild(input);
    return wrap;
  }

  function renderObjects() {
    var host = $("metaObjects");
    host.innerHTML = "";
    $("metaObjCount").textContent = "（" + editing.objects.length + " / " + catalog.maxObjects + "）";
    editing.objects.forEach(function (o, index) {
      var box = el("div");
      box.className = "metaObj";
      var head = el("div");
      head.className = "head";
      var title = el("b", labelOf(catalog.objectTypes, o.type));
      head.appendChild(title);
      if (o.type === "board" && o.ad) head.appendChild(el("span", "広告", { class: "adTag" }));
      var slotSel = document.createElement("select");
      options(slotSel, catalog.slots, o.slot);
      slotSel.addEventListener("change", function () { o.slot = slotSel.value; });
      head.appendChild(el("span", "置き場所", { style: "font-size:12px;color:var(--muted)" }));
      head.appendChild(slotSel);
      var remove = el("button", "外す", { type: "button" });
      remove.addEventListener("click", function () {
        editing.objects.splice(index, 1);
        renderObjects();
      });
      head.appendChild(remove);
      box.appendChild(head);

      var grid = el("div");
      grid.className = "formGrid";
      grid.appendChild(field("見出し", o.title, function (v) { o.title = v; }, { maxLength: 24 }));

      if (o.type === "board") {
        grid.appendChild(field("本文", o.text, function (v) { o.text = v; }, { maxLength: 80, placeholder: "80文字まで" }));
        grid.appendChild(field("画像のURL（任意）", o.imageUrl, function (v) { o.imageUrl = v; }, { placeholder: "https://…" }));
        grid.appendChild(field("リンク先（任意）", o.linkUrl, function (v) { o.linkUrl = v; }, { placeholder: "https://…" }));
        var adWrap = el("label");
        var ad = document.createElement("input");
        ad.type = "checkbox";
        ad.checked = !!o.ad;
        ad.style.width = "auto";
        ad.addEventListener("change", function () {
          o.ad = ad.checked;
          renderObjects();
        });
        adWrap.appendChild(ad);
        adWrap.appendChild(document.createTextNode(" 広告として出す（「広告」の表示が付きます）"));
        grid.appendChild(adWrap);
      } else if (o.type === "video") {
        grid.appendChild(field("動画のURL", o.videoUrl, function (v) { o.videoUrl = v; }, { placeholder: "https://…/movie.mp4" }));
      } else if (o.type === "treasure") {
        grid.appendChild(field("説明", o.text, function (v) { o.text = v; }, { maxLength: 80 }));
        grid.appendChild(field("星の数（3〜30）", o.count, function (v) { o.count = v; }, { type: "number", min: 3, max: 30 }));
        grid.appendChild(field("制限時間（秒・15〜300）", o.seconds, function (v) { o.seconds = v; }, { type: "number", min: 15, max: 300 }));
        grid.appendChild(field("クリアしたときの言葉（任意）", o.clearMessage, function (v) { o.clearMessage = v; }, { maxLength: 60, placeholder: "例: クーポンコード SPRING" }));
      } else if (o.type === "rally") {
        grid.appendChild(field("説明", o.text, function (v) { o.text = v; }, { maxLength: 80 }));
        grid.appendChild(field("旗の数（2〜8）", o.points, function (v) { o.points = v; }, { type: "number", min: 2, max: 8 }));
        grid.appendChild(field("クリアしたときの言葉（任意）", o.clearMessage, function (v) { o.clearMessage = v; }, { maxLength: 60 }));
      } else if (o.type === "quiz") {
        grid.appendChild(field("説明", o.text, function (v) { o.text = v; }, { maxLength: 80 }));
        grid.appendChild(field("全問正解のときの言葉（任意）", o.clearMessage, function (v) { o.clearMessage = v; }, { maxLength: 60 }));
      }
      box.appendChild(grid);

      if (o.type === "quiz") {
        box.appendChild(el("div", "問題（" + (o.questions || []).length + " / " + catalog.maxQuizQuestions + "）", { style: "font-size:12px;color:var(--muted);margin-bottom:6px" }));
        (o.questions || []).forEach(function (q, qi) {
          var row = el("div");
          row.className = "quizRow";
          var qIn = document.createElement("input");
          qIn.placeholder = "問題（60文字まで）";
          qIn.maxLength = 60;
          qIn.value = q.q || "";
          qIn.addEventListener("input", function () { q.q = qIn.value; });
          var aSel = document.createElement("select");
          options(aSel, [{ id: "o", label: "正解は○" }, { id: "x", label: "正解は×" }], q.a || "o");
          aSel.addEventListener("change", function () { q.a = aSel.value; });
          var nIn = document.createElement("input");
          nIn.placeholder = "答えのあとの一言（任意）";
          nIn.maxLength = 60;
          nIn.value = q.note || "";
          nIn.addEventListener("input", function () { q.note = nIn.value; });
          var rm = el("button", "×", { type: "button", title: "この問題を消す" });
          rm.addEventListener("click", function () {
            o.questions.splice(qi, 1);
            renderObjects();
          });
          row.appendChild(qIn);
          row.appendChild(aSel);
          row.appendChild(nIn);
          row.appendChild(rm);
          box.appendChild(row);
        });
        if ((o.questions || []).length < catalog.maxQuizQuestions) {
          var addQ = el("button", "＋ 問題を足す", { type: "button" });
          addQ.addEventListener("click", function () {
            o.questions = o.questions || [];
            o.questions.push({ q: "", a: "o", note: "" });
            renderObjects();
          });
          box.appendChild(addQ);
        }
      }
      host.appendChild(box);
    });
    $("metaAddBtn").disabled = editing.objects.length >= catalog.maxObjects;
  }

  function init() {
    if (!$("metaNewBtn")) return;
    $("metaNewBtn").addEventListener("click", function () {
      if (!catalog) return;
      startEdit(null);
    });
    $("metaAddBtn").addEventListener("click", function () {
      if (!editing || editing.objects.length >= catalog.maxObjects) return;
      if (!freeSlot()) {
        $("metaStatus").textContent = "置き場所が埋まっています";
        return;
      }
      editing.objects.push(defaultsFor($("metaAddType").value));
      renderObjects();
    });
    $("metaCancelBtn").addEventListener("click", function () {
      editing = null;
      $("metaEditor").hidden = true;
    });
    $("metaSaveBtn").addEventListener("click", async function () {
      if (!editing) return;
      $("metaStatus").textContent = "保存しています…";
      try {
        var res = await api("/api/admin/meta/rooms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: editing.id,
            name: $("metaName").value,
            place: $("metaPlace").value,
            time: $("metaTime").value,
            camera: $("metaCamera").value,
            listed: $("metaListed").checked,
            objects: editing.objects,
          }),
        });
        editing.id = res.room.id;
        editing.objects = res.room.objects;
        $("metaStatus").textContent = "保存しました（いま部屋にいる人の画面にも反映されます）";
        $("metaEditorTitle").textContent = "部屋を直す";
        $("metaOpenLink").hidden = false;
        $("metaOpenLink").href = "/meta?room=" + encodeURIComponent(res.room.id);
        renderObjects();
        loadMetaRooms();
      } catch (e) {
        $("metaStatus").textContent = e.message;
      }
    });
  }

  init();
})();
