# わけたま検証機 — 機器と母艦のあいだの取り決め（WTP/1）
#
# 1行 = 1つのJSON。改行で区切る。それだけ。
# USBシリアル(115200)でも、TCPでも、HTTPのボディでも同じものが流れる。
# 仕様の文章は docs/DEVICE_SPEC.md §4。ここはその実装。
#
# なぜ自前の小さな取り決めにしたか:
#   MQTT も ROS も、この検証には大きすぎる。Pico の 520KB に載せたいのと、
#   シリアルモニタに人が手で1行貼って試せることを優先した。
#
# MicroPython でも動く（json だけ使う）。

import json

PROTO = "WTP/1"

# 母艦 → 機器
T_PERSONA = "persona"   # {"t":"persona","d":{最小形}}     人格を入れ替える
T_EVENT = "event"       # {"t":"event","e":"greet"}         イベントを起こす
T_PING = "ping"         # {"t":"ping"}                      生きているか
T_STOP = "stop"         # {"t":"stop"}                      全出力を安全な位置へ
T_MODE = "mode"         # {"t":"mode","auto":true}          自走（待機ループ）の入切

# 機器 → 母艦
T_OK = "ok"             # {"t":"ok","persona":"5b0a7533","bytes":256}
T_ERR = "err"           # {"t":"err","m":"..."}
T_PONG = "pong"         # {"t":"pong","fw":"wt-pico/1.0","up":12345}
T_ACT = "act"           # {"t":"act","o":"servo","n":"arm","v":"wave 1/2","ms":12}
T_METRIC = "metric"     # {"t":"metric","e":"greet","first_ms":458,"total_ms":1620}
T_LOG = "log"           # {"t":"log","m":"..."}             人が読む用


def encode(obj):
    """1行のJSONにする。区切りを詰めるのは、シリアルの取りこぼしを減らすため。"""
    return json.dumps(obj) + "\n"


def decode(line):
    """1行を読む。壊れていても例外を投げずに None を返す。

    シリアルは本当に壊れる（起動時のノイズ、途中で抜けたケーブル）。
    ここで落ちると機器が止まり、原因が配線なのかコードなのか分からなくなる。
    """
    if not line:
        return None
    s = line.strip()
    if not s or s[0] != "{":
        return None
    try:
        obj = json.loads(s)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    # 人が手で貼るときのために、最小形そのものを1行貼っても人格として受け取る
    if "t" not in obj and obj.get("v") == 1 and "m" in obj:
        return {"t": T_PERSONA, "d": obj}
    return obj


def ok(persona_id, nbytes):
    return {"t": T_OK, "persona": persona_id, "bytes": nbytes}


def err(message):
    return {"t": T_ERR, "m": str(message)[:120]}


def pong(fw, uptime_ms):
    return {"t": T_PONG, "fw": fw, "up": int(uptime_ms), "proto": PROTO}


def act(kind, name, value, at_ms):
    return {"t": T_ACT, "o": kind, "n": name, "v": value, "ms": int(at_ms)}


def metric(event, first_ms, total_ms):
    """イベントから最初にモーターが動くまで／全部終わるまで。

    検証記録の「応答までの時間」は、人がストップウォッチで測るのではなく
    これを集める。手で測ると、測る人によって100ms は平気でずれる。
    """
    return {"t": T_METRIC, "e": event, "first_ms": int(first_ms), "total_ms": int(total_ms)}


def log(message):
    return {"t": T_LOG, "m": str(message)[:200]}
