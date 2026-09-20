/**
 * ブラウザを実際に動かす通しテスト（E2E）。
 *
 * vitest（npm test）はWorker側のロジックを検証するもので、
 * 「画面がスマホ幅で崩れていないか」「削除したあとに行き止まりにならないか」といった
 * ブラウザ上でしか分からない部分は拾えない。ここはそれを補うためのスクリプト。
 *
 * 使い方（2つのターミナル、または別プロセスで）:
 *   1) npx wrangler d1 migrations apply nfc-companion-db --local   # 初回のみ
 *   2) npm run dev                                                  # http://127.0.0.1:8787 で待ち受け
 *   3) npm run test:e2e
 *
 * スクリーンショットは tools/.e2e-out/ に出る（.gitignore 済み）。目視確認にも使える。
 * playwrightは開発時のみ必要なため、未インストールなら案内だけ出して終了する。
 */

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".e2e-out");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (err) {
  console.error("playwrightが見つかりません。`npm i -D playwright` を実行してから再度お試しください。");
  process.exit(1);
}

const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label} ${detail}`);
    failures.push(label);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

// 開発サーバーが起動しているかを先に確かめる（起動忘れで意味不明なエラーを出さないため）
try {
  const ping = await fetch(`${BASE}/home`);
  if (!ping.ok) throw new Error(`status ${ping.status}`);
} catch (err) {
  console.error(`開発サーバー(${BASE})に接続できませんでした。先に \`npm run dev\` を起動してください。`);
  process.exit(1);
}

const browser = await chromium.launch({
  // クラウド開発環境などでプリインストール済みChromiumを使いたい場合に指定できるようにしておく
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});

const pageErrors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 820 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("dialog", (d) => d.accept()); // 削除の確認ダイアログは自動で承諾する

/**
 * はじめる前の同意。
 *
 * 会話も召喚も、同意していないと先へ進まない作りにした（public/gate.js）。
 * E2Eでも実際の人と同じ手順を踏む——ここを迂回できるようにすると、
 * 「同意しなくても使えてしまう」不具合をテストが素通りする。
 */
async function acceptGateIfShown(label) {
  const btn = page.locator(".wtGate button:not(.ghost)");
  try {
    await btn.waitFor({ state: "visible", timeout: 4000 });
  } catch (e) {
    return false;
  }
  await btn.click();
  await page.locator(".wtGate").waitFor({ state: "detached", timeout: 8000 });
  if (label) check(label, true);
  return true;
}

console.log("\n[1] はじめる前の同意 → 依代 → 召喚 → チャット");
const tagId = `e2e-${Date.now()}`;
await page.goto(`${BASE}/t/${tagId}`, { waitUntil: "networkidle" });
const summonUrl = new URL(page.url());
check("タップで召喚ページに遷移する", summonUrl.pathname === "/summon", summonUrl.pathname);
await acceptGateIfShown("同意しないと先へ進めない画面が出る");
check("持ち主トークンがURLから消えている（localStorageへ退避済み）", summonUrl.searchParams.get("token") === null);

const cid = summonUrl.searchParams.get("cid");
check("cidが発行されている", Boolean(cid));
const storedToken = await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), cid);
check("持ち主トークンがこの端末に保存されている", Boolean(storedToken));

await page.goto(`${BASE}/chat?cid=${cid}`, { waitUntil: "networkidle" });
await acceptGateIfShown();
await page.waitForTimeout(700);

console.log("\n[2] スマホ幅でのレイアウト");
const layout = await page.evaluate(() => ({
  nameWidth: Math.round(document.querySelector(".nameCol").getBoundingClientRect().width),
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("キャラクター名の欄が潰れていない", layout.nameWidth > 100, `width=${layout.nameWidth}`);
check("横スクロールが発生していない", layout.overflowX === false);
await page.screenshot({ path: path.join(OUT_DIR, "chat.png") });

console.log("\n[3] PWA / OGP");
const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
check("manifestが配信される", manifest.name === "わけたま" && manifest.start_url === "/home");
check("Service Workerが配信される", (await fetch(`${BASE}/sw.js`)).ok);
const html = await (await fetch(`${BASE}/home`)).text();
// 検証したいのは「相対パスのままSNSに渡らないこと」。オリジンそのものは環境で変わる
// （wrangler devはwrangler.tomlのカスタムドメインをホスト名として使うため、ローカルでも
//   http://app.waketama.com/... になる）ので、絶対URLかどうかだけを見る。
const ogImage = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] || "";
check("og:imageが絶対URLになっている", /^https?:\/\/[^/]+\/icons\/ogp\.png$/.test(ogImage), ogImage);

console.log("\n[4] 分身の削除と、そのあとの導線");
await page.click("#toggleExport");
await page.waitForTimeout(200);
await page.click("#deleteBtn");
await page.waitForTimeout(1500);
check("削除後は分身一覧へ戻る", new URL(page.url()).pathname === "/home");
const after = await page.evaluate(
  (c) => ({
    list: JSON.parse(localStorage.getItem("sodatsukake_myCharacters") || "[]").length,
    token: localStorage.getItem(`sodatsukake_token_${c}`),
  }),
  cid
);
check("一覧から消えている", after.list === 0);
check("持ち主トークンも消えている", after.token === null);

await page.goto(`${BASE}/chat?cid=${cid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
const status = (await page.textContent("#status")) || "";
check("削除済みの分身を開いても行き止まりにならない", status.includes("見つかりませんでした"), status);
check("削除済みの分身には話しかけられない", await page.isDisabled("#input"));
await page.screenshot({ path: path.join(OUT_DIR, "chat-deleted.png") });

console.log("\n[5] 同じ依代の再利用（削除したあと）");
await page.goto(`${BASE}/t/${tagId}`, { waitUntil: "networkidle" });
await acceptGateIfShown();
const newCid = new URL(page.url()).searchParams.get("cid");
check("再タップで新しい分身が発行される", Boolean(newCid) && newCid !== cid);

console.log("\n[6] 自己診断とデバッグ用の版数");
const health = await (await fetch(`${BASE}/api/health`)).json();
check("D1のテーブルまで確認できている", health.checks?.d1?.ok === true, JSON.stringify(health.checks?.d1));
check("版数が返る", Boolean(health.version));

console.log("\n[7] その場限りの通話");
await page.goto(`${BASE}/call?cid=${newCid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("開始前に「保存されない」ことが明示されている", (await page.textContent("#privacyNote")).includes("保存されません"));

const callLayout = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("通話画面が横に溢れていない", callLayout.overflowX === false);

// 通話開始 → 1ターン送る（AIはローカルでも実際に呼ばれるため、応答有無ではなく画面の挙動を見る）
await page.click("#startBtn");
await page.waitForTimeout(400);
check("開始すると通話画面に切り替わる", await page.isHidden("#startOverlay"));
const openingLine = await page.textContent("#transcript");
check(
  "開始時に「記録されない・性格に影響しない」ことが会話欄にも出る",
  openingLine.includes("記録され") && openingLine.includes("性格"),
  openingLine.slice(0, 60)
);

await page.fill("#input", "テスト発話です");
await page.click("#sendBtn");
await page.waitForTimeout(1200);
const transcript = await page.textContent("#transcript");
check("送った言葉が画面に出る", transcript.includes("テスト発話です"));

// 通話を終えたら、画面にも履歴にも何も残っていないこと
await page.click("#hangupBtn");
await page.waitForTimeout(900);
check("通話を終えるとチャット画面へ戻る", new URL(page.url()).pathname === "/chat");
const leftovers = await page.evaluate(() => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  // 通話の内容がlocalStorageに保存されていないこと（キー名に call が現れないこと）
  return keys.filter((k) => k.toLowerCase().includes("call"));
});
check("通話の内容が端末に保存されていない", leftovers.length === 0, leftovers.join(","));

console.log("\n[8] 引き継ぎコード");
const issueRes = await fetch(`${BASE}/api/character/transfer/issue`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, token: await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), newCid) }),
});
const issued = await issueRes.json();
check("持ち主なら引き継ぎコードを発行できる", Boolean(issued.code), JSON.stringify(issued));

const claimRes = await fetch(`${BASE}/api/character/transfer/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: issued.code }),
});
const claimed = await claimRes.json();
check("コードで所有権を引き継げる", claimed.characterId === newCid && Boolean(claimed.ownerToken));

const reuse = await fetch(`${BASE}/api/character/transfer/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: issued.code }),
});
check("同じコードは二度使えない", reuse.status === 410);

console.log("\n[9] かざして話す");
// E2Eの実行環境にカメラは無い前提。カメラが取れなくても会話が成立することまで含めて確認する。
await page.goto(`${BASE}/talk?cid=${newCid}`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
check("開始前に「映像は送らない」ことが明示されている", (await page.textContent("#startOverlay")).includes("送信も保存もされません"));
check("分身の名前が読み込まれている", ((await page.textContent("#charName")) || "").length > 1);

await page.click("#startBtn");
await page.waitForTimeout(900);
check("開始するとカメラ画面に切り替わる", await page.isHidden("#startOverlay"));
check("出迎えの言葉が撮像画面の上に出る", ((await page.textContent("#bubbleText")) || "").length > 0);
check("カメラが無くても「これ見て」が無効化されるだけで会話は続く", await page.isDisabled("#lookBtn"));

const talkLayout = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("かざして話す画面が横に溢れていない", talkLayout.overflowX === false);

// 音声入力はE2Eでは使えないので、文字入力の逃げ道から1ターン送る
const beforeTalk = await (await fetch(`${BASE}/api/character?cid=${newCid}`)).json();
await page.click("#typeBtn");
await page.fill("#typeInput", "かざして話すのテストです");
await page.click("#typeSend");
await page.waitForTimeout(4000);
check("話しかけた言葉が画面に出る", ((await page.textContent("#heard")) || "").includes("かざして話す"));
const afterTalk = await (await fetch(`${BASE}/api/character?cid=${newCid}`)).json();
check(
  "かざして話すの会話は保存される（通話モードとは違い、育つ）",
  afterTalk.interactionCount > beforeTalk.interactionCount,
  `${beforeTalk.interactionCount} -> ${afterTalk.interactionCount}`
);
check("会話の中身は公開APIから読めない", !JSON.stringify(afterTalk).includes("かざして話すのテストです"));
check("分身ごとの声が返ってくる", typeof afterTalk.voice?.pitch === "number");
await page.screenshot({ path: path.join(OUT_DIR, "talk.png") });

console.log("\n[10] プライバシーポリシー");
const privacyHtml = await (await fetch(`${BASE}/privacy`)).text();
check("プライバシーポリシーが配信される", privacyHtml.includes("プライバシーポリシー"));
check("カメラ映像の扱いが書かれている", privacyHtml.includes("カメラ映像の扱い"));

console.log("\n[11] LP・管理画面");
const lpHtml = await (await fetch(`${BASE}/lp`)).text();
check("LPが配信される", lpHtml.includes("御霊"));
// LPは一般向けの入口。人格データの売買の話は表に出さない方針にしている
check("LPに人格データ販売の話が出ていない", !lpHtml.includes("販売") && !lpHtml.includes("マーケット"));

// 出品の機能は畳んだ。消したつもりで残っていないことを、ここで押さえる
check("マーケットのページは無くなっている", (await fetch(`${BASE}/market`)).status === 404);
check("出品のAPIも無くなっている", (await fetch(`${BASE}/api/market/listings`)).status === 404);

const adminRes = await fetch(`${BASE}/admin`);
// 合言葉(ADMIN_PASSCODE)を設定していない状態が既定。素通しになっていないこと
check("管理画面は合言葉なしでは開かない", adminRes.status === 404 || adminRes.status === 401, String(adminRes.status));
const adminApi = await fetch(`${BASE}/api/admin/overview`);
check("管理APIも閉じている", adminApi.status === 404 || adminApi.status === 401, String(adminApi.status));

console.log("\n[12] 同意と属性（既定はすべてオフ）");
// [8]の引き継ぎで持ち主トークンが差し替わっているため、端末に残っている古い値ではなく
// 引き継ぎで発行された新しいトークンを使う（古い方は、もう持ち主として通らない）
const profileToken = claimed.ownerToken || (await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), newCid));
// 復旧（[21]）で引き継ぎコードを使うと持ち主トークンが変わる。
// それ以降の節は、こちらの「いま有効なトークン」を使うこと。
let currentToken = profileToken;
const ownerView = await (await fetch(`${BASE}/api/profile?cid=${newCid}&token=${profileToken}`)).json();
// この分身は同意画面を通っているので terms だけが立っている。
// 任意の項目（属性・統計）は、こちらから何もしていない以上オフのままであること。
check(
  "はじめる前の同意だけが記録されていて、任意の項目はオフ",
  ownerView.consent === null ||
    (ownerView.consent.terms === true &&
      ownerView.consent.profile === false &&
      ownerView.consent.aggregate === false),
  JSON.stringify(ownerView.consent)
);

// 同意画面を通っていない分身は、本当に何も同意していない
{
  const fresh = await fetch(`${BASE}/t/consent-fresh-${Date.now()}`, { redirect: "manual" });
  const fl = new URL(fresh.headers.get("location"), BASE);
  const freshView = await (
    await fetch(`${BASE}/api/profile?cid=${fl.searchParams.get("cid")}&token=${fl.searchParams.get("token")}`)
  ).json();
  check("同意画面を通る前は、何にも同意していない", freshView.consent === null, JSON.stringify(freshView.consent));
}

const noAuth = await fetch(`${BASE}/api/profile?cid=${newCid}`);
check("持ち主トークンなしでは属性を読めない", noAuth.status === 403, String(noAuth.status));

const beforeConsent = await fetch(`${BASE}/api/profile`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, token: profileToken, answers: { ageBand: ["30代"] } }),
});
check("同意前は属性を保存できない", beforeConsent.status === 403, String(beforeConsent.status));

await fetch(`${BASE}/api/consent`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, token: profileToken, consent: { profile: true } }),
});
await fetch(`${BASE}/api/profile`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    characterId: newCid,
    token: profileToken,
    answers: { ageBand: ["30代"], realName: "山田太郎" },
  }),
});
const afterConsent = await (await fetch(`${BASE}/api/profile?cid=${newCid}&token=${profileToken}`)).text();
check("同意後は答えた属性が保存される", afterConsent.includes("30代"));
check("定義していない項目は捨てられる", !afterConsent.includes("山田太郎"));

const publicView = await (await fetch(`${BASE}/api/character?cid=${newCid}`)).text();
check("属性は公開APIから読めない", !publicView.includes("30代"));

console.log("\n[13] 人格カードの書き出し");
const cardRes = await fetch(`${BASE}/api/persona/card?cid=${newCid}&token=${profileToken}`);
const card = await cardRes.json();
check("人格カードが書き出せる", card.format === "waketama.persona-card", JSON.stringify(card).slice(0, 80));
check("そのまま使えるシステムプロンプトが入っている", (card.runtime?.systemPrompt || "").length > 100);
const modelfile = await (await fetch(`${BASE}/api/persona/card?cid=${newCid}&token=${profileToken}&format=modelfile`)).text();
check("Ollama Modelfile として書き出せる", modelfile.includes("FROM ") && modelfile.includes("SYSTEM "));
const cardNoAuth = await fetch(`${BASE}/api/persona/card?cid=${newCid}`);
check("人格カードは持ち主以外には渡さない", cardNoAuth.status === 403, String(cardNoAuth.status));

console.log("\n[14] 統計（k-匿名性）");
const insights = await (await fetch(`${BASE}/api/market/insights`)).json();
check("最小人数の下限が設定されている", insights.minCohortSize >= 10, String(insights.minCohortSize));
check("人数の少ないグループは出力されない", (insights.insights || []).every((i) => i.count >= insights.minCohortSize));

console.log("\n[15] 視線・スイッチ入力");
// このページは読み込み後も待ち受け続ける（スキャンのタイマー等）ため、networkidle は使わない
await page.goto(`${BASE}/eyes?cid=${newCid}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1200);
check("カメラが無くてもスイッチ操作で始められる", await page.isVisible("#startScan"));
await page.click("#startScan");
await page.waitForTimeout(400);
check("選択盤が8面ある", (await page.locator("#board .zone").count()) === 8);

// キーボードの1〜8でも同じ木をたどれること（スイッチ機器の多くはキー入力として届く）
await page.keyboard.press("1");   // あ・か行へ
await page.waitForTimeout(200);
await page.keyboard.press("1");   // 「あ」
await page.waitForTimeout(200);
await page.keyboard.press("2");   // さ・た行へ
await page.waitForTimeout(200);
await page.keyboard.press("1");   // 「さ」
await page.waitForTimeout(200);
const typed = (await page.textContent("#composer")) || "";
check("キー操作で文字が入る", typed.includes("あ") && typed.includes("さ"), typed);

const eyesLayout = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("視線入力の画面が横に溢れていない", eyesLayout.overflowX === false);
await page.screenshot({ path: path.join(OUT_DIR, "eyes.png") });

console.log("\n[16] プライバシーポリシーの更新");
const privacy2 = await (await fetch(`${BASE}/privacy`)).text();
check("3つの同意が説明されている", privacy2.includes("あなたが選ぶ3つの同意"));
check("統計に含まれないものが列挙されている", privacy2.includes("統計として提供されるもの"));
check("会話の中身が管理画面に出ないと書かれている", privacy2.includes("管理画面のどこにも表示されません"));

console.log("\n[17] 利用規約・LP・法人向けページ");
const termsHtml = await (await fetch(`${BASE}/terms`)).text();
check("利用規約が配信される", termsHtml.includes("利用規約"));
check("当方によるデータ利用が書かれている", termsHtml.includes("当方によるデータの利用"));
check("個人情報を預からないと明記されている", termsHtml.includes("個人情報をお預かりしません"));
check("運営がデータを使う範囲が明記されている", termsHtml.includes("当方が次の目的で利用することがあります"));
check("同意したうえで開始する形になっている", termsHtml.includes("同意いただいたうえで、サービスのご利用を開始"));
check("利用者どうしの売り買いは提供していないと書かれている", termsHtml.includes("マーケット」は提供していません"));

const lp2 = await (await fetch(`${BASE}/lp`)).text();
check("LPで分け御霊の由来を説明している", lp2.includes("分 け 御 霊") || lp2.includes("分け御霊"));
check("LPで話しかけ方が5通り紹介されている", lp2.includes("かざして話す") && lp2.includes("視線で話す") && lp2.includes("その場限りの通話"));
check("LPから法人ページへ行ける", lp2.includes('href="/biz"'));

const bizHtml = await (await fetch(`${BASE}/biz`)).text();
check("法人向けページが配信される", bizHtml.includes("小さなモデルに"));
check("SLM・エッジ向けの訴求が入っている", bizHtml.includes("フィジカルAI") && bizHtml.includes("メタバース"));
check("マスキング済みデータの説明が入っている", bizHtml.includes("マスキング済み"));
check("人格カードの書き出し形式が示されている", bizHtml.includes("modelfile"));
// 検査結果を訴求に使っている以上、数字と検査コードは必ずセットで出ていること
check("品質を測っていることが書かれている", bizHtml.includes("測っています"));
check("到達率の実測値が出ている", bizHtml.includes("到達率") && bizHtml.includes("100%"));
check("検査を再現できると書いてある", bizHtml.includes("persona:check"));
check("LLM無しで振る舞いが分かれる例が出ている", bizHtml.includes("policy[].code"));
check("確かめていないことも書いてある", bizHtml.includes("モデル次第です"));

await page.goto(`${BASE}/biz`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);
const bizLayout = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("法人向けページが横に溢れていない", bizLayout.overflowX === false);

// 問い合わせの経路。
// フォームの送信そのものは Formspree（外部）に投げる作りなので、ここでは押さない
// （外部への送信をE2Eで発生させない）。代わりに、
//   1) Formspreeへ送る口があること
//   2) 同じ内容の控えがこちらの管理画面にも残るように仕込まれていること
//   3) その受け皿（/api/contact）が生きていること
// の3点を確かめる。1つでも欠けると「問い合わせが届かない」に直結する。
check("問い合わせフォームがFormspreeへ送られる", bizHtml.includes("formspree.io/f/"));
check("控えがこちらにも残るよう仕込まれている", bizHtml.includes('sendBeacon("/api/contact"'));
check("LPの問い合わせフォームにも同じ仕込みがある", lp2.includes('sendBeacon("/api/contact"'));

const bizMail = `e2e-biz-${Date.now()}@example.com`;
const contactRes = await fetch(`${BASE}/api/contact`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "biz", company: "E2E株式会社", contact: bizMail, topic: "poc", message: "検証用の問い合わせです" }),
});
check("問い合わせが受け付けられる", contactRes.status === 200, String(contactRes.status));
const contactBad = await fetch(`${BASE}/api/contact`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ contact: "not-an-email" }),
});
check("宛先にならない入力は弾かれる", contactBad.status === 400, String(contactBad.status));
await page.screenshot({ path: path.join(OUT_DIR, "biz.png") });

const contactsClosed = await fetch(`${BASE}/api/admin/contacts`);
check("届いた問い合わせは管理画面の中にしか無い", contactsClosed.status === 404 || contactsClosed.status === 401);

console.log("\n[18] 覚え書きの書き直し");
const notesRes = await fetch(`${BASE}/api/notes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, token: profileToken, notes: "妹がいる" }),
});
const notesData = await notesRes.json();
check("本人が覚え書きを直せる", notesData.notes === "・妹がいる", JSON.stringify(notesData));
const notesNoAuth = await fetch(`${BASE}/api/notes`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, notes: "勝手に書き換える" }),
});
check("持ち主以外は覚え書きを書き換えられない", notesNoAuth.status === 403, String(notesNoAuth.status));

console.log("\n[19] 復旧の窓口");
const recoverHtml = await (await fetch(`${BASE}/recover`)).text();
check("復旧の窓口が配信される", recoverHtml.includes("分身を取り戻す"));
check("データが消えていないことを先に伝えている", recoverHtml.includes("消えていません"));
check("引き継ぎコードを先に案内している", recoverHtml.includes("引き継ぎコードをお持ちなら"));

await page.goto(`${BASE}/recover`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
const recoverMail = `e2e-recover-${Date.now()}@example.com`;
await page.fill("#tagId", "e2e-tag-unknown");
await page.fill("#charName", "テストこ");
await page.fill("#contact", recoverMail);
await page.fill("#detail", "機種変更で引き継ぎを忘れました");
await page.click("#submitBtn");
await page.waitForTimeout(1200);
check("復旧の依頼が受け付けられる", ((await page.textContent("#status")) || "").includes("受け付けました"));

// 所有権を移せる操作なので、管理画面の外からは触れないこと
const lookupClosed = await fetch(`${BASE}/api/admin/recovery/lookup?q=${newCid}`);
check("復旧の検索は管理画面の中にしかない", lookupClosed.status === 404 || lookupClosed.status === 401);
const issueClosed = await fetch(`${BASE}/api/admin/recovery/issue`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ characterId: newCid, reason: "勝手に発行" }),
});
check("復旧コードの発行も管理画面の中にしかない", issueClosed.status === 404 || issueClosed.status === 401);

console.log("\n[20] 記述の正確さ");
const privacy3 = await (await fetch(`${BASE}/privacy`)).text();
check("復旧について書かれている", privacy3.includes("復旧"));
// 「絶対に見られない」と書くのは事実に反する。管理画面に出さないこととは分けて書く
check("運営が技術的にアクセスできることを認めている", privacy3.includes("技術的にはアクセスできる状態"));
check("それでも復旧に会話を読む必要が無いと説明している", privacy3.includes("会話を読む必要はありません"));

const terms2 = await (await fetch(`${BASE}/terms`)).text();
check("規約でも復旧に応じると書いている", terms2.includes("分身の復旧について"));
check("規約から「復旧できません」が消えている", !terms2.includes("復旧のご要望にはお応えできません"));

const health2 = await (await fetch(`${BASE}/api/health`)).json();
check("管理画面が有効かどうかが分かる", typeof health2.admin === "string", String(health2.admin));

// 管理画面と復旧は「合言葉を設定したときだけ」動く経路なので、既定のE2Eでは入口が閉じていることまでしか見ていない。
// 中の動作まで確かめたいときは、.dev.vars に ADMIN_PASSCODE を書いたうえで
//   E2E_ADMIN_PASSCODE=<同じ値> npm run test:e2e
// を実行する。所有権を移す操作を含むので、通しで動くことを一度は確認しておきたい。
const adminPass = process.env.E2E_ADMIN_PASSCODE;
if (adminPass) {
  console.log("\n[21] 管理画面の中身（合言葉あり）");

  const gate = await fetch(`${BASE}/admin?key=${encodeURIComponent(adminPass)}`, { redirect: "manual" });
  check("合言葉で管理画面に入れる", gate.status === 302, String(gate.status));
  const setCookie = gate.headers.get("set-cookie") || "";
  check("合言葉はCookieへ移されURLから消える", setCookie.includes("waketama_admin") && setCookie.includes("HttpOnly"));
  const cookie = setCookie.split(";")[0];

  const overview = await (await fetch(`${BASE}/api/admin/overview`, { headers: { cookie } })).json();
  check("概況が取得できる", typeof overview.totals?.characters === "number", JSON.stringify(overview).slice(0, 80));

  const lookup = await (await fetch(`${BASE}/api/admin/recovery/lookup?q=${newCid}`, { headers: { cookie } })).json();
  check("本人確認用の情報が引ける", Boolean(lookup.verification?.name), JSON.stringify(lookup).slice(0, 80));
  // 復旧に会話は要らない。管理画面から中身が読めてしまわないこと
  const lookupText = JSON.stringify(lookup);
  check("会話の中身は返らない", !lookupText.includes("かざして話すのテストです") && !lookupText.includes("妹がいる"));

  const noReason = await fetch(`${BASE}/api/admin/recovery/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ characterId: newCid }),
  });
  check("理由なしではコードを発行できない", noReason.status === 400, String(noReason.status));

  const issuedRecovery = await (await fetch(`${BASE}/api/admin/recovery/issue`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ characterId: newCid, reason: "名前と育て始めた時期が一致" }),
  })).json();
  check("運営が引き継ぎコードを発行できる", Boolean(issuedRecovery.code), JSON.stringify(issuedRecovery));

  const recovered = await (await fetch(`${BASE}/api/character/transfer/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: issuedRecovery.code }),
  })).json();
  check("そのコードで所有権が戻る", recovered.characterId === newCid && Boolean(recovered.ownerToken));
  currentToken = recovered.ownerToken;

  // 戻った所有権で、会話の履歴を含めた自分のデータが読めること（＝復旧が成立している）
  const restored = await (await fetch(
    `${BASE}/api/profile?cid=${newCid}&token=${encodeURIComponent(recovered.ownerToken)}`
  )).json();
  check("復旧後は本人が覚え書きを読める", typeof restored.notes === "string", JSON.stringify(restored).slice(0, 80));
  const card = await (await fetch(
    `${BASE}/api/persona/card?cid=${newCid}&token=${encodeURIComponent(recovered.ownerToken)}`
  )).json();
  check("会話の履歴も戻っている", (card.examples || []).length > 0 || (card.memories || []).length >= 0);
}

console.log("\n[22] 迷子の受け皿と、検索エンジン向けの案内");
// アセット層の not_found_handling を有効にすると、無いパスがWorkerまで届かず
// /api/* が丸ごと死ぬ。この2つは必ず一緒に確認する（片方だけ見ると気づけない）。
const missingRes = await fetch(`${BASE}/no-such-page-${Date.now()}`);
check("存在しないパスは404になる", missingRes.status === 404, String(missingRes.status));
check("404には行き先の案内がある", (await missingRes.text()).includes("分身の一覧をひらく"));
const healthAlive = await fetch(`${BASE}/api/health`);
check("APIが巻き添えになっていない", (healthAlive.headers.get("content-type") || "").includes("json"));

const robotsRes = await fetch(`${BASE}/robots.txt`);
const robotsTxt = await robotsRes.text();
check("robots.txtが配信される", robotsRes.status === 200);
check("管理画面はクロール対象外", robotsTxt.includes("Disallow: /admin"));
const sitemapRes = await fetch(`${BASE}/sitemap.xml`);
check("sitemap.xmlが配信される", sitemapRes.status === 200);
check("個人のページはsitemapに載せない", !(await sitemapRes.text()).includes("/home"));

const swBody = await (await fetch(`${BASE}/sw.js`)).text();
check("Service Workerが通常どおり配信される", swBody.includes("isCacheableAsset"));

const canonicalHtml = await (await fetch(`${BASE}/lp`)).text();
check("canonicalリンクが入っている", /<link rel="canonical" href="https?:\/\/[^"]+\/lp">/.test(canonicalHtml));

const lpHeaders = await fetch(`${BASE}/lp`);
check("埋め込み防止のヘッダが付いている", lpHeaders.headers.get("x-frame-options") === "DENY");
check("カメラ・マイクは自分のページにだけ許可されている",
  (lpHeaders.headers.get("permissions-policy") || "").includes("camera=(self)"));

console.log("\n[23] パルスサーベイ（1問ずつ聞く）");
{
  // ここは専用の分身を1体作ってから確かめる。
  // 他の節で使い回すと、同意済み・所有権が移ったあと、といった状態が混ざり、
  // 「同意前は聞かない」のような肝心の確認ができなくなる。
  await page.goto(`${BASE}/t/survey-${Date.now()}`, { waitUntil: "networkidle" });
  await acceptGateIfShown();
  const sCid = new URL(page.url()).searchParams.get("cid");
  const sToken = await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), sCid);
  const q = (t) => `cid=${encodeURIComponent(sCid)}&token=${encodeURIComponent(t)}`;

  const before = await (await fetch(`${BASE}/api/survey/next?${q(sToken)}`)).json();
  check("同意前は設問を出さない", before.needsConsent === true && before.item === null, JSON.stringify(before).slice(0, 90));
  check("同意の文面が一緒に返る", typeof before.consentText === "string" && before.consentText.length > 10);

  const saveWithoutConsent = await fetch(`${BASE}/api/survey/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: sCid, token: sToken, id: "ageBand", values: ["30代"] }),
  });
  check("同意していない相手の回答は保存しない", saveWithoutConsent.status === 403, String(saveWithoutConsent.status));

  await fetch(`${BASE}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: sCid, token: sToken, consent: { profile: true } }),
  });

  const first = await (await fetch(`${BASE}/api/survey/next?${q(sToken)}`)).json();
  check("同意すると1問返る", Boolean(first.item), JSON.stringify(first.item));
  check("なぜ聞くのかが一緒に返る", Boolean(first.item && first.item.why));
  check("厚みが一緒に返る", typeof first.depth?.score === "number");

  const answered = await fetch(`${BASE}/api/survey/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: sCid, token: sToken, id: first.item.id, values: [first.item.options[0]] }),
  });
  check("答えを保存できる", answered.status === 200, String(answered.status));

  const second = await (await fetch(`${BASE}/api/survey/next?${q(sToken)}`)).json();
  check("同じ設問を二度出さない", second.item && second.item.id !== first.item.id, String(second.item?.id));
  check("厚みが増えている", second.depth.score >= first.depth.score, `${first.depth.score} → ${second.depth.score}`);

  // 価値観の申告が、AI推定と同じ軸に載ること
  const valueAnswer = await fetch(`${BASE}/api/survey/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: sCid, token: sToken, id: "psy_stimulation", values: ["絶対はじめての店"] }),
  });
  check("価値観の設問に答えられる", valueAnswer.status === 200, String(valueAnswer.status));
  const view = await (await fetch(`${BASE}/api/profile?${q(sToken)}`)).json();
  check("申告した価値観が人物像に反映される", (view.psychographics?.values?.stimulation ?? 0) > 70, String(view.psychographics?.values?.stimulation));
  check("申告値が別枠でも保持される", view.psychographics?.selfReported?.stimulation === 92);

  const stranger = await fetch(`${BASE}/api/survey/next?cid=${sCid}&token=wrong`);
  check("持ち主以外には設問も進み具合も見せない", stranger.status === 403, String(stranger.status));

  // 属性ページに、厚みと1問ずつの欄が出ていること
  await page.goto(`${BASE}/profile?cid=${sCid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const profileHtml = await page.content();
  check("属性ページに厚みが出ている", profileHtml.includes("この分身の厚み"));
  check("属性ページに1問ずつの欄がある", profileHtml.includes("ひとつずつ答える"));
  const pulseVisible = await page.evaluate(() => {
    const card = document.querySelector(".wtPulse");
    return Boolean(card && !card.hidden);
  });
  check("設問カードが実際に表示される", pulseVisible === true);
  const profileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  check("属性ページが横に溢れていない", profileOverflow === false);
  await page.screenshot({ path: path.join(OUT_DIR, "profile-survey.png") });
}

console.log("\n[24] ロゴと行き止まり");
for (const [pathname, label] of [["/lp", "LP"], ["/home", "分身の一覧"], ["/add", "分身を増やす"]]) {
  const html = await (await fetch(`${BASE}${pathname}`)).text();
  // 勾玉ロゴは同じ座標をHTMLに直接埋め込んである（public/icons/mark.svg と同じ形）
  check(`${label}に勾玉のロゴが入っている`, html.includes("M59.7 13.8 C61.1"));
}
check("ロゴのSVGが単体でも配信される", (await fetch(`${BASE}/icons/mark.svg`)).ok);

for (const [pathname, label] of [["/summon", "召喚"], ["/add", "分身を増やす"], ["/recover", "復旧"]]) {
  await page.goto(`${BASE}${pathname}?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  const hasExit = await page.evaluate(() => {
    const links = [...document.querySelectorAll("a,button")];
    return links.some((el) => /もどる|戻る|一覧/.test(el.textContent || ""));
  });
  check(`${label}に行き止まりの出口がある`, hasExit === true);
}

console.log("\n[25] 人格カードが載せ先で動く形になっているか");
{
  // 詳しい検査は tools/persona-runtime-check.mjs（対照になる2体で測る）。
  // ここでは「実際に育てた分身から書き出したカード」が、最低限の形を満たすかだけ見る。
  // 価値観を1問答えておく（答えていない分身は、価値観が全部50なので方針が出ない＝正しい挙動）
  await fetch(`${BASE}/api/survey/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: newCid, token: currentToken, id: "psy_stimulation", values: ["絶対はじめての店"] }),
  });

  const card = await (await fetch(
    `${BASE}/api/persona/card?cid=${newCid}&token=${encodeURIComponent(currentToken)}&format=json`
  )).json();

  check("身体の動きのパラメータが入っている", typeof card.runtime?.avatar?.motion?.energy === "number");
  check("対人距離が入っている", typeof card.runtime?.avatar?.proxemics?.comfortableDistanceM === "number");
  check("機械が分岐できる識別子が付いている",
    (card.runtime?.avatar?.policy || []).every((p) => /^[a-z_]+$/.test(p.code)));
  check("本人が申告した価値観と、推定を区別している", typeof card.owner?.declaredValues === "object");

  const prompt = card.runtime?.systemPrompt || "";
  // 属性に同意して答えている分身なので、プロンプトに人物像が載っていること
  check("属性がプロンプトに載っている", prompt.includes("相手（この分身を育てた人）について"), prompt.slice(0, 60));
  check("価値観が行動の指示として載っている", prompt.includes("大事にしていること"));
  check("年収はプロンプトに載らない", !/年収|万円/.test(prompt));
  check("AI失敗時の定型文が応答例に混ざっていない",
    (card.examples || []).every((e) => !e.assistant.includes("うまく考えがまとまらない")));
}

console.log("\n[26] 依代（NFCタグ・QR）と、分身の増やし方");
{
  // 集める体験の土台は「1つの依代から1体だけ」「入口が違っても同じ扱い」の2つ。
  // どちらもコードを分けた瞬間に静かに壊れる類なので、実物の経路で確かめる。
  const code = `e2e-yori-${Date.now()}`;
  const first = await fetch(`${BASE}/t/${code}`, { redirect: "manual" });
  const firstLoc = new URL(first.headers.get("location"), BASE);
  const born = firstLoc.searchParams.get("cid");
  check("依代をかざすと分身が生まれる", Boolean(born) && firstLoc.searchParams.get("first") === "1");
  check("持ち主の印は誕生の瞬間だけURLに乗る", Boolean(firstLoc.searchParams.get("token")));

  const second = await fetch(`${BASE}/t/${code}`, { redirect: "manual" });
  const secondLoc = new URL(second.headers.get("location"), BASE);
  check("同じ依代からは2体目が生まれない", secondLoc.searchParams.get("cid") === born);
  check("2回目には持ち主の印が乗らない", secondLoc.searchParams.get("token") === null);

  const viaQr = await fetch(`${BASE}/q/${code}`, { redirect: "manual" });
  check("QRとして読んでも同じ子に着く",
    new URL(viaQr.headers.get("location"), BASE).searchParams.get("cid") === born);

  // 依代を持っていない人の入口。
  // **3番は既定で閉じている**ので、依代を1枚かざした状態にしてから見る
  // （閉じているほうの見え方は [34] で確かめている）。
  await page.goto(`${BASE}/t/${code}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.goto(`${BASE}/add`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  check("分身の増やし方のページが開く", (await page.title()).includes("分身を増やす"));
  const addText = await page.textContent("main");
  check("NFCという言い方が画面に出ていない", !addText.includes("NFC"), addText.slice(0, 80));
  check("依代という言い方に揃っている", addText.includes("依代"));
  await page.click("#createBtn");
  await page.waitForURL(/\/summon\?cid=/, { timeout: 15000 });
  check("依代を持つ人は、端末だけでも増やせる", page.url().includes("/summon?cid="));
  await page.screenshot({ path: path.join(OUT_DIR, "add-direct.png") });

  // 一覧に「増やす」入口があること（無いと、2体目が作れることに気づけない）
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  const homeText = await page.textContent("body");
  check("一覧からも増やせる", homeText.includes("分身を増やす"));
  check("一覧にNFCという言い方が残っていない", !homeText.includes("NFC"), homeText.slice(0, 80));
}

console.log("\n[27] 覚え書きの土台と、前回までの会話");
{
  // 「だいぶ会話しても覚え書きが空っぽ」への対処。
  // 本人が先に書ける場所があり、それが会話にも届くこと。
  // 引き継ぎコードを使った時点で持ち主の印が入れ替わっているので、
  // この端末の記録も最新のものに揃えてから開く（実機では引き継ぎ画面が同じことをしている）。
  await page.evaluate(([c, t]) => localStorage.setItem(`sodatsukake_token_${c}`, t), [newCid, currentToken]);
  await page.goto(`${BASE}/profile?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  const profileText = await page.textContent("main");
  check("土台を自分で書く欄がある", profileText.includes("あなたが書く土台"), profileText.slice(0, 80));
  check("会話から覚えた分と分かれている", profileText.includes("会話から覚えたこと"));

  // このページは読み込み後にサーベイと厚みを描き直すので、実クリックだと要素が入れ替わる瞬間に当たる。
  // 押したいのはハンドラなので、要素の安定待ちに引っかからない形で直接呼ぶ。
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.getElementById("editSeedBtn").click());
  await page.evaluate(() => document.getElementById("templateSeedBtn").click());
  const template = await page.inputValue("#notesSeedEdit");
  check("書くことに詰まらないようひな形が出る", template.includes("・呼ばれたい名前は"));
  await page.fill("#notesSeedEdit", "柴犬のコタロウを飼っている\n夜勤で働いている");
  await page.evaluate(() => document.getElementById("saveSeedBtn").click());
  await page.waitForTimeout(1200);
  const seedShown = await page.textContent("#notesSeed");
  check("土台が保存されて表示される", seedShown.includes("柴犬のコタロウ"), seedShown.slice(0, 60));
  await page.screenshot({ path: path.join(OUT_DIR, "profile-seed.png") });

  // 土台は、分身が会話で使う「覚えていること」に混ぜて渡される
  const card = await (await fetch(
    `${BASE}/api/persona/card?cid=${newCid}&token=${encodeURIComponent(currentToken)}&format=json`
  )).json();
  check("土台が分身の覚えていることに入る",
    (card.notes || []).some((n) => n.includes("柴犬のコタロウ")), JSON.stringify(card.notes || []).slice(0, 80));

  // 前回までの会話が画面に戻ること
  await page.goto(`${BASE}/chat?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  await acceptGateIfShown();
  await page.waitForTimeout(1500);
  const chatText = await page.textContent("#log");
  check("前に話した内容が残っている", chatText.length > 0 && chatText.includes("ここまでが前回まで"), chatText.slice(0, 80));
  check("育ちの進み具合が出ている", Boolean(await page.$("#growthBar")));
  await page.screenshot({ path: path.join(OUT_DIR, "chat-history.png") });
}

console.log("\n[28] 紹介動画・声・かざして話す");
{
  // 紹介動画。LPに置いた以上、実際に配信されていないと意味が無い
  const lp3 = await (await fetch(`${BASE}/lp`)).text();
  check("LPに紹介動画が置かれている", lp3.includes('src="/media/intro.mp4"'));
  check("動画は勝手に落とさない（preload=none）", lp3.includes('preload="none"'));
  const video = await fetch(`${BASE}/media/intro.mp4`);
  check("動画が実際に配信される", video.ok, String(video.status));
  check("動画のcontent-typeが正しい", (video.headers.get("content-type") || "").includes("video/mp4"),
    video.headers.get("content-type") || "");

  // 声。種族・色ごとに変わっていること（同じ声で全員喋る状態に戻っていないか）
  const voices = new Set();
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE}/t/voice-${Date.now()}-${i}`, { redirect: "manual" });
    const vcid = new URL(res.headers.get("location"), BASE).searchParams.get("cid");
    const st = await (await fetch(`${BASE}/api/character?cid=${vcid}`)).json();
    check(`声のパラメータが返る(${i})`, typeof st.voice?.pitch === "number" && typeof st.voice?.label === "string");
    voices.add(`${st.voice.pitch}/${st.voice.rate}`);
  }
  // 6体すべて同じなら、種族・色が効いていない
  check("分身ごとに声が違う", voices.size > 1, `${voices.size}種類`);

  // 「これ見て」。押した時点で送る作りになっていること（予約ボタンに戻っていないか）
  await page.goto(`${BASE}/talk?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  const talkText = await page.textContent("body");
  check("押した瞬間に見せる、と書かれている", talkText.includes("押した瞬間"), talkText.slice(0, 60));
  // カメラが無い環境で押しても、黙って何もしないのではなく理由を出す
  await page.evaluate(() => document.getElementById("lookBtn").click());
  await page.waitForTimeout(500);
  const lookStatus = (await page.textContent("#status")) || "";
  check("カメラが無いときは理由を出す", lookStatus.length > 0, lookStatus);

  // 会話画面で、キャラクターが消えないこと
  await page.goto(`${BASE}/chat?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  await acceptGateIfShown();
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById("modelToggle").click());
  await page.waitForTimeout(500);
  const stageH = await page.evaluate(() => document.getElementById("modelStage").getBoundingClientRect().height);
  check("たたんでもキャラクターは消えない", stageH > 40, `${Math.round(stageH)}px`);
}

console.log("\n[29] 成長グラフと、実画面の写真");
{
  // **読み込んだ直後にグラフが描けていること。**
  // 以前は hidden のまま描いていたので、親の幅が0になり「空のグラフ」が出ていた。
  // 画面を回すと直るので、人が見ても気づきにくい。ここで毎回押さえる。
  await page.goto(`${BASE}/history?cid=${newCid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  const chart = await page.evaluate(() => {
    const el = document.getElementById("chart");
    if (!el || el.offsetParent === null) return { drawn: false, why: "グラフが出ていない" };
    const ctx = el.getContext("2d");
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0) painted++;
    return { drawn: painted > 500, painted, w: el.width };
  });
  // 記録が1回ぶんしか無い分身ではグラフを出さない（線が引けず白紙に見えるため）
  const fallbackShown = await page.evaluate(() => {
    const el = document.getElementById("chartFallback");
    return !!el && !el.hidden;
  });
  check("成長グラフが読み込み直後に描けている", chart.drawn === true || fallbackShown === true,
    JSON.stringify(chart));

  // LPと法人ページに載せた実画面の写真が、実際に配信されていること
  for (const name of ["home", "chat", "history", "profile"]) {
    const res = await fetch(`${BASE}/media/shots/${name}.webp`);
    check(`実画面の写真が配信される(${name})`, res.ok && (res.headers.get("content-type") || "").includes("image"),
      `${res.status} ${res.headers.get("content-type")}`);
  }
  const lp4 = await (await fetch(`${BASE}/lp`)).text();
  check("LPに実画面の写真が載っている", lp4.includes("/media/shots/chat.webp"));
  check("LPが「つながっていなくても動く」と書いている", lp4.includes("電波が届かない場所でも"));

  const biz2 = await (await fetch(`${BASE}/biz`)).text();
  check("法人ページにエッジ向けの節がある", biz2.includes('id="edge"'));
  check("法人ページが機種ごとの線引きを出している",
    biz2.includes("ESP32 (WROOM-32)") && biz2.includes("Raspberry Pi Pico 2 W"));
  check("法人ページが実際の書き出しを載せている", biz2.includes("persona.min.json"));
  check("法人ページも同じ勾玉のロゴを使っている", biz2.includes("M59.7 13.8 C61.1"));
  // 数字は測り直すと動く。断定して載せていないか
  check("実測値がぶれることを断ってある", biz2.includes("実行のたびに数ポイント動きます"));
}

console.log("\n[30] キーホルダーの販売案内");
{
  const lp5 = await (await fetch(`${BASE}/lp`)).text();
  check("値段が出ている", lp5.includes("5,500") && lp5.includes("税込・送料別"));
  // 価格は2箇所（商品セクションとFAQ）に出る。片方だけ直して食い違うのが一番まずい
  check("FAQの値段と食い違っていない", (lp5.match(/5,500/g) || []).length >= 2);
  check("このページで決済しないと明記してある", lp5.includes("このページでの決済は行っていません"));

  // 商品写真。差し替えるのは中身だけで、パスは変わらない前提にしてある
  const photo = await fetch(`${BASE}/media/keyholder.jpg`);
  check("商品写真が配信される", photo.ok && (photo.headers.get("content-type") || "").includes("image"),
    `${photo.status} ${photo.headers.get("content-type")}`);

  // 「購入する」を押したら、問い合わせフォームへ行って用件が入っていること
  await page.goto(`${BASE}/lp`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.click("[data-buy]");
  await page.waitForTimeout(1200);
  const filled = await page.inputValue("#contact #message");
  check("購入ボタンから用件が先に入る", filled.includes("キーホルダー"), filled.slice(0, 40));
  const atForm = await page.evaluate(() => {
    const r = document.querySelector("#contact").getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  });
  check("問い合わせフォームまで移動する", atForm === true);

  // 書きかけを消さないこと（ここを壊すと、書いた文章が消える）
  await page.goto(`${BASE}/lp`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  await page.fill("#contact #message", "先に書いていた文章");
  await page.click("[data-buy]");
  await page.waitForTimeout(900);
  check("書きかけは上書きしない", (await page.inputValue("#contact #message")) === "先に書いていた文章");
}

console.log("\n[31] ホーム画面への追加と、規約の穴");
{
  // 案内の実装は1箇所（/install-hint.js）。2箇所に書くと文言も条件も食い違う
  const hint = await fetch(`${BASE}/install-hint.js`);
  check("追加の案内スクリプトが配信される", hint.ok, String(hint.status));
  const hintSrc = await hint.text();
  check("iOSの手順が書いてある", hintSrc.includes("ホーム画面に追加") && hintSrc.includes("共有"));
  check("入れられない端末には出さない", hintSrc.includes("beforeinstallprompt") && hintSrc.includes("isIosSafari"));

  for (const [pathname, label] of [["/home", "分身の一覧"], ["/chat", "会話画面"]]) {
    const html = await (await fetch(`${BASE}${pathname}`)).text();
    check(`${label}が同じ案内を読み込んでいる`, html.includes("/install-hint.js"));
    check(`${label}に差し込み先がある`, html.includes('id="installSlot"'));
  }

  // 規約とポリシー。売り物ができた以上、書いていないと困ることが増えた
  const terms = await (await fetch(`${BASE}/terms`)).text();
  check("規約が音声とカメラの扱いに触れている", terms.includes("音声とカメラを使う機能について"));
  check("規約が他人を無断で撮らないよう求めている", terms.includes("他人の声を録って"));
  check("規約に依代の値段が書いてある", terms.includes("5,500円"));
  check("規約がこのサービス上で決済しないと書いている", terms.includes("本サービス上での決済は行っていません"));

  const privacy = await (await fetch(`${BASE}/privacy`)).text();
  check("ポリシーが音声の扱いに触れている", privacy.includes("音声の扱い"));
  check("ポリシーが発送時の氏名・住所について書いている", privacy.includes("お送りするときにいただく情報"));
  check("カード番号を預からないと書いてある", privacy.includes("クレジットカード番号を当方がお預かりすることはありません"));

  // 空欄が残っているあいだは「下書きです」を消さないこと（食い違うと事故になる）
  for (const [html, label] of [[terms, "規約"], [privacy, "ポリシー"]]) {
    const blanks = (html.match(/［[^］]*］/g) || []).length;
    const draft = html.includes("この文書は下書きです");
    check(`${label}の空欄と但し書きが食い違っていない`, blanks > 0 ? draft : !draft, `空欄${blanks}件`);
  }
}

console.log("\n[32] 依代を何個でも持てること、書き込むURLの案内、集めた姿");
{
  // 依代が2つあれば2体。端末あたりの上限は無い
  const a = `e2e-multi-a-${Date.now()}`;
  const b = `e2e-multi-b-${Date.now()}`;
  const cidOf = async (p) => {
    const res = await fetch(`${BASE}${p}`, { redirect: "manual" });
    return new URL(res.headers.get("location"), BASE).searchParams.get("cid");
  };
  const cidA = await cidOf(`/t/${a}`);
  const cidB = await cidOf(`/q/${b}`);
  check("依代が2つなら分身も2体になる", !!cidA && !!cidB && cidA !== cidB);
  check("2体ともちゃんと生きている",
    (await fetch(`${BASE}/api/character?cid=${cidA}`)).ok && (await fetch(`${BASE}/api/character?cid=${cidB}`)).ok);

  // 同じ依代を2回読んでも増えない（「1つにつき1体」）
  check("同じ依代を読み直しても増えない", (await cidOf(`/t/${a}`)) === cidA);

  // 一覧に2体並び、図鑑が出ること
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([x, y]) =>
      localStorage.setItem(
        "sodatsukake_myCharacters",
        JSON.stringify([
          { cid: x, name: "いちばん", species: "punikoro", color: "coral", lastVisit: Date.now() },
          { cid: y, name: "にばんめ", species: "kiratsubu", color: "sun", lastVisit: Date.now() },
        ])
      ),
    [cidA, cidB]
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  // 「分身を増やす」のタイルも .entry なので、そちらは数えない
  check("一覧に2体とも並ぶ", (await page.locator("#grid .entry:not(.addEntry)").count()) === 2);
  const dex = await page.evaluate(() => {
    const card = document.getElementById("dexCard");
    // 一覧は開いたときにサーバーの姿で上書きされる。**2体が同じ姿を引くこともある**
    // （30通りなので3%ほど）。数え方を固定値で書くと、たまに落ちるテストになる。
    let list = [];
    try { list = JSON.parse(localStorage.getItem("sodatsukake_myCharacters") || "[]"); } catch (e) { /* noop */ }
    const distinct = new Set(list.filter((c) => c.species && c.color).map((c) => `${c.species}_${c.color}`));
    return {
      shown: card && !card.hidden,
      count: (document.getElementById("dexCount") || {}).textContent || "",
      owned: document.querySelectorAll("#dexGrid .dexCell:not(.unseen)").length,
      cells: document.querySelectorAll("#dexGrid .dexCell").length,
      distinct: distinct.size,
    };
  });
  check("集めた姿の図鑑が出る", dex.shown === true && dex.cells === 30, JSON.stringify(dex));
  check("持っている姿だけが開いている",
    dex.distinct > 0 && dex.owned === dex.distinct && dex.count.includes(`${dex.distinct} / 30`),
    JSON.stringify(dex));

  // 1体も居ない端末では図鑑を出さない（集める前に空の棚を見せない）
  await page.evaluate(() => localStorage.removeItem("sodatsukake_myCharacters"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  check("1体も居なければ図鑑は出さない",
    (await page.evaluate(() => document.getElementById("dexCard").hidden)) === true);

  // 管理画面。タグに書き込むURLで迷わせない（合言葉が渡されているときだけ）
  if (adminPass) {
    const gate = await fetch(`${BASE}/admin?key=${encodeURIComponent(adminPass)}`, { redirect: "manual" });
    const cookie = (gate.headers.get("set-cookie") || "").split(";")[0];
    const admin = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    check("書き込むURLの案内がある", admin.includes("タグに書き込むURL"));
    check("/home を書き込むなと書いてある", admin.includes("をタグに書き込まないでください"));
    check("依代を使わない入口も案内している", admin.includes("<code>/add</code>"));
    check("限定の姿を設定できる", admin.includes("ここでしか出ない姿にする"));
    check("限定でも個体は選べないと明記", admin.includes("どの子が出るかは指定できません"));
    check("共通URLで発注できると書いてある", admin.includes("全部に同じものを書き込んで構いません"));
    check("UIDミラーの設定漏れに注意させている", admin.includes("必ず2枚かざして"));
  }
}

console.log("\n[33] 全タグ共通のURL（UIDミラー）");
{
  const cidOf = async (p) => {
    const res = await fetch(`${BASE}${p}`, { redirect: "manual" });
    const loc = res.headers.get("location") || "";
    return new URL(loc, BASE);
  };
  const uid = (n) => "04" + `${Date.now()}${n}`.slice(-12).replace(/[^0-9a-f]/g, "a").padEnd(12, "b");

  // 同じ内容を書き込んだタグでも、チップがUIDを差し替えるので別々の子になる
  const a = uid(1);
  const b = uid(2);
  const first = (await cidOf(`/t?u=${a}`)).searchParams.get("cid");
  const again = (await cidOf(`/t?u=${a}`)).searchParams.get("cid");
  const other = (await cidOf(`/t?u=${b}`)).searchParams.get("cid");
  check("UIDが違えば別の子になる", !!first && !!other && first !== other);
  check("同じUIDを読み直せば同じ子に戻る", again === first);

  // カウンタミラーが一緒でも、読むたびに別の子にならない
  const withCounter = (await cidOf(`/t?u=${a}x0004c2`)).searchParams.get("cid");
  check("カウンタが付いても同じ子のまま", withCounter === first);

  // **設定漏れのタグ**。全員が同じ分身を共有する事故を起こさない
  const filler1 = await cidOf("/t?u=00000000000000");
  check("埋め草のUIDは受け皿へ送る", filler1.pathname === "/summon" && filler1.searchParams.get("claim") === "tag");
  check("埋め草から分身を結び付けない", !filler1.searchParams.get("cid"));

  // 受け皿の画面。かざした人の前で行き止まりにしない
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("sodatsukake_tagClaim"));
  await page.goto(`${BASE}/summon?claim=tag`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const claimed = await page.evaluate(() => {
    let v = "";
    try { v = localStorage.getItem("sodatsukake_tagClaim") || ""; } catch (e) { /* noop */ }
    return { stored: v, url: location.href };
  });
  check("受け皿で1体つくられる", claimed.stored.length > 0, JSON.stringify(claimed));
  check("そのまま誕生の画面へ進む", claimed.url.includes("cid="), claimed.url.slice(-60));
  check("受け皿でJavaScriptエラーを出さない", errors.length === 0, errors.join(" / "));

  // 2回目は同じ子に戻る（かざすたびに増えない）
  await page.goto(`${BASE}/summon?claim=tag`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check("2回目は前の子に戻る",
    page.url().includes("/chat") && page.url().includes(claimed.stored),
    page.url().slice(-70));
}

console.log("\n[35] はじめての流れ（同意 → 名前 → 土台）");
{
  const uid = "04" + `${Date.now()}`.slice(-12).replace(/[^0-9a-f]/g, "a").padEnd(12, "c");
  const res = await fetch(`${BASE}/t?u=${uid}`, { redirect: "manual" });
  const born = new URL(res.headers.get("location"), BASE);
  const freshCid = born.searchParams.get("cid");
  const freshToken = born.searchParams.get("token");

  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(born.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);

  // 同意。**必須だけでなく、任意の2つもここで見せる**
  check("同意の画面が出る", (await page.locator(".wtGate").count()) === 1);
  check("任意の同意も最初に出す", (await page.locator(".wtGate .optItem input").count()) === 2);
  check("任意は既定オフ（黙認にしない）",
    (await page.evaluate(() => [...document.querySelectorAll(".wtGate .optItem input")].every((i) => !i.checked))) === true);
  // **押すところが見えていること。** 差し込み先の button{opacity:0} を拾って
  // 見えなくなっていたことがある（押せてはいたので気づけなかった）
  const btnOpacity = await page.evaluate(() =>
    [...document.querySelectorAll(".wtGate button")].map((b) => getComputedStyle(b).opacity)
  );
  check("同意ボタンが見えている", btnOpacity.every((o) => Number(o) > 0.9), btnOpacity.join("/"));

  await page.check("#wtGateOpt_profile");
  await page.click(".wtGate button:not(.ghost)");
  await page.waitForTimeout(4200);

  // 選んだとおりに記録されていること（オンにしたものだけ）
  const view = await (await fetch(
    `${BASE}/api/profile?cid=${freshCid}&token=${encodeURIComponent(freshToken)}`
  )).json();
  check("必須の同意が記録される", view.consent?.terms === true);
  check("オンにした任意だけが記録される", view.consent?.profile === true && view.consent?.aggregate === false,
    JSON.stringify(view.consent));

  // 名前 → 土台
  await page.fill("#nameInput", "はじめのこ");
  await page.click("#nameForm button[type=submit]");
  await page.waitForTimeout(2200);
  check("名前のつぎに土台を聞く",
    (await page.evaluate(() => document.getElementById("seedForm").classList.contains("show"))) === true);
  check("なぜ書くのかが出ている",
    (await page.textContent("#seedWhy")).includes("まだあなたのことを何も知りません"));
  check("あとで書く道がある", (await page.locator("#seedSkip").count()) === 1);
  // 入力欄が画面に収まっていること（書く前にスクロールさせない）
  const fits = await page.evaluate(() => {
    const r = document.getElementById("seedSave").getBoundingClientRect();
    return r.bottom > 0 && r.bottom <= window.innerHeight;
  });
  check("書いて押すところまで画面に収まる", fits === true);

  await page.fill("#seedInput", "・柴犬のコタロウを飼っている\n・朝がとても弱い");
  await page.click("#seedSave");
  await page.waitForTimeout(2600);
  check("土台を書いたら会話へ進む", page.url().includes("/chat"), page.url().slice(-40));

  const after = await (await fetch(
    `${BASE}/api/profile?cid=${freshCid}&token=${encodeURIComponent(freshToken)}`
  )).json();
  check("書いた土台が保存されている", (after.notesSeed || "").includes("コタロウ"), (after.notesSeed || "").slice(0, 30));
  check("はじめての流れでJavaScriptエラーを出さない", errs.length === 0, errs.join(" / "));

  // 「あとで書く」でも会話へ行けること（必須にしない）
  const uid2 = "04" + `${Date.now() + 5}`.slice(-12).replace(/[^0-9a-f]/g, "a").padEnd(12, "d");
  const born2 = new URL(
    (await fetch(`${BASE}/t?u=${uid2}`, { redirect: "manual" })).headers.get("location"),
    BASE
  );
  await page.goto(born2.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  await page.click(".wtGate button:not(.ghost)");
  await page.waitForTimeout(4200);
  await page.fill("#nameInput", "あとでのこ");
  await page.click("#nameForm button[type=submit]");
  await page.waitForTimeout(2200);
  await page.click("#seedSkip");
  await page.waitForTimeout(2200);
  check("土台を書かなくても会話へ進める", page.url().includes("/chat"), page.url().slice(-40));
}

console.log("\n[34] 誰が新しい分身を作れるか（既定は依代を持つ人だけ）");
{
  // **既定では閉じている。** 依代は売り物なので、その横に誰でも押せるボタンを置かない。
  const entry = await (await fetch(`${BASE}/api/entry`)).json();
  check("何も持たない人には閉じている", entry.canCreate === false, JSON.stringify(entry));
  check("断る理由を言葉で返す", (entry.message || "").includes("依代"));

  const refused = await fetch(`${BASE}/api/character/new`, { method: "POST" });
  check("依代なしの作成は断られる", refused.status === 403, String(refused.status));

  const closedW = await fetch(`${BASE}/w`, { redirect: "manual" });
  const toClosed = new URL(closedW.headers.get("location") || "", BASE);
  check("閉じているとき /w は案内へ送る",
    toClosed.pathname === "/add" && toClosed.searchParams.get("closed") === "1",
    toClosed.pathname + toClosed.search);

  // 画面が、押せないボタンを出していないこと
  await page.context().clearCookies();
  await page.goto(`${BASE}/add`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  check("3番のボタンを出さない",
    (await page.evaluate(() => document.getElementById("createOpen").hidden)) === true);
  check("代わりに理由を出す",
    ((await page.textContent("#closedMsg")) || "").includes("依代"));

  // --- 依代を持っている人（ミラーが効いていない現物も含む）は通る ---
  // **ここを止めると、買った人が使えなくなる。**
  await page.goto(`${BASE}/t?u=00000000000000`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  check("依代から来た人は受け皿で1体つくれる", page.url().includes("cid="), page.url().slice(-50));

  await page.goto(`${BASE}/add`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  check("依代を持つ人には3番も出す",
    (await page.evaluate(() => document.getElementById("createOpen").hidden)) === false);

  // 依代の印を持っていれば /w も通る
  await page.evaluate(() => localStorage.removeItem("sodatsukake_tagClaim"));
  await page.goto(`${BASE}/w`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3200);
  const born = await page.evaluate(() => {
    let v = "";
    try { v = localStorage.getItem("sodatsukake_tagClaim") || ""; } catch (e) { /* noop */ }
    return { stored: v, url: location.href };
  });
  check("/w を開くだけで1体生まれる", born.stored.length > 0, JSON.stringify(born));
  check("そのまま誕生の画面に居る", born.url.includes("/summon") && born.url.includes("cid="), born.url.slice(-60));

  // **開くたびに増えない**（ここが壊れると数がすぐ意味を失う）
  await page.goto(`${BASE}/w`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  check("2回目に開いても増えない", page.url().includes(born.stored), page.url().slice(-70));

  // --- 管理者はいつでも作れる（手元で試すため）---
  if (adminPass) {
    const gate = await fetch(`${BASE}/admin?key=${encodeURIComponent(adminPass)}`, { redirect: "manual" });
    const cookie = (gate.headers.get("set-cookie") || "").split(";")[0];
    const asAdmin = await (await fetch(`${BASE}/api/entry`, { headers: { cookie } })).json();
    check("管理者には開いている", asAdmin.canCreate === true && asAdmin.reason === "admin",
      JSON.stringify(asAdmin));

    // **管理者の印は、そのブラウザで /admin?key= を1回開くだけで付く。**
    // 毎日入れ直さずに済むよう30日もたせている
    const maxAge = Number(/Max-Age=(\d+)/.exec(gate.headers.get("set-cookie") || "")?.[1]);
    check("管理者は30日覚えている", maxAge === 30 * 24 * 60 * 60, String(maxAge));
    check("合言葉はURLに残さない", !(gate.headers.get("location") || "").includes("key="),
      gate.headers.get("location") || "");

    // その端末だけ降りられること（人に貸した端末を戻す手立て）
    const out = await fetch(`${BASE}/admin?logout=1`, { redirect: "manual", headers: { cookie } });
    check("この端末だけ管理者から降りられる", (out.headers.get("set-cookie") || "").includes("Max-Age=0"),
      out.headers.get("set-cookie") || "");
    const adminPage = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    check("降りる導線が管理画面に出ている", adminPage.includes("この端末を管理者から外す"));

    const admin = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
    check("管理画面が依代なしのURLも出している", admin.includes('id="urlWeb"'));
    check("タグ前でも始められると書いてある", admin.includes("タグが刷り上がる前に始めたいとき"));
  }

  const add = await (await fetch(`${BASE}/add`)).text();
  check("分身を増やす画面が /w を案内している", add.includes('id="webLink"'));
}

check("JavaScriptエラーが出ていない", pageErrors.length === 0, pageErrors.join(" / "));

await browser.close();

console.log(`\nスクリーンショット: ${OUT_DIR}`);
if (failures.length > 0) {
  console.error(`\n${failures.length}件 失敗しました:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
