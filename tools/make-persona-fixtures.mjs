/**
 * 検証用に、性格の異なる分身を2体つくって人格カードを書き出す。
 *
 * 「集めたデータで本当に別の人格として動くのか」を確かめるには、
 * **対照になる2体**が要る。同じ設問に正反対の答えをした2人を作り、
 * 書き出したカードがどれだけ違うかを測る（tools/persona-runtime-check.mjs）。
 *
 * 使い方:
 *   npm run dev                     # 別プロセスで
 *   node tools/make-persona-fixtures.mjs
 *   → tools/.persona-out/{seeker,keeper}.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE = process.env.E2E_BASE_URL || "http://127.0.0.1:8787";
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".persona-out");
mkdirSync(OUT_DIR, { recursive: true });

async function json(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const post = (path, body) =>
  json(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * 2体の設定。
 * 同じ設問に、意図的に反対側の選択肢を選ばせている。
 * 会話の中身も、それぞれの人物像から自然に出てくるものにしてある
 * （同じ会話をさせて属性だけ変えると、口調が同じままになり、差が出たように見えない）。
 */
const PERSONAS = [
  {
    key: "seeker",
    name: "さきがけ",
    profile: {
      ageBand: ["20代"],
      gender: ["女性"],
      region: ["首都圏"],
      occupation: ["自営業・フリーランス"],
      hobbies: ["旅行", "カメラ", "プログラミング"],
      chronotype: ["夜型"],
      wantedRelation: ["相棒として"],
      futureBody: ["小さなロボット", "VR・メタバース"],
    },
    psycho: {
      psy_stimulation: "絶対はじめての店",
      psy_achievement: "結果を出せた日",
      psy_security: "決めない方が気が楽",
      psy_selfDirection: "自分で決めたい",
      psy_tradition: "古いやり方にこだわりはない",
      psy_power: "自分が引っぱることが多い",
      psy_hedonism: "とにかく楽しいことをする",
      psy_benevolence: "向こうから言ってくるまで待つ",
    },
    // 育った状態を再現するための性格。会話5回では数値が動かないので、
    // 「60回話した分身」を人格パッケージとして流し込んでから測る
    personality: { warmth: 55, curiosity: 88, cheerfulness: 74, caution: 26, independence: 84, humor: 66 },
    interactionCount: 62,
    growthStage: "おしゃべり期",
    turns: [
      ["来月いきなり福岡に行くことにした。宿もまだ決めてない", "いいね、宿は着いてから探すのも面白いよ。屋台で朝まで粘るやつ、やってみたら"],
      ["新しいカメラ買ったから、知らない街で撮り歩きたい", "それ絶対いい。地図見ないで歩いた方が変な路地に当たるよ"],
      ["仕事は自分で全部決められるのが楽しい", "わかる。締切も自分で引いた方が守れるタイプでしょ"],
      ["深夜に作業してると一番はかどる", "夜の方が頭が回るもんね。朝方に寝る生活、こっちは慣れてるよ"],
      ["失敗してもいいから、やったことないことをやりたい", "やろうよ。失敗した話の方が、あとで面白くなるし"],
      ["どっちの案がいいと思う？", "両方いけると思うけど、やったことない方を先に試してみない"],
    ],
    notes: "・フリーランスで働いている\n・夜型で深夜に作業する\n・旅とカメラが好き\n・自分で決めたい人",
  },
  {
    key: "keeper",
    name: "ひだまり",
    profile: {
      ageBand: ["40代"],
      gender: ["男性"],
      region: ["東海"],
      occupation: ["会社員"],
      hobbies: ["料理", "読書", "映画・ドラマ"],
      chronotype: ["朝型"],
      wantedRelation: ["きょうだいみたいに"],
      futureBody: ["スマートスピーカー", "スマホの中のまま"],
    },
    psycho: {
      psy_stimulation: "ぜったいいつもの店",
      psy_achievement: "人に喜んでもらえた日",
      psy_security: "だいたい埋まっている",
      psy_selfDirection: "決まっている方が助かる",
      psy_tradition: "理由があるから続いている",
      psy_power: "決まったことに従うのが楽",
      psy_hedonism: "たまっている用事を片づける",
      psy_benevolence: "すぐ連絡して会いに行く",
    },
    personality: { warmth: 86, curiosity: 40, cheerfulness: 54, caution: 80, independence: 33, humor: 44 },
    interactionCount: 58,
    growthStage: "おしゃべり期",
    turns: [
      ["毎週日曜に一週間分の作り置きをしてる", "えらいなあ。日曜の午後にそれが終わってると、一週間が落ち着くよね"],
      ["同じ喫茶店に10年通ってる。頼むものもだいたい同じ", "10年はすごいよ。同じ席に座れる場所があるのって、ありがたいことだと思う"],
      ["子どもが熱を出したと聞いて、すぐ実家に寄ってきた", "すぐ行けたのがいいね。あとで様子どうだったか、教えてほしいな"],
      ["朝5時に起きて本を読む時間が好きだ", "静かな時間だもんね。その時間を守れてるの、うらやましいよ"],
      ["急に予定が変わるのは苦手", "わかるよ。決まってると安心して動けるもんね"],
      ["どっちの案がいいと思う？", "いつものやり方に近い方が無難だと思うな。急がなくていいなら、そっちを勧めるよ"],
    ],
    notes: "・会社員で朝型\n・毎週日曜に作り置きをする\n・10年通っている喫茶店がある\n・家族をとても大事にしている",
  },
];

for (const persona of PERSONAS) {
  const tag = `fixture-${persona.key}-${Date.now()}`;
  // NFCタップと同じ経路で1体つくる
  const tapped = await fetch(`${BASE}/t/${tag}`, { redirect: "manual" });
  const location = tapped.headers.get("location") || "";
  const params = new URL(location, BASE).searchParams;
  const cid = params.get("cid");
  const token = params.get("token");
  if (!cid || !token) throw new Error(`分身を作れませんでした: ${location}`);

  // 「育った分身」の状態を人格パッケージで流し込む。
  // ローカルではAIが応答しないので、会話を積んでも中身の無いやり取りしか残らない。
  // 販売できる水準（会話60回程度）の分身で測りたいので、ここは復元の経路を使う。
  await post("/api/character/import", {
    characterId: cid,
    token,
    package: {
      formatVersion: "1.1",
      exportedAt: Date.now(),
      character: {
        id: cid,
        name: persona.name,
        species: "punikoro",
        color: persona.key === "seeker" ? "sun" : "leaf",
        createdAt: Date.now() - 90 * 24 * 3600 * 1000,
        growthStage: persona.growthStage,
        interactionCount: persona.interactionCount,
      },
      personality: persona.personality,
      personalityHistory: [],
      memory: {
        shortTerm: "",
        longTerm: [],
        profileNotes: persona.notes,
        recentTurns: persona.turns.flatMap(([user, character], i) => [
          { role: "user", text: user, t: Date.now() - (persona.turns.length - i) * 60000 },
          { role: "character", text: character, t: Date.now() - (persona.turns.length - i) * 60000 + 1000 },
        ]),
      },
      meta: { generator: "waketama", note: "検証用の固定データ" },
    },
  });
  await post("/api/consent", { characterId: cid, token, consent: { terms: true, profile: true, aggregate: true } });
  await post("/api/profile", { characterId: cid, token, answers: persona.profile });

  for (const [id, value] of Object.entries(persona.psycho)) {
    await post("/api/survey/answer", { characterId: cid, token, id, values: [value] });
  }
  await post("/api/notes", { characterId: cid, token, notes: persona.notes });

  const card = await json(
    `${BASE}/api/persona/card?cid=${encodeURIComponent(cid)}&token=${encodeURIComponent(token)}&format=json`
  );
  writeFileSync(path.join(OUT_DIR, `${persona.key}.json`), JSON.stringify(card, null, 2));
  console.log(`${persona.key}: ${card.identity.name} / 会話${card.identity.interactionCount}回 → ${persona.key}.json`);
}

console.log(`\n書き出し先: ${OUT_DIR}`);
