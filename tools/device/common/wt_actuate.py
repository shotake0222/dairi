# わけたま検証機 — 「動きの指示」を実際の角度と明るさに落とす層
#
# wt_core.py が出すのは ("servo", "arm", "wave 1/2") のような**指示**で、
# 何度まで回すかは機器ごとに違う。その差をここ1か所に集める。
#
# 機器側が用意するのは3つだけ（+任意でブザー）:
#     hw.servo(slot, deg)     slot は "body" / "arm"、deg は 0〜180
#     hw.led(slot, percent)   slot は "mouth" / "eye"、percent は 0〜100
#     hw.sleep_ms(ms)
#     hw.beep(hz, ms)         省略可
#
# Pico も Pi も、この3つを書くだけで同じ人格が同じように動く。
# 新しい機器を足すときも、ここは触らない（docs/TEXT_TO_BEHAVIOR.md §7 の手順）。
#
# **この検証機には車輪が無い。** だから "drive forward" は前傾で代用する。
# ごまかしではなく、そう代用したことを act ログに残す（母艦の記録に出る）。

try:
    from wt_core import Driver
except ImportError:  # PCから tools/device/common/ 外で読むとき
    from .wt_core import Driver  # type: ignore

ARM_HOME = 90
ARM_UP = 130
ARM_DOWN = 55
BODY_HOME = 90
LEAN_FORWARD = 18
LEAN_BACK = 14
GESTURE_HALF_MS = 180
NOD_MS = 140


def _num(text, default=0.0):
    """\"wave 1/2\" や \"±10.2 deg / 2360ms\" から最初の数を取り出す。"""
    digits = ""
    seen = False
    for ch in str(text):
        if ch.isdigit() or (ch == "." and "." not in digits):
            digits += ch
            seen = True
        elif seen:
            break
    if not digits:
        return default
    try:
        return float(digits)
    except ValueError:
        return default


def _nums(text):
    out = []
    cur = ""
    for ch in str(text) + " ":
        if ch.isdigit() or (ch == "." and "." not in cur):
            cur += ch
        else:
            if cur:
                try:
                    out.append(float(cur))
                except ValueError:
                    pass
                cur = ""
    return out


class RigDriver(Driver):
    """wt_core の指示を、この検証機の body/arm サーボと mouth/eye LED へ割り当てる。"""

    def __init__(self, hw, emit=None, clock=None):
        self.hw = hw
        self.emit = emit          # act ログを母艦へ流す関数（省略可）
        self.clock = clock        # 経過ms を返す関数（省略可）
        self.center = BODY_HOME
        self.smile = 50
        self.substitutions = []   # 「この機器には無いので代用した」記録

    def bind(self, persona):
        """人格から、この機器の基準姿勢を決める。縮こまっている子は少し前傾。"""
        self.center = BODY_HOME - (50 - persona.posture) // 4
        self.smile = persona.smile
        self.substitutions = []
        self.hw.servo("body", self.center)
        self.hw.servo("arm", ARM_HOME)
        self.hw.led("mouth", persona.smile)
        self.hw.led("eye", 0)

    # --- wt_core.Driver -------------------------------------------------

    def servo(self, name, value):
        self._log("servo", name, value)
        if name == "arm":
            self._arm(value)
        elif name == "body_sway":
            self._sway(value)
        elif name == "drive":
            self._drive(value)
        elif name == "head":
            self._head(value)
        elif name == "gaze":
            self._gaze(value)
        elif name == "body":
            self._body(value)

    def led(self, name, value):
        self._log("led", name, value)
        pct = int(_num(value, self.smile))
        if name == "mouth" or name == "cheek":
            self.hw.led("mouth", pct)
        elif name == "eye":
            self.hw.led("eye", pct)

    def wait(self, ms):
        self._log("wait", "", ms)
        self.hw.sleep_ms(int(ms))

    def note(self, text):
        self._log("note", "", text)

    # --- 個々の割り当て ---------------------------------------------------

    def _arm(self, value):
        if str(value).startswith("beckon"):
            self._wave_once()
            return
        self._wave_once()

    def _wave_once(self):
        self.hw.servo("arm", ARM_UP)
        self.hw.sleep_ms(GESTURE_HALF_MS)
        self.hw.servo("arm", ARM_DOWN)
        self.hw.sleep_ms(GESTURE_HALF_MS)
        self.hw.servo("arm", ARM_HOME)

    def _sway(self, value):
        vals = _nums(value)
        amplitude = int(vals[0]) if vals else 4
        period = int(vals[1]) if len(vals) > 1 else 2400
        half = max(60, period // 2)
        self.hw.servo("body", self.center + amplitude)
        self.hw.sleep_ms(half)
        self.hw.servo("body", self.center - amplitude)
        self.hw.sleep_ms(half)

    def _drive(self, value):
        # 車輪が無いので前傾／後傾で代用する。代用したことを残す
        forward = str(value).startswith("forward")
        deg = self.center - LEAN_FORWARD if forward else self.center + LEAN_BACK
        self.substitutions.append("drive(%s)→lean" % value)
        self.hw.servo("body", deg)
        self.hw.sleep_ms(400)
        self.hw.servo("body", self.center)

    def _head(self, value):
        v = str(value)
        if v.startswith("nod"):
            times = 2 if "fast" in v else 1
            gap = 90 if "fast" in v else NOD_MS
            for _ in range(times):
                self.hw.servo("body", self.center - 10)
                self.hw.sleep_ms(gap)
                self.hw.servo("body", self.center)
                self.hw.sleep_ms(gap)
        elif v.startswith("shake"):
            for d in (-6, 6, -4, 0):
                self.hw.servo("body", self.center + d)
                self.hw.sleep_ms(110)
        elif v.startswith("tilt") or v.startswith("turn"):
            self.hw.servo("body", self.center - 8)
            self.hw.sleep_ms(200)
        else:  # face
            self.hw.servo("body", self.center)

    def _gaze(self, value):
        if str(value).startswith("glance"):
            self.hw.led("eye", 100)
            self.hw.sleep_ms(160)
            self.hw.led("eye", 0)
            return
        ms = int(_num(value, 800))
        self.hw.led("eye", 100)
        self.hw.sleep_ms(ms)
        self.hw.led("eye", 0)

    def _body(self, value):
        if str(value).startswith("bounce"):
            for d in (12, -8, 5, 0):
                self.hw.servo("body", self.center + d)
                self.hw.sleep_ms(90)
        else:  # settle
            self.hw.servo("body", self.center)
            self.hw.sleep_ms(200)

    # --- ログ -------------------------------------------------------------

    def _log(self, kind, name, value):
        if not self.emit:
            return
        at = self.clock() if self.clock else 0
        self.emit({"t": "act", "o": kind, "n": name, "v": value, "ms": int(at)})
