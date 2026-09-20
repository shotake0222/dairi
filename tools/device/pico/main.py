# わけたま検証機 WT-1「たね」 — Raspberry Pi Pico 2 W 用ファーム（MicroPython）
#
# これが一番小さい構成。**LLM も Wi-Fi も使わない。**
# 520KB のマイコンで人格の差が動きの差として出るなら、
# 「人格データは言葉を介さずに身体を動かせる」という主張は本物と言える。
#
# 置くファイル（すべて Pico のルートへ）:
#     wt_core.py  wt_proto.py  wt_actuate.py  wt_pins.py  main.py  persona.min.json
#
#     mpremote cp tools/device/common/wt_core.py    :wt_core.py
#     mpremote cp tools/device/common/wt_proto.py   :wt_proto.py
#     mpremote cp tools/device/common/wt_actuate.py :wt_actuate.py
#     mpremote cp tools/device/pico/wt_pins.py      :wt_pins.py
#     mpremote cp tools/device/pico/main.py         :main.py
#     mpremote cp persona.min.json                  :persona.min.json
#     mpremote reset
#
# 配線は docs/DEVICE_BUILD.md §3 と docs/device/wt1_pico_wiring.svg。
# ピン番号は wt_pins.py（tools/device/pinmap.json から生成）にしか書かれていない。
#
# 人格の入れ替え: シリアル(115200)に最小形のJSONを1行貼る。
# 同じ配線・同じファームのまま、その場で別の子になる。これが見どころ。

import sys
import time

import uselect
from machine import PWM, Pin, time_pulse_us

import wt_core
import wt_pins
import wt_proto
from wt_actuate import RigDriver

FW = "wt-pico/1.0"
PERSONA_PATH = "persona.min.json"
IDLE_GAP_MS = 400          # 待機の一巡ごとに、この時間だけ入力を見る
SILENCE_AFTER_S = 20       # これだけ誰も触らなければ silence イベント
SONAR_EVERY_MS = 700       # 測距の間隔。毎周回すとサーボの電流と干渉する


# --- 機器の口（hw）。RigDriver が使うのはこの4つだけ -------------------------


class PicoHardware(object):
    def __init__(self):
        self.servos = {
            "body": self._pwm(wt_pins.SERVO_BODY, 50),
            "arm": self._pwm(wt_pins.SERVO_ARM, 50),
        }
        self.leds = {
            "mouth": self._pwm(wt_pins.LED_MOUTH, 1000),
            "eye": self._pwm(wt_pins.LED_EYE, 1000),
        }
        self.buzzer = self._pwm(wt_pins.BUZZER, 2000)
        self.buzzer.duty_u16(0)
        self.button = Pin(wt_pins.BTN_TALK, Pin.IN, Pin.PULL_UP)
        self.trig = Pin(wt_pins.SONAR_TRIG, Pin.OUT)
        self.echo = Pin(wt_pins.SONAR_ECHO, Pin.IN)
        self.trig.value(0)
        try:
            self.alive = Pin(wt_pins.LED_ALIVE, Pin.OUT)
        except (TypeError, ValueError):
            self.alive = None

    def _pwm(self, pin, freq):
        p = PWM(Pin(pin))
        p.freq(freq)
        return p

    def servo(self, slot, deg):
        # SG90: 0.5ms〜2.4ms を 0〜180度へ。20ms 周期なので分母は 20000
        deg = max(0, min(180, int(deg)))
        us = 500 + (deg * (2400 - 500) // 180)
        self.servos[slot].duty_u16(int(us * 65535 // 20000))

    def led(self, slot, percent):
        pct = max(0, min(100, int(percent)))
        self.leds[slot].duty_u16(int(pct * 65535 // 100))

    def sleep_ms(self, ms):
        time.sleep_ms(max(0, int(ms)))

    def beep(self, hz, ms):
        self.buzzer.freq(max(50, int(hz)))
        self.buzzer.duty_u16(8000)
        time.sleep_ms(int(ms))
        self.buzzer.duty_u16(0)

    def pressed(self):
        return self.button.value() == 0

    def distance_m(self):
        """HC-SR04。測れなければ None（配線が無くても検証は続けられる）。"""
        self.trig.value(0)
        time.sleep_us(2)
        self.trig.value(1)
        time.sleep_us(10)
        self.trig.value(0)
        try:
            us = time_pulse_us(self.echo, 1, 30000)
        except OSError:
            return None
        if us <= 0:
            return None
        return (us * 0.0343) / 2 / 100.0  # cm → m

    def heartbeat(self, on):
        if self.alive:
            self.alive.value(1 if on else 0)

    def safe(self):
        """止めるときは、腕を下ろして体を正面へ。焼けた匂いがしたらまずこれ。"""
        self.servo("arm", 90)
        self.servo("body", 90)
        self.led("mouth", 0)
        self.led("eye", 0)
        self.buzzer.duty_u16(0)


# --- シリアル（母艦 or 人が手で貼る） ------------------------------------------


class Line(object):
    def __init__(self):
        self.poll = uselect.poll()
        self.poll.register(sys.stdin, uselect.POLLIN)
        self.buf = ""

    def read(self, timeout_ms):
        """1行取れたら返す。取れなければ None。ここで止まらないこと。"""
        if not self.poll.poll(timeout_ms):
            return None
        ch = sys.stdin.read(1)
        while ch:
            if ch == "\n":
                line, self.buf = self.buf, ""
                return line
            if len(self.buf) < 1024:
                self.buf += ch
            ch = sys.stdin.read(1) if self.poll.poll(0) else ""
        return None


def send(obj):
    sys.stdout.write(wt_proto.encode(obj))


# --- 本体 ---------------------------------------------------------------------


class Device(object):
    def __init__(self):
        self.hw = PicoHardware()
        self.line = Line()
        self.t0 = time.ticks_ms()
        self.driver = RigDriver(self.hw, emit=send, clock=self.uptime)
        self.persona = None
        self.auto = True
        self.last_touch = time.ticks_ms()
        self.silenced = False
        self.last_approach = time.ticks_ms() - 100000
        self.prev_dist = None

    def uptime(self):
        return time.ticks_diff(time.ticks_ms(), self.t0)

    # 人格 ---------------------------------------------------------------

    def load_file(self, path=PERSONA_PATH):
        try:
            f = open(path)
        except OSError:
            send(wt_proto.log("persona.min.json がありません。シリアルから貼ってください"))
            return False
        try:
            import json
            data = json.load(f)
        finally:
            f.close()
        return self.set_persona(data)

    def set_persona(self, data):
        try:
            p = wt_core.Persona(data)
        except (ValueError, KeyError, TypeError) as exc:
            send(wt_proto.err("人格を読めません: %s" % exc))
            return False
        self.persona = p
        self.driver.bind(p)
        import json
        send(wt_proto.ok(p.id, len(json.dumps(data))))
        send(wt_proto.log("人格: %s / 方針: %s" % (p.name, ",".join(p.policies))))
        return True

    # イベント -------------------------------------------------------------

    def fire(self, event, arg=None):
        if not self.persona:
            send(wt_proto.err("人格が入っていません"))
            return
        start = self.uptime()
        first = [None]

        original = self.driver.emit

        def emit(obj):
            if first[0] is None and obj.get("o") in ("servo", "led"):
                first[0] = self.uptime() - start
            original(obj)

        self.driver.emit = emit
        try:
            wt_core.dispatch(self.persona, self.driver, event, arg)
        finally:
            self.driver.emit = original
        send(wt_proto.metric(event, first[0] if first[0] is not None else 0, self.uptime() - start))
        self.last_touch = time.ticks_ms()
        self.silenced = False

    def _approach_is_news(self, d):
        """人が立っているだけで approach を撃ち続けないための間引き。

        間引かないと、誰かが前にいる限り silence が永遠に来ない。
        「近づいた」と言えるのは、距離が 0.3m 以上変わったか、5秒空いたとき。
        """
        moved = self.prev_dist is None or abs(d - self.prev_dist) > 0.3
        cooled = time.ticks_diff(time.ticks_ms(), self.last_approach) > 5000
        if not (moved and cooled):
            self.prev_dist = d
            return False
        self.prev_dist = d
        self.last_approach = time.ticks_ms()
        return True

    # 入力 -----------------------------------------------------------------

    def handle(self, msg):
        t = msg.get("t")
        if t == wt_proto.T_PERSONA:
            self.set_persona(msg.get("d") or {})
        elif t == wt_proto.T_EVENT:
            self.fire(msg.get("e"), msg.get("dist", msg.get("sec")))
        elif t == wt_proto.T_PING:
            send(wt_proto.pong(FW, self.uptime()))
        elif t == wt_proto.T_STOP:
            self.auto = False
            self.hw.safe()
            send(wt_proto.log("停止しました（出力は安全位置）"))
        elif t == wt_proto.T_MODE:
            self.auto = bool(msg.get("auto", True))
            send(wt_proto.log("自走: %s" % self.auto))
        else:
            send(wt_proto.err("知らない種類です: %s" % t))

    def run(self):
        send(wt_proto.log("%s 起動（%s）" % (FW, wt_proto.PROTO)))
        self.load_file()
        beat = False
        last_sonar = time.ticks_ms()
        was_pressed = False

        while True:
            line = self.line.read(IDLE_GAP_MS)
            if line:
                msg = wt_proto.decode(line)
                if msg:
                    self.handle(msg)

            pressed = self.hw.pressed()
            if pressed and not was_pressed:
                self.fire("greet")
            was_pressed = pressed

            if time.ticks_diff(time.ticks_ms(), last_sonar) > SONAR_EVERY_MS:
                last_sonar = time.ticks_ms()
                d = self.hw.distance_m()
                if d is not None and 0.05 < d < 4.0 and self._approach_is_news(d):
                    self.fire("approach", d)

            idle_s = time.ticks_diff(time.ticks_ms(), self.last_touch) / 1000
            if self.auto and not self.silenced and idle_s > SILENCE_AFTER_S:
                self.silenced = True
                self.fire("silence", idle_s)

            beat = not beat
            self.hw.heartbeat(beat)

            if self.auto and self.persona:
                wt_core.on_idle(self.persona, self.driver)


def main():
    dev = Device()
    try:
        dev.run()
    except KeyboardInterrupt:
        dev.hw.safe()
        send(wt_proto.log("止めました"))


if __name__ == "__main__":
    main()
