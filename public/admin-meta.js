/*
 * 管理画面「メタバース管理」「ミニゲーム管理」タブ。
 *
 *   メタバース管理: エリア（場所・時間帯・視点・置く物・状態・開放日時・終了日時・並び）を作る・直す・消す、
 *                   最初からあるエリアの上書きと「元に戻す」、2つ以上のエリアを1つにまとめる
 *   ミニゲーム管理: ミニゲームを止める・戻す、エリアに置くときの既定値、どのエリアで使っているか、試し場で試す
 *
 * admin.html の本体スクリプトにある api() / el() / table() を使う（このファイルはその後に読む）。
 * 選択肢（場所・置く物の種類・置き場所・センサーのゲームの範囲）はサーバーが返す定義
 * （src/metaverse.ts の metaverseCatalog）をそのまま並べる。ここで書き写すと、サーバーと食い違ったときに
 * 保存できない設定が作れてしまう。
 */
(function () {
  "use strict";

  var catalog = null;
  var settings = { disabled: [], defaults: {} };
  var rooms = [];
  var editing = null; // { id?, objects, merge?: {targetId, sourceIds}, builtin, mergedInto }

  var STATE_LABEL = { open: "公開中", soon: "近日開放", draft: "準備中", closed: "閉鎖", moved: "まとめ済み" };
  var LEVELS = [
    { id: 1, label: "やさしい" },
    { id: 2, label: "ふつう" },
    { id: 3, label: "むずかしい" },
  ];
  /** 歩いて遊ぶゲーム（センサーを使わない）の設定の範囲。SENSOR_GAMES と同じ形にそろえる */
  var WALK_GAMES = {
    treasure: { sensors: ["歩く"], goal: { label: "星の数", min: 3, max: 30, default: 10 }, seconds: { min: 15, max: 300, default: 60 }, how: "分身を歩かせて星を集める" },
    rally: { sensors: ["歩く"], goal: { label: "旗の数", min: 2, max: 8, default: 4 }, seconds: null, how: "空間の旗をぜんぶまわる" },
    quiz: { sensors: ["歩く"], goal: null, seconds: null, how: "○か×の場所へ分身を歩かせる" },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function options(select, list, value, filter) {
    select.innerHTML = "";
    list.filter(filter || function () { return true; }).forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.id;
      o.textContent = x.label;
      if (String(x.id) === String(value)) o.selected = true;
      select.appendChild(o);
    });
  }

  function labelOf(list, id) {
    var hit = list.find(function (x) { return x.id === id; });
    return hit ? hit.label : id;
  }

  function gameSpec(type) {
    return (catalog.sensorGames && catalog.sensorGames[type]) || WALK_GAMES[type] || null;
  }

  function isSensor(type) {
    return !!(catalog.sensorGames && catalog.sensorGames[type]);
  }

  function typeLabel(type) {
    return (isSensor(type) ? "📱 " : "") + labelOf(catalog.objectTypes, type);
  }

  function stateTag(state, room) {
    var text = STATE_LABEL[state] || state;
    if (state === "soon" && room && room.opensAt) text += " " + formatDate(room.opensAt);
    if (state === "moved" && room && room.mergedInto) text += " → " + roomName(room.mergedInto);
    return el("span", text, { class: "stateTag " + state });
  }

  function roomName(id) {
    var r = rooms.find(function (x) { return x.id === id; });
    return r ? r.name : id;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDate(ms) {
    var d = new Date(ms);
    return d.getMonth() + 1 + "/" + d.getDate() + " " + d.getHours() + ":" + pad2(d.getMinutes());
  }

  /** datetime-local の値 ⇔ ミリ秒（管理者のブラウザの時刻で入力する） */
  function toLocalInput(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }

  function freeSlot(objects) {
    var used = objects.map(function (o) { return o.slot; });
    var free = catalog.slots.find(function (s) { return used.indexOf(s.id) < 0; });
    return free ? free.id : null;
  }

  function defaultsFor(type) {
    var slot = freeSlot(editing.objects);
    var base = { type: type, slot: slot, title: "", text: "" };
    var d = settings.defaults[type] || {};
    if (type === "board") return Object.assign(base, { title: "お知らせ", text: "", imageUrl: "", linkUrl: "", ad: false });
    if (type === "video") return Object.assign(base, { title: "", videoUrl: "" });
    if (type === "members") return Object.assign(base, { title: "いまいる子" });
    if (type === "treasure") return Object.assign(base, { title: "宝さがし", text: "星を集めよう", count: d.goal || 10, seconds: d.seconds || 60, clearMessage: d.clearMessage || "" });
    if (type === "rally") return Object.assign(base, { title: "スタンプラリー", text: "旗をぜんぶまわろう", points: d.goal || 4, clearMessage: d.clearMessage || "" });
    if (type === "quiz") return Object.assign(base, { title: "○×クイズ", text: "○か×の場所へ歩いてね", questions: [{ q: "", a: "o", note: "" }], clearMessage: d.clearMessage || "" });
    var spec = catalog.sensorGames[type];
    if (spec) {
      return Object.assign(base, {
        title: spec.label,
        text: "",
        goal: spec.goal ? d.goal || spec.goal.default : undefined,
        seconds: spec.seconds ? d.seconds || spec.seconds.default : undefined,
        level: d.level || 2,
        clearMessage: d.clearMessage || "",
      });
    }
    return base;
  }

  async function loadAll() {
    var data = await api("/api/admin/meta/rooms");
    catalog = data.catalog;
    settings = data.settings || settings;
    rooms = data.rooms || [];
    return data;
  }

  // ================================================================ メタバース管理

  window.loadMetaRooms = async function () {
    try {
      await loadAll();
    } catch (e) {
      $("metaRoomTable").textContent = e.message;
      return;
    }
    var visible = rooms.filter(function (r) { return r.id !== "r-game-test"; });
    table("metaRoomTable", ["エリア", "状態", "場所・時間", "置く物", "一覧", "並び", ""], visible, function (r) {
      var tr = el("tr");
      if (r.state === "closed" || r.state === "moved") tr.className = "offRow";
      var name = el("td", r.name);
      if (r.builtin) name.appendChild(el("span", r.overridden ? "  最初からある（直してある）" : "  最初からある", { style: "font-size:11px;color:#9a90c0" }));
      tr.appendChild(name);
      var st = el("td");
      st.appendChild(stateTag(r.state, r));
      if (r.closesAt && r.state !== "closed") st.appendChild(el("div", "終了 " + formatDate(r.closesAt), { style: "font-size:11px;color:var(--muted)" }));
      tr.appendChild(st);
      tr.appendChild(el("td", labelOf(catalog.places, r.place) + "・" + labelOf(catalog.times, r.time)));
      var kinds = (r.objects || []).map(function (o) {
        var off = settings.disabled.indexOf(o.type) >= 0 ? "（停止中）" : "";
        return (o.ad ? "【広告】" : "") + (isSensor(o.type) ? "📱" : "") + (o.title || labelOf(catalog.objectTypes, o.type)) + off;
      });
      var objTd = el("td", kinds.join(" / ") || "なし");
      objTd.className = "wrap";
      tr.appendChild(objTd);
      tr.appendChild(el("td", r.listed ? "出す" : "リンクのみ"));
      tr.appendChild(el("td", String(r.sortOrder)));
      var act = el("td");
      act.style.whiteSpace = "nowrap";
      var open = el("a", "開く", { href: "/meta?room=" + encodeURIComponent(r.id), target: "_blank", rel: "noopener" });
      open.style.marginRight = "8px";
      act.appendChild(open);
      var edit = el("button", "直す", { type: "button" });
      edit.addEventListener("click", function () { startEdit(r); });
      act.appendChild(edit);
      var copy = el("button", "複製", { type: "button", title: "これを元に新しいエリアを作る" });
      copy.style.marginLeft = "6px";
      copy.addEventListener("click", function () {
        startEdit(Object.assign({}, r, { id: undefined, builtin: false, overridden: false, mergedInto: null, name: r.name + "（コピー）", status: "draft" }));
      });
      act.appendChild(copy);
      if (!r.builtin || r.overridden) {
        var del = el("button", r.builtin ? "元に戻す" : "消す", { type: "button" });
        del.style.marginLeft = "6px";
        del.addEventListener("click", async function () {
          var msg = r.builtin
            ? "「" + r.name + "」を、最初の状態に戻しますか？（直した設定は消えます）"
            : "「" + r.name + "」を消しますか？（いま入っている人は外に出され、リンクでも入れなくなります。ここへまとめたエリアは、まとめが解けます）";
          if (!confirm(msg)) return;
          await api("/api/admin/meta/rooms", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: r.id }),
          });
          loadMetaRooms();
        });
        act.appendChild(del);
      }
      tr.appendChild(act);
      return tr;
    });
    renderMergePicker();
  };

  // ---- まとめる ----
  function renderMergePicker() {
    var candidates = rooms.filter(function (r) { return r.state !== "moved" && r.id !== "r-game-test"; });
    var target = $("mergeTarget");
    var prev = target.value;
    options(target, candidates.map(function (r) { return { id: r.id, label: r.name + "（" + (STATE_LABEL[r.state] || r.state) + "）" }; }), prev || (candidates[0] && candidates[0].id));
    var drawSources = function () {
      var host = $("mergeSources");
      host.innerHTML = "";
      candidates
        .filter(function (r) { return r.id !== target.value; })
        .forEach(function (r) {
          var label = el("label");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = r.id;
          label.appendChild(cb);
          label.appendChild(document.createTextNode(r.name));
          host.appendChild(label);
        });
    };
    target.onchange = drawSources;
    drawSources();
  }

  function startMerge() {
    var targetId = $("mergeTarget").value;
    var sourceIds = Array.prototype.map.call($("mergeSources").querySelectorAll("input:checked"), function (cb) { return cb.value; });
    if (!targetId || sourceIds.length === 0) {
      $("mergeStatus").textContent = "まとめ先と、まとめるエリアを選んでください";
      return;
    }
    var target = rooms.find(function (r) { return r.id === targetId; });
    var objects = JSON.parse(JSON.stringify(target.objects || []));
    var dropped = [];
    sourceIds.forEach(function (sid) {
      var src = rooms.find(function (r) { return r.id === sid; });
      (src.objects || []).forEach(function (o) {
        // 同じ種類の「いまいる子の紹介」は1つで足りる
        if (o.type === "members" && objects.some(function (x) { return x.type === "members"; })) return;
        var copy = JSON.parse(JSON.stringify(o));
        copy.id = undefined;
        if (objects.some(function (x) { return x.slot === copy.slot; })) copy.slot = freeSlot(objects);
        if (!copy.slot || objects.length >= catalog.maxObjects) {
          dropped.push((src.name || sid) + "の「" + (o.title || labelOf(catalog.objectTypes, o.type)) + "」");
          return;
        }
        objects.push(copy);
      });
    });
    var names = sourceIds.map(roomName).join("・");
    startEdit(Object.assign({}, target, { objects: objects, name: target.name }), {
      merge: { targetId: targetId, sourceIds: sourceIds },
      note:
        "「" + names + "」を「" + target.name + "」にまとめます。保存すると、まとめた元のエリアのリンク・いま入っている人は、ここへ案内されます。" +
        (dropped.length ? "\n置き場所が足りず外した物: " + dropped.join("、") + "（必要なら、ほかの物を外して置き直してください）" : ""),
    });
    $("mergeStatus").textContent = "";
  }

  // ---- 編集 ----
  function startEdit(room, extra) {
    extra = extra || {};
    editing = {
      id: room && room.id,
      builtin: !!(room && room.builtin),
      mergedInto: (room && room.mergedInto) || null,
      merge: extra.merge || null,
      objects: JSON.parse(JSON.stringify((room && room.objects) || [])),
    };
    $("metaEditor").hidden = false;
    $("metaEditorTitle").textContent = editing.merge ? "エリアをまとめる" : editing.id ? "エリアを直す" : "エリアを作る";
    var note = $("metaEditorNote");
    note.innerHTML = "";
    var notes = [];
    if (extra.note) notes.push({ text: extra.note, warn: false });
    if (editing.builtin && !editing.merge) notes.push({ text: "最初からあるエリアです。保存すると上書きの設定として残り、一覧の「元に戻す」で最初の状態に戻せます。", warn: false });
    if (editing.mergedInto) notes.push({ text: "このエリアは「" + roomName(editing.mergedInto) + "」にまとめられています。下の「まとめを解く」に印を付けて保存すると、また入れるようになります。", warn: true });
    notes.forEach(function (n) {
      var d = el("div", n.text, { class: "metaNote" + (n.warn ? " warn" : "") });
      d.style.whiteSpace = "pre-line";
      note.appendChild(d);
    });
    $("metaName").value = (room && room.name) || "";
    options($("metaPlace"), catalog.places, (room && room.place) || "meadow");
    options($("metaTime"), catalog.times, (room && room.time) || "day");
    options($("metaCamera"), catalog.cameras, (room && room.camera) || "overview");
    // 新しいエリアは「準備中」から（管理者だけが入って確かめ、公開にする）
    options($("metaStatusSel"), catalog.statuses, (room && room.status) || "draft");
    $("metaOpensAt").value = toLocalInput(room && room.opensAt);
    $("metaClosesAt").value = toLocalInput(room && room.closesAt);
    $("metaSort").value = room && room.sortOrder !== undefined ? room.sortOrder : 100;
    options(
      $("metaAddType"),
      catalog.objectTypes.map(function (t) { return { id: t.id, label: typeLabel(t.id) + (settings.disabled.indexOf(t.id) >= 0 ? "（停止中）" : "") }; }),
      "board"
    );
    $("metaListed").checked = room ? room.listed !== false : true;
    $("metaUnmergeWrap").hidden = !editing.mergedInto;
    $("metaUnmerge").checked = false;
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

  function selectField(label, list, value, onChange) {
    var wrap = el("label");
    wrap.textContent = label;
    var sel = document.createElement("select");
    options(sel, list, value);
    sel.addEventListener("change", function () { onChange(sel.value); });
    wrap.appendChild(sel);
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
      var title = el("b", typeLabel(o.type));
      head.appendChild(title);
      if (o.type === "board" && o.ad) head.appendChild(el("span", "広告", { class: "adTag" }));
      if (settings.disabled.indexOf(o.type) >= 0) head.appendChild(el("span", "停止中（ミニゲーム管理で止めています）", { class: "stateTag closed" }));
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

      var spec = isSensor(o.type) ? catalog.sensorGames[o.type] : null;
      if (spec) box.appendChild(el("div", spec.how + "（使うもの: " + spec.sensors.join("・") + "／使えないときは" + spec.fallback + "）", { class: "sensorHow" }));

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
      } else if (spec) {
        grid.appendChild(field("説明（任意）", o.text, function (v) { o.text = v; }, { maxLength: 80 }));
        if (spec.goal) {
          grid.appendChild(
            field(spec.goal.label + "（" + spec.goal.min + "〜" + spec.goal.max + "）", o.goal, function (v) { o.goal = v; }, { type: "number", min: spec.goal.min, max: spec.goal.max })
          );
        }
        if (spec.seconds) {
          grid.appendChild(
            field("制限時間（秒・" + spec.seconds.min + "〜" + spec.seconds.max + "）", o.seconds, function (v) { o.seconds = v; }, { type: "number", min: spec.seconds.min, max: spec.seconds.max })
          );
        }
        grid.appendChild(selectField("むずかしさ", LEVELS, o.level || 2, function (v) { o.level = Number(v); }));
        grid.appendChild(field("クリアしたときの言葉（任意）", o.clearMessage, function (v) { o.clearMessage = v; }, { maxLength: 60, placeholder: "例: クーポンコード SPRING" }));
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

  function roomPayload() {
    return {
      id: editing.id,
      name: $("metaName").value,
      place: $("metaPlace").value,
      time: $("metaTime").value,
      camera: $("metaCamera").value,
      listed: $("metaListed").checked,
      status: $("metaStatusSel").value,
      opensAt: fromLocalInput($("metaOpensAt").value),
      closesAt: fromLocalInput($("metaClosesAt").value),
      sortOrder: Number($("metaSort").value) || 100,
      unmerge: $("metaUnmerge").checked,
      objects: editing.objects,
    };
  }

  async function save() {
    if (!editing) return;
    $("metaStatus").textContent = "保存しています…";
    try {
      var res;
      if (editing.merge) {
        res = await api("/api/admin/meta/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetId: editing.merge.targetId, sourceIds: editing.merge.sourceIds, room: roomPayload() }),
        });
        $("metaStatus").textContent = "まとめました（" + res.merged.length + "つのエリアを、ここへ案内します）";
        editing.merge = null;
      } else {
        res = await api("/api/admin/meta/rooms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(roomPayload()),
        });
        var state = res.state ? "（いまの状態: " + (STATE_LABEL[res.state] || res.state) + "）" : "";
        $("metaStatus").textContent = "保存しました" + state + "。いまエリアにいる人の画面にも反映されます";
      }
      editing.id = res.room.id;
      editing.objects = res.room.objects;
      editing.mergedInto = res.room.mergedInto || null;
      $("metaUnmergeWrap").hidden = !editing.mergedInto;
      $("metaEditorTitle").textContent = "エリアを直す";
      $("metaEditorNote").innerHTML = "";
      $("metaOpenLink").hidden = false;
      $("metaOpenLink").href = "/meta?room=" + encodeURIComponent(res.room.id);
      renderObjects();
      loadMetaRooms();
    } catch (e) {
      $("metaStatus").textContent = e.message;
    }
  }

  // ================================================================ ミニゲーム管理

  window.loadMetaGames = async function () {
    var data;
    try {
      data = await api("/api/admin/meta/games");
    } catch (e) {
      $("metaGameTable").textContent = e.message;
      return;
    }
    catalog = data.catalog;
    settings = data.settings || { disabled: [], defaults: {} };
    var usedIn = data.usedIn || {};
    var draft = { disabled: settings.disabled.slice(), defaults: JSON.parse(JSON.stringify(settings.defaults || {})) };
    window.__metaGamesDraft = draft;
    var games = catalog.objectTypes.filter(function (t) { return t.game; });
    table("metaGameTable", ["ミニゲーム", "使うもの", "出す", "使っているエリア", "エリアに置くときの既定値", ""], games, function (t) {
      var spec = gameSpec(t.id) || {};
      var tr = el("tr");
      var off = draft.disabled.indexOf(t.id) >= 0;
      if (off) tr.className = "offRow";
      var name = el("td");
      name.appendChild(el("b", typeLabel(t.id).replace("ミニゲーム：", "")));
      if (spec.how) name.appendChild(el("div", spec.how, { style: "font-size:11px;color:var(--muted);max-width:26em;white-space:normal" }));
      tr.appendChild(name);
      var sensors = el("td", (spec.sensors || []).join("・") + (spec.fallback ? "\n（代わり: " + spec.fallback + "）" : ""));
      sensors.style.whiteSpace = "pre-line";
      sensors.style.fontSize = "12px";
      tr.appendChild(sensors);
      var onTd = el("td");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !off;
      cb.style.width = "auto";
      cb.addEventListener("change", function () {
        var i = draft.disabled.indexOf(t.id);
        if (cb.checked && i >= 0) draft.disabled.splice(i, 1);
        if (!cb.checked && i < 0) draft.disabled.push(t.id);
        tr.className = cb.checked ? "" : "offRow";
        $("gamesStatus").textContent = "まだ保存していません";
      });
      var lab = el("label");
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(cb.checked ? " 出す" : " 止める"));
      cb.addEventListener("change", function () { lab.lastChild.textContent = cb.checked ? " 出す" : " 止める"; });
      onTd.appendChild(lab);
      tr.appendChild(onTd);
      var list = usedIn[t.id] || [];
      var used = el("td", list.filter(function (r) { return r.id !== "r-game-test"; }).map(function (r) { return r.name + (r.state !== "open" ? "（" + (STATE_LABEL[r.state] || r.state) + "）" : ""); }).join("、") || "—");
      used.className = "wrap";
      used.style.fontSize = "12px";
      tr.appendChild(used);

      var defTd = el("td");
      var box = el("div");
      box.className = "gameDefaults";
      var d = (draft.defaults[t.id] = draft.defaults[t.id] || {});
      var num = function (label, key, range) {
        box.appendChild(el("span", label));
        var input = document.createElement("input");
        input.type = "number";
        input.min = range.min;
        input.max = range.max;
        input.placeholder = String(range.default);
        input.value = d[key] || "";
        input.addEventListener("input", function () {
          d[key] = input.value ? Number(input.value) : undefined;
          $("gamesStatus").textContent = "まだ保存していません";
        });
        box.appendChild(input);
      };
      if (spec.goal) num(spec.goal.label, "goal", spec.goal);
      if (spec.seconds) num("秒", "seconds", spec.seconds);
      if (isSensor(t.id)) {
        box.appendChild(el("span", "むずかしさ"));
        var sel = document.createElement("select");
        options(sel, LEVELS, d.level || 2);
        sel.addEventListener("change", function () {
          d.level = Number(sel.value);
          $("gamesStatus").textContent = "まだ保存していません";
        });
        box.appendChild(sel);
      }
      if (!spec.goal && !spec.seconds && !isSensor(t.id)) box.appendChild(el("span", "（問題はエリアごとに入れます）"));
      defTd.appendChild(box);
      tr.appendChild(defTd);

      var act = el("td");
      var tryBtn = el("button", "試す", { type: "button", title: "このゲームだけを置いた試し場（管理者だけが入れる）を開きます" });
      tryBtn.addEventListener("click", async function () {
        // ポップアップを止められないように、先に窓を開けてから行き先を入れる
        var win = window.open("about:blank", "_blank");
        try {
          var res = await api("/api/admin/meta/games/test", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: t.id }),
          });
          if (win) win.location.href = res.url;
          else location.href = res.url;
        } catch (e) {
          if (win) win.close();
          $("gamesStatus").textContent = e.message;
        }
      });
      act.appendChild(tryBtn);
      tr.appendChild(act);
      return tr;
    });
  };

  async function saveGames() {
    var draft = window.__metaGamesDraft;
    if (!draft) return;
    $("gamesStatus").textContent = "保存しています…";
    try {
      var res = await api("/api/admin/meta/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      settings = res.settings;
      $("gamesStatus").textContent = "保存しました（止めたゲームは、いま開いているエリアからもすぐ消えます）";
      loadMetaGames();
    } catch (e) {
      $("gamesStatus").textContent = e.message;
    }
  }

  // ================================================================ 起動

  function init() {
    if (!$("metaNewBtn")) return;
    $("metaNewBtn").addEventListener("click", function () {
      if (!catalog) return;
      startEdit(null);
    });
    $("metaAddBtn").addEventListener("click", function () {
      if (!editing || editing.objects.length >= catalog.maxObjects) return;
      if (!freeSlot(editing.objects)) {
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
    $("metaSaveBtn").addEventListener("click", save);
    $("mergeStartBtn").addEventListener("click", startMerge);
    if ($("gamesSaveBtn")) $("gamesSaveBtn").addEventListener("click", saveGames);
  }

  init();
})();
