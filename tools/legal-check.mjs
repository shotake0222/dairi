/**
 * 利用規約とプライバシーポリシーに、**埋め忘れの空欄**が残っていないかを見る。
 *
 * なぜ要るか: 事業者名・連絡先・管轄裁判所は、こちらでは決められない。
 * 決められないものは放っておくと残る。残ったまま公開されるのが一番まずいので、
 * 「残っている／残っていない」を機械が言えるようにしておく。
 *
 *   npm run legal:check
 *
 * 空欄が残っているあいだは、両ページの冒頭に「下書きです」の但し書きが**出ていること**を、
 * 逆に全部埋まったら**消えていること**を確認する（片方だけ直すと食い違うため）。
 * 終了コードは、空欄が残っていても 0。これは進捗の報告であって、失敗ではない。
 * 食い違っているときだけ 1 で落ちる。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 埋めるべき箇所の印。本文中の全角ブラケットで統一してある。 */
export const BLANK = /［[^］]*］/g;
/** 空欄が残っているあいだ出しておく但し書き（class="draft" の節） */
export const DRAFT_NOTE = "この文書は下書きです";

const PAGES = [
  ["利用規約", "public/terms.html"],
  ["プライバシーポリシー", "public/privacy.html"],
];

let mismatched = false;
let total = 0;

for (const [label, rel] of PAGES) {
  const html = readFileSync(path.join(ROOT, rel), "utf8");
  const blanks = [...new Set(html.match(BLANK) || [])];
  const hasNote = html.includes(DRAFT_NOTE);
  total += blanks.length;

  console.log(`\n${label}（${rel}）`);
  if (blanks.length === 0) {
    console.log("  空欄なし");
  } else {
    console.log(`  埋める箇所 ${blanks.length}種類:`);
    for (const b of blanks) console.log(`    ${b}`);
  }

  if (blanks.length > 0 && !hasNote) {
    console.error("  ⚠ 空欄が残っているのに「下書きです」の但し書きが無い");
    mismatched = true;
  }
  if (blanks.length === 0 && hasNote) {
    console.error("  ⚠ 全部埋まっているのに「下書きです」の但し書きが残っている。消すこと");
    mismatched = true;
  }
}

console.log("");
if (total > 0) {
  console.log(`公開前に埋める箇所が ${total}種類 残っています。`);
  console.log("いずれも当方でしか決められないもの（事業者名・連絡先・管轄裁判所）です。");
  console.log("埋めたら、両ページ冒頭の「下書きです」の節も一緒に消してください。");
} else {
  console.log("空欄はありません。弁護士等の確認が済んでいれば、公開できる状態です。");
}

process.exit(mismatched ? 1 : 0);
