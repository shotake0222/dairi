# わけたま — Raspberry Pi Pico（MicroPython）で人格データを動かす最小の実装。
#
# tools/edge/rule_runtime.py と同じ考え方の、実機版。
# Pico には LLM は載らないが、載せる必要も無い。「人格 → 振る舞い」の翻訳は
# サーバ側（src/persona/avatarProfile.ts）で済んでいるので、
# ここは数百バイトの数値を読んで、LEDとサーボを動かすだけでよい。
#
# 置き方:
#   1. tools/edge/make_compact.mjs で persona.min.json を作る
#   2. persona.min.json と このファイル（main.py としても可）を Pico へコピー
#   3. リセット
#
# 配線:
#   - LED: GP15（+ 抵抗 330Ω）。オンボードLEDを使うなら "LED"
#   - サーボ: GP16（信号）。電源は別で取ること（USBから取るとリセットが掛かる）

import json
import time

from machine import Pin, PWM

PERSONA_PATH = "persona.min.json"

led = PWM(Pin(15))
led.freq(1000)
servo = PWM(Pin(16))
servo.freq(50)


def load_persona(path=PERSONA_PATH):
    f = open(path)
    try:
        d = json.load(f)
    finally:
        f.close()
    if d.get("v") != 1:
        raise ValueError("未対応の形式です")
    m, p, e, t = d["m"], d["p"], d["e"], d["t"]
    return {
        "name": d.get("n", ""),
        "energy": m[0],
        "gesture": m[1],
        "idle": m[2],
        "delay_ms": m[3],
        "gaze_ms": m[4],
        "posture": m[5],
        "distance_m": p[0],
        "approach": p[1],
        "smile": e[0],
        "blink": e[1],
        "caution": t[3],
        "codes": d.get("c", []),
    }


def set_led(percent):
    led.duty_u16(int(max(0, min(100, percent)) * 65535 / 100))


def set_angle(deg):
    # SG90 系: 0.5ms〜2.4ms を 0〜180度に割り当てる
    deg = max(0, min(180, deg))
    us = 500 + (deg * (2400 - 500) // 180)
    servo.duty_u16(int(us * 65535 // 20000))


def greet(p):
    """話しかけられたときの反応。間の取り方と身振りの量に人格が出る。"""
    time.sleep_ms(p["delay_ms"])
    for _ in range(p["gesture"] // 25):
        set_angle(120)
        time.sleep_ms(180)
        set_angle(60)
        time.sleep_ms(180)
    set_angle(90)
    set_led(100)
    time.sleep_ms(p["gaze_ms"])
    set_led(p["smile"])


def idle(p):
    """待機。揺らぎが小さい子はほとんど動かない（それも人格）。"""
    amplitude = p["idle"] * 12 // 100
    period = 4000 - p["energy"] * 20
    center = 90 - (50 - p["posture"]) // 4
    set_led(p["smile"])
    set_angle(center + amplitude)
    time.sleep_ms(period // 2)
    set_angle(center - amplitude)
    time.sleep_ms(period // 2)


def main():
    p = load_persona()
    print("人格:", p["name"], "/ 方針:", ",".join(p["codes"]))
    greet(p)
    while True:
        idle(p)


if __name__ == "__main__":
    main()
