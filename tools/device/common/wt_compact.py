#!/usr/bin/env python3
# わけたま検証機 — 人格カード → 機器へ焼ける最小形（Python 版）
#
# **なぜ tools/edge/compact.mjs があるのに、もう1つ書くのか。**
# 母艦（Raspberry Pi）の上で、ネットに出られない状態でも変換したいから。
# Node を入れれば済む話ではあるが、検証機は「電源とSDカードだけで再現できる」ことに
# 価値があるので、Python だけで閉じられるようにしてある。
#
# **同じ答えになることは機械で確かめている。** tools/device/selftest.py が
# 同じカードを compact.mjs と この実装に通して、1バイト単位で一致を見る。
# （Node が無い環境ではその比較だけ飛ばす。）
#
# 使い方:
#     python3 tools/device/common/wt_compact.py card.json -o persona.min.json

import json
import math
import sys

CONTRACT_VERSION = 1
TRAIT_ORDER = ("warmth", "curiosity", "cheerfulness", "caution", "independence", "humor")
MAX_BYTES = 512


def _round(v):
    """JavaScript の Math.round と同じ丸め（0.5 は上へ）。

    Python の round() は偶数丸めなので、そのまま使うと compact.mjs と
    1 ずれることがある。ずれた値が機器へ行くと、原因の分からない差になる。
    """
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    if x != x:  # NaN
        return 0
    return int(math.floor(x + 0.5))


def _f2(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = 0.0
    if x != x:
        x = 0.0
    r = math.floor(x * 100 + 0.5) / 100.0
    # JSON.stringify は 2.0 を "2" と書く。バイト数を合わせるために整数へ落とす
    return int(r) if r == int(r) else r


def to_compact(card, max_policies=6):
    avatar = (card.get("runtime") or {}).get("avatar")
    if not avatar:
        raise ValueError("runtime.avatar がありません（古い形式の人格カードです）")
    m = avatar["motion"]
    p = avatar["proxemics"]
    e = avatar["expression"]
    identity = card.get("identity") or {}
    personality = card.get("personality") or {}
    return {
        "v": CONTRACT_VERSION,
        "id": str(identity.get("id", ""))[:8],
        "n": str(identity.get("name", ""))[:16],
        "m": [
            _round(m.get("energy")),
            _round(m.get("gestureRate")),
            _round(m.get("idleVariance")),
            _round(m.get("responseDelayMs")),
            _round(m.get("gazeHoldMs")),
            _round(m.get("postureOpenness")),
        ],
        "p": [_f2(p.get("comfortableDistanceM")), _f2(p.get("approachSpeedMps"))],
        "e": [_round(e.get("baselineSmile")), _round(e.get("blinkRatePerMin"))],
        "t": [_round(personality.get(k, 50)) for k in TRAIT_ORDER],
        "c": [str(x.get("code")) for x in (avatar.get("policy") or [])[:max_policies]],
    }


def to_json(compact):
    """1行のJSON。compact.mjs（JSON.stringify）と同じ並び・同じ詰め方。"""
    return json.dumps(compact, separators=(",", ":"), ensure_ascii=False)


def audit(compact, card):
    """焼く前の検査。会話・覚え書き・属性が1文字も混ざっていないことを機械で見る。

    目視に任せると、いつか事故る。落ちたら配信しない。
    """
    text = to_json(compact)
    leaks = []
    secrets = []
    secrets.extend(card.get("notes") or [])
    secrets.extend([x.get("text", "") for x in (card.get("memories") or [])])
    for x in card.get("examples") or []:
        secrets.append(x.get("user", ""))
        secrets.append(x.get("assistant", ""))
    secrets.extend([str(v) for v in ((card.get("owner") or {}).get("attributes") or {}).values()])
    secrets.append((card.get("runtime") or {}).get("systemPrompt", "") or "")

    for s in secrets:
        s = str(s or "").strip()
        if len(s) < 6:  # 短い断片は偶然一致する
            continue
        if s in text:
            leaks.append(s[:40])

    nbytes = len(text.encode("utf-8"))
    return {"ok": not leaks, "bytes": nbytes, "leaks": leaks, "over": nbytes > MAX_BYTES}


def main(argv):
    paths = [a for a in argv if not a.startswith("-")]
    if not paths:
        print(__doc__ or "usage: wt_compact.py card.json -o persona.min.json")
        return 1
    out = None
    for i, a in enumerate(argv):
        if a == "-o" and i + 1 < len(argv):
            out = argv[i + 1]
            paths = [x for x in paths if x != out]
    src = paths[0]
    with open(src, encoding="utf-8") as f:
        card = json.load(f)

    compact = to_compact(card)
    report = audit(compact, card)
    text = to_json(compact)

    if not report["ok"]:
        sys.stderr.write("会話・覚え書きが混ざっています。焼かないでください:\n")
        for leak in report["leaks"]:
            sys.stderr.write("  - %s...\n" % leak)
        return 2
    if report["over"]:
        sys.stderr.write("最小形が %d バイトで、上限 %d を超えています（方針を減らしてください）\n"
                         % (report["bytes"], MAX_BYTES))
        return 3

    if out:
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
        print("%s を書き出しました（%d バイト）" % (out, report["bytes"]))
    else:
        print(text)
    print("  名前: %s  方針: %s" % (compact["n"], ", ".join(compact["c"]) or "（なし）"))
    print("  会話・覚え書き・属性は含まれていません（機器へ焼いて問題ありません）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
