#!/usr/bin/env node
/**
 * わけたま検証機 — JS版エンジン（web/wt_core.mjs）を Node で動かして、
 * Python版・C++版と突き合わせるための道具。
 *
 * これ自体はブラウザに持っていかない。**写し間違いを見つけるためだけ**に存在する
 * （tools/device/hostcheck.cpp の JS 版に相当）。
 *
 * 使い方:
 *   node tools/device/webcheck.mjs persona.min.json greet [arg]
 *     → 手順を1行1動作で出す（kind\tname\tvalue）。tools/device/selftest.py が読む
 *
 *   node tools/device/webcheck.mjs compare a.min.json b.min.json
 *     → compare() の結果をJSONで出す（selftest.py が Python版の compare() と突き合わせる）
 */

import { readFileSync } from "node:fs";
import { Collector, Persona, compare, dispatch } from "./web/wt_core.mjs";

async function runEvent(personaPath, event, arg) {
  const data = JSON.parse(readFileSync(personaPath, "utf8"));
  const persona = new Persona(data);
  const collector = new Collector();
  const ok = await dispatch(persona, collector, event, arg);
  if (!ok) {
    process.stderr.write(`知らないイベント: ${event}\n`);
    process.exit(3);
  }
  for (const [kind, name, value] of collector.actions) {
    process.stdout.write(`${kind}\t${name}\t${value}\n`);
  }
}

async function runCompare(pathA, pathB) {
  const a = new Persona(JSON.parse(readFileSync(pathA, "utf8")));
  const b = new Persona(JSON.parse(readFileSync(pathB, "utf8")));
  const result = await compare(a, b);
  process.stdout.write(JSON.stringify(result));
}

async function main(argv) {
  if (argv[0] === "compare") {
    if (argv.length < 3) {
      process.stderr.write("usage: webcheck.mjs compare a.min.json b.min.json\n");
      return 1;
    }
    await runCompare(argv[1], argv[2]);
    return 0;
  }
  if (argv.length < 2) {
    process.stderr.write("usage: webcheck.mjs persona.min.json <event> [arg]\n");
    return 1;
  }
  await runEvent(argv[0], argv[1], argv[2]);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exit(2);
  });
