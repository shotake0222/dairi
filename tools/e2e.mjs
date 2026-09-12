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
check("og:imageが絶対URLになっている", html.includes(`content="${BASE}/icons/ogp.png"`));

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

check("JavaScriptエラーが出ていない", pageErrors.length === 0, pageErrors.join(" / "));

await browser.close();

console.log(`\nスクリーンショット: ${OUT_DIR}`);
if (failures.length > 0) {
  console.error(`\n${failures.length}件 失敗しました:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nすべて通りました。");
