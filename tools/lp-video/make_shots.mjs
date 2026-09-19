/**
 * /lp と /biz に載せる**実画面の写真**を、本物のサービスから撮る。
 *
 * なぜコードにしてあるか: 紹介ページの画像は真っ先に古くなる。
 * 画面を直したのに写真だけ前の版のまま、というのが一番よくない
 * （「実際に触ったら違った」は、そのまま信用を失う）。1コマンドで撮り直せる形にしておく。
 *
 * 撮影用の分身と撮り方は動画と共有している（./demo.mjs）。
 * 動画の中の子とLPに載っている子が別人にならないようにするため。
 *
 * 使い方:
 *   npx wrangler dev --local --port 8787     # 別プロセスで
 *   node tools/lp-video/make_shots.mjs
 *   → public/media/shots/*.webp（LPから参照する）
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { launchOptions, makeShooter, seedDemo, seedDeviceList } from "./demo.mjs";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const WORK = path.join(HERE, ".shots");
const OUT_DIR = path.join(ROOT, "public", "media", "shots");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright が要ります: npm i -D playwright");
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log("撮影用の分身を用意しています…");
const { cid, token, state } = await seedDemo(BASE);
console.log(`  ${state.name} / ${state.growthStage} / 会話${state.interactionCount}回`);

const browser = await chromium.launch(launchOptions());
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const shot = makeShooter(BASE, phone, { cid, token }, WORK);

console.log("画面を撮っています…");
await seedDeviceList(BASE, phone, { cid, token });

// LPに載せるのはこの4枚。「会う→話す→育ちが見える→自分で選べる」の順に並べる。
const PAGES = [
  ["home", "/home", { wait: 2400 }],
  ["chat", `/chat?cid=${cid}`, { wait: 7000 }],
  ["history", `/history?cid=${cid}`, { wait: 3200 }],
  ["profile", `/profile?cid=${cid}`, { wait: 2600 }],
];

for (const [name, url, opts] of PAGES) {
  await shot(name, url, opts);
  console.log(`  ${name}`);
}

await phone.close();
await browser.close();

// ---- 書き出し --------------------------------------------------------------
//
// 端末の縦画面（780×1688）そのままだと1枚300KB近い。
// 紹介ページは初見の人が開くところなので、幅を半分に落として WebP にする。

const WIDTH = 390;

for (const [name] of PAGES) {
  const src = path.join(WORK, `${name}.png`);
  const dst = path.join(OUT_DIR, `${name}.webp`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", src,
    "-vf", `scale=${WIDTH}:-2:flags=lanczos`,
    "-quality", "82",
    dst,
  ]);
  console.log(`  ${path.relative(ROOT, dst)}  ${(statSync(dst).size / 1024).toFixed(0)}KB`);
}

console.log("できました。");
