#!/usr/bin/env python3
"""
わけたま — エッジ機器用の参照実装（LLMなし）。

**これは何を確かめるためのものか。**
「集めた人格データで、本当にロボットやアバターが動くのか」を、
LLMを一切使わずに確かめるための最小の実装。
言語モデルを積めない機器（ESP32 / Raspberry Pi Pico / Pi Zero）でも
**人格の違いが振る舞いの違いとして出る**なら、この主張は本物と言える。
逆にここで差が出ないなら、集めているデータは飾りだということになる。

入力は tools/edge/compact.mjs が作る数百バイトのJSONだけ。
会話も覚え書きも属性も入っていないので、そのまま機器に焼ける。

MicroPython でも動くよう、標準ライブラリの json / time / random しか使っていない
（f文字列とdataclassは使わない。Pico向けにそのまま持っていけるようにするため）。

使い方:
    python3 tools/edge/rule_runtime.py persona.min.json
    python3 tools/edge/rule_runtime.py persona.min.json --events approach,greet,idle,change
    python3 tools/edge/rule_runtime.py a.min.json b.min.json --diff   # 2体を並べて比べる
"""

import json
import sys

# --- 機器側で用意する出力の口 ------------------------------------------------
# 実機ではこの3つを差し替える。Pi ならGPIO、ESP32ならLEDC/サーボ、
# メタバースなら Animator のパラメータ。ここを差し替えるだけで同じ人格が動く。


def out_servo(name, value):
    print("  servo  %-10s %s" % (name, value))


def out_led(name, value):
    print("  led    %-10s %s" % (name, value))


def out_wait(ms):
    print("  wait   %dms" % ms)


# --- 人格 → 振る舞い ----------------------------------------------------------


class Persona(object):
    """compact.mjs の出力を、意味のある名前で読めるようにしただけのもの。"""

    def __init__(self, data):
        if data.get("v") != 1:
            raise ValueError("未対応の形式です: v=%s" % data.get("v"))
        self.name = data.get("n", "")
        self.id = data.get("id", "")
        m = data["m"]
        self.energy, self.gesture_rate, self.idle_variance = m[0], m[1], m[2]
        self.response_delay_ms, self.gaze_hold_ms, self.posture = m[3], m[4], m[5]
        self.distance_m, self.approach_mps = data["p"][0], data["p"][1]
        self.smile, self.blink_per_min = data["e"][0], data["e"][1]
        t = data["t"]
        self.warmth, self.curiosity, self.cheerfulness = t[0], t[1], t[2]
        self.caution, self.independence, self.humor = t[3], t[4], t[5]
        self.policies = data.get("c", [])

    def has(self, code):
        return code in self.policies


def on_idle(p):
    """待機。ここが一番「その子らしさ」が出る。置物にしないこと。"""
    print("[idle]")
    # 揺らぎが小さい子は、ほとんど動かない。大きい子は絶えず小さく動く
    amplitude = round(p.idle_variance / 100.0 * 12, 1)
    period_ms = int(4000 - p.energy * 20)
    out_servo("body_sway", "±%s deg / %dms" % (amplitude, period_ms))
    out_led("cheek", "%d%%" % p.smile)
    out_wait(int(60000 / max(1, p.blink_per_min)))


def on_approach(p, distance_m):
    """人が近づいてきた。踏み込むか、待つか。"""
    print("[approach] 相手との距離 %.1fm" % distance_m)
    if distance_m > p.distance_m:
        # まだ遠い。自分から寄るかどうかは自立心と慎重さで変わる
        forward = (p.independence >= 55 or p.has("prefer_novel_options")) and not p.has("confirm_before_change")
        if forward:
            step = round(min(p.approach_mps, distance_m - p.distance_m), 2)
            out_servo("drive", "forward %sm/s" % step)
        else:
            out_servo("head", "tilt toward")
            print("  （自分からは寄らない）")
    else:
        # 心地よい距離より近い。慎重な子は下がる
        if p.caution >= 60:
            out_servo("drive", "back %.2fm" % round(p.distance_m - distance_m, 2))
        else:
            out_servo("head", "face")


def on_greet(p):
    """話しかけられた。間の取り方と身振りの量に差が出る。"""
    print("[greet]")
    out_wait(p.response_delay_ms)
    gestures = max(0, int(p.gesture_rate / 25))
    for i in range(gestures):
        out_servo("arm", "wave %d/%d" % (i + 1, gestures))
    out_servo("gaze", "hold %dms" % p.gaze_hold_ms)
    out_led("mouth", "smile %d%%" % min(100, p.smile + p.cheerfulness // 4))
    if p.has("keep_light_and_playful"):
        out_servo("body", "bounce")


def on_change(p):
    """予定の変更を持ちかけられた。方針（policy）がそのまま分岐になる。"""
    print("[change] 予定を変えようと言われた")
    if p.has("confirm_before_change"):
        out_servo("head", "shake slight")
        print("  → まず確かめる（confirm_before_change）")
    elif p.has("prefer_novel_options"):
        out_servo("head", "nod fast")
        print("  → 乗る（prefer_novel_options）")
    else:
        out_servo("head", "nod")
        print("  → ふつうに受ける")


EVENTS = {
    "idle": lambda p: on_idle(p),
    "approach": lambda p: on_approach(p, 2.0),
    "greet": lambda p: on_greet(p),
    "change": lambda p: on_change(p),
}


def run(persona, events):
    print("=== %s (%s) ===" % (persona.name or "(名前なし)", persona.id))
    print("方針: %s" % (", ".join(persona.policies) or "（なし）"))
    for name in events:
        handler = EVENTS.get(name)
        if not handler:
            print("不明なイベント: %s" % name)
            continue
        handler(persona)
    print("")


def load(path):
    f = open(path)
    try:
        return Persona(json.load(f))
    finally:
        f.close()


def main(argv):
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return 1

    events = ["idle", "approach", "greet", "change"]
    for a in argv:
        if a.startswith("--events="):
            events = a.split("=", 1)[1].split(",")

    for path in paths:
        run(load(path), events)

    if "--diff" in argv and len(paths) == 2:
        a, b = load(paths[0]), load(paths[1])
        print("=== 差 ===")
        for label, x, y in [
            ("動きの大きさ", a.energy, b.energy),
            ("身振りの頻度", a.gesture_rate, b.gesture_rate),
            ("返すまでの間(ms)", a.response_delay_ms, b.response_delay_ms),
            ("心地よい距離(m)", a.distance_m, b.distance_m),
            ("待機の揺らぎ", a.idle_variance, b.idle_variance),
        ]:
            print("  %-16s %s vs %s%s" % (label, x, y, "  ← 同じ" if x == y else ""))
        only_a = [c for c in a.policies if c not in b.policies]
        only_b = [c for c in b.policies if c not in a.policies]
        print("  片方だけの方針  A:%s  B:%s" % (only_a or "-", only_b or "-"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
