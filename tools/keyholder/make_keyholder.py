#!/usr/bin/env python3
"""
わけたま NFCキーホルダー — 図面と加工データを作る。

50mm × 50mm、削り出しで作れる形。出力は次の3つ:

  docs/keyholder/keyholder_front.svg   … 表（意匠面）。寸法つき
  docs/keyholder/keyholder_back.svg    … 裏（インレイの座ぐりと蓋）。寸法つき
  docs/keyholder/keyholder.dxf         … 加工用。外形・穴・座ぐりを層で分けてある

**なぜ図を手で描かずに生成するか。**
勾玉の形は public/icons/mark.svg と tools/make_brand_assets.py と同じ作図から来ている。
図面だけ手で描くと、ロゴを直したときに現物だけ古い形のまま残る。
1つの作図から、画面のロゴも、削り出しの図面も出す。

使い方:
    python3 tools/keyholder/make_keyholder.py
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

from make_brand_assets import magatama_outline  # noqa: E402

# ---- 寸法（mm）。ここを変えると図面もDXFも一緒に変わる ----

PLATE = 50.0          # 外形 50×50
CORNER_R = 6.0        # 角のR。握ったときに角が立たない最小限
THICK = 4.0           # 板厚
ENGRAVE_DEPTH = 0.8   # 勾玉を彫る深さ
RING_HOLE_D = 4.0     # キーリングの穴
RING_EDGE = 6.0       # 穴の中心から辺までの距離（縁の残り＝6−2=4mm）

INLAY_D = 25.0        # NFCインレイ（NTAG213/215の丸形25mm）
POCKET_D = 26.0       # 座ぐりの径。インレイ+0.5mmのすきま
POCKET_DEPTH = 0.9    # 座ぐりの深さ（インレイ0.25mm + フェライト0.3mm + 余裕）
LID_D = 28.0          # 蓋のはまる段差
LID_DEPTH = 0.6       # 蓋の厚み分
TOOL_D = 3.0          # 想定する刃物の直径（内Rはこれ以上必要）

MAGATAMA_H = 34.0      # 勾玉の高さ（板50mmに対して。周りに8mmずつ残る）


def magatama_path(target_h=MAGATAMA_H, center=(PLATE / 2, PLATE / 2)):
    """
    勾玉の閉じた輪郭を点列で返す（両端の半円を含む）。

    作図そのものは tools/make_brand_assets.py と共通。ここで**外接矩形から測り直して**
    置き直しているのは、元の作図が100×100の枠の中で 中心より右下に偏っていて、
    枠の中心に合わせただけでは板の上で右下にずれて見えるため。
    アイコンの大きさでは気にならないが、50mmの板だと目で分かる。
    """
    outer, inner, head, tail, w_head, w_tail = magatama_outline(100.0, 1.0)

    def arc(center, radius, a0, a1, n=48):
        return [
            (center[0] + radius * math.cos(a0 + (a1 - a0) * i / n),
             center[1] + radius * math.sin(a0 + (a1 - a0) * i / n))
            for i in range(n + 1)
        ]

    def cap(center, radius, p_from, p_to, bulge):
        """
        端の半円。**外側へ回る方**を選ぶ。

        近い方に回すと端が切り落とされて、勾玉ではなく細い三日月になる
        （実際そうなって、ロゴと現物の形が別物になりかけた）。
        どちらに回るかは、背骨の接線を延ばした先（bulge）を通る側かどうかで決める。
        """
        def ang(p):
            return math.atan2(p[1] - center[1], p[0] - center[0])

        a0, a1, ab = ang(p_from), ang(p_to), ang(bulge)

        def contains(a_start, a_end, a_mid):
            span = (a_end - a_start) % (2 * math.pi)
            rel = (a_mid - a_start) % (2 * math.pi)
            return rel <= span

        if contains(a0, a1, ab):
            a_end = a0 + ((a1 - a0) % (2 * math.pi))
        else:
            a_end = a0 - ((a0 - a1) % (2 * math.pi))
        return arc(center, radius, a0, a_end)

    def spine(i):
        return ((outer[i][0] + inner[i][0]) / 2, (outer[i][1] + inner[i][1]) / 2)

    def bulge_from(p_end, p_inner, radius):
        """端点から、背骨を延ばした向きへ radius だけ進んだ点。"""
        dx, dy = p_end[0] - p_inner[0], p_end[1] - p_inner[1]
        n = math.hypot(dx, dy) or 1.0
        return (p_end[0] + dx / n * radius, p_end[1] + dy / n * radius)

    head_bulge = bulge_from(spine(0), spine(3), w_head / 2)
    tail_bulge = bulge_from(spine(len(outer) - 1), spine(len(outer) - 4), w_tail / 2)

    pts = list(outer)
    pts += cap(tail, w_tail / 2, outer[-1], inner[-1], tail_bulge)
    pts += list(reversed(inner))
    pts += cap(head, w_head / 2, inner[0], outer[0], head_bulge)

    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    k = target_h / (max(ys) - min(ys))
    mx = (min(xs) + max(xs)) / 2
    my = (min(ys) + max(ys)) / 2

    def place(p):
        return (center[0] + (p[0] - mx) * k, center[1] + (p[1] - my) * k)

    return [place(p) for p in pts], place(head), w_head * k


def rounded_rect_path(w, h, r):
    """角Rの矩形。SVGのpath文字列。"""
    return (
        f"M {r} 0 H {w - r} A {r} {r} 0 0 1 {w} {r} V {h - r} "
        f"A {r} {r} 0 0 1 {w - r} {h} H {r} A {r} {r} 0 0 1 0 {h - r} "
        f"V {r} A {r} {r} 0 0 1 {r} 0 Z"
    )


def poly_to_path(pts):
    d = f"M {pts[0][0]:.3f} {pts[0][1]:.3f} "
    d += " ".join(f"L {x:.3f} {y:.3f}" for x, y in pts[1:])
    return d + " Z"


def dim_line(x1, y1, x2, y2, label, offset=0):
    """寸法線。図面として読めるように、線・矢羽根・数値をまとめて出す。"""
    return (
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#c0392b" stroke-width="0.2"/>'
        f'<text x="{(x1 + x2) / 2}" y="{(y1 + y2) / 2 - 1 + offset}" font-size="2.4" fill="#c0392b" '
        f'text-anchor="middle" font-family="monospace">{label}</text>'
    )


def svg_header(title, w=78, h=78):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -12 {w} {h}" '
        f'width="{w * 8}" height="{h * 8}">\n'
        f"  <!-- {title}。単位はすべてmm。tools/keyholder/make_keyholder.py が生成 -->\n"
        f'  <rect x="-14" y="-12" width="{w}" height="{h}" fill="#ffffff"/>\n'
    )


def front_svg():
    ring_cx, ring_cy = RING_EDGE, RING_EDGE
    pts, head, w_head = magatama_path()

    out = [svg_header("わけたま キーホルダー 表面")]
    out.append(f'  <path d="{rounded_rect_path(PLATE, PLATE, CORNER_R)}" fill="#f4f1ff" stroke="#1c1630" stroke-width="0.35"/>')
    out.append(f'  <path d="{poly_to_path(pts)}" fill="#7c5cff" fill-rule="evenodd" stroke="#4c3a99" stroke-width="0.2"/>')
    # 勾玉の頭の穴（意匠。貫通させない）
    out.append(f'  <circle cx="{head[0]:.2f}" cy="{head[1]:.2f}" r="{w_head * 0.24:.2f}" fill="#f4f1ff" stroke="#4c3a99" stroke-width="0.2"/>')
    # キーリングの穴（貫通）
    out.append(f'  <circle cx="{ring_cx}" cy="{ring_cy}" r="{RING_HOLE_D / 2}" fill="#ffffff" stroke="#1c1630" stroke-width="0.35"/>')
    out.append(f'  <line x1="{ring_cx - 3}" y1="{ring_cy}" x2="{ring_cx + 3}" y2="{ring_cy}" stroke="#c0392b" stroke-width="0.12"/>')
    out.append(f'  <line x1="{ring_cx}" y1="{ring_cy - 3}" x2="{ring_cx}" y2="{ring_cy + 3}" stroke="#c0392b" stroke-width="0.12"/>')

    out.append(dim_line(0, -5, PLATE, -5, f"{PLATE:.0f}"))
    out.append(dim_line(-5, 0, -5, PLATE, f"{PLATE:.0f}"))
    out.append(f'  <text x="{PLATE / 2}" y="{PLATE + 7}" font-size="2.6" text-anchor="middle" font-family="monospace" fill="#1c1630">'
               f'表面 / 勾玉 高さ{MAGATAMA_H:.0f} 彫り込み深さ{ENGRAVE_DEPTH}　角R{CORNER_R:.0f}　板厚{THICK:.0f}</text>')
    out.append(f'  <text x="{ring_cx + 4}" y="{ring_cy - 3}" font-size="2.2" font-family="monospace" fill="#c0392b">'
               f'ø{RING_HOLE_D:.0f} 貫通（中心 {RING_EDGE:.0f},{RING_EDGE:.0f}）</text>')
    out.append("</svg>\n")
    return "\n".join(out)


def back_svg():
    cx = cy = PLATE / 2
    ring_cx, ring_cy = RING_EDGE, RING_EDGE

    out = [svg_header("わけたま キーホルダー 裏面")]
    out.append(f'  <path d="{rounded_rect_path(PLATE, PLATE, CORNER_R)}" fill="#fbfaff" stroke="#1c1630" stroke-width="0.35"/>')
    out.append(f'  <circle cx="{cx}" cy="{cy}" r="{LID_D / 2}" fill="#efe9ff" stroke="#1c1630" stroke-width="0.3"/>')
    out.append(f'  <circle cx="{cx}" cy="{cy}" r="{POCKET_D / 2}" fill="#e2d8ff" stroke="#1c1630" stroke-width="0.3"/>')
    out.append(f'  <circle cx="{cx}" cy="{cy}" r="{INLAY_D / 2}" fill="none" stroke="#c0392b" stroke-width="0.2" stroke-dasharray="1.2 1"/>')
    out.append(f'  <circle cx="{ring_cx}" cy="{ring_cy}" r="{RING_HOLE_D / 2}" fill="#ffffff" stroke="#1c1630" stroke-width="0.35"/>')

    out.append(f'  <text x="{cx}" y="{cy - 1}" font-size="2.2" text-anchor="middle" font-family="monospace" fill="#1c1630">ø{POCKET_D:.0f} 深さ{POCKET_DEPTH}</text>')
    out.append(f'  <text x="{cx}" y="{cy + 2.6}" font-size="2.2" text-anchor="middle" font-family="monospace" fill="#1c1630">（インレイ ø{INLAY_D:.0f}）</text>')
    out.append(f'  <text x="{cx}" y="{cy + LID_D / 2 + 4}" font-size="2.2" text-anchor="middle" font-family="monospace" fill="#c0392b">蓋の段差 ø{LID_D:.0f} 深さ{LID_DEPTH}</text>')
    out.append(dim_line(0, -5, PLATE, -5, f"{PLATE:.0f}"))
    out.append(f'  <text x="{PLATE / 2}" y="{PLATE + 7}" font-size="2.6" text-anchor="middle" font-family="monospace" fill="#1c1630">'
               f'裏面 / インレイの座ぐり</text>')
    out.append(f'  <text x="{PLATE / 2}" y="{PLATE + 10.5}" font-size="2.2" text-anchor="middle" font-family="monospace" fill="#c0392b">'
               f'※金属材のときは底にフェライトシート</text>')
    out.append("</svg>\n")
    return "\n".join(out)


def dxf():
    """
    最小限のDXF（R12相当）。CAM側で読めれば十分なので、LINE/ARC/CIRCLE/LWPOLYLINE だけ使う。
    層で分けてあるので、深さは加工側で層ごとに指定する。
    """
    lines = ["0", "SECTION", "2", "ENTITIES"]

    def circle(x, y, r, layer):
        lines.extend(["0", "CIRCLE", "8", layer, "10", f"{x:.4f}", "20", f"{y:.4f}", "30", "0.0", "40", f"{r:.4f}"])

    def polyline(pts, layer, closed=True):
        lines.extend(["0", "LWPOLYLINE", "8", layer, "90", str(len(pts)), "70", "1" if closed else "0"])
        for x, y in pts:
            lines.extend(["10", f"{x:.4f}", "20", f"{y:.4f}"])

    # 外形（角R付きの矩形を点列にする。CAMで読みやすいよう素直な折れ線にしている）
    outline = []
    r = CORNER_R
    corners = [(PLATE - r, PLATE - r, 0), (r, PLATE - r, 90), (r, r, 180), (PLATE - r, r, 270)]
    for cx, cy, a0 in corners:
        for i in range(25):
            a = math.radians(a0 + 90 * i / 24)
            outline.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    polyline(outline, "OUTLINE")

    circle(RING_EDGE, RING_EDGE, RING_HOLE_D / 2, "HOLE_THRU")
    circle(PLATE / 2, PLATE / 2, POCKET_D / 2, "POCKET_INLAY")
    circle(PLATE / 2, PLATE / 2, LID_D / 2, "POCKET_LID")

    pts, head, w_head = magatama_path()
    # SVGはy下向き、DXFはy上向き。反転しないと図が裏返る
    polyline([(x, PLATE - y) for x, y in pts], "ENGRAVE_MAGATAMA")
    circle(head[0], PLATE - head[1], w_head * 0.24, "ENGRAVE_MAGATAMA")

    lines.extend(["0", "ENDSEC", "0", "EOF"])
    return "\n".join(lines) + "\n"


def main():
    out_dir = os.path.join(HERE, "..", "..", "docs", "keyholder")
    os.makedirs(out_dir, exist_ok=True)
    files = {
        "keyholder_front.svg": front_svg(),
        "keyholder_back.svg": back_svg(),
        "keyholder.dxf": dxf(),
    }
    for name, content in files.items():
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"{os.path.relpath(path)}  ({len(content)} bytes)")

    print("")
    print(f"外形 {PLATE:.0f}×{PLATE:.0f}mm / 板厚 {THICK:.0f}mm / 角R{CORNER_R:.0f}")
    print(f"インレイ座ぐり ø{POCKET_D:.0f} 深さ{POCKET_DEPTH} / 蓋の段差 ø{LID_D:.0f} 深さ{LID_DEPTH}")
    print(f"最小内R = 刃物ø{TOOL_D:.0f} の半径 {TOOL_D / 2:.1f}mm 以上")
    print(f"座ぐり底から表面までの残り厚 = {THICK - POCKET_DEPTH - LID_DEPTH:.1f}mm（彫り込み{ENGRAVE_DEPTH}を引くと "
          f"{THICK - POCKET_DEPTH - LID_DEPTH - ENGRAVE_DEPTH:.1f}mm）")


if __name__ == "__main__":
    main()
