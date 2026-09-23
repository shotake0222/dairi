/**
 * メタバースの財布とお店の画面（通貨の中身は src/economy.ts）。
 *
 *   HUD の「🪙 120」… いま選んでいる子の財布（持ち物・引換券・出入り・ルール）
 *   お店の屋台       … そのお店の商品（買う → 身につける・演出に使う・提携店の引換券になる）
 *
 * 財布を開けるのは、この端末に持ち主の印がある子だけ（API に cid と持ち主トークンを送って確かめる）。
 * 演出を使う・かざりを付け替えたことは、部屋（WebSocket）に知らせて、みんなの画面に出す。
 */

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }) : "");
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

const STATUS_TEXT = { issued: "使えます", used: "使用済み", cancelled: "取り消し", expired: "期限切れ" };

/**
 * @param {object} ctx
 *   $(id), dialog({title, body, actions}), toast(text), hint(text, ms)
 *   selected() → いま選んでいる子（Actor）か null
 *   creds(aid) → { cid, token } | null
 *   send(msg)  → 部屋へ送る
 */
export function createWallet(ctx) {
  const { $ } = ctx;
  let info = null;
  let data = null;
  let tab = "items";
  const cache = new Map(); // aid → 残高

  async function post(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || "うまくいきませんでした"), { code: json.code });
    return json;
  }

  function me() {
    const a = ctx.selected();
    if (!a) return null;
    const c = ctx.creds(a.aid);
    return c ? { actor: a, ...c } : null;
  }

  function label(n) {
    const s = info?.settings || {};
    return `${s.symbol || "🪙"} ${Number(n || 0).toLocaleString()}`;
  }

  function renderPill() {
    const btn = $("walletBtn");
    if (!info || !info.settings.enabled) {
      btn.hidden = true;
      return;
    }
    const a = ctx.selected();
    btn.hidden = !a || !ctx.creds(a.aid);
    if (a) btn.textContent = label(cache.get(a.aid) ?? 0);
  }

  async function loadInfo() {
    try {
      info = await (await fetch("/api/meta/economy/info")).json();
    } catch {
      info = null;
    }
    renderPill();
  }

  /** いま選んでいる子の財布を読み直す（HUD の数字も） */
  async function refresh() {
    const m = me();
    if (!m || !info?.settings.enabled) return renderPill();
    try {
      data = await post("/api/meta/economy/wallet", { cid: m.cid, token: m.token });
      cache.set(m.actor.aid, data.balance);
    } catch {
      data = null;
    }
    renderPill();
    if (!$("walletSheet").hidden) renderWallet();
  }

  /** 部屋から「貯まった」の知らせ */
  function onCoins(msg) {
    cache.set(msg.aid, msg.balance);
    renderPill();
    const s = info?.settings || {};
    const why = { login: "今日はじめての入室", clear: "ミニゲームをクリア", talk: "おしゃべり" }[msg.reason] || "";
    ctx.toast(`${s.symbol || "🪙"} +${msg.amount} ${s.unit || ""}（${why}）`);
    const a = ctx.selected();
    if (a && a.aid === msg.aid) a.bubble(`${s.symbol || "🪙"}+${msg.amount}`, 1800, "stamp");
    if (!$("walletSheet").hidden) refresh();
  }

  // ---------------------------------------------------------------- 財布

  function open() {
    if (!me()) {
      ctx.dialog({ title: "財布", body: "この端末で育てている子を選ぶと、財布が開けます。", actions: [{ label: "とじる" }] });
      return;
    }
    $("walletSheet").hidden = false;
    renderWallet();
    refresh();
  }

  function renderWallet() {
    const s = info?.settings || {};
    const a = ctx.selected();
    $("walletTitle").textContent = `${a ? a.name : ""}の財布`;
    $("walletBalance").textContent = data ? label(data.balance) : "…";
    $("walletToday").textContent = data ? `今日 +${data.todayEarned}（1日 ${s.dailyEarnCap} ${s.unit}まで）` : "";
    for (const b of document.querySelectorAll("#walletTabs button")) b.classList.toggle("on", b.dataset.tab === tab);
    const body = $("walletBody");
    if (!data) {
      body.innerHTML = `<p class="wEmpty">読み込み中…</p>`;
      return;
    }
    if (tab === "items") body.innerHTML = itemsHtml();
    else if (tab === "vouchers") body.innerHTML = vouchersHtml();
    else if (tab === "history") body.innerHTML = historyHtml();
    else body.innerHTML = rulesHtml();
    for (const b of body.querySelectorAll("[data-equip]")) b.addEventListener("click", () => doEquip(b.dataset.equip, b.dataset.on === "1"));
    for (const b of body.querySelectorAll("[data-use]")) b.addEventListener("click", () => useEffect(b.dataset.use));
    for (const b of body.querySelectorAll("[data-voucher]")) b.addEventListener("click", () => showVoucher(data.vouchers.find((v) => v.code === b.dataset.voucher)));
  }

  function itemsHtml() {
    const list = data.inventory.filter((i) => i.item);
    if (!list.length) return `<p class="wEmpty">まだ何もありません。<br />エリアの「お店」（ひろばの雑貨屋など）で買えます。</p>`;
    return list
      .map((i) => {
        const it = i.item;
        let action = "";
        if (it.kind === "wear") action = i.equipped ? `<button type="button" data-equip="${escapeHtml(it.id)}" data-on="0" class="on">つけている</button>` : `<button type="button" data-equip="${escapeHtml(it.id)}" data-on="1">つける</button>`;
        else if (it.kind === "effect") action = `<button type="button" data-use="${escapeHtml(it.id)}">使う</button>`;
        return `<div class="wRow"><span class="wIcon">${escapeHtml(it.icon)}</span><span class="wMain"><b>${escapeHtml(it.name)}</b><small>${escapeHtml(
          it.kind === "effect" ? `のこり ${i.qty}こ・${it.description}` : it.description
        )}</small></span>${action}</div>`;
      })
      .join("");
  }

  function vouchersHtml() {
    if (!data.vouchers.length) return `<p class="wEmpty">引換券はまだありません。<br />「引き換え所」で、コインを提携店の引換券にかえられます。</p>`;
    return data.vouchers
      .map(
        (v) => `<button type="button" class="wRow wVoucher ${v.status}" data-voucher="${escapeHtml(v.code)}"><span class="wIcon">🎟</span><span class="wMain"><b>${escapeHtml(v.title)}</b><small>${escapeHtml(
          v.partnerName
        )}・${v.status === "issued" && v.expiresAt ? `${fmtDate(v.expiresAt)}まで` : STATUS_TEXT[v.status]}</small></span><em>${STATUS_TEXT[v.status]}</em></button>`
      )
      .join("");
  }

  function historyHtml() {
    if (!data.ledger.length) return `<p class="wEmpty">まだ出入りはありません。</p>`;
    return `<div class="wHist">${data.ledger
      .map((l) => `<div><span>${escapeHtml(fmtDateTime(l.at))}</span><span class="n">${escapeHtml(l.note)}</span><b class="${l.delta > 0 ? "plus" : "minus"}">${l.delta > 0 ? "+" : ""}${l.delta}</b></div>`)
      .join("")}</div>`;
  }

  function rulesHtml() {
    const s = info?.settings || {};
    const rules = info?.rules || [];
    return `<div class="wRules"><p><b>${escapeHtml(s.name)}</b>は、メタバースの中だけで使えるポイントです。</p><ul>${rules.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      <p class="wNote">貯まる額: 毎日の入室 +${s.loginBonus}／ミニゲームのクリア +${s.clearReward}（同じ屋台は1日1回）／おしゃべり +${s.talkReward}（1日${s.talkDailyMax}回まで）。1日 ${s.dailyEarnCap} ${escapeHtml(s.unit)}まで。</p>
      <p class="wNote">引換券は1か月${s.voucherMonthlyLimit}枚まで。お店で見せると、お店の人が「使った」にします。</p></div>`;
  }

  async function doEquip(itemId, on) {
    const m = me();
    if (!m) return;
    try {
      const r = await post("/api/meta/economy/equip", { cid: m.cid, token: m.token, itemId, on });
      m.actor.setWear(r.wear);
      ctx.send({ t: "wear", aid: m.actor.aid });
      await refresh();
    } catch (e) {
      ctx.toast(e.message);
    }
  }

  function useEffect(itemId) {
    const a = ctx.selected();
    if (!a) return;
    ctx.send({ t: "effect", aid: a.aid, itemId });
    $("walletSheet").hidden = true;
  }

  function onEffectLeft() {
    refresh();
  }

  function showVoucher(v) {
    if (!v) return;
    $("voucherTitle").textContent = v.title;
    $("voucherPartner").textContent = v.partnerName ? `使えるお店: ${v.partnerName}` : "";
    $("voucherCode").textContent = v.code.replace(/(.{4})(.{4})(.{2})/, "$1-$2-$3");
    $("voucherStatus").textContent = STATUS_TEXT[v.status] + (v.status === "issued" && v.expiresAt ? `（${fmtDate(v.expiresAt)}まで）` : v.usedAt ? `（${fmtDateTime(v.usedAt)}）` : "");
    $("voucherStatus").className = v.status;
    $("voucherNote").textContent = v.note || "お店の人にこの画面を見せてください。お店の人が番号を確かめて「使った」にします。";
    const qrBox = $("voucherQr");
    qrBox.innerHTML = "";
    if (v.status === "issued" && typeof window.qrcode === "function") {
      const qr = window.qrcode(0, "M");
      qr.addData(`${location.origin}/redeem?code=${v.code}`);
      qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
    }
    $("voucherSheet").hidden = false;
  }

  // ---------------------------------------------------------------- お店

  let shopState = null;

  async function openShop(shopId, fallbackTitle) {
    const m = me();
    if (!info?.settings.enabled) {
      ctx.dialog({ title: fallbackTitle || "お店", body: "いまはお店がお休みです。", actions: [{ label: "とじる" }] });
      return;
    }
    if (!m) {
      ctx.dialog({ title: fallbackTitle || "お店", body: "この端末で育てている子を選ぶと、買い物ができます。", actions: [{ label: "とじる" }] });
      return;
    }
    $("shopSheet").hidden = false;
    $("shopName").textContent = fallbackTitle || "お店";
    $("shopKeeper").textContent = "";
    $("shopItems").innerHTML = `<p class="wEmpty">読み込み中…</p>`;
    try {
      shopState = await post("/api/meta/economy/shop", { cid: m.cid, token: m.token, shopId });
      shopState.shopId = shopId;
      cache.set(m.actor.aid, shopState.balance);
      renderPill();
      renderShop();
    } catch (e) {
      $("shopItems").innerHTML = `<p class="wEmpty">${escapeHtml(e.message)}</p>`;
    }
  }

  function renderShop() {
    const st = shopState;
    const s = st.settings;
    $("shopName").textContent = st.shop.name;
    $("shopKeeper").textContent = st.shop.keeper || st.shop.description || "";
    $("shopBalance").textContent = `持っている${s.name}: ${label(st.balance)}`;
    if (!st.items.length) {
      $("shopItems").innerHTML = `<p class="wEmpty">${st.shop.id === "koukan" || st.shop.name.includes("引き換え") ? "提携店の引換券は、まだ準備中です。" : "いまは商品がありません。"}</p>`;
      return;
    }
    $("shopItems").innerHTML = st.items
      .map((i) => {
        const short = st.balance < i.price;
        const btn = i.blocked
          ? `<button type="button" disabled>${escapeHtml(i.blocked)}</button>`
          : `<button type="button" data-buy="${escapeHtml(i.id)}" ${short ? "disabled" : ""}>${short ? "たりない" : "買う"}</button>`;
        const extra =
          i.kind === "real" && i.partner
            ? `<small class="real">🏪 ${escapeHtml(i.partner.name)}${i.partner.area ? `（${escapeHtml(i.partner.area)}）` : ""}・発行から${i.validDays}日間</small>`
            : i.kind === "effect"
              ? `<small>使うと部屋のみんなに見えます${i.owned ? `（持っている: ${i.owned}こ）` : ""}</small>`
              : "";
        const left = i.left !== null && i.left !== undefined ? `<small>のこり ${i.left}</small>` : "";
        return `<div class="wRow"><span class="wIcon">${escapeHtml(i.icon)}</span><span class="wMain"><b>${escapeHtml(i.name)}</b><small>${escapeHtml(i.description)}</small>${extra}${left}</span><span class="wPrice">${label(
          i.price
        )}${btn}</span></div>`;
      })
      .join("");
    for (const b of $("shopItems").querySelectorAll("[data-buy]")) b.addEventListener("click", () => confirmBuy(st.items.find((i) => i.id === b.dataset.buy)));
  }

  function confirmBuy(item) {
    if (!item) return;
    const s = shopState.settings;
    const realNote = item.kind === "real" ? `\n\n提携店「${item.partner?.name || ""}」で使える引換券になります（発行から${item.validDays}日間）。${item.usage ? `\n${item.usage}` : ""}\n引き換えたあとは、コインに戻せません。` : "";
    ctx.dialog({
      title: `${item.name}を買いますか？`,
      body: `${label(item.price)} ${s.unit}を使います。${realNote}`,
      actions: [
        { label: "買う", primary: true, run: () => doBuy(item) },
        { label: "やめる" },
      ],
    });
  }

  async function doBuy(item) {
    const m = me();
    if (!m) return;
    try {
      const r = await post("/api/meta/economy/buy", { cid: m.cid, token: m.token, shopId: shopState.shopId, itemId: item.id });
      cache.set(m.actor.aid, r.balance);
      renderPill();
      m.actor.bubble("ありがとう！", 1800);
      await openShop(shopState.shopId, shopState.shop.name);
      if (r.voucher) {
        await refresh();
        showVoucher(r.voucher);
      } else if (item.kind === "wear") {
        ctx.dialog({
          title: `${item.name}を買いました`,
          body: "いま身につけますか？（財布の「持ち物」からも付け替えられます）",
          actions: [
            { label: "つける", primary: true, run: () => doEquip(item.id, true) },
            { label: "あとで" },
          ],
        });
      } else {
        ctx.toast(`${item.name}を買いました（財布の「持ち物」から使えます）`);
      }
    } catch (e) {
      ctx.toast(e.message);
    }
  }

  // ---------------------------------------------------------------- つなぐ

  $("walletBtn").addEventListener("click", open);
  $("walletClose").addEventListener("click", () => ($("walletSheet").hidden = true));
  $("shopClose").addEventListener("click", () => ($("shopSheet").hidden = true));
  $("shopWallet").addEventListener("click", () => {
    $("shopSheet").hidden = true;
    open();
  });
  $("voucherClose").addEventListener("click", () => ($("voucherSheet").hidden = true));
  for (const b of document.querySelectorAll("#walletTabs button")) {
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      renderWallet();
    });
  }
  loadInfo();

  return {
    refresh,
    renderPill,
    onCoins,
    onEffectLeft,
    open,
    openShop,
    get enabled() {
      return !!info?.settings.enabled;
    },
  };
}
