/**
 * ステージング環境の初期セットアップを1コマンドで済ませるスクリプト。
 *
 *   npm run setup:staging
 *
 * やること（すべて何度実行しても安全＝冪等）:
 *   1. D1 `waketama-staging-db` を作る（既にあればそれを使う）
 *   2. その database_id を wrangler.toml に書き込む（プレースホルダを置換）
 *   3. ステージングD1にマイグレーションを適用する
 *   4. Vectorizeインデックスとメタデータインデックスを作る（既にあれば飛ばす）
 *
 * なぜ用意したか:
 * 手順としては `d1 create` の出力に含まれる database_id を wrangler.toml に貼るだけなのだが、
 * 貼り忘れたまま deploy すると
 *   「binding DB of type d1 must have a valid `database_id` specified [code: 10021]」
 * という、原因が読み取りにくいエラーで止まる。実際にそれで一度詰まったので、
 * 貼り付け作業自体を無くしてしまうことにした。
 *
 * このスクリプトはCloudflareアカウントにリソースを作成する。実行前に
 * `npx wrangler whoami` でログイン済みであることを確認すること。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const D1_NAME = "waketama-staging-db";
const VECTORIZE_NAME = "waketama-staging-memory";
const CONFIG_PATH = "wrangler.toml";
const PLACEHOLDER = "REPLACE_WITH_STAGING_D1_ID";

function run(args, { allowFail = false } = {}) {
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const output = `${err.stdout || ""}${err.stderr || ""}`;
    if (allowFail) return output;
    console.error(`\n✘ wrangler ${args.join(" ")} が失敗しました\n`);
    console.error(output.trim());
    process.exit(1);
  }
}

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

// --- 前提確認 -------------------------------------------------------------
const who = run(["whoami"], { allowFail: true });
if (/not authenticated|wrangler login/i.test(who)) {
  console.error("Cloudflareにログインしていません。先に `npx wrangler login` を実行してください。");
  process.exit(1);
}

// --- 1. D1を用意する ------------------------------------------------------
step(1, `D1 "${D1_NAME}" を確認`);

/** wranglerの出力から database_id / uuid を拾う（出力形式の違いに幅を持たせる）。 */
function extractId(text) {
  const patterns = [
    /database_id\s*=\s*"([0-9a-f-]{36})"/i,
    /"(?:uuid|database_id)"\s*:\s*"([0-9a-f-]{36})"/i,
    /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

let databaseId = null;
const listed = run(["d1", "list", "--json"], { allowFail: true });
try {
  const rows = JSON.parse(listed);
  const hit = Array.isArray(rows) ? rows.find((r) => r?.name === D1_NAME) : null;
  if (hit) databaseId = hit.uuid || hit.database_id || null;
} catch (err) {
  // --json に対応していない版のwranglerでも動くよう、テキストからも拾えるようにしておく
  if (listed.includes(D1_NAME)) databaseId = extractId(listed);
}

if (databaseId) {
  console.log(`    既にあります: ${databaseId}`);
} else {
  console.log("    見つからないので作成します…");
  const created = run(["d1", "create", D1_NAME]);
  databaseId = extractId(created);
  if (!databaseId) {
    console.error("作成はできましたが database_id を読み取れませんでした。出力を確認してください:\n");
    console.error(created);
    process.exit(1);
  }
  console.log(`    作成しました: ${databaseId}`);
}

// --- 2. wrangler.toml に書き込む -----------------------------------------
step(2, `${CONFIG_PATH} に database_id を書き込み`);
const config = readFileSync(CONFIG_PATH, "utf8");
if (config.includes(databaseId)) {
  console.log("    すでに設定済みです");
} else if (config.includes(PLACEHOLDER)) {
  writeFileSync(CONFIG_PATH, config.replace(PLACEHOLDER, databaseId));
  console.log("    書き込みました");
} else {
  console.error(
    `    プレースホルダ(${PLACEHOLDER})が見つかりませんでした。\n` +
      `    [[env.staging.d1_databases]] の database_id を手動で ${databaseId} にしてください。`
  );
  process.exit(1);
}

// --- 3. マイグレーション ---------------------------------------------------
step(3, "ステージングD1にマイグレーションを適用");
console.log(run(["d1", "migrations", "apply", D1_NAME, "--remote", "--env", "staging"]).trim());

// --- 4. Vectorize ---------------------------------------------------------
step(4, `Vectorizeインデックス "${VECTORIZE_NAME}" を確認`);
const vectorizeList = run(["vectorize", "list"], { allowFail: true });
if (vectorizeList.includes(VECTORIZE_NAME)) {
  console.log("    既にあります");
} else {
  console.log("    作成します…");
  run(["vectorize", "create", VECTORIZE_NAME, "--dimensions=1024", "--metric=cosine"]);
  // メタデータインデックスはキャラクターごとの記憶の絞り込みに必須。
  // これが無いと検索が空振りし、「昔の話を思い出さない」状態になる。
  run(["vectorize", "create-metadata-index", VECTORIZE_NAME, "--property-name=characterId", "--type=string"], {
    allowFail: true,
  });
  console.log("    作成しました");
}

console.log(`
────────────────────────────────────────
準備ができました。次のコマンドでデプロイします:

  npm run deploy:staging

完了すると https://staging.waketama.com で開けるようになります
（DNSレコードと証明書はCloudflareが自動で用意します）。

検証環境は誰でも開ける状態になるため、合言葉をかけておくことを推奨します:

  npx wrangler secret put STAGING_PASSCODE --env staging
────────────────────────────────────────`);
