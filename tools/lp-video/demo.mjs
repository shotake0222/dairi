/**
 * 紹介素材（動画・LPの画面写真）で使う「撮影用の分身」と、実画面の撮り方。
 *
 * 動画とLPの画面写真で同じ分身・同じ撮り方を使うために、ここに出してある。
 * 別々に書くと、動画の中の子とLPに載っている子が違う、ということが起きる。
 *
 * ここで作られるもののうち**本物でないのは会話の本文だけ**（ローカルではAIが応答しないため）。
 * 成長段階・性格の推移・厚み・声は、その本文からサービスが実際に計算した値。
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

export const DEMO = {
  name: "こだま",
  species: "mofukuru",
  color: "peach",
  interactionCount: 168,
  growthStage: "相棒期",
  personality: { warmth: 78, curiosity: 71, cheerfulness: 66, caution: 38, independence: 52, humor: 63 },
  notesSeed: "・柴犬のコタロウを飼っている\n・朝がとても弱い\n・写真を撮るのが好き",
  notes: "・週末は近所の川沿いを散歩する\n・コーヒーは深煎りが好み\n・来月、引っ越しを考えている",
  turns: [
    ["ただいま。今日はずっと会議だった", "おかえり。ずっと画面越しだと疲れるよね。コタロウは待ちくたびれてなかった？"],
    ["散歩には行けたよ。川沿いまで", "いいね、あそこ気持ちいいもんね。写真は撮った？"],
    ["撮ったけど、曇ってていまいち", "曇りの日のほうが色が出ることもあるよ。あとで見せて"],
    ["来月の引っ越し、まだ何も決まってない", "急がなくていいと思うけど、内見だけ先に入れておくと気が楽かも"],
    ["明日は早起きしないといけない", "朝、弱いもんね。今夜の分だけでも先に準備しておこうか"],
  ],
  profile: {
    ageBand: ["30代"],
    region: ["首都圏"],
    hobbies: ["カメラ", "散歩"],
    chronotype: ["夜型"],
    wantedRelation: ["相棒として"],
    futureBody: ["小さなロボット"],
  },
  psycho: {
    psy_stimulation: "絶対はじめての店",
    psy_benevolence: "すぐ連絡して会いに行く",
    psy_selfDirection: "自分で決めたい",
    psy_hedonism: "前からやりたかったことをする",
  },
};

/** 撮影用の分身を1体つくる。返すのは cid・持ち主トークンと、実際に計算された状態。 */
export async function seedDemo(BASE) {
  const post = async (p, body) => {
    const res = await fetch(`${BASE}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${p} → ${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json().catch(() => ({}));
  };

  const tapped = await fetch(`${BASE}/t/lpdemo-${Date.now()}`, { redirect: "manual" });
  const loc = new URL(tapped.headers.get("location") || "", BASE);
  const cid = loc.searchParams.get("cid");
  const token = loc.searchParams.get("token");
  if (!cid || !token) throw new Error("分身を作れませんでした");

  await post("/api/character/import", {
    characterId: cid,
    token,
    package: {
      formatVersion: "1.1",
      exportedAt: Date.now(),
      character: {
        id: cid,
        name: DEMO.name,
        species: DEMO.species,
        color: DEMO.color,
        createdAt: Date.now() - 120 * 24 * 3600 * 1000,
        growthStage: DEMO.growthStage,
        interactionCount: DEMO.interactionCount,
      },
      personality: DEMO.personality,
      personalityHistory: Array.from({ length: 8 }, (_, i) => ({
        t: Date.now() - (8 - i) * 12 * 24 * 3600 * 1000,
        interactionCount: Math.round((DEMO.interactionCount / 8) * i),
        personality: Object.fromEntries(
          Object.entries(DEMO.personality).map(([k, v]) => [k, Math.round(50 + (v - 50) * (i / 7))])
        ),
      })),
      memory: {
        shortTerm: "",
        longTerm: [],
        profileNotes: DEMO.notes,
        recentTurns: DEMO.turns.flatMap(([u, c], i) => [
          { role: "user", text: u, t: Date.now() - (DEMO.turns.length - i) * 3600000 },
          { role: "character", text: c, t: Date.now() - (DEMO.turns.length - i) * 3600000 + 30000 },
        ]),
      },
      meta: { generator: "waketama", note: "紹介素材の撮影用" },
    },
  });
  await post("/api/consent", { characterId: cid, token, consent: { terms: true, profile: true, aggregate: true } });
  await post("/api/profile", { characterId: cid, token, answers: DEMO.profile });
  for (const [id, value] of Object.entries(DEMO.psycho)) {
    await post("/api/survey/answer", { characterId: cid, token, id, values: [value] });
  }
  await post("/api/notes", { characterId: cid, token, part: "seed", notes: DEMO.notesSeed });

  const state = await (await fetch(`${BASE}/api/character?cid=${cid}`)).json();
  return { cid, token, state };
}

/**
 * キャラクターは3Dモデル（model-viewer）で出している。
 * 既定のヘッドレスだとGPUが無くて何も描かれず、**キャラの居ない絵**になる。
 * ソフトウェアで描かせる（遅いが確実）。
 */
export const HEADLESS_GL_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

export function launchOptions() {
  return {
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
    args: HEADLESS_GL_ARGS,
  };
}

/** 端末サイズのページで、実際の画面を撮る。`shot(name, url, opts)` を返す。 */
export function makeShooter(BASE, phone, { cid, token }, outDir) {
  mkdirSync(outDir, { recursive: true });
  return async function shot(name, url, opts = {}) {
    await phone.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    // 同意はもう記録済みだが、端末に印が無い状態で開くと出るので通しておく
    await phone.evaluate(([c, t]) => localStorage.setItem(`sodatsukake_token_${c}`, t), [cid, token]);
    if (opts.reload !== false) await phone.reload({ waitUntil: "domcontentloaded" });
    // 3Dモデルは読み込みに時間がかかる。描き終わる前に撮ると、キャラの居ない絵になる
    await phone
      .waitForFunction(
        () => {
          const mv = document.querySelector("model-viewer");
          return !mv || mv.loaded === true;
        },
        { timeout: 15000 }
      )
      .catch(() => {});
    await phone.waitForTimeout(opts.wait ?? 2200);
    if (opts.before) await opts.before(phone);
    const file = path.join(outDir, `${name}.png`);
    await phone.screenshot({ path: file, fullPage: opts.fullPage === true });
    return file;
  };
}

/** 一覧は「この端末で開いたことのある分身」しか並ばない。撮る前に印を置いておく。 */
export async function seedDeviceList(BASE, phone, { cid, token }) {
  await phone.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await phone.evaluate(
    ([c, t, d]) => {
      localStorage.setItem(`sodatsukake_token_${c}`, t);
      localStorage.setItem("sodatsukake_myCharacters", JSON.stringify([d]));
    },
    [
      cid,
      token,
      {
        cid,
        name: DEMO.name,
        species: DEMO.species,
        color: DEMO.color,
        growthStage: DEMO.growthStage,
        interactionCount: DEMO.interactionCount,
        lastVisit: Date.now() - 3600000,
      },
    ]
  );
}
