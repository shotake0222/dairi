"""
「わけたま」のブランド画像（PWAアイコン・OGP画像）を生成するスクリプト。

デザインの意図:
  サービス名の由来である「分け魂（＝自分の魂を分けても元の自分は欠けない）」を、
  ひとつの光の玉から、もうひとつの玉が分かれて生まれる形で表す。
  大きい玉（＝あなた自身）と小さい玉（＝分身）が重なり、重なった部分がいちばん明るく光る
  ——「分けても失われず、むしろ増える」という世界観をそのまま図にしている。

  配色はアプリ本体のUI（#7c5cff / #a78bfa の紫系）に合わせてある。

使い方:
  python3 tools/make_brand_assets.py
  生成物は public/icons/ 以下に出力される（リポジトリにコミットして配信する想定）。
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT_DIR = "public/icons"
FONT_JP = "/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc"

BG_TOP = (167, 139, 250)     # #a78bfa
BG_BOTTOM = (108, 74, 245)   # 少し濃い紫（#6c4af5）


def vertical_gradient(size, top, bottom):
    """上から下への直線グラデーションを作る。"""
    w, h = size
    grad = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        grad.putpixel(
            (0, y),
            (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return grad.resize((w, h), Image.BILINEAR)


SS = 4  # スーパーサンプリング倍率（大きく描いて縮小し、輪郭を滑らかにする）


def soul_orb(draw, center, radius, alpha, tail_angle=None, tail_len=1.9):
    """
    人魂（ひとだま）を1つ描く。丸い本体に、後ろへたなびく細い尾を付けることで
    「ただの円」ではなく「ふわりと漂う魂」に見えるようにしている。
    tail_angle: 尾が伸びる方向（ラジアン）。Noneなら尾なし。
    """
    import math

    cx, cy = center
    if tail_angle is not None:
        # 尾: 玉の両脇から出て、後方の1点へ収束する三角形。玉と重ねて一体に見せる。
        tip = (cx + math.cos(tail_angle) * radius * tail_len, cy + math.sin(tail_angle) * radius * tail_len)
        perp = tail_angle + math.pi / 2
        spread = radius * 0.72
        draw.polygon(
            [
                (cx + math.cos(perp) * spread, cy + math.sin(perp) * spread),
                (cx - math.cos(perp) * spread, cy - math.sin(perp) * spread),
                tip,
            ],
            fill=(255, 255, 255, alpha),
        )
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(255, 255, 255, alpha))


def draw_mark(canvas_size, scale=1.0, offset=(0, 0)):
    """
    「分け魂」のマーク。
    左下の大きな魂（＝あなた自身）から、右上へ小さな魂（＝分身）が分かれて昇っていく。
    2つのあいだに空きをつくり、そこに分かれていく途中の粒を置くことで
    「重なった2つの丸」ではなく「ひとつが分かれた瞬間」として読めるようにする。
    """
    import math

    s = canvas_size * SS
    size = (s, s)
    c = s / 512.0 * scale
    ox = s * 0.5 + offset[0] * SS - 256 * c
    oy = s * 0.5 + offset[1] * SS - 256 * c

    def p(x, y):
        return (ox + x * c, oy + y * c)

    # 本体（＝あなた自身）。尾を付けると吹き出しに見えてしまうため、静かな玉のまま置く。
    body = Image.new("RGBA", size, (255, 255, 255, 0))
    soul_orb(ImageDraw.Draw(body), p(196, 330), 116 * c, 252)

    # 本体の内側にうっすら三日月状の陰を入れて、平らな円ではなく球体に見せる。
    shade = Image.new("RGBA", size, (255, 255, 255, 0))
    scx, scy = p(160, 300)
    sr = 108 * c
    ImageDraw.Draw(shade).ellipse([scx - sr, scy - sr, scx + sr, scy + sr], fill=(255, 255, 255, 40))
    body = Image.alpha_composite(body, shade)

    # 分身（＝分けて生まれたほう）。ひと回り小さく、少し透けさせて「生まれたて」の軽さを出す。
    child = Image.new("RGBA", size, (255, 255, 255, 0))
    soul_orb(ImageDraw.Draw(child), p(360, 168), 66 * c, 210)

    # 本体から分身へ向かって小さくなっていく粒の列。
    # これがあることで「並んだ2つの丸」ではなく「ひとつが分かれて昇っていく」動きとして読める。
    dots = Image.new("RGBA", size, (255, 255, 255, 0))
    dd = ImageDraw.Draw(dots)
    for x, y, r, a in ((268, 254, 26, 200), (312, 218, 15, 165), (340, 196, 8, 125)):
        cx, cy = p(x, y)
        rr = r * c
        dd.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(255, 255, 255, a))
    _ = math

    mark = Image.alpha_composite(Image.alpha_composite(body, dots), child)

    # 全体をほんのり発光させる（ぼかした複製を下に敷く）。
    glow = mark.filter(ImageFilter.GaussianBlur(22 * c))
    glow.putalpha(glow.getchannel("A").point(lambda v: int(v * 0.42)))
    mark = Image.alpha_composite(glow, mark)

    return mark.resize((canvas_size, canvas_size), Image.LANCZOS)


def rounded_icon(size, corner_ratio=0.22, mark_scale=1.0):
    """角丸のアプリアイコン（通常用）。"""
    base = vertical_gradient((size, size), BG_TOP, BG_BOTTOM).convert("RGBA")
    base = Image.alpha_composite(base, draw_mark(size, scale=mark_scale))

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * corner_ratio), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def maskable_icon(size):
    """maskable用。OS側で好きな形に切り抜かれるため、背景は全面・マークは中央65%に収める。"""
    base = vertical_gradient((size, size), BG_TOP, BG_BOTTOM).convert("RGBA")
    return Image.alpha_composite(base, draw_mark(size, scale=0.62))


def _fitted_font(text, size, max_width, min_size=18):
    """指定幅に収まるまでフォントサイズを落とす（文言を変えても右端で切れないようにする）。"""
    while size > min_size:
        font = ImageFont.truetype(FONT_JP, size)
        if font.getbbox(text)[2] <= max_width:
            return font
        size -= 2
    return ImageFont.truetype(FONT_JP, min_size)


def ogp_image(w=1200, h=630):
    """SNSシェア時のカード画像。左にマーク、右にテキストを置き、互いに重ならないようにする。"""
    base = vertical_gradient((w, h), BG_TOP, BG_BOTTOM).convert("RGBA")

    # 左側のマーク。テキスト領域に食い込まないよう、正方形キャンバスごと左に寄せて配置する。
    mark_box = int(h * 0.72)
    mark = draw_mark(mark_box, scale=0.92)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(mark, (int(w * 0.02), (h - mark_box) // 2), mark)
    base = Image.alpha_composite(base, canvas)

    d = ImageDraw.Draw(base)
    text_x = int(w * 0.40)
    max_width = w - text_x - 72  # 右マージン72px

    title = _fitted_font("わけたま", 128, max_width)
    lead = _fitted_font("会話で育つ、もうひとりの自分。", 44, max_width)
    sub = _fitted_font("NFCタグをタップして、あなたの分身と出会う", 30, max_width)

    # 3行をまとめて縦中央に置く
    gap1, gap2 = 34, 20
    th = title.getbbox("わけたま")[3]
    lh = lead.getbbox("あ")[3]
    sh = sub.getbbox("あ")[3]
    total = th + gap1 + lh + gap2 + sh
    y = (h - total) // 2

    d.text((text_x, y), "わけたま", font=title, fill=(255, 255, 255, 255))
    y += th + gap1
    d.text((text_x + 4, y), "会話で育つ、もうひとりの自分。", font=lead, fill=(255, 255, 255, 242))
    y += lh + gap2
    d.text((text_x + 4, y), "NFCタグをタップして、あなたの分身と出会う", font=sub, fill=(255, 255, 255, 190))
    return base.convert("RGB")


def main():
    import os

    os.makedirs(OUT_DIR, exist_ok=True)
    rounded_icon(512).save(f"{OUT_DIR}/icon-512.png")
    rounded_icon(192).save(f"{OUT_DIR}/icon-192.png")
    # iOSのホーム画面アイコンは角丸をOS側で付けるため、角丸なし（正方形）で用意する。
    maskable_icon(180).save(f"{OUT_DIR}/apple-touch-icon.png")
    maskable_icon(512).save(f"{OUT_DIR}/icon-maskable-512.png")
    rounded_icon(64, corner_ratio=0.20, mark_scale=1.06).save(f"{OUT_DIR}/favicon-64.png")
    ogp_image().save(f"{OUT_DIR}/ogp.png")
    print("generated:", sorted(os.listdir(OUT_DIR)))


if __name__ == "__main__":
    main()
