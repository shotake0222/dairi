#!/usr/bin/env python3
"""
わけたま検証機 WT-3「こだち」 — Raspberry Pi（Zero 2 W / 4）で動かすノード。

Pico・ESP32 とまったく同じ振る舞いエンジン（tools/device/common/wt_core.py）を、
Pi の GPIO に繋いだもの。**機種が変わっても人格の解釈は変わらない**ことを、
同じイベントを流して同じ手順が出ることで確かめる。

Pi を使う利点は2つだけ:
  - 記録が取りやすい（そのまま CSV に落とせる）
  - 段階B（ローカルLLMで喋る）を同じ箱の中でやれる（Pi 4 以上）

使い方:
    # 実機で動かす（gpiozero が要る）
    python3 wt_node.py --persona persona.min.json

    # 機材が無いところで手順だけ見る（GPIOを触らない）
    python3 wt_node.py --persona persona.min.json --dry --events greet,silence

    # 母艦から操る（標準入出力が WTP/1 になる。USBシリアル相当）
    python3 wt_node.py --persona persona.min.json --serve

配線は docs/device/wt3_pi_wiring.svg。ピン番号は pinmap.json が出所で、
このファイルには書かれていない（図と現物がずれるのを防ぐため）。

サーボがガタつくときは pigpio を使うこと:
    sudo apt install -y pigpio python3-pigpio && sudo systemctl enable --now pigpiod
    GPIOZERO_PIN_FACTORY=pigpio python3 wt_node.py ...
"""

import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "common"))

import wt_core  # noqa: E402
import wt_proto  # noqa: E402
from wt_actuate import RigDriver  # noqa: E402

FW = "wt-pi/1.0"
PINMAP = os.path.join(HERE, "..", "pinmap.json")


def load_pins():
    with open(PINMAP, encoding="utf-8") as f:
        return json.load(f)["boards"]["pi"]["pins"]


class DryHardware(object):
    """機材が無いときの口。角度と明るさを人が読める形で出すだけ。

    **待ち時間は本当に待つ。** ここを素通りさせると、母艦が測る「返すまでの間」が
    全部 0ms になり、記録として使えないものが残る。遅い子は本当に遅く出る方がよい。
    """

    def __init__(self, out=sys.stdout):
        self.out = out
        self.moves = 0

    def servo(self, slot, deg):
        self.moves += 1
        self.out.write("    servo %-5s %3d deg\n" % (slot, deg))

    def led(self, slot, percent):
        self.out.write("    led   %-5s %3d %%\n" % (slot, percent))

    def sleep_ms(self, ms):
        self.out.write("    wait  %dms\n" % ms)
        time.sleep(max(0, int(ms)) / 1000.0)

    def beep(self, hz, ms):
        self.out.write("    beep  %dHz %dms\n" % (hz, ms))

    def pressed(self):
        return False

    def distance_m(self):
        return None

    def close(self):
        pass


class PiHardware(object):
    """gpiozero 版。ここが「新しい機器へ載せるときに書く3つ」の実物。"""

    def __init__(self, pins):
        from gpiozero import Button, DistanceSensor, PWMLED, AngularServo

        self.servos = {
            "body": AngularServo(pins["SERVO_BODY"], min_angle=0, max_angle=180,
                                 min_pulse_width=0.0005, max_pulse_width=0.0024),
            "arm": AngularServo(pins["SERVO_ARM"], min_angle=0, max_angle=180,
                                min_pulse_width=0.0005, max_pulse_width=0.0024),
        }
        self.leds = {
            "mouth": PWMLED(pins["LED_MOUTH"]),
            "eye": PWMLED(pins["LED_EYE"]),
        }
        self.button = Button(pins["BTN_TALK"], pull_up=True, bounce_time=0.05)
        try:
            self.sonar = DistanceSensor(echo=pins["SONAR_ECHO"], trigger=pins["SONAR_TRIG"],
                                        max_distance=4.0, queue_len=3)
        except Exception:  # 測距は無くても検証は成立する
            self.sonar = None
        self.buzzer = None
        try:
            from gpiozero import TonalBuzzer
            self.buzzer = TonalBuzzer(pins["BUZZER"])
        except Exception:
            pass

    def servo(self, slot, deg):
        self.servos[slot].angle = max(0, min(180, int(deg)))

    def led(self, slot, percent):
        self.leds[slot].value = max(0, min(100, int(percent))) / 100.0

    def sleep_ms(self, ms):
        time.sleep(max(0, int(ms)) / 1000.0)

    def beep(self, hz, ms):
        if not self.buzzer:
            return
        self.buzzer.play(hz)
        time.sleep(ms / 1000.0)
        self.buzzer.stop()

    def pressed(self):
        return self.button.is_pressed

    def distance_m(self):
        return self.sonar.distance * 4.0 if self.sonar else None

    def close(self):
        for s in self.servos.values():
            s.detach()
        for led in self.leds.values():
            led.off()


class Node(object):
    def __init__(self, hw, emit=None):
        self.hw = hw
        self.t0 = time.time()
        self.emit = emit
        self.driver = RigDriver(hw, emit=emit, clock=self.uptime_ms)
        self.persona = None
        self.auto = True
        self.last_touch = time.time()
        self.silenced = False
        self.last_approach = 0.0
        self.prev_dist = None

    def uptime_ms(self):
        return int((time.time() - self.t0) * 1000)

    def send(self, obj):
        if self.emit:
            self.emit(obj)

    def set_persona(self, data):
        try:
            p = wt_core.Persona(data)
        except Exception as exc:
            self.send(wt_proto.err("人格を読めません: %s" % exc))
            return False
        self.persona = p
        self.driver.bind(p)
        self.send(wt_proto.ok(p.id, len(json.dumps(data, ensure_ascii=False))))
        return True

    def fire(self, event, arg=None):
        if not self.persona:
            self.send(wt_proto.err("人格が入っていません"))
            return
        start = self.uptime_ms()
        first = {"ms": None}
        original = self.driver.emit

        def emit(obj):
            if first["ms"] is None and obj.get("o") in ("servo", "led"):
                first["ms"] = self.uptime_ms() - start
            if original:
                original(obj)

        self.driver.emit = emit
        try:
            ok = wt_core.dispatch(self.persona, self.driver, event, arg)
        finally:
            self.driver.emit = original
        if not ok:
            self.send(wt_proto.err("知らないイベント: %s" % event))
            return
        self.send(wt_proto.metric(event, first["ms"] or 0, self.uptime_ms() - start))
        self.last_touch = time.time()
        self.silenced = False

    def handle(self, msg):
        t = msg.get("t")
        if t == wt_proto.T_PERSONA:
            self.set_persona(msg.get("d") or {})
        elif t == wt_proto.T_EVENT:
            self.fire(msg.get("e"), msg.get("dist", msg.get("sec")))
        elif t == wt_proto.T_PING:
            self.send(wt_proto.pong(FW, self.uptime_ms()))
        elif t == wt_proto.T_STOP:
            self.auto = False
            self.hw.servo("arm", 90)
            self.hw.servo("body", 90)
            self.hw.led("mouth", 0)
            self.hw.led("eye", 0)
            self.send(wt_proto.log("停止しました"))
        elif t == wt_proto.T_MODE:
            self.auto = bool(msg.get("auto", True))
        else:
            self.send(wt_proto.err("知らない種類です: %s" % t))

    def approach_is_news(self, d):
        moved = self.prev_dist is None or abs(d - self.prev_dist) > 0.3
        cooled = (time.time() - self.last_approach) > 5.0
        self.prev_dist = d
        if moved and cooled:
            self.last_approach = time.time()
            return True
        return False

    def loop_once(self):
        if self.hw.pressed():
            self.fire("greet")
        d = self.hw.distance_m()
        if d is not None and 0.05 < d < 4.0 and self.approach_is_news(d):
            self.fire("approach", d)
        idle_s = time.time() - self.last_touch
        if self.auto and not self.silenced and idle_s > 20:
            self.silenced = True
            self.fire("silence", idle_s)
        if self.auto and self.persona:
            wt_core.on_idle(self.persona, self.driver)


def stdout_emit(obj):
    sys.stdout.write(wt_proto.encode(obj))
    sys.stdout.flush()


def main(argv=None):
    ap = argparse.ArgumentParser(description="わけたま検証機ノード（Raspberry Pi）")
    ap.add_argument("--persona", required=True, help="最小形のJSON（wt_compact.py の出力）")
    ap.add_argument("--dry", action="store_true", help="GPIOを触らずに手順だけ出す")
    ap.add_argument("--serve", action="store_true", help="標準入出力を WTP/1 にして母艦から操られる")
    ap.add_argument("--events", default="", help="この順で1回だけ流して終わる（例 greet,approach）")
    args = ap.parse_args(argv)

    with open(args.persona, encoding="utf-8") as f:
        data = json.load(f)

    if args.dry:
        # --serve のときの標準出力は WTP/1 の通り道なので、人が読む行は混ぜない
        hw = DryHardware(out=sys.stderr if args.serve else sys.stdout)
    else:
        try:
            hw = PiHardware(load_pins())
        except Exception as exc:
            sys.stderr.write("GPIO を用意できませんでした（%s）。--dry で手順だけ確認できます\n" % exc)
            return 1

    node = Node(hw, emit=stdout_emit if args.serve else None)
    if not node.set_persona(data):
        return 2
    if not args.serve:
        print("人格: %s / 方針: %s" % (node.persona.name, ", ".join(node.persona.policies)))

    try:
        if args.events:
            for name in args.events.split(","):
                name = name.strip()
                if not name:
                    continue
                if not args.serve:
                    print("[%s]" % name)
                node.fire(name)
            return 0

        if args.serve:
            stdout_emit(wt_proto.log("%s 起動（%s）" % (FW, wt_proto.PROTO)))
            for line in sys.stdin:
                msg = wt_proto.decode(line)
                if msg:
                    node.handle(msg)
            return 0

        while True:
            node.loop_once()
    except KeyboardInterrupt:
        return 0
    finally:
        hw.close()


if __name__ == "__main__":
    sys.exit(main())
