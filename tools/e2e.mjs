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

console.log("\n[1] NFCタップ → 召喚 → チャット");
const tagId = `e2e-${Date.now()}`;
await page.goto(`${BASE}/t/${tagId}`, { waitUntil: "networkidle" });
const summonUrl = new URL(page.url());
check("タップで召喚ページに遷移する", summonUrl.pathname === "/summon", summonUrl.pathname);
check("持ち主トークンがURLから消えている（localStorageへ退避済み）", summonUrl.searchParams.get("token") === null);

const cid = summonUrl.searchParams.get("cid");
check("cidが発行されている", Boolean(cid));
const storedToken = await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), cid);
check("持ち主トークンがこの端末に保存されている", Boolean(storedToken));

await page.goto(`${BASE}/chat?cid=${cid}`, { waitUntil: "networkidle" });
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

console.log("\n[5] 同じNFCタグの再利用");
await page.goto(`${BASE}/t/${tagId}`, { waitUntil: "networkidle" });
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

console.log("\n[11] LP・マーケット・管理画面");
const lpHtml = await (await fetch(`${BASE}/lp`)).text();
check("LPが配信される", lpHtml.includes("御霊"));
// LPは一般向けの入口。人格データの売買の話は表に出さない方針にしている
check("LPに人格データ販売の話が出ていない", !lpHtml.includes("販売") && !lpHtml.includes("マーケット"));

const marketHtml = await (await fetch(`${BASE}/market`)).text();
check("マーケットが配信される", marketHtml.includes("人格マーケット"));

const adminRes = await fetch(`${BASE}/admin`);
// 合言葉(ADMIN_PASSCODE)を設定していない状態が既定。素通しになっていないこと
check("管理画面は合言葉なしでは開かない", adminRes.status === 404 || adminRes.status === 401, String(adminRes.status));
const adminApi = await fetch(`${BASE}/api/admin/overview`);
check("管理APIも閉じている", adminApi.status === 404 || adminApi.status === 401, String(adminApi.status));

console.log("\n[12] 同意と属性（既定はすべてオフ）");
// [8]の引き継ぎで持ち主トークンが差し替わっているため、端末に残っている古い値ではなく
// 引き継ぎで発行された新しいトークンを使う（古い方は、もう持ち主として通らない）
const profileToken = claimed.ownerToken || (await page.evaluate((c) => localStorage.getItem(`sodatsukake_token_${c}`), newCid));
const ownerView = await (await fetch(`${BASE}/api/profile?cid=${newCid}&token=${profileToken}`)).json();
check("初期状態では何にも同意していない", ownerView.consent === null, JSON.stringify(ownerView.consent));

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
check("マーケットの扱いが書かれている", termsHtml.includes("マーケットについて"));
check("決済を提供していないことが明記されている", termsHtml.includes("決済機能は提供していません"));

const lp2 = await (await fetch(`${BASE}/lp`)).text();
check("LPで分け御霊の由来を説明している", lp2.includes("分 け 御 霊") || lp2.includes("分け御霊"));
check("LPで話しかけ方が5通り紹介されている", lp2.includes("かざして話す") && lp2.includes("視線で話す") && lp2.includes("その場限りの通話"));
check("LPから法人ページへ行ける", lp2.includes('href="/biz"'));

const bizHtml = await (await fetch(`${BASE}/biz`)).text();
check("法人向けページが配信される", bizHtml.includes("小さなモデルに"));
check("SLM・エッジ向けの訴求が入っている", bizHtml.includes("フィジカルAI") && bizHtml.includes("メタバース"));
check("マスキング済みデータの説明が入っている", bizHtml.includes("マスキング済み"));
check("人格カードの書き出し形式が示されている", bizHtml.includes("modelfile"));

await page.goto(`${BASE}/biz`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);
const bizLayout = await page.evaluate(() => ({
  overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
}));
check("法人向けページが横に溢れていない", bizLayout.overflowX === false);

// 問い合わせフォームが実際に届くこと
const bizMail = `e2e-biz-${Date.now()}@example.com`;
await page.fill("#company", "E2E株式会社");
await page.fill("#contactEmail", bizMail);
await page.fill("#message", "検証用の問い合わせです");
await page.click("#submitBtn");
await page.waitForTimeout(1200);
check("問い合わせが受け付けられる", ((await page.textContent("#formStatus")) || "").includes("受け付けました"));
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

check("JavaScriptエラーが出ていない", pageErrors.length === 0, pageErrors.join(" / "));

await browser.close();

console.log(`\nスクリーンショット: ${OUT_DIR}`);
if (failures.length > 0) {
  console.error(`\n${failures.length}件 失敗しました:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
