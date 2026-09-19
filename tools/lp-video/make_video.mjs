/**
 * サービス紹介動画を、**実際の画面から**作る。
 *
 * なぜ作り方をコードにしてあるか:
 * 動画は真っ先に古くなる。画面を直したのに動画だけ前の版のまま、というのが一番よくない
 * （「実際に触ったら違った」は、そのまま信用を失う）。
 * 実物のサービスを起動して、そこを撮って作る形にしておけば、作り直しが1コマンドで済む。
 *
 * 出てくるのは全部本物:
 *   - 画面      … ローカルで動かした本物のわけたま
 *   - キャラクター … public/characters の実物のモデル
 *   - 数値      … 成長段階・性格・厚みは、その分身から実際に計算されたもの
 * 会話の中身だけは、あらかじめ用意した文章を人格パッケージで流し込んでいる。
 * ローカルではAIが応答しないため（この点は動画内にも明記する）。
 *
 * 使い方:
 *   npx wrangler dev --local --port 8787     # 別プロセスで
 *   node tools/lp-video/make_video.mjs
 *   → public/media/intro.mp4 と intro.jpg
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { launchOptions, makeShooter, seedDemo, seedDeviceList } from "./demo.mjs";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const WORK = path.join(HERE, ".work");
const OUT_DIR = path.join(ROOT, "public", "media");

const W = 1280;
const H = 720;
const FPS = 25;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  console.error("playwright が要ります: npm i -D playwright");
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

console.log("撮影用の分身を用意しています…");
const { cid, token, state } = await seedDemo(BASE);
const depth = await (
  await fetch(`${BASE}/api/survey/next?cid=${cid}&token=${encodeURIComponent(token)}`)
).json();
console.log(`  ${state.name} / ${state.growthStage} / 会話${state.interactionCount}回 / 声: ${state.voice?.label}`);

// ---- 2. 実際の画面を撮る ---------------------------------------------------

const browser = await chromium.launch(launchOptions());
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const shot = makeShooter(BASE, phone, { cid, token }, WORK);

console.log("画面を撮っています…");
const shots = {};

await seedDeviceList(BASE, phone, { cid, token });
shots.home = await shot("home", "/home");
shots.chat = await shot("chat", `/chat?cid=${cid}`, { wait: 7000 });
shots.profile = await shot("profile", `/profile?cid=${cid}`, { wait: 2600 });
shots.history = await shot("history", `/history?cid=${cid}`, { wait: 2600 });
shots.add = await shot("add", "/add");

// 会話の続きを1往復ぶん見せる（入力欄に文字が入っているところ）
shots.typing = await shot("typing", `/chat?cid=${cid}`, {
  wait: 7000,
  before: async (p) => {
    await p.fill("#input", "おはよう。今日もよろしくね");
    await p.waitForTimeout(400);
  },
});

await phone.close();

// ---- 3. 1コマずつ、画面を組み立てて撮る ------------------------------------
//
// ffmpeg のフィルタで文字と枠を足すより、HTMLで組んで撮るほうが速くて確実。
// 端末の枠に入れるのは、これがスマホで動くものだと一目で分かるようにするため。

const BRAND = "#7c5cff";

function sceneHtml({ title, lines, shotFile, badge, accent }) {
  const img = shotFile ? `<img src="file://${shotFile}" />` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden; display: flex; align-items: center;
    font-family: "Noto Sans CJK JP", "Noto Sans JP", sans-serif;
    background: radial-gradient(1000px 700px at 78% 30%, #efeaff 0%, #f7f5ff 45%, #ffffff 100%);
    color: #1c1630;
  }
  .text { flex: 1; padding: 0 56px 0 76px; }
  .badge {
    display: inline-block; background: ${accent || BRAND}; color: #fff; font-size: 17px; font-weight: 700;
    padding: 7px 18px; border-radius: 999px; margin-bottom: 22px; letter-spacing: .04em;
  }
  h1 { font-size: 46px; line-height: 1.32; letter-spacing: -.01em; margin-bottom: 26px; }
  h1 em { font-style: normal; color: ${BRAND}; }
  li { font-size: 21px; line-height: 1.95; color: #4a4266; list-style: none; padding-left: 26px; position: relative; }
  li::before { content: ""; position: absolute; left: 4px; top: 17px; width: 9px; height: 9px; border-radius: 50%; background: ${BRAND}; opacity: .55; }
  .phone {
    width: 356px; height: 700px; flex: none; margin-right: 78px; border-radius: 42px; padding: 11px;
    background: #17132b; box-shadow: 0 30px 70px rgba(50,35,110,.28); position: relative;
  }
  .phone::after {
    content: ""; position: absolute; top: 22px; left: 50%; transform: translateX(-50%);
    width: 104px; height: 22px; border-radius: 999px; background: #17132b; z-index: 2;
  }
  .phone img { width: 100%; height: 100%; object-fit: cover; object-position: top center; border-radius: 32px; display: block; }
  .mark { position: absolute; left: 76px; bottom: 44px; display: flex; align-items: center; gap: 9px; opacity: .85; }
  .mark svg { width: 26px; height: 26px; }
  .mark span { font-size: 17px; font-weight: 700; color: ${BRAND}; letter-spacing: .06em; }
  </style></head><body>
  <div class="text">
    ${badge ? `<div class="badge">${badge}</div>` : ""}
    <h1>${title}</h1>
    <ul>${(lines || []).map((l) => `<li>${l}</li>`).join("")}</ul>
  </div>
  ${shotFile ? `<div class="phone">${img}</div>` : ""}
  <div class="mark"><svg viewBox="0 0 100 100"><path fill="${BRAND}" fill-rule="evenodd" d="M59.7 13.8 C61.1 14.9 65.5 17.8 68.1 20.4 C70.6 22.9 73.1 26.0 74.9 29.0 C76.6 32.1 77.8 35.3 78.5 38.7 C79.1 42.1 79.3 45.9 78.7 49.4 C78.0 52.9 76.7 56.7 74.8 59.7 C72.9 62.7 70.3 65.4 67.4 67.3 C64.5 69.2 60.8 70.7 57.5 71.1 C54.1 71.5 50.2 71.2 47.1 69.9 C44.0 68.6 40.1 64.6 38.7 63.5 A5.0 5.0 0 0 1 45.1 55.8 C45.6 56.1 46.9 57.1 48.0 57.4 C49.0 57.7 50.2 57.8 51.2 57.6 C52.3 57.4 53.5 56.9 54.4 56.3 C55.3 55.7 56.0 54.8 56.5 53.8 C57.0 52.9 57.3 51.7 57.3 50.6 C57.3 49.6 57.0 48.3 56.5 47.4 C56.0 46.5 55.0 45.5 54.1 45.2 C53.2 44.9 51.7 45.6 51.2 45.7 A16.5 16.5 0 0 1 59.7 13.8 Z M47.5 29.7a7.9 7.9 0 1 0 15.8 0a7.9 7.9 0 1 0 -15.8 0Z"/></svg><span>わけたま</span></div>
  </body></html>`;
}

// キャプションの数字は、上で実際に引いてきた値を使う。手で書くと必ずズレる。
const depthScore = depth?.depth?.score ?? "-";
const SCENES = [
  {
    seconds: 4,
    badge: "わけたま",
    title: "話しかけるほど、<em>あなたに似ていく</em>。",
    lines: ["依代（キーホルダーやQR）をかざすと、分身がひとり生まれます", "アカウント登録はありません"],
    shot: shots.home,
  },
  {
    seconds: 5,
    badge: "育つ",
    title: "会話が、そのまま<em>その子の個性</em>になる。",
    lines: [
      `いまの段階: ${state.growthStage}（会話${state.interactionCount}回）`,
      "段階が上がると、覚えていられる量と話し方が実際に変わります",
      "前に話した内容は、次に開いたときちゃんと残っています",
    ],
    shot: shots.chat,
  },
  {
    seconds: 4,
    badge: "覚える",
    title: "あなたのことを、<em>覚えていく</em>。",
    lines: [
      "土台はあなたが書き、その上に会話からの学習が積み上がります",
      "何を覚えられているかは、いつでも見られて、直せます",
      `この子の厚み: ${depthScore} / 100`,
    ],
    shot: shots.profile,
  },
  {
    seconds: 4,
    badge: "見える",
    title: "育ち方が、<em>数字で見える</em>。",
    lines: ["温かさ・好奇心・慎重さ…6つの軸が、会話のたびに少しずつ動きます", "どう育ってきたかを、あとから振り返れます"],
    shot: shots.history,
  },
  {
    seconds: 4,
    badge: "集める",
    title: "依代ひとつに、<em>ひとり</em>だけ。",
    lines: [
      "1つのタグ・1枚のQRから生まれるのは、1体だけ",
      "姿はそのとき決まります。どこで手に入れた子かも残ります",
    ],
    shot: shots.add,
  },
  {
    seconds: 5,
    badge: "持ち出す",
    title: "育てた人格は、<em>外へ持ち出せます</em>。",
    lines: [
      "ロボットやアバターへ渡す数値は、わずか240バイト。LLMは要りません",
      "性格が逆の2体で、返すまでの間は 410ms と 930ms",
      "特定の会社に閉じ込めない形で書き出せます",
    ],
    shot: shots.typing,
  },
  {
    seconds: 4,
    badge: "",
    title: "その子は、まだ<em>名前を持っていません</em>。",
    lines: ["waketama.com", "※ 画面はすべて実際のものです。会話の文面のみ、紹介用に用意したものを表示しています"],
    shot: null,
    accent: "#4c3a99",
  },
];

console.log("コマを組み立てています…");
const canvas = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const sceneFiles = [];
for (let i = 0; i < SCENES.length; i++) {
  const sc = SCENES[i];
  const html = sceneHtml({ title: sc.title, lines: sc.lines, shotFile: sc.shot, badge: sc.badge, accent: sc.accent });
  const htmlPath = path.join(WORK, `scene-${i}.html`);
  writeFileSync(htmlPath, html);
  await canvas.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
  const file = path.join(WORK, `scene-${String(i).padStart(2, "0")}.png`);
  await canvas.screenshot({ path: file });
  sceneFiles.push({ file, seconds: sc.seconds });
}
await canvas.close();
await browser.close();

// ---- 4. つなぐ -------------------------------------------------------------
//
// 1枚ずつを動画にしてから、重ねながら繋ぐ（crossfade）。
// 静止画を並べただけだと紙芝居に見えるので、ゆっくり寄せる動き（ズーム）を足す。

console.log("動画にしています…");
const FADE = 0.6;
const parts = [];
for (let i = 0; i < sceneFiles.length; i++) {
  const { file, seconds } = sceneFiles[i];
  const out = path.join(WORK, `part-${String(i).padStart(2, "0")}.mp4`);
  const frames = Math.round(seconds * FPS);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-loop", "1", "-i", file,
      "-vf",
      // ゆっくり1.04倍まで寄せる。動きが速いと落ち着かないので、これ以上は付けない。
      //
      // 式に **カンマもシングルクォートも使わないこと**。
      // execFileSync はシェルを通さないので、引用符はそのまま式の一部としてffmpegへ渡る。
      // カンマはフィルタの区切りとして先に解釈されてしまう（min(a,b) が書けない）。
      // ここでは on が 0〜frames-1 の範囲しか来ないので、上限を取らずに素直に足すだけで足りる。
      `scale=${W * 2}:${H * 2},zoompan=z=1+0.04*on/${frames}:d=${frames}:x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2):s=${W}x${H}:fps=${FPS},format=yuv420p`,
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "medium", "-crf", "24",
      out,
    ],
    { stdio: "inherit" }
  );
  parts.push({ out, seconds });
}

// crossfade は2本ずつしか繋げないので、順番に重ねていく
let current = parts[0].out;
let elapsed = parts[0].seconds;
for (let i = 1; i < parts.length; i++) {
  const next = path.join(WORK, `merge-${i}.mp4`);
  const offset = Math.max(0, elapsed - FADE);
  execFileSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-i", current, "-i", parts[i].out,
      "-filter_complex", `[0:v][1:v]xfade=transition=fade:duration=${FADE}:offset=${offset},format=yuv420p[v]`,
      "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "24",
      next,
    ],
    { stdio: "inherit" }
  );
  current = next;
  elapsed = offset + parts[i].seconds;
}

const mp4 = path.join(OUT_DIR, "intro.mp4");
execFileSync(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-i", current, "-c:v", "libx264", "-preset", "slow", "-crf", "27",
   "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4],
  { stdio: "inherit" }
);

// 再生前に見えている1枚。動画が読めない環境でも、ここだけは出る
const poster = path.join(OUT_DIR, "intro.jpg");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-frames:v", "1", "-q:v", "4", poster], {
  stdio: "inherit",
});

const size = execFileSync("du", ["-h", mp4]).toString().split("\t")[0];
console.log(`\npublic/media/intro.mp4（${size}, 約${Math.round(elapsed)}秒）`);
console.log("public/media/intro.jpg");
