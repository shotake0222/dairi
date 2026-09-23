#!/usr/bin/env python3
"""
わけたまのキャラクター（種族×6色）を、画像（PNG）と3Dモデル（GLB）の両方で書き出す。

    python3 tools/characters/make_characters.py            # 新しい10種族 × 6色 = 60組を作る
    python3 tools/characters/make_characters.py --sheet    # 一覧（contact sheet）も書き出す
    python3 tools/characters/make_characters.py --only hoshipo

出力: public/characters/{species}_{color}.png / .glb

**既存の5種族（ぷにころ・もふくる・つのまる・ほわほわ・きらつぶ）はここでは作らない。**
あれは初期に別の手順で作ったもので、上書きすると既存の利用者の分身の見た目が変わる。
このスクリプトが触るのは、下の SPECIES に並べた種族だけ。

作りの約束（既存の30体と揃えるため）:
- 画像: 1000×1000・背景透過・平塗り＋同系色の濃い縁取り・左上にハイライト・白い縁のある黒目・頬の赤み
- 3D: Y軸が上、顔は +Z を向く、幅はおおむね 1.3（chat の model-viewer と、メタバースで同じ大きさに見える）
- 3Dは骨なしの静的メッシュ、色は頂点色（COLOR_0）。メタバース側の小さな読み込み器がそのまま読める形
- 色（coral / sky / leaf / sun / lavender / peach）の値は、既存の30体から実測した値をそのまま使う
- **既存のキャラクター（他社作品）に寄せない。** 形は「丸い体＋特徴1つ」の組み合わせで、特定の作品を連想させる
  配色・模様・記号は使わない
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from shapely import affinity
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "characters"

# ---- 色（既存の30体から実測） ---------------------------------------------------------

PALETTES = {
    "coral": {"body": (255, 110, 110), "light": (255, 141, 141), "line": (200, 0, 0)},
    "sky": {"body": (79, 169, 255), "light": (117, 188, 255), "line": (0, 93, 183)},
    "leaf": {"body": (126, 217, 87), "light": (154, 225, 123), "line": (62, 136, 30)},
    "sun": {"body": (255, 217, 61), "light": (255, 225, 103), "line": (173, 139, 0)},
    "lavender": {"body": (176, 140, 255), "light": (193, 165, 255), "line": (68, 0, 217)},
    "peach": {"body": (255, 176, 214), "light": (255, 193, 223), "line": (237, 0, 114)},
}
COLORS = list(PALETTES)

EYE = (35, 28, 48)
EYE3D = (40, 34, 54)
WHITE = (255, 255, 255)
CREAM = (255, 246, 230)
BLUSH = (255, 140, 160)
MOUTH = (120, 62, 70)
BEAK = (255, 170, 60)
BEAK_LINE = (205, 110, 20)
SPROUT = (96, 196, 96)
SPROUT_LINE = (40, 130, 50)


def mix(a, b, t):
    return tuple(int(round(a[i] * (1 - t) + b[i] * t)) for i in range(3))


def palette(color: str) -> dict:
    p = dict(PALETTES[color])
    # 模様・影に使う、体より一段濃い色（縁取りほど濃くしない）
    p["deep"] = mix(p["body"], p["line"], 0.35)
    # 葉っぱ色の子の芽は、体と同化しないように濃い緑にする
    p["sprout"] = (60, 150, 60) if color == "leaf" else SPROUT
    p["sprout_line"] = (30, 95, 30) if color == "leaf" else SPROUT_LINE
    return p


# ---- 2D（画像） -------------------------------------------------------------------------

SIZE = 1000
SS = 4  # 4倍で描いて縮める（縁のギザギザを消すため）
K = 390  # 1単位 = 390px（下の3Dの SCALE_3D と合わせて、既存の30体と同じ大きさに見える倍率）
CX, CY = 500, 530
LINE_W = 0.034  # 縁取りの太さ（単位系で。約10px）


class Canvas:
    def __init__(self):
        self.img = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.img)

    def _px(self, geom):
        def tr(x, y):
            return ((CX + x * K) * SS, (CY - y * K) * SS)

        polys = geom.geoms if hasattr(geom, "geoms") else [geom]
        out = []
        for poly in polys:
            if poly.is_empty:
                continue
            out.append([tr(x, y) for x, y in poly.exterior.coords])
        return out

    def fill(self, geom, color, alpha=255):
        if alpha == 255:
            for pts in self._px(geom):
                self.draw.polygon(pts, fill=color + (255,))
        else:
            layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
            d = ImageDraw.Draw(layer)
            for pts in self._px(geom):
                d.polygon(pts, fill=color + (alpha,))
            self.img.alpha_composite(layer)

    def part(self, geom, fill, line, width=LINE_W):
        """縁取りつきで1つの部品を描く（縁は外側へ太らせた同じ形を先に塗る）。"""
        if line is not None:
            self.fill(geom.buffer(width, resolution=24), line)
        self.fill(geom, fill)

    def stroke(self, points, color, width=0.022):
        pts = [((CX + x * K) * SS, (CY - y * K) * SS) for x, y in points]
        self.draw.line(pts, fill=color + (255,), width=int(width * K * SS), joint="curve")
        r = width * K * SS / 2
        for x, y in (pts[0], pts[-1]):
            self.draw.ellipse([x - r, y - r, x + r, y + r], fill=color + (255,))

    def save(self, path: Path):
        self.img.resize((SIZE, SIZE), Image.LANCZOS).save(path, optimize=True)


def ell(cx, cy, rx, ry, rot=0.0):
    g = affinity.scale(Point(0, 0).buffer(1.0, resolution=48), rx, ry)
    if rot:
        g = affinity.rotate(g, rot, origin=(0, 0))
    return affinity.translate(g, cx, cy)


def radial(cx, cy, fn, n=240):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        r = fn(t)
        pts.append((cx + r[0] * math.cos(t), cy + r[1] * math.sin(t)) if isinstance(r, tuple) else (cx + r * math.cos(t), cy + r * math.sin(t)))
    return Polygon(pts)


def face2d(c: Canvas, cx, cy, s=1.0, mouth="smile", blush=True):
    """目・頬・口。既存の子と同じ顔つき（白い縁の黒目＋右上の光）。"""
    for sx in (-1, 1):
        ex = cx + sx * 0.14 * s
        c.fill(ell(ex, cy, 0.074 * s, 0.092 * s), WHITE)
        c.fill(ell(ex, cy - 0.004 * s, 0.056 * s, 0.074 * s), EYE)
        c.fill(ell(ex + 0.018 * s, cy + 0.03 * s, 0.018 * s, 0.018 * s), WHITE)
        c.fill(ell(ex - 0.012 * s, cy - 0.034 * s, 0.009 * s, 0.009 * s), WHITE)
        if blush:
            c.fill(ell(cx + sx * 0.3 * s, cy - 0.1 * s, 0.075 * s, 0.038 * s), BLUSH, alpha=150)
    my = cy - 0.12 * s
    if mouth == "smile":
        c.stroke([(cx - 0.04 * s, my + 0.01 * s), (cx, my - 0.02 * s), (cx + 0.04 * s, my + 0.01 * s)], MOUTH, 0.018 * s)
    elif mouth == "w":
        c.stroke(
            [(cx - 0.06 * s, my + 0.012 * s), (cx - 0.03 * s, my - 0.018 * s), (cx, my + 0.008 * s),
             (cx + 0.03 * s, my - 0.018 * s), (cx + 0.06 * s, my + 0.012 * s)],
            MOUTH, 0.017 * s,
        )
    elif mouth == "o":
        c.fill(ell(cx, my - 0.005 * s, 0.028 * s, 0.032 * s), MOUTH)


def highlight(c: Canvas, cx, cy, rx, ry, p, rot=-20):
    c.fill(ell(cx, cy, rx, ry, rot), p["light"])


# ---- 3D（GLB） --------------------------------------------------------------------------


def colored(mesh: trimesh.Trimesh, rgb) -> trimesh.Trimesh:
    mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=np.tile(np.array(list(rgb) + [255], dtype=np.uint8), (len(mesh.vertices), 1)))
    return mesh


def ellipsoid(center, radii, rgb, rot=None, sub=3):
    m = trimesh.creation.icosphere(subdivisions=sub, radius=1.0)
    m.apply_scale(radii)
    if rot is not None:
        for axis, deg in rot:
            m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(deg), axis))
    m.apply_translation(center)
    return colored(m, rgb)


def cone(base_center, radius, height, rgb, tilt=None):
    m = trimesh.creation.cone(radius=radius, height=height, sections=32)
    # trimesh の cone は +Z 向き。Y を上にする
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    if tilt is not None:
        for axis, deg in tilt:
            m.apply_transform(trimesh.transformations.rotation_matrix(math.radians(deg), axis))
    m.apply_translation(base_center)
    return colored(m, rgb)


def cylinder(p0, p1, radius, rgb):
    m = trimesh.creation.cylinder(radius=radius, segment=[p0, p1], sections=20)
    return colored(m, rgb)


def torus(center, major, minor, rgb):
    m = trimesh.creation.torus(major_radius=major, minor_radius=minor, major_sections=48, minor_sections=16)
    m.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    m.apply_translation(center)
    return colored(m, rgb)


def surface_z(body_c, body_r, x, y):
    """楕円体の表面の z（顔の部品を体に貼るため）。"""
    cx, cy, cz = body_c
    a, b, c = body_r
    v = 1 - ((x - cx) / a) ** 2 - ((y - cy) / b) ** 2
    return cz + c * math.sqrt(max(v, 0.0))


def face3d(body_c, body_r, cy, s=1.0, blush=True):
    parts = []
    for sx in (-1, 1):
        ex = body_c[0] + sx * 0.14 * s
        z = surface_z(body_c, body_r, ex, cy)
        parts.append(ellipsoid((ex, cy, z - 0.005), (0.062 * s, 0.078 * s, 0.035), EYE3D))
        parts.append(ellipsoid((ex + 0.018 * s, cy + 0.028 * s, z + 0.028), (0.016 * s, 0.016 * s, 0.01), WHITE, sub=2))
        if blush:
            bx = body_c[0] + sx * 0.3 * s
            by = cy - 0.1 * s
            bz = surface_z(body_c, body_r, bx, by)
            parts.append(ellipsoid((bx, by, bz - 0.01), (0.07 * s, 0.036 * s, 0.022), BLUSH, sub=2))
    return parts


# ---- 種族 --------------------------------------------------------------------------------
#
# 1種族 = 名前・読み・2Dの描き方・3Dの組み方。体の中心はおおむね原点、顔は +Z。


def hoshipo_2d(c, p):
    body = radial(0, 0.02, lambda t: 0.5 * (1 + 0.2 * math.cos(5 * (t - math.pi / 2))))
    c.part(body, p["body"], p["line"])
    highlight(c, -0.17, 0.2, 0.1, 0.07, p)
    face2d(c, 0, 0.0, 0.92, "smile")
    c.part(ell(-0.2, -0.47, 0.1, 0.06), p["body"], p["line"])
    c.part(ell(0.2, -0.47, 0.1, 0.06), p["body"], p["line"])


def hoshipo_3d(p):
    bc, br = (0, 0.02, 0), (0.44, 0.44, 0.36)
    parts = [ellipsoid(bc, br, p["body"])]
    for k in range(5):
        ang = math.radians(90 + 72 * k)
        parts.append(ellipsoid((0.4 * math.cos(ang), 0.02 + 0.4 * math.sin(ang), 0), (0.2, 0.13, 0.2), p["body"], rot=[([0, 0, 1], math.degrees(ang))]))
    parts += face3d(bc, br, 0.0, 0.92)
    parts += [ellipsoid((sx * 0.2, -0.47, 0.05), (0.1, 0.06, 0.1), p["body"]) for sx in (-1, 1)]
    return parts


def kinokon_2d(c, p):
    c.part(ell(0, -0.16, 0.42, 0.4), CREAM, mix(CREAM, p["line"], 0.45))
    cap = unary_union([ell(0, 0.26, 0.64, 0.36), ell(0, 0.12, 0.62, 0.12)])
    cap = cap.intersection(Polygon([(-1, 0.06), (1, 0.06), (1, 1), (-1, 1)]))
    c.part(cap, p["body"], p["line"])
    highlight(c, -0.26, 0.42, 0.12, 0.06, p)
    for x, y, r in ((-0.36, 0.2, 0.07), (0.05, 0.44, 0.08), (0.34, 0.24, 0.06), (-0.08, 0.2, 0.045)):
        c.fill(ell(x, y, r, r * 0.85), WHITE)
    face2d(c, 0, -0.15, 0.95, "smile")
    for sx in (-1, 1):
        c.part(ell(sx * 0.2, -0.56, 0.11, 0.06), CREAM, mix(CREAM, p["line"], 0.45))


def kinokon_3d(p):
    bc, br = (0, -0.16, 0), (0.42, 0.4, 0.38)
    parts = [ellipsoid(bc, br, CREAM)]
    parts.append(ellipsoid((0, 0.2, 0), (0.64, 0.3, 0.6), p["body"]))
    for x, y, z in ((-0.36, 0.3, 0.38), (0.05, 0.46, 0.2), (0.34, 0.32, 0.36), (0.0, 0.4, -0.4), (0.4, 0.3, -0.3)):
        parts.append(ellipsoid((x, y, z), (0.07, 0.05, 0.07), WHITE, sub=2))
    parts += face3d(bc, br, -0.15, 0.95)
    parts += [ellipsoid((sx * 0.2, -0.56, 0.05), (0.11, 0.06, 0.12), CREAM) for sx in (-1, 1)]
    return parts


def tamatori_2d(c, p):
    for sx in (-1, 1):
        c.part(ell(sx * 0.46, -0.02, 0.16, 0.26, sx * 25), p["body"], p["line"])
    for dx, h in ((-0.07, 0.16), (0.0, 0.22), (0.07, 0.15)):
        c.part(ell(dx, 0.46 + h / 2, 0.035, h / 2, -dx * 200), p["body"], p["line"])
    c.part(ell(0, 0.0, 0.5, 0.5), p["body"], p["line"])
    c.fill(ell(0, -0.2, 0.3, 0.24), CREAM)
    highlight(c, -0.2, 0.22, 0.1, 0.07, p)
    face2d(c, 0, 0.06, 0.95, None)
    c.part(Polygon([(-0.06, -0.03), (0.06, -0.03), (0, -0.12)]), BEAK, BEAK_LINE, 0.015)
    for sx in (-1, 1):
        c.part(ell(sx * 0.16, -0.53, 0.09, 0.045), BEAK, BEAK_LINE, 0.015)


def tamatori_3d(p):
    bc, br = (0, 0, 0), (0.5, 0.5, 0.46)
    parts = [ellipsoid(bc, br, p["body"])]
    parts.append(ellipsoid((0, -0.18, 0.3), (0.3, 0.24, 0.2), CREAM))
    for sx in (-1, 1):
        parts.append(ellipsoid((sx * 0.46, -0.02, -0.02), (0.14, 0.26, 0.12), p["body"], rot=[([0, 0, 1], sx * 25)]))
        parts.append(ellipsoid((sx * 0.16, -0.52, 0.12), (0.09, 0.04, 0.12), BEAK))
    for dx, h in ((-0.07, 0.16), (0.0, 0.22), (0.07, 0.15)):
        parts.append(ellipsoid((dx, 0.46 + h / 2, 0), (0.035, h / 2, 0.035), p["body"], rot=[([0, 0, 1], -dx * 200)]))
    parts.append(cone((0, -0.06, surface_z(bc, br, 0, -0.06) - 0.02), 0.06, 0.12, BEAK, tilt=[([1, 0, 0], 90)]))
    parts += face3d(bc, br, 0.06, 0.95)
    return parts


def mimipyon_2d(c, p):
    for sx in (-1, 1):
        c.part(ell(sx * 0.17, 0.62, 0.1, 0.32, -sx * 8), p["body"], p["line"])
        c.fill(ell(sx * 0.17, 0.6, 0.05, 0.24, -sx * 8), CREAM)
    c.part(ell(0.42, -0.3, 0.13, 0.13), CREAM, mix(CREAM, p["line"], 0.45))
    c.part(ell(0, -0.04, 0.46, 0.44), p["body"], p["line"])
    highlight(c, -0.18, 0.16, 0.1, 0.07, p)
    face2d(c, 0, -0.02, 0.95, "w")
    for sx in (-1, 1):
        c.part(ell(sx * 0.2, -0.46, 0.12, 0.06), p["body"], p["line"])


def mimipyon_3d(p):
    bc, br = (0, -0.04, 0), (0.46, 0.44, 0.42)
    parts = [ellipsoid(bc, br, p["body"])]
    for sx in (-1, 1):
        parts.append(ellipsoid((sx * 0.17, 0.62, -0.02), (0.1, 0.32, 0.08), p["body"], rot=[([0, 0, 1], -sx * 8)]))
        parts.append(ellipsoid((sx * 0.17, 0.6, 0.045), (0.05, 0.24, 0.03), CREAM, rot=[([0, 0, 1], -sx * 8)]))
        parts.append(ellipsoid((sx * 0.2, -0.46, 0.08), (0.12, 0.06, 0.14), p["body"]))
    parts.append(ellipsoid((0, -0.2, -0.44), (0.13, 0.13, 0.13), CREAM))
    parts += face3d(bc, br, -0.02, 0.95)
    return parts


def futabaru_2d(c, p):
    c.stroke([(0, 0.4), (0, 0.6)], p["sprout_line"], 0.05)
    c.stroke([(0, 0.41), (0, 0.59)], p["sprout"], 0.026)
    for sx in (-1, 1):
        c.part(ell(sx * 0.15, 0.66, 0.16, 0.07, sx * 25), p["sprout"], p["sprout_line"], 0.024)
    c.part(ell(0, -0.05, 0.5, 0.46), p["body"], p["line"])
    highlight(c, -0.2, 0.17, 0.11, 0.07, p)
    face2d(c, 0, -0.03, 1.0, "smile")
    for sx in (-1, 1):
        c.part(ell(sx * 0.48, -0.12, 0.08, 0.1), p["body"], p["line"])
        c.part(ell(sx * 0.2, -0.5, 0.12, 0.06), p["body"], p["line"])


def futabaru_3d(p):
    bc, br = (0, -0.05, 0), (0.5, 0.46, 0.44)
    parts = [ellipsoid(bc, br, p["body"])]
    parts.append(cylinder((0, 0.35, 0), (0, 0.62, 0), 0.025, p["sprout"]))
    for sx in (-1, 1):
        parts.append(ellipsoid((sx * 0.15, 0.66, 0), (0.16, 0.035, 0.08), p["sprout"], rot=[([0, 0, 1], sx * 25)]))
        parts.append(ellipsoid((sx * 0.48, -0.12, 0.04), (0.08, 0.1, 0.08), p["body"]))
        parts.append(ellipsoid((sx * 0.2, -0.5, 0.08), (0.12, 0.06, 0.13), p["body"]))
    parts += face3d(bc, br, -0.03, 1.0)
    return parts


def kuragekko_2d(c, p):
    for i, x in enumerate((-0.3, -0.1, 0.1, 0.3)):
        pts = [(x + 0.05 * math.sin(k * 1.4 + i), -0.05 - 0.09 * k) for k in range(6)]
        c.stroke(pts, p["line"], 0.07)
        c.stroke(pts, p["light"], 0.04)
    dome = ell(0, 0.08, 0.52, 0.42).intersection(Polygon([(-1, -0.12), (1, -0.12), (1, 1), (-1, 1)]))
    rim = ell(0, -0.1, 0.5, 0.07)
    c.part(unary_union([dome, rim]), p["body"], p["line"])
    highlight(c, -0.22, 0.3, 0.12, 0.06, p)
    c.fill(ell(0.24, 0.34, 0.04, 0.03), WHITE)
    face2d(c, 0, 0.08, 0.95, "o")


def kuragekko_3d(p):
    bc, br = (0, 0.08, 0), (0.52, 0.42, 0.48)
    parts = [ellipsoid(bc, br, p["body"])]
    parts.append(ellipsoid((0, -0.1, 0), (0.5, 0.07, 0.46), p["body"]))
    for i, x in enumerate((-0.3, -0.1, 0.1, 0.3)):
        for k in range(6):
            parts.append(ellipsoid((x + 0.05 * math.sin(k * 1.4 + i), -0.12 - 0.09 * k, 0.12), (0.035, 0.05, 0.035), p["light"], sub=2))
    parts += face3d(bc, br, 0.08, 0.95)
    return parts


def nyamaru_2d(c, p):
    c.stroke([(0.38, -0.3), (0.58, -0.2), (0.62, 0.02), (0.52, 0.12)], p["line"], 0.1)
    c.stroke([(0.38, -0.3), (0.58, -0.2), (0.62, 0.02), (0.52, 0.12)], p["body"], 0.062)
    for sx in (-1, 1):
        ear = Polygon([(sx * 0.14, 0.34), (sx * 0.42, 0.34), (sx * 0.33, 0.62)])
        c.part(ear.buffer(0.03), p["body"], p["line"])
        c.fill(Polygon([(sx * 0.21, 0.37), (sx * 0.37, 0.37), (sx * 0.32, 0.53)]).buffer(0.01), CREAM)
    c.part(ell(0, -0.02, 0.48, 0.44), p["body"], p["line"])
    highlight(c, -0.2, 0.18, 0.1, 0.07, p)
    face2d(c, 0, 0.0, 0.95, "w")
    for sx in (-1, 1):
        for dy in (0.02, -0.04):
            c.stroke([(sx * 0.3, -0.1 + dy), (sx * 0.5, -0.07 + dy * 2)], mix(p["line"], EYE, 0.4), 0.012)
        c.part(ell(sx * 0.2, -0.47, 0.11, 0.06), p["body"], p["line"])


def nyamaru_3d(p):
    bc, br = (0, -0.02, 0), (0.48, 0.44, 0.42)
    parts = [ellipsoid(bc, br, p["body"])]
    for sx in (-1, 1):
        parts.append(cone((sx * 0.28, 0.3, 0), 0.14, 0.3, p["body"], tilt=[([0, 0, 1], -sx * 12)]))
        parts.append(cone((sx * 0.28, 0.31, 0.05), 0.07, 0.18, CREAM, tilt=[([0, 0, 1], -sx * 12)]))
        parts.append(ellipsoid((sx * 0.2, -0.47, 0.08), (0.11, 0.06, 0.12), p["body"]))
        for dy in (0.02, -0.04):
            y = -0.1 + dy
            z = surface_z(bc, br, sx * 0.32, y)
            parts.append(cylinder((sx * 0.3, y, z), (sx * 0.52, y + dy * 2 + 0.03, z + 0.02), 0.006, mix(p["line"], EYE3D, 0.4)))
    for k in range(7):
        t = k / 6
        parts.append(ellipsoid((0.3 + 0.28 * math.sin(t * 2.2), -0.3 + 0.42 * t, -0.35), (0.06, 0.06, 0.06), p["body"], sub=2))
    parts += face3d(bc, br, 0.0, 0.95)
    return parts


def kamenko_2d(c, p):
    head_line = mix(p["light"], p["line"], 0.55)
    for sx in (-1, 1):
        c.part(ell(sx * 0.4, -0.36, 0.1, 0.08), p["light"], head_line)
    shell = ell(0, 0.02, 0.56, 0.38).intersection(Polygon([(-1, -0.18), (1, -0.18), (1, 1), (-1, 1)]))
    c.part(unary_union([shell, ell(0, -0.2, 0.56, 0.06)]), p["body"], p["line"])
    for x, y in ((-0.28, 0.08), (0.0, 0.22), (0.28, 0.08), (-0.14, -0.08), (0.14, -0.08)):
        hexa = Polygon([(x + 0.1 * math.cos(math.pi / 3 * k), y + 0.08 * math.sin(math.pi / 3 * k)) for k in range(6)])
        c.fill(hexa, p["deep"])
    c.part(ell(0, -0.3, 0.3, 0.26), p["light"], head_line)
    face2d(c, 0, -0.29, 0.85, "smile")


def kamenko_3d(p):
    hc, hr = (0, -0.3, 0.34), (0.3, 0.26, 0.26)
    parts = [ellipsoid((0, 0.02, 0), (0.56, 0.38, 0.5), p["body"]), ellipsoid((0, -0.2, 0), (0.56, 0.06, 0.5), p["body"])]
    for x, y, z in ((-0.28, 0.12, 0.34), (0.0, 0.3, 0.2), (0.28, 0.12, 0.34), (-0.3, 0.14, -0.3), (0.3, 0.14, -0.3), (0, 0.35, -0.1)):
        parts.append(ellipsoid((x, y, z), (0.1, 0.06, 0.1), p["deep"], sub=2))
    parts.append(ellipsoid(hc, hr, p["light"]))
    for sx, sz in ((-1, 1), (1, 1), (-1, -1), (1, -1)):
        parts.append(ellipsoid((sx * 0.4, -0.36, sz * 0.26), (0.1, 0.08, 0.1), p["light"]))
    parts += face3d(hc, hr, -0.29, 0.85)
    return parts


def ponpoko_2d(c, p):
    tail = ell(0.46, -0.16, 0.16, 0.26, -25)
    c.part(tail, p["body"], p["line"])
    for k in range(2):
        band = ell(0.46, -0.16, 0.2, 0.26, -25).intersection(ell(0.46 + 0.06 * k, -0.08 - 0.14 * k, 0.2, 0.035, -25))
        c.fill(band, p["deep"])
    for sx in (-1, 1):
        c.part(ell(sx * 0.3, 0.38, 0.11, 0.1), p["body"], p["line"])
        c.fill(ell(sx * 0.3, 0.37, 0.055, 0.05), p["deep"])
    c.part(ell(0, -0.04, 0.46, 0.44), p["body"], p["line"])
    c.fill(ell(0, -0.2, 0.26, 0.2), CREAM)
    highlight(c, -0.2, 0.18, 0.09, 0.06, p)
    for sx in (-1, 1):
        c.fill(ell(sx * 0.14, 0.0, 0.12, 0.1), p["deep"])
    face2d(c, 0, 0.0, 0.95, "smile")
    c.fill(ell(0, -0.07, 0.035, 0.025), EYE)
    for sx in (-1, 1):
        c.part(ell(sx * 0.2, -0.46, 0.11, 0.06), p["body"], p["line"])


def ponpoko_3d(p):
    bc, br = (0, -0.04, 0), (0.46, 0.44, 0.42)
    parts = [ellipsoid(bc, br, p["body"])]
    parts.append(ellipsoid((0, -0.2, 0.28), (0.26, 0.2, 0.16), CREAM))
    for sx in (-1, 1):
        parts.append(ellipsoid((sx * 0.3, 0.36, 0), (0.11, 0.1, 0.07), p["body"]))
        parts.append(ellipsoid((sx * 0.3, 0.36, 0.05), (0.055, 0.05, 0.03), p["deep"]))
        z = surface_z(bc, br, sx * 0.14, 0.0)
        parts.append(ellipsoid((sx * 0.14, 0.0, z - 0.03), (0.12, 0.1, 0.04), p["deep"]))
        parts.append(ellipsoid((sx * 0.2, -0.46, 0.08), (0.11, 0.06, 0.12), p["body"]))
    parts.append(ellipsoid((0, -0.07, surface_z(bc, br, 0, -0.07)), (0.035, 0.025, 0.025), EYE3D, sub=2))
    parts.append(ellipsoid((0.32, -0.2, -0.38), (0.16, 0.26, 0.16), p["body"], rot=[([0, 0, 1], -25)]))
    for k in range(2):
        parts.append(torus((0.32 + 0.05 * k, -0.12 - 0.13 * k, -0.38), 0.14 - 0.02 * k, 0.03, p["deep"]))
    parts += face3d(bc, br, 0.0, 0.95)
    return parts


def futatama_2d(c, p):
    c.part(ell(0, -0.22, 0.44, 0.34), p["body"], p["line"])
    for sx in (-1, 1):
        c.part(ell(sx * 0.44, -0.18, 0.08, 0.1), p["body"], p["line"])
    c.part(ell(0, 0.0, 0.34, 0.07), CREAM, mix(CREAM, p["line"], 0.45))
    c.part(ell(0, 0.28, 0.34, 0.3), p["body"], p["line"])
    highlight(c, -0.14, 0.42, 0.08, 0.05, p)
    highlight(c, -0.2, -0.08, 0.09, 0.05, p)
    face2d(c, 0, 0.26, 0.8, "smile")
    for x in (0, ):
        c.fill(ell(x, -0.18, 0.03, 0.03), p["deep"])
        c.fill(ell(x, -0.3, 0.03, 0.03), p["deep"])


def futatama_3d(p):
    hc, hr = (0, 0.28, 0), (0.34, 0.3, 0.32)
    parts = [ellipsoid((0, -0.22, 0), (0.44, 0.34, 0.42), p["body"]), ellipsoid(hc, hr, p["body"])]
    parts.append(torus((0, 0.0, 0), 0.3, 0.06, CREAM))
    for sx in (-1, 1):
        parts.append(ellipsoid((sx * 0.44, -0.18, 0.04), (0.08, 0.1, 0.08), p["body"]))
    for y in (-0.18, -0.3):
        parts.append(ellipsoid((0, y, surface_z((0, -0.22, 0), (0.44, 0.34, 0.42), 0, y)), (0.03, 0.03, 0.02), p["deep"], sub=2))
    parts += face3d(hc, hr, 0.26, 0.8)
    return parts


SPECIES = {
    "hoshipo": ("ほしぽ", hoshipo_2d, hoshipo_3d),
    "kinokon": ("きのこん", kinokon_2d, kinokon_3d),
    "tamatori": ("たまとり", tamatori_2d, tamatori_3d),
    "mimipyon": ("みみぴょん", mimipyon_2d, mimipyon_3d),
    "futabaru": ("ふたばる", futabaru_2d, futabaru_3d),
    "kuragekko": ("くらげっこ", kuragekko_2d, kuragekko_3d),
    "nyamaru": ("にゃまる", nyamaru_2d, nyamaru_3d),
    "kamenko": ("かめんこ", kamenko_2d, kamenko_3d),
    "ponpoko": ("ぽんぽこ", ponpoko_2d, ponpoko_3d),
    "futatama": ("ふたたま", futatama_2d, futatama_3d),
}


# ---- 書き出し ----------------------------------------------------------------------------


# 種族の定義は体の半径0.5前後で書いてある。既存の30体（幅およそ1.3）に揃えるための倍率
SCALE_3D = 1.3


def write_glb(parts, path: Path, species: str, color: str, label: str):
    scene = trimesh.Scene()
    for i, m in enumerate(parts):
        m.apply_scale(SCALE_3D)
        scene.add_geometry(m, node_name=f"{species}_{i}", geom_name=f"geometry_{i}")
    data = scene.export(file_type="glb")
    # 既存の30体と同じく、由来をファイルの中に書いておく（asset.copyright と extras）
    json_len = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20 : 20 + json_len])
    doc.setdefault("asset", {})["copyright"] = "わけたま (Waketama) / Straid / license: All Rights Reserved"
    doc["extras"] = {
        "title": f"{species}_{color}",
        "label": label,
        "author": "わけたま (Waketama) / Straid",
        "license": "All Rights Reserved (Waketama internal asset)",
        "species": species,
        "color": color,
        "rig": "none (static mesh, no skeleton)",
        "generator": "tools/characters/make_characters.py",
    }
    new_json = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    new_json += b" " * ((4 - len(new_json) % 4) % 4)
    rest = data[20 + json_len :]
    body = struct.pack("<I", len(new_json)) + b"JSON" + new_json + rest
    header = b"glTF" + struct.pack("<II", 2, 12 + len(body))
    path.write_bytes(header + body)


def make(species: str, color: str):
    label, draw2d, build3d = SPECIES[species]
    p = palette(color)
    c = Canvas()
    draw2d(c, p)
    c.save(OUT / f"{species}_{color}.png")
    write_glb(build3d(p), OUT / f"{species}_{color}.glb", species, color, label)


def contact_sheet(names, path: Path):
    cell = 170
    sheet = Image.new("RGBA", (cell * len(COLORS), cell * len(names)), (255, 255, 255, 255))
    for r, sp in enumerate(names):
        for col, co in enumerate(COLORS):
            im = Image.open(OUT / f"{sp}_{co}.png").resize((cell, cell), Image.LANCZOS)
            sheet.alpha_composite(im, (col * cell, r * cell))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="この種族だけ作る")
    ap.add_argument("--sheet", help="一覧画像の書き出し先")
    args = ap.parse_args()
    names = [args.only] if args.only else list(SPECIES)
    OUT.mkdir(parents=True, exist_ok=True)
    for sp in names:
        for co in COLORS:
            make(sp, co)
        print(f"{sp}: 6色 書き出し")
    if args.sheet:
        contact_sheet(names, Path(args.sheet))
        print(f"一覧: {args.sheet}")


if __name__ == "__main__":
    main()
