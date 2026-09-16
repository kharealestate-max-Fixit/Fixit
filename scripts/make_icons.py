#!/usr/bin/env python3
"""Generate the FixIt WORDMARK icon set (PWA icons, favicons, share image).
Pure Pillow — no external design tools. A rounded gradient tile with the
two-tone "FixIt" wordmark (DM Sans 800): "Fix" white, "It" charcoal.
"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/out2"
os.makedirs(OUT, exist_ok=True)

# DM Sans variable font: bundled next to this script, else the /tmp download.
HERE = os.path.dirname(os.path.abspath(__file__))
FONT = next(p for p in [os.path.join(HERE, "fonts", "DMSans.ttf"), "/tmp/DMSans.ttf"]
            if os.path.exists(p))

DARK   = (9, 9, 11)          # #09090b  page/OG background
CHAR   = (28, 25, 23)        # #1c1917  "It"
WHITE  = (255, 255, 255)
ORANGE = (249, 115, 22)      # #f97316
RED    = (239, 68, 68)       # #ef4444
SS     = 4                   # supersample factor
RADIUS = 0.24                # corner radius as fraction of size
COLORS = [WHITE, WHITE, WHITE, CHAR, CHAR]   # F i x I t

def font(px, weight=800, opsz=40):
    f = ImageFont.truetype(FONT, px)
    f.set_variation_by_axes([opsz, weight])
    return f

def gradient(size):
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126.0
            px[x, y] = (round(ORANGE[0]+(RED[0]-ORANGE[0])*t),
                        round(ORANGE[1]+(RED[1]-ORANGE[1])*t),
                        round(ORANGE[2]+(RED[2]-ORANGE[2])*t))
    return small.resize(size, Image.BILINEAR)

def word_width(f, tracking, text="FixIt"):
    return sum(f.getlength(c) for c in text) + tracking*(len(text)-1)

def render_word(px, weight, tracking_ratio, text="FixIt", colors=COLORS):
    """Two-tone wordmark rendered at font size px, cropped tight."""
    f = font(px, weight)
    tr = tracking_ratio * px
    w = int(word_width(f, tr, text)) + px
    tmp = Image.new("RGBA", (w, px*2), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    x = px*0.5
    for ch, col in zip(text, colors):
        d.text((x, px), ch, font=f, fill=col, anchor="lm")
        x += f.getlength(ch) + tr
    return tmp.crop(tmp.getbbox())

def fitted_word(canvas_px, text_frac, weight, tracking_ratio, text="FixIt", colors=COLORS):
    ref = 400
    w0 = word_width(font(ref, weight), tracking_ratio*ref, text)
    px = max(8, int(ref * (text_frac*canvas_px) / w0))
    return render_word(px, weight, tracking_ratio, text, colors)

def tile(size, rounded=True, full_bleed=False, text_frac=0.80, weight=800,
         tracking_ratio=-0.02, rgb=False):
    S = size*SS
    grad = gradient((S, S))
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if full_bleed:
        img.paste(grad, (0, 0))
    else:
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S-1, S-1], radius=int(RADIUS*S), fill=255)
        img.paste(grad, (0, 0), m)
    word = fitted_word(S, text_frac, weight, tracking_ratio)
    img.alpha_composite(word, ((S-word.width)//2, (S-word.height)//2))
    img = img.resize((size, size), Image.LANCZOS)
    return img.convert("RGB") if rgb else img

# ── PWA / app icons ───────────────────────────────────────────────────────────
tile(192).save(f"{OUT}/icon-192.png")
tile(512).save(f"{OUT}/icon-512.png")
tile(512, full_bleed=True, text_frac=0.60).save(f"{OUT}/icon-maskable-512.png")  # safe zone
tile(180, full_bleed=True, rgb=True).save(f"{OUT}/apple-touch-icon.png")         # iOS rounds it
tile(512).save(f"{OUT}/icon.png")
# favicons — bigger, looser, heavier so they stay legible when tiny
tile(32, text_frac=0.90, weight=900, tracking_ratio=0.0).save(f"{OUT}/favicon-32.png")
tile(16, text_frac=0.94, weight=900, tracking_ratio=0.0).save(f"{OUT}/favicon-16.png")

# ── Open Graph share image (1200×630) ─────────────────────────────────────────
def og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), DARK)
    # tile on the left
    t = tile(430, rounded=True)
    img.paste(t, (110, (H-430)//2), t)
    # title + descriptor on the right — white so it reads on the dark bg
    d = ImageDraw.Draw(img)
    tx = 620
    title = render_word(150, 800, -0.02, colors=[WHITE]*5)   # all white on dark
    img.paste(title, (tx, 214), title)
    f_sub = font(58, 600)
    d.text((tx+4, 214+title.height+34), "AI Home Repair", font=f_sub, fill=(226, 224, 220))
    return img

og_image().save(f"{OUT}/og.png")
print("wrote to", OUT)
for fn in sorted(os.listdir(OUT)):
    print(f"  {fn:24} {os.path.getsize(os.path.join(OUT,fn)):>7}b")
