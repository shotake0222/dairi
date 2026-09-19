#!/usr/bin/env node
/**
 * 人格カード → 機器用の最小形（persona.min.json）を作る。
 *
 * 人格カードそのものは会話の抜粋や覚え書きを含むので、機器には焼かない。
 * ここで数値と識別子だけに落とし、**中身が漏れていないことを機械的に確かめてから**書き出す。
 *
 * 使い方:
 *   # 手元に落としたカードから
 *   node tools/edge/make_compact.mjs card.json -o persona.min.json
 *
 *   # サービスから直接（cid と 持ち主トークンが要る。トークンは端末のlocalStorageにある）
 *   node tools/edge/make_compact.mjs --url https://app.waketama.com --cid <cid> --token <token> -o persona.min.json
 *
 * 出力の最後に、バイト数と「会話の断片が混ざっていないか」の結果を出す。
 */

import { readFile, writeFile } from "node:fs/promises";
import { auditCompact, toCompact } from "./compact.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function loadCard() {
  const base = arg("--url");
  if (base) {
    const cid = arg("--cid");
    const token = arg("--token", "");
    if (!cid) throw new Error("--url を使うときは --cid も指定してください");
    const url = `${base.replace(/\/$/, "")}/api/character/card?format=json&cid=${encodeURIComponent(cid)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`人格カードを取得できませんでした (${res.status})`);
    return res.json();
  }

  const path = process.argv.slice(2).find((a) => !a.startsWith("-") && a.endsWith(".json"));
  if (!path) throw new Error("カードのJSONファイルか、--url を指定してください");
  return JSON.parse(await readFile(path, "utf8"));
}

const card = await loadCard();
const compact = toCompact(card);
const audit = auditCompact(compact, card);

const out = arg("-o", "persona.min.json");
await writeFile(out, JSON.stringify(compact));

console.log(`${out} を書き出しました（${audit.bytes} バイト）`);
console.log(`  名前: ${compact.n || "(なし)"}  方針: ${compact.c.join(", ") || "(なし)"}`);
if (audit.ok) {
  console.log("  会話・覚え書き・属性は含まれていません（機器へ焼いて問題ありません）");
} else {
  console.error("  ⚠ 会話の断片が混ざっています。焼かないでください:");
  for (const leak of audit.leaks) console.error(`    - ${leak}`);
  process.exitCode = 1;
}
