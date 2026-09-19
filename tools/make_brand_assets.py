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


def magatama_outline(size, scale=1.0, steps=240):
    """
    勾玉の輪郭の点列を返す。public/icons/mark.svg と同じ作図。

      背骨になる「らせん」を1本引く。中心から半径21で始め、尾に向かって半径を40%縮めながら
      205度まわす。その背骨に、頭で33・尾で10の太さを持たせ、両端を半円で閉じる。
      らせんにしてあるのが肝で、ただの円弧だと内側の縁に段差が出る。

    数値は100×100の設計図の座標なので、実際の大きさに合わせて拡大する。
    """
    import math

    k = size / 100.0 * scale
    off = (size - 100 * k) / 2.0
    cx, cy, Rs = 50.0, 50.0, 21.0
    start_deg, sweep_deg, shrink = 75.0, 205.0, 0.40
    w_head, w_tail, taper = 33.0, 10.0, 1.5

    outer, inner = [], []
    for i in range(steps + 1):
        t = i / steps
        ang = math.radians(start_deg - sweep_deg * t)
        r = Rs * (1 - shrink * t)
        w = w_head + (w_tail - w_head) * (t ** (1 / taper))
        sx, sy = cx + r * math.cos(ang), cy - r * math.sin(ang)
        nx, ny = math.cos(ang), -math.sin(ang)
        outer.append((off + (sx + nx * w / 2) * k, off + (sy + ny * w / 2) * k))
        inner.append((off + (sx - nx * w / 2) * k, off + (sy - ny * w / 2) * k))

    head = (off + (cx + Rs * math.cos(math.radians(start_deg))) * k,
            off + (cy - Rs * math.sin(math.radians(start_deg))) * k)
    tail_spine_ang = math.radians(start_deg - sweep_deg)
    tail_r = Rs * (1 - shrink)
    tail = (off + (cx + tail_r * math.cos(tail_spine_ang)) * k,
            off + (cy - tail_r * math.sin(tail_spine_ang)) * k)
    return outer, inner, head, tail, w_head * k, w_tail * k


def magatama_mask(canvas_size, scale=1.0):
    """勾玉の形の白黒マスク。両端の半円と、頭の紐穴まで含めて描く。"""
    s = canvas_size * SS
    mask = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(mask)

    outer, inner, head, tail, wh, wt = magatama_outline(s, scale=scale)
    d.polygon(outer + list(reversed(inner)), fill=255)

    def circle(center, radius, fill):
        x, y = center
        d.ellipse([x - radius, y - radius, x + radius, y + radius], fill=fill)

    circle(head, wh / 2, 255)          # 頭の丸み
    circle(tail, wt / 2, 255)          # 尾の丸み
    circle(head, wh * 0.24, 0)         # 紐を通す穴

    return mask.resize((canvas_size, canvas_size), Image.LANCZOS)


def draw_mark(canvas_size, scale=1.0, offset=(0, 0)):
    """勾玉のマークを、白抜き＋ほのかな発光で返す（背景のグラデーションに重ねて使う）。"""
    mask = magatama_mask(canvas_size, scale=scale)
    transparent = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 0))
    white = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 250))
    mark = Image.composite(white, transparent, mask)

    if offset != (0, 0):
        shifted = Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 0))
        shifted.paste(mark, (int(offset[0]), int(offset[1])), mark)
        mark = shifted

    glow = mark.filter(ImageFilter.GaussianBlur(canvas_size * 0.045))
    glow.putalpha(glow.getchannel("A").point(lambda v: int(v * 0.40)))
    return Image.alpha_composite(glow, mark)


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
    rounded_icon(512, mark_scale=0.86).save(f"{OUT_DIR}/icon-512.png")
    rounded_icon(192, mark_scale=0.86).save(f"{OUT_DIR}/icon-192.png")
    # iOSのホーム画面アイコンは角丸をOS側で付けるため、角丸なし（正方形）で用意する。
    maskable_icon(180).save(f"{OUT_DIR}/apple-touch-icon.png")
    maskable_icon(512).save(f"{OUT_DIR}/icon-maskable-512.png")
    rounded_icon(64, corner_ratio=0.20, mark_scale=0.94).save(f"{OUT_DIR}/favicon-64.png")
    ogp_image().save(f"{OUT_DIR}/ogp.png")
    print("generated:", sorted(os.listdir(OUT_DIR)))


if __name__ == "__main__":
    main()
