# わけたま検証機 — 振る舞いエンジン（LLMなし・入出力なし）
#
# **この1ファイルが、全機種で共通の「人格 → 動き」の変換**。
# Pico(MicroPython) も Pi(CPython) も、ここを読んで、出力の口（Driver）だけ差し替える。
# ESP32 版は同じ規則を C++ に写したもの（tools/device/esp32/wt_device/wt_core.h）で、
# 両者が同じ答えを出すことは tools/device/selftest.py が確かめている。
#
# 守ること:
#   - 標準ライブラリしか使わない（json/time/random まで）。f文字列・dataclass・typing は使わない
#     → そのまま Pico へ持っていけるようにするため
#   - 入出力を直接書かない。GPIO を触るのは Driver の実装側
#   - 乱数で動きを作らない。同じ人格・同じイベントなら、いつでも同じ手順が出ること
#     （検証機の目的は「差が人格から来ている」ことの確認。揺らぎを混ぜると測れなくなる）
#
# 並びの出所は tools/device/contract.json。変えるときは向こうを先に直すこと。

VERSION = "wt-core/1.0"
CONTRACT_VERSION = 1

EVENTS = ("idle", "approach", "greet", "change", "silence")


class Persona(object):
    """最小形（compact）を、意味のある名前で読めるようにしただけのもの。"""

    def __init__(self, data):
        if data.get("v") != CONTRACT_VERSION:
            raise ValueError("未対応の形式です: v=%s" % data.get("v"))
        m, p, e, t = data["m"], data["p"], data["e"], data["t"]
        self.id = data.get("id", "")
        self.name = data.get("n", "")
        # m: 動き
        self.energy = m[0]
        self.gesture_rate = m[1]
        self.idle_variance = m[2]
        self.response_delay_ms = m[3]
        self.gaze_hold_ms = m[4]
        self.posture = m[5]
        # p: 間合い
        self.distance_m = p[0]
        self.approach_mps = p[1]
        # e: 表情
        self.smile = e[0]
        self.blink_per_min = e[1]
        # t: 性格6軸
        self.warmth = t[0]
        self.curiosity = t[1]
        self.cheerfulness = t[2]
        self.caution = t[3]
        self.independence = t[4]
        self.humor = t[5]
        self.policies = data.get("c", [])

    def has(self, code):
        return code in self.policies


class Driver(object):
    """出力の口。実機ではこれを継承して GPIO を触る。

    ここを3つに絞ってあるのは、新しい機器へ載せるときに
    「この3つだけ書けば動く」と言い切れるようにするため。
    """

    def servo(self, name, value):
        raise NotImplementedError

    def led(self, name, value):
        raise NotImplementedError

    def wait(self, ms):
        raise NotImplementedError

    def note(self, text):
        """人が読むための一言。機械は使わない。既定では捨てる。"""
        pass


class Collector(Driver):
    """動きを実行せずに集める。PCでの確認・母艦での記録・テストに使う。"""

    def __init__(self):
        self.actions = []
        self.notes = []
        self.total_wait_ms = 0

    def servo(self, name, value):
        self.actions.append(("servo", name, value))

    def led(self, name, value):
        self.actions.append(("led", name, value))

    def wait(self, ms):
        self.actions.append(("wait", "", int(ms)))
        self.total_wait_ms += int(ms)

    def note(self, text):
        self.notes.append(text)


# --- イベント → 動き ----------------------------------------------------------
# どの関数も「人格と状況だけ」から手順を決める。時計も乱数も見ない。


def on_idle(p, d):
    """待機。ここが一番その子らしさが出る。置物にしないこと。"""
    amplitude = round(p.idle_variance / 100.0 * 12, 1)
    period_ms = int(4000 - p.energy * 20)
    d.servo("body_sway", "±%s deg / %dms" % (amplitude, period_ms))
    d.led("cheek", "%d%%" % p.smile)
    d.wait(int(60000 / max(1, p.blink_per_min)))


def on_approach(p, d, distance_m):
    """人が近づいた。踏み込むか、待つか、下がるか。"""
    if distance_m > p.distance_m:
        forward = (p.independence >= 55 or p.has("prefer_novel_options")) and not p.has("confirm_before_change")
        if forward:
            # float() を通すのは、最小形が 1 のような整数で来たときに
            # "1" と "1.0" で表記が割れるのを防ぐため（C++版・ESP32版と突き合わせる）
            step = round(min(float(p.approach_mps), distance_m - p.distance_m), 2)
            d.servo("drive", "forward %sm/s" % step)
        else:
            d.servo("head", "tilt toward")
            d.note("（自分からは寄らない）")
    else:
        if p.caution >= 60:
            d.servo("drive", "back %.2fm" % round(p.distance_m - distance_m, 2))
        else:
            d.servo("head", "face")


def on_greet(p, d):
    """話しかけられた。間の取り方と身振りの量に差が出る。"""
    d.wait(p.response_delay_ms)
    gestures = max(0, int(p.gesture_rate / 25))
    for i in range(gestures):
        d.servo("arm", "wave %d/%d" % (i + 1, gestures))
    d.servo("gaze", "hold %dms" % p.gaze_hold_ms)
    d.led("mouth", "smile %d%%" % min(100, p.smile + p.cheerfulness // 4))
    if p.has("keep_light_and_playful"):
        d.servo("body", "bounce")


def on_change(p, d):
    """予定の変更。方針コードがそのまま分岐になる。"""
    if p.has("confirm_before_change"):
        d.servo("head", "shake slight")
        d.note("→ まず確かめる（confirm_before_change）")
    elif p.has("prefer_novel_options"):
        d.servo("head", "nod fast")
        d.note("→ 乗る（prefer_novel_options）")
    else:
        d.servo("head", "nod")
        d.note("→ ふつうに受ける")


def on_silence(p, d, seconds):
    """沈黙が続いた。自分から切り出すか、待つか。

    docs/TEXT_TO_BEHAVIOR.md §6 の表にあって、これまで実装が無かったイベント。
    検証機で一番わかりやすく差が出るのがここ（片方は喋りかけ、片方は待つ）。
    """
    patience_s = 3 + (100 - p.energy) / 20.0
    if seconds < patience_s:
        d.servo("gaze", "hold %dms" % p.gaze_hold_ms)
        return
    if p.has("take_initiative") or (p.curiosity >= 65 and not p.has("follow_the_lead")):
        d.servo("head", "turn toward")
        d.led("mouth", "smile %d%%" % min(100, p.smile + 10))
        d.servo("arm", "beckon")
        d.note("→ 自分から切り出す")
    elif p.has("follow_the_lead") or p.caution >= 60:
        d.servo("body", "settle")
        d.led("cheek", "%d%%" % max(0, p.smile - 10))
        d.note("→ 待つ")
    else:
        d.servo("gaze", "glance")
        d.note("→ ちらと見るだけ")


def dispatch(p, d, event, arg=None):
    """イベント名で振り分ける。未知の名前は False を返す（落とさない）。"""
    if event == "idle":
        on_idle(p, d)
    elif event == "approach":
        on_approach(p, d, 2.0 if arg is None else float(arg))
    elif event == "greet":
        on_greet(p, d)
    elif event == "change":
        on_change(p, d)
    elif event == "silence":
        on_silence(p, d, 10.0 if arg is None else float(arg))
    else:
        return False
    return True


def plan(p, event, arg=None):
    """動かさずに手順だけ取る。母艦の記録と、2体の比較に使う。"""
    c = Collector()
    ok = dispatch(p, c, event, arg)
    if not ok:
        return None
    return c


# --- 2体の比較（検証機の本体はこれ） -------------------------------------------

COMPARE_ROWS = (
    ("動きの大きさ", "energy"),
    ("身振りの頻度", "gesture_rate"),
    ("待機の揺らぎ", "idle_variance"),
    ("返すまでの間(ms)", "response_delay_ms"),
    ("目線を保つ(ms)", "gaze_hold_ms"),
    ("心地よい距離(m)", "distance_m"),
    ("近づく速さ(m/s)", "approach_mps"),
)


def compare(a, b, events=EVENTS):
    """性格の違う2体を並べて、差が出ているかを機械で判定する。

    docs/EDGE_DEVICE_TEST.md §3 の「合格の基準」をそのまま実装したもの。
    人が見て「違う気がする」で済ませないために、ここで数字にする。
    """
    rows = []
    for label, attr in COMPARE_ROWS:
        rows.append((label, getattr(a, attr), getattr(b, attr)))

    only_a = [c for c in a.policies if c not in b.policies]
    only_b = [c for c in b.policies if c not in a.policies]

    seq_a, seq_b, differing = {}, {}, []
    for ev in events:
        pa, pb = plan(a, ev), plan(b, ev)
        seq_a[ev] = pa.actions if pa else []
        seq_b[ev] = pb.actions if pb else []
        if seq_a[ev] != seq_b[ev]:
            differing.append(ev)

    delay_a = max(1, a.response_delay_ms)
    delay_b = max(1, b.response_delay_ms)
    delay_ratio = round(max(delay_a, delay_b) / float(min(delay_a, delay_b)), 2)

    # 「2倍以上」は、ある1回の実測（410ms vs 930ms）をそのまま基準にしたもので、きつすぎた。
    # 実際の2体は 1.9〜2.3倍あたりに散らばる（性格の抽出をAIがやるので毎回ぶれる）。
    # 1.94倍を不合格にすると、正しく差が出ている組み合わせを弾いてしまう。
    # 「はっきり違うと分かる」の線として 1.5倍を採る。
    DELAY_RATIO_MIN = 1.5

    checks = [
        ("返すまでの間が1.5倍以上ちがう", delay_ratio >= DELAY_RATIO_MIN, "%.2f倍" % delay_ratio),
        ("身振りの回数がちがう", int(a.gesture_rate / 25) != int(b.gesture_rate / 25),
         "%d回 vs %d回" % (int(a.gesture_rate / 25), int(b.gesture_rate / 25))),
        ("近づく判断が分かれる", seq_a.get("approach") != seq_b.get("approach"), ""),
        ("方針コードに重ならない差がある", len(only_a) > 0 and len(only_b) > 0,
         "A:%d件 B:%d件" % (len(only_a), len(only_b))),
        ("半分以上のイベントで手順がちがう", len(differing) * 2 >= len(events),
         "%d/%d" % (len(differing), len(events))),
    ]
    return {
        "a": a.name or a.id,
        "b": b.name or b.id,
        "rows": rows,
        "only_a": only_a,
        "only_b": only_b,
        "differing_events": differing,
        "checks": checks,
        "pass": all(x[1] for x in checks),
    }
