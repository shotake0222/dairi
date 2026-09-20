#!/usr/bin/env python3
"""
わけたま検証機 — 実機を触る前の自己点検。

**何を守るためのものか。**
同じ「人格 → 動き」の規則が、5つの場所に書かれている:

    tools/device/common/wt_core.py              Pico / Pi（本体）
    tools/device/esp32/wt_device/wt_core.h      ESP32（C++への写し）
    tools/device/web/wt_core.mjs                ブラウザ／メタバースのアバター（JSへの写し）
    tools/edge/rule_runtime.py                  PC上の最小の参照実装
    tools/device/common/wt_compact.py           人格カード→最小形（compact.mjs の写し）

写しが1つでもずれると、**機種によって性格が変わる**。そうなると検証そのものが無意味になり、
しかも現場では「ESP32だけ挙動が違う」という形でしか現れないので、原因に辿り着けない。
だから人の目で見比べるのをやめて、ここで機械に比べさせる。

    python3 tools/device/selftest.py
    npm run device:selftest

g++ が無い環境では C++ の比較だけ飛ばす（飛ばしたことは必ず表示する）。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "common"))
sys.path.insert(0, os.path.join(ROOT, "tools", "edge"))

import wt_compact  # noqa: E402
import wt_core  # noqa: E402

EVENTS = [("idle", None), ("approach", 2.0), ("greet", None), ("change", None), ("silence", 30.0)]
SHARED_EVENTS = [("idle", None), ("approach", 2.0), ("greet", None), ("change", None)]

# 性格が逆の2体。実物の fixtures（npm run persona:fixtures）と同じ形で、
# 値だけ手で置いたもの。ここは「差が出るはず」の側の代表として使う。
BOLD = {
    "v": 1, "id": "5b0a7533", "n": "さきがけ",
    "m": [77, 73, 85, 458, 1212, 65], "p": [1.3, 0.7], "e": [65, 17],
    "t": [55, 88, 74, 26, 84, 66],
    "c": ["prefer_novel_options", "take_initiative", "prioritize_enjoyment", "tolerate_open_plans"],
}
CAREFUL = {
    "v": 1, "id": "9c41ba02", "n": "ひだまり",
    "m": [41, 34, 30, 890, 1444, 44], "p": [1.4, 0.3], "e": [51, 12],
    "t": [82, 44, 39, 71, 33, 41],
    "c": ["confirm_before_change", "prefer_familiar_options", "notice_others_first", "follow_the_lead"],
}

CARD = {
    "identity": {"id": "5b0a7533-aaaa-bbbb", "name": "さきがけ"},
    "personality": {"warmth": 55, "curiosity": 88, "cheerfulness": 74,
                    "caution": 26, "independence": 84, "humor": 66},
    "notes": ["犬を飼っている", "夜勤のある仕事をしている"],
    "memories": [{"text": "先週、引っ越しの相談をした"}],
    "examples": [{"user": "今日はつかれた", "assistant": "おつかれさま。無理しないでね"}],
    "owner": {"attributes": {"ageBand": "30代"}},
    "runtime": {
        "systemPrompt": "あなたは さきがけ です",
        "avatar": {
            "motion": {"energy": 77.4, "gestureRate": 72.5, "idleVariance": 85.2,
                       "responseDelayMs": 458.4, "gazeHoldMs": 1211.6, "postureOpenness": 64.5},
            "proxemics": {"comfortableDistanceM": 1.298, "approachSpeedMps": 0.7},
            "expression": {"baselineSmile": 65.4, "blinkRatePerMin": 16.6},
            "policy": [{"code": "prefer_novel_options"}, {"code": "take_initiative"},
                       {"code": "prioritize_enjoyment"}, {"code": "tolerate_open_plans"}],
        },
    },
}

PASS, FAIL, SKIP = [], [], []


def ok(name, detail=""):
    PASS.append(name)
    print("  [ok]   %s %s" % (name, detail))


def ng(name, detail=""):
    FAIL.append(name)
    print("  [NG]   %s %s" % (name, detail))


def skip(name, why):
    SKIP.append(name)
    print("  [skip] %s（%s）" % (name, why))


# --- 1. contract.json と実装の並びが合っているか ------------------------------


def check_contract():
    print("1. 並びの取り決め（contract.json）")
    with open(os.path.join(HERE, "contract.json"), encoding="utf-8") as f:
        contract = json.load(f)

    if contract["version"] != wt_core.CONTRACT_VERSION:
        return ng("版が一致", "contract=%s core=%s" % (contract["version"], wt_core.CONTRACT_VERSION))
    ok("版が一致", "v=%d" % contract["version"])

    traits = [x["key"] for x in contract["arrays"]["t"]["fields"]]
    if tuple(traits) != wt_compact.TRAIT_ORDER:
        return ng("性格6軸の並び", "%s vs %s" % (traits, list(wt_compact.TRAIT_ORDER)))
    ok("性格6軸の並び")

    for key, data in (("m", BOLD["m"]), ("p", BOLD["p"]), ("e", BOLD["e"]), ("t", BOLD["t"])):
        want = len(contract["arrays"][key]["fields"])
        if len(data) != want:
            return ng("%s の長さ" % key, "%d != %d" % (len(data), want))
    ok("配列の長さ")

    events = [x["e"] for x in contract["events"]]
    if sorted(events) != sorted(wt_core.EVENTS):
        return ng("イベントの一覧", "%s vs %s" % (events, list(wt_core.EVENTS)))
    ok("イベントの一覧", ", ".join(events))


# --- 2. wt_core.py と rule_runtime.py が同じ答えを出すか -----------------------


def collect_rule_runtime(data, event, arg):
    import io
    import contextlib

    import rule_runtime

    actions = []
    # rule_runtime は人が読む用に print もする。比べるのは動作だけなので画面には出さない
    sink = contextlib.redirect_stdout(io.StringIO())
    sink.__enter__()
    rule_runtime.out_servo = lambda n, v: actions.append(("servo", n, v))
    rule_runtime.out_led = lambda n, v: actions.append(("led", n, v))
    rule_runtime.out_wait = lambda ms: actions.append(("wait", "", int(ms)))
    try:
        p = rule_runtime.Persona(data)
        if event == "idle":
            rule_runtime.on_idle(p)
        elif event == "approach":
            rule_runtime.on_approach(p, arg)
        elif event == "greet":
            rule_runtime.on_greet(p)
        elif event == "change":
            rule_runtime.on_change(p)
    finally:
        sink.__exit__(None, None, None)
    return actions


def check_rule_runtime():
    print("2. wt_core.py ↔ tools/edge/rule_runtime.py")
    bad = 0
    for data in (BOLD, CAREFUL):
        p = wt_core.Persona(data)
        for event, arg in SHARED_EVENTS:
            mine = wt_core.plan(p, event, arg).actions
            theirs = collect_rule_runtime(data, event, arg)
            if mine != theirs:
                bad += 1
                ng("%s / %s" % (data["n"], event), "\n         core : %s\n         rule : %s" % (mine, theirs))
    if not bad:
        ok("4イベント×2体すべて一致")


# --- 3. wt_core.py と wt_core.h（C++）が同じ答えを出すか -----------------------


def check_cpp(tmp):
    print("3. wt_core.py ↔ esp32/wt_device/wt_core.h（C++）")
    if not shutil.which("g++"):
        return skip("C++との突き合わせ", "g++ がありません")
    binary = os.path.join(tmp, "wt_hostcheck")
    build = subprocess.run(["g++", "-std=c++11", "-O0", "-Wall", "-o", binary,
                            os.path.join(HERE, "hostcheck.cpp")],
                           capture_output=True, text=True)
    if build.returncode != 0:
        return ng("C++のビルド", build.stderr.strip().split("\n")[-1])
    ok("C++のビルド")

    bad = 0
    for data in (BOLD, CAREFUL):
        path = os.path.join(tmp, "%s.min.json" % data["id"])
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        p = wt_core.Persona(data)
        for event, arg in EVENTS:
            cmd = [binary, path, event] + ([str(arg)] if arg is not None else [])
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                bad += 1
                ng("%s / %s" % (data["n"], event), res.stderr.strip())
                continue
            theirs = []
            for line in res.stdout.splitlines():
                kind, name, value = (line.split("\t") + ["", ""])[:3]
                theirs.append((kind, name, int(value) if kind == "wait" else value))
            mine = wt_core.plan(p, event, arg).actions
            if mine != theirs:
                bad += 1
                ng("%s / %s" % (data["n"], event), "\n         py  : %s\n         cpp : %s" % (mine, theirs))
    if not bad:
        ok("5イベント×2体すべて一致")


# --- 4. wt_core.py と web/wt_core.mjs（JS・メタバースのアバター）が同じ答えを出すか ---


def check_web(tmp):
    print("4. wt_core.py ↔ web/wt_core.mjs（JS・メタバースのアバター）")
    if not shutil.which("node"):
        return skip("JSとの突き合わせ", "node がありません")

    webcheck = os.path.join(HERE, "webcheck.mjs")
    bad = 0
    for data in (BOLD, CAREFUL):
        path = os.path.join(tmp, "%s.min.json" % data["id"])
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
        p = wt_core.Persona(data)
        for event, arg in EVENTS:
            cmd = ["node", webcheck, path, event] + ([str(arg)] if arg is not None else [])
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                bad += 1
                ng("%s / %s" % (data["n"], event), res.stderr.strip().split("\n")[-1])
                continue
            theirs = []
            for line in res.stdout.splitlines():
                kind, name, value = (line.split("\t") + ["", ""])[:3]
                theirs.append((kind, name, int(value) if kind == "wait" else value))
            mine = wt_core.plan(p, event, arg).actions
            if mine != theirs:
                bad += 1
                ng("%s / %s" % (data["n"], event), "\n         py : %s\n         js : %s" % (mine, theirs))
    if not bad:
        ok("5イベント×2体すべて一致")

    # compare() も同じ答えか（判定パネルが表示に使う関数そのもの）
    a_path = os.path.join(tmp, "%s.min.json" % BOLD["id"])
    b_path = os.path.join(tmp, "%s.min.json" % CAREFUL["id"])
    res = subprocess.run(["node", webcheck, "compare", a_path, b_path], capture_output=True, text=True)
    if res.returncode != 0:
        return ng("compare() の実行", res.stderr.strip().split("\n")[-1])
    js_result = json.loads(res.stdout)
    py_result = wt_core.compare(wt_core.Persona(BOLD), wt_core.Persona(CAREFUL))
    js_checks = [(c[0], c[1]) for c in js_result["checks"]]
    py_checks = [(c[0], c[1]) for c in py_result["checks"]]
    if js_checks != py_checks or js_result["pass"] != py_result["pass"]:
        return ng("compare() の判定が一致", "\n         py : %s\n         js : %s" % (py_checks, js_checks))
    ok("compare() の判定が一致", "5項目とも同じ真偽値")


# --- 5. wt_compact.py と tools/edge/compact.mjs が同じ形を出すか ---------------


def check_compact(tmp):
    print("5. wt_compact.py ↔ tools/edge/compact.mjs")
    mine = wt_compact.to_json(wt_compact.to_compact(CARD))
    report = wt_compact.audit(wt_compact.to_compact(CARD), CARD)
    if not report["ok"]:
        ng("漏れの検査", "会話や覚え書きが混ざっています: %s" % report["leaks"])
    else:
        ok("漏れの検査", "%d バイト" % report["bytes"])

    if not shutil.which("node"):
        return skip("compact.mjs との突き合わせ", "node がありません")

    card_path = os.path.join(tmp, "card.json")
    with open(card_path, "w", encoding="utf-8") as f:
        json.dump(CARD, f, ensure_ascii=False)
    script = (
        "import {toCompactJson} from '%s';"
        "import {readFileSync} from 'node:fs';"
        "process.stdout.write(toCompactJson(JSON.parse(readFileSync('%s','utf8'))));"
        % (os.path.join(ROOT, "tools", "edge", "compact.mjs").replace("\\", "/"), card_path.replace("\\", "/"))
    )
    js = os.path.join(tmp, "run.mjs")
    with open(js, "w", encoding="utf-8") as f:
        f.write(script)
    res = subprocess.run(["node", js], capture_output=True, text=True, cwd=ROOT)
    if res.returncode != 0:
        return ng("compact.mjs の実行", res.stderr.strip().split("\n")[-1])
    if res.stdout != mine:
        return ng("1バイトまで一致", "\n         py : %s\n         js : %s" % (mine, res.stdout))
    ok("1バイトまで一致", "%d バイト" % len(mine.encode("utf-8")))


# --- 6. 検証機として成立しているか（合格基準） ---------------------------------


def check_acceptance():
    print("6. 2体の差（docs/EDGE_DEVICE_TEST.md §3 の合格基準）")
    result = wt_core.compare(wt_core.Persona(BOLD), wt_core.Persona(CAREFUL))
    for name, good, detail in result["checks"]:
        (ok if good else ng)(name, detail)
    if result["pass"]:
        ok("総合判定", "%s と %s で差が出ています" % (result["a"], result["b"]))
    else:
        ng("総合判定", "この2体では検証にならない")


# --- 7. ピン割り当てに無理が無いか ---------------------------------------------


def check_pinmap():
    print("7. ピン割り当て（pinmap.json）")
    with open(os.path.join(HERE, "pinmap.json"), encoding="utf-8") as f:
        pinmap = json.load(f)
    roles = [r["role"] for r in pinmap["roles"]]
    bad = 0
    for key, board in pinmap["boards"].items():
        pins = board["pins"]
        missing = [r for r in roles if r not in pins]
        if missing:
            bad += 1
            ng("%s に割り当てが無い役割" % key, ", ".join(missing))
        used = [v for v in pins.values() if isinstance(v, int)]
        if len(used) != len(set(used)):
            bad += 1
            ng("%s でピンの重複" % key, str(sorted(used)))
    # ESP32 の危ないピンを使っていないか（ここを踏むと書き込みできなくなる）
    esp = pinmap["boards"]["esp32"]["pins"]
    danger = {0, 2, 5, 12, 15}
    hit = [k for k, v in esp.items() if isinstance(v, int) and v in danger and k != "LED_ALIVE"]
    if hit:
        bad += 1
        ng("ESP32 の起動時に見られるピンを使っている", ", ".join(hit))
    flash = [k for k, v in esp.items() if isinstance(v, int) and 6 <= v <= 11]
    if flash:
        bad += 1
        ng("ESP32 の内蔵フラッシュ用ピンを使っている", ", ".join(flash))
    inputs_only = [k for k, v in esp.items() if isinstance(v, int) and v >= 34 and k != "SONAR_ECHO"]
    if inputs_only:
        bad += 1
        ng("ESP32 の入力専用ピンを出力に使っている", ", ".join(inputs_only))
    if not bad:
        ok("3機種とも、役割がそろっていて重複も禁止ピンも無い")


# --- 生成物が最新か -----------------------------------------------------------


def check_generated():
    print("8. 生成物（配線図・ピン定数）が pinmap.json と合っているか")
    gen = os.path.join(HERE, "make_device_docs.py")
    before = {}
    targets = [
        os.path.join(HERE, "pico", "wt_pins.py"),
        os.path.join(HERE, "esp32", "wt_device", "wt_pins.h"),
        os.path.join(ROOT, "docs", "device", "wt1_pico_wiring.svg"),
    ]
    for path in targets:
        before[path] = open(path, encoding="utf-8").read() if os.path.exists(path) else None
    res = subprocess.run([sys.executable, gen], capture_output=True, text=True)
    if res.returncode != 0:
        return ng("生成の実行", res.stderr.strip().split("\n")[-1])
    stale = [os.path.relpath(p, ROOT) for p in targets
             if before[p] != open(p, encoding="utf-8").read()]
    if stale:
        return ng("生成物が古い", "作り直しました: %s（コミットに含めてください）" % ", ".join(stale))
    ok("生成物は最新")


def main():
    print("わけたま検証機 — 自己点検\n")
    tmp = tempfile.mkdtemp(prefix="wt-selftest-")
    try:
        check_contract()
        check_rule_runtime()
        check_cpp(tmp)
        check_web(tmp)
        check_compact(tmp)
        check_acceptance()
        check_pinmap()
        check_generated()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("\n合格 %d / 不合格 %d / 飛ばした %d" % (len(PASS), len(FAIL), len(SKIP)))
    if SKIP:
        print("飛ばしたもの: %s" % ", ".join(SKIP))
    if FAIL:
        print("\n直すまで実機に持っていかないこと。機種によって性格が変わります。")
        return 1
    print("実機に持っていって大丈夫です。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
