/**
 * はじめる前の同意（利用規約・プライバシーポリシー）。
 *
 * **なぜ画面をまたぐ共通スクリプトにしたか。**
 * 同意を取る場所が1つだと、その画面を通らずに入ってきた人が素通りする。
 * 依代から来る人（/summon）と、ホーム画面から直接開く人（/chat）で入口が違うので、
 * どちらにも同じものを差し込む。文面はサーバー（src/persona/consent.ts）が唯一の定義元で、
 * ここでは取ってきて並べるだけ——2箇所に書くと必ず食い違う。
 *
 * 同意していないあいだは会話をさせない。「あとで読む」を作らないのは、
 * あとで読む人がいないから。**読まずに始められる導線を用意した時点で、同意は形だけになる。**
 *
 * 使い方（HTML側）:
 *   <script src="/gate.js" defer></script>
 *   await window.waketamaGate.require(cid, ownerToken)   // 同意済みなら即 true
 */
(function () {
  "use strict";

  const STYLE = `
  .wtGate { position: fixed; inset: 0; background: rgba(28,22,48,.72); z-index: 9999;
    display: grid; place-items: center; padding: 16px; }
  .wtGate .box { background: #fff; border-radius: 18px; max-width: 460px; width: 100%;
    max-height: 88vh; overflow: auto; padding: 22px 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
    color: #1c1630; line-height: 1.85; }
  .wtGate h2 { margin: 0 0 10px; font-size: 17px; }
  .wtGate p { margin: 0 0 12px; font-size: 13.5px; color: #4a4266; }
  .wtGate .note { font-size: 12.5px; color: #6f668f; }
  .wtGate .points { background: #f7f5ff; border-radius: 12px; padding: 12px 14px; margin: 0 0 14px; }
  .wtGate .points div { font-size: 13px; margin-bottom: 8px; display: flex; gap: 8px; }
  .wtGate .points div:last-child { margin-bottom: 0; }
  .wtGate .points b { color: #4c3a99; flex: none; }
  .wtGate a { color: #7c5cff; }
  /* 文面が長いので、押すところは**下に貼り付けておく**。
     読み切らないと同意できない作りだが、押す場所を探させるのは別の話。 */
  .wtGate .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px;
    position: sticky; bottom: -22px; background: #fff; padding: 12px 0 14px;
    box-shadow: 0 -10px 12px -10px rgba(28,22,48,.18); }
  /*
   * **opacity を必ず打ち消すこと。**
   * この画面は差し込み先のCSSの中で描かれる。召喚画面（/summon）には
   *   button { opacity: 0; transition: opacity .6s }  ← 登場演出のための指定
   * があり、それがこちらのボタンにも効いて、**同意ボタンが最初の画面で
   * 完全に見えなくなっていた**（押せてはいたので、E2Eでは気づけなかった）。
   * 生まれてすぐの人が、文章の壁の前で進めなくなる。
   * 以降、ここに差し込むものは「親の指定が来ても壊れない」書き方にする。
   */
  .wtGate button { border: none; background: #7c5cff; color: #fff; font-weight: 700; font-size: 15px;
    padding: 13px 24px; border-radius: 999px; cursor: pointer; font-family: inherit;
    opacity: 1; transform: none; transition: none; }
  .wtGate button.ghost { background: #fff; color: #6f668f; border: 1px solid #e9e5f7; font-weight: 400; font-size: 13px; }
  .wtGate input[type="checkbox"] { opacity: 1; }
  .wtGate label { display: block; cursor: pointer; }
  .wtGate .err { color: #c0392b; font-size: 12.5px; min-height: 18px; }
  /* 同意すると一緒に有効になる使い道。**選ばせないが、隠さない。**
     囲って別扱いにしているのは、本文の一部として読み飛ばされないようにするため。 */
  .wtGate .opt { border: 1px solid #ece8fb; border-radius: 12px; padding: 12px 14px; margin: 14px 0 0; }
  .wtGate .opt > .lead { font-size: 12.5px; color: #6f668f; margin: 0 0 10px; }
  .wtGate .optItem { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; }
  .wtGate .optItem:last-child { margin-bottom: 0; }
  .wtGate .optItem .mark { color: #7c5cff; font-weight: 700; flex: none; }
  .wtGate .optItem .t { font-size: 13px; font-weight: 700; display: block; margin-bottom: 2px; }
  .wtGate .optItem .d { font-size: 12.5px; color: #4a4266; display: block; }
  .wtGate .optItem .n { font-size: 12px; color: #8f86ad; display: block; margin-top: 3px; }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `失敗しました (${res.status})`);
    return data;
  }

  /**
   * 同意の画面を出して、押されるまで待つ。
   * 閉じる手段は「同意する」しか無い。読まずに進む道を作らないため。
   *
   * **聞くのは1つだけ。使い道は全部見せる。**
   * 以前はここに任意のチェックを2つ並べていたが、生まれた直後の人に
   * 3つの判断を求める形になっていて、結局ほとんど読まれずに素通りしていた。
   * いまは「はじめるかどうか」だけを聞き、その同意に含まれる使い道は
   * **チェックではなく本文として全部並べる**（src/persona/consent.ts の BUNDLED_WITH_TERMS）。
   *
   * この形が成立する条件は2つ。**どちらも外さないこと**:
   *   1. 束ねた使い道を1つ残らずここに出す（畳まない・省略しない）
   *   2. あとから1つずつ止められる（/profile の設定）
   */
  function ask(allTexts, cid, ownerToken) {
    const texts = allTexts.terms || {};
    return new Promise((resolve) => {
      const style = el("style");
      style.textContent = STYLE;
      document.head.appendChild(style);

      const overlay = el("div", "wtGate");
      const box = el("div", "box");

      box.appendChild(el("h2", null, texts.title || "はじめる前に"));

      // 長い文章は読まれない。先に3行で要点を出してから、本文へ落とす。
      const points = el("div", "points");
      [
        ["個人情報", "氏名・メールアドレス・電話番号はお預かりしません。アカウント登録もありません"],
        ["会話の中身", "運営が読むことはありません。外へ出るときも、本文そのものは渡りません"],
        ["使い道", "会話から生まれた性格や傾向を、運営がサービスの改善や、個人が特定されない形での提供に使うことがあります"],
      ].forEach(([k, v]) => {
        const row = el("div");
        row.appendChild(el("b", null, k));
        row.appendChild(el("span", null, v));
        points.appendChild(row);
      });
      box.appendChild(points);

      // サーバー側の文面をそのまま出す。** で強調されている箇所だけ太字にする。
      // 本文だけに掛けていたので、note に ** を書いた日に記号が素で出た
      const withEmphasis = (cls, source) => {
        const p = el("p", cls);
        String(source || "").split(/\*\*(.+?)\*\*/).forEach((part, i) => {
          p.appendChild(i % 2 === 1 ? el("strong", null, part) : document.createTextNode(part));
        });
        return p;
      };
      box.appendChild(withEmphasis(null, texts.body));
      box.appendChild(withEmphasis("note", texts.note));

      const links = el("p", "note");
      const terms = el("a", null, "利用規約");
      terms.href = "/terms";
      terms.target = "_blank";
      terms.rel = "noopener";
      const privacy = el("a", null, "プライバシーポリシー");
      privacy.href = "/privacy";
      privacy.target = "_blank";
      privacy.rel = "noopener";
      links.append(terms, document.createTextNode(" ・ "), privacy, document.createTextNode(" を開く"));
      box.appendChild(links);

      // --- 束ねた使い道。**チェックではなく、説明として全部見せる** ---
      // 選ばせないぶん、隠さない。ここを畳んだり省いたりしたら、同意ではなくなる。
      const bundled = ["profile", "aggregate"].filter((k) => allTexts[k]);
      if (bundled.length > 0) {
        const opt = el("div", "opt");
        opt.appendChild(el("p", "lead", "はじめると、次の2つが有効になります。あとから設定でいつでも止められます。"));
        for (const key of bundled) {
          const t = allTexts[key] || {};
          const item = el("div", "optItem");
          const mark = el("span", "mark", "・");
          const label = el("div");
          label.appendChild(el("span", "t", t.title || key));
          label.appendChild(el("span", "d", t.body || ""));
          if (t.note) label.appendChild(el("span", "n", t.note));
          item.append(mark, label);
          opt.appendChild(item);
        }
        box.appendChild(opt);
      }

      const err = el("div", "err");
      const row = el("div", "row");
      const ok = el("button", null, "同意してはじめる");
      const no = el("button", "ghost", "やめておく");
      row.append(ok, no);
      box.append(row, err);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      ok.addEventListener("click", async () => {
        ok.disabled = true;
        err.textContent = "";
        try {
          await fetchJson("/api/consent", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              characterId: cid,
              token: ownerToken,
              // terms だけ送る。束ねた使い道はサーバーが付ける
              // （BUNDLED_WITH_TERMS。画面が勝手に足すと、束ねる範囲が2箇所に散る）
              consent: { terms: true },
            }),
          });
          overlay.remove();
          resolve(true);
        } catch (e) {
          // ここで失敗したまま進ませない。同意が記録されていないのに使えるのは、同意が無いのと同じ。
          err.textContent = e.message + "（電波のいい場所で、もう一度お試しください）";
          ok.disabled = false;
        }
      });

      no.addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
    });
  }

  /**
   * 同意が要るかを確かめ、必要なら聞く。
   * @returns true なら進んでよい
   */
  async function require_(cid, ownerToken) {
    if (!cid) return true;
    try {
      const [schema, view] = await Promise.all([
        fetchJson("/api/profile/schema"),
        fetchJson(`/api/profile?cid=${encodeURIComponent(cid)}&token=${encodeURIComponent(ownerToken || "")}`),
      ]);
      const c = view.consent || {};
      // 版が上がっているときも聞き直す。文面が変わったのに古い同意を使い回すのは、
      // 黙って範囲を広げるのと同じ。
      if (c.version === schema.consentVersion && c.terms === true) return true;
      return await ask(schema.consentTexts || {}, cid, ownerToken);
    } catch (e) {
      // 持ち主でない端末（403）や、まだ存在しない分身では聞きようがない。
      // ここで止めると復旧や共有リンクまで塞ぐので、通す。
      return true;
    }
  }

  window.waketamaGate = { require: require_ };
})();
