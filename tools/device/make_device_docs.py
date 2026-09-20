#!/usr/bin/env python3
"""
わけたま検証機 — 配線図とファーム用のピン定数を作る。

出力:
    tools/device/pico/wt_pins.py                 … MicroPython 用の定数
    tools/device/esp32/wt_device/wt_pins.h       … Arduino 用の定数
    docs/device/wt1_pico_wiring.svg              … WT-1 の配線図
    docs/device/wt2_esp32_wiring.svg             … WT-2 の配線図
    docs/device/wt3_pi_wiring.svg                … WT-3 の配線図
    docs/device/wt_system.svg                    … 4構成の系統図（誰が何を持つか）

**なぜ図とコードを同じところから出すか。**
ピン番号は、図・ファーム・手順書の3箇所に書かれる。手で3箇所直すと、必ず1つ残る。
残った1つを頼りに配線した人は、動かない理由を半日探すことになる。
出所は tools/device/pinmap.json ひとつだけ。

    python3 tools/device/make_device_docs.py
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PINMAP = os.path.join(HERE, "pinmap.json")
DOCS = os.path.join(ROOT, "docs", "device")

INK = "#1c1630"
MUTED = "#6f668f"
LINE = "#d9d3f0"
ACCENT = "#7c5cff"
WARN = "#c0392b"
BG = "#ffffff"
PANEL = "#f7f5ff"

WIRE_COLOR = {
    "pwm-out": ACCENT,
    "out": "#3aa76d",
    "in": "#e08a1e",
    "in-pullup": "#e08a1e",
}


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def text(x, y, s, size=12, fill=INK, weight="400", anchor="start"):
    return ('<text x="%.1f" y="%.1f" font-family="Hiragino Sans, Yu Gothic, sans-serif" '
            'font-size="%s" fill="%s" font-weight="%s" text-anchor="%s">%s</text>'
            % (x, y, size, fill, weight, anchor, esc(s)))


def rect(x, y, w, h, fill=BG, stroke=LINE, r=8, width=1.2):
    return ('<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%s" fill="%s" stroke="%s" stroke-width="%s"/>'
            % (x, y, w, h, r, fill, stroke, width))


def wire(x1, y1, x2, y2, color=ACCENT, dash=None):
    d = ' stroke-dasharray="%s"' % dash if dash else ""
    mid = (x1 + x2) / 2
    return ('<path d="M%.1f %.1f H%.1f V%.1f H%.1f" fill="none" stroke="%s" stroke-width="2"%s/>'
            % (x1, y1, mid, y2, x2, color, d))


# --- 配線図 -------------------------------------------------------------------


def wiring_svg(key, board, roles):
    """1機種ぶんの配線図。左に基板、右に部品、あいだを線でつなぐだけの素直な図。"""
    rows = [r for r in roles if r["role"] in board["pins"] and board["pins"][r["role"]] is not None]
    row_h = 46
    top = 118
    height = top + row_h * len(rows) + 150
    width = 760
    board_x, board_w = 40, 190
    part_x, part_w = 470, 250

    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
           % (width, height, width, height)]
    out.append(rect(0, 0, width, height, fill=BG, stroke="none", r=0))
    out.append(text(40, 40, "わけたま検証機 — %s 配線図" % board["name"], 17, INK, "700"))
    out.append(text(40, 62, "ピン番号の出所: tools/device/pinmap.json（%s）。手で書き換えないこと" % board["numbering"], 11.5, MUTED))
    out.append(text(40, 82, "生成: tools/device/make_device_docs.py", 11, MUTED))

    board_h = row_h * len(rows) + 20
    out.append(rect(board_x, top - 10, board_w, board_h, fill=PANEL, stroke=ACCENT))
    out.append(text(board_x + board_w / 2, top + 12, board["name"], 12.5, INK, "700", "middle"))

    for i, role in enumerate(rows):
        y = top + 40 + i * row_h
        pin = board["pins"][role["role"]]
        pin_label = pin if isinstance(pin, str) else "%s%s" % ("GP" if key == "pico" else ("GPIO" if key == "esp32" else "GPIO"), pin)
        color = WIRE_COLOR.get(role["kind"], ACCENT)

        out.append(text(board_x + 12, y + 4, pin_label, 12, INK, "700"))
        out.append('<circle cx="%.1f" cy="%.1f" r="4" fill="%s"/>' % (board_x + board_w, y, color))
        out.append(wire(board_x + board_w, y, part_x, y, color))
        out.append(rect(part_x, y - 18, part_w, 36, fill=BG, stroke=LINE))
        out.append(text(part_x + 12, y - 2, role["label"], 12, INK, "700"))
        out.append(text(part_x + 12, y + 14, role["note"], 10.5, MUTED))

    # 電源の注意。ここを読まずに作ると必ず再起動する
    py = top + row_h * len(rows) + 30
    out.append(rect(40, py, width - 80, 96, fill="#fff6f4", stroke=WARN))
    out.append(text(58, py + 24, "電源", 12.5, WARN, "700"))
    out.append(text(58, py + 44, "基板: %s" % board["power"]["board"], 11.5, INK))
    out.append(text(58, py + 62, "サーボ: %s" % board["power"]["servo"], 11.5, INK))
    out.append(text(58, py + 80, board["power"]["warn"], 11.5, WARN))
    out.append("</svg>")
    return "\n".join(out)


# --- 系統図 -------------------------------------------------------------------


SYSTEM_BOXES = [
    (40, 110, 220, 96, "わけたま（Cloudflare）", "会話 → 性格6軸 → 価値観8軸\n→ 身体パラメータ9個", ACCENT),
    (300, 110, 200, 96, "操作する人のPC / 母艦", "人格カードを取得（要トークン）\n→ 最小形 約250バイトへ", "#3aa76d"),
    (540, 60, 180, 70, "WT-1 Pico", "サーボ2・LED2・測距", INK),
    (540, 148, 180, 70, "WT-2 ESP32", "同じ＋Wi-Fi で受け取り", INK),
    (540, 236, 180, 70, "WT-3 Pi Zero", "同じ＋記録（CSV）", INK),
]


def system_svg():
    width, height = 780, 470
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
           % (width, height, width, height)]
    out.append(rect(0, 0, width, height, fill=BG, stroke="none", r=0))
    out.append(text(40, 40, "わけたま検証機 — 系統図", 17, INK, "700"))
    out.append(text(40, 62, "トークンと人格カードは母艦より右へ行かない。機器へ渡すのは数値だけ", 11.5, MUTED))
    out.append(text(40, 82, "生成: tools/device/make_device_docs.py", 11, MUTED))

    for x, y, w, h, title, body, color in SYSTEM_BOXES:
        out.append(rect(x, y, w, h, fill=PANEL if color != INK else BG, stroke=color))
        out.append(text(x + 14, y + 26, title, 12.5, INK, "700"))
        for i, ln in enumerate(body.split("\n")):
            out.append(text(x + 14, y + 46 + i * 16, ln, 11, MUTED))

    out.append(wire(260, 158, 300, 158, ACCENT))
    for ty in (95, 183, 271):
        out.append(wire(500, 158, 540, ty, "#3aa76d"))

    # 境界線。ここを越えてよいものを図の中に書いておく
    out.append('<path d="M520 40 V430" stroke="%s" stroke-width="1.5" stroke-dasharray="6 6"/>' % WARN)
    out.append(text(528, 400, "ここから右へ渡すのは最小形だけ", 11.5, WARN, "700"))
    out.append(text(528, 418, "（持ち主トークン・会話・覚え書きは渡さない）", 11, WARN))

    # WT-4 は上の3つを束ねた構成なので、囲いで示す
    out.append(rect(300, 330, 200, 76, fill=BG, stroke="#3aa76d"))
    out.append(text(314, 356, "WT-4 母艦（Pi 4 8GB）", 12.5, INK, "700"))
    out.append(text(314, 376, "2台へ同じイベントを同時送出", 11, MUTED))
    out.append(text(314, 392, "記録CSV / Ollama（段階B）", 11, MUTED))
    out.append(wire(400, 330, 400, 206, "#3aa76d", dash="5 5"))
    out.append("</svg>")
    return "\n".join(out)


# --- ファーム用の定数 ----------------------------------------------------------


def pins_py(board):
    lines = [
        "# 自動生成 — 手で書き換えないこと（tools/device/make_device_docs.py が上書きします）",
        "# 出所: tools/device/pinmap.json / %s" % board["name"],
        "",
    ]
    for role, pin in board["pins"].items():
        if pin is None:
            continue
        lines.append('%s = %s' % (role, '"%s"' % pin if isinstance(pin, str) else pin))
    return "\n".join(lines) + "\n"


def pins_h(board):
    lines = [
        "// 自動生成 — 手で書き換えないこと（tools/device/make_device_docs.py が上書きします）",
        "// 出所: tools/device/pinmap.json / %s" % board["name"],
        "",
        "#ifndef WT_PINS_H",
        "#define WT_PINS_H",
        "",
    ]
    for role, pin in board["pins"].items():
        if pin is None or isinstance(pin, str):
            continue
        lines.append("static const int PIN_%s = %d;" % (role, pin))
    lines += ["", "#endif  // WT_PINS_H", ""]
    return "\n".join(lines)


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  %s" % os.path.relpath(path, ROOT))


def main():
    with open(PINMAP, encoding="utf-8") as f:
        pinmap = json.load(f)
    roles = pinmap["roles"]
    boards = pinmap["boards"]

    print("配線図と定数を作ります")
    write(os.path.join(DOCS, "wt1_pico_wiring.svg"), wiring_svg("pico", boards["pico"], roles))
    write(os.path.join(DOCS, "wt2_esp32_wiring.svg"), wiring_svg("esp32", boards["esp32"], roles))
    write(os.path.join(DOCS, "wt3_pi_wiring.svg"), wiring_svg("pi", boards["pi"], roles))
    write(os.path.join(DOCS, "wt_system.svg"), system_svg())
    write(os.path.join(HERE, "pico", "wt_pins.py"), pins_py(boards["pico"]))
    write(os.path.join(HERE, "esp32", "wt_device", "wt_pins.h"), pins_h(boards["esp32"]))
    print("できました")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
