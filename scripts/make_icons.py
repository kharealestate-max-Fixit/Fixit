#!/usr/bin/env python3
"""Generate the FixIt logo icon set (PWA icons, favicons, share image) in code.
Pure Pillow — no external design tools. Draws a gradient 'house' with a wrench
carved out as negative space, on a dark background.
"""
from PIL import Image, ImageDraw, ImageChops, ImageFont
import os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/out"
os.makedirs(OUT, exist_ok=True)

DARK   = (9, 9, 11)          # #09090b
ORANGE = (249, 115, 22)      # #f97316
RED    = (239, 68, 68)       # #ef4444
R = 1024                     # master render resolution

# ── diagonal orange→red gradient (top-left → bottom-right) ────────────────────
def gradient(size):
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126.0
            px[x, y] = (
                round(ORANGE[0] + (RED[0]-ORANGE[0])*t),
                round(ORANGE[1] + (RED[1]-ORANGE[1])*t),
                round(ORANGE[2] + (RED[2]-ORANGE[2])*t),
            )
    return small.resize(size, Image.BILINEAR)

# ── the house silhouette (filled white on black) ──────────────────────────────
def house_mask():
    m = Image.new("L", (R, R), 0)
    d = ImageDraw.Draw(m)
    def P(x, y): return (x*R, y*R)
    # simple, bold house: triangular roof on a square body, small overhang
    poly = [
        P(0.50, 0.15),   # apex
        P(0.88, 0.49),   # right eave
        P(0.785, 0.49),  # step to right wall
        P(0.785, 0.86),  # right bottom
        P(0.215, 0.86),  # left bottom
        P(0.215, 0.49),  # left wall top
        P(0.12, 0.49),   # left eave
    ]
    d.polygon(poly, fill=255)
    # round the two bottom corners a touch for a modern feel
    return m

# ── the wrench, built upright then rotated, as a white shape ──────────────────
def wrench_mask(angle=32):
    WW, WH = 460, 1000
    w = Image.new("L", (WW, WH), 0)
    d = ImageDraw.Draw(w)
    cx = WW/2
    hw = 70                      # handle half-width
    # handle
    d.rounded_rectangle([cx-hw, 250, cx+hw, 760], radius=hw, fill=255)
    # open-end head (top): a rounded block with a slot cut upward
    d.rounded_rectangle([cx-150, 70, cx+150, 320], radius=70, fill=255)
    d.rounded_rectangle([cx-58, 20, cx+58, 250], radius=40, fill=0)     # the jaw slot
    # box-end ring (bottom): disc with a hole
    d.ellipse([cx-160, 620, cx+160, 940], fill=255)
    d.ellipse([cx-70, 710, cx+70, 850], fill=0)                        # ring hole
    w = w.rotate(angle, expand=True, resample=Image.BICUBIC)
    # center the rotated wrench on a full R×R canvas, scaled to fit the house
    canvas = Image.new("L", (R, R), 0)
    target_h = int(R*0.62)
    scale = target_h / w.height
    w = w.resize((int(w.width*scale), int(w.height*scale)), Image.LANCZOS)
    canvas.paste(w, ((R-w.width)//2, int(R*0.50)-w.height//2))
    return canvas

# ── the gradient symbol with the wrench carved out, transparent elsewhere ─────
def symbol_rgba():
    mask = ImageChops.subtract(house_mask(), wrench_mask())
    grad = gradient((R, R))
    sym = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    sym.paste(grad, (0, 0), mask)
    return sym

SYM = symbol_rgba()

def icon(size, symbol_frac, bg=DARK):
    """Dark square with the symbol centered at the given fraction of the canvas."""
    canvas = Image.new("RGBA", (R, R), bg + (255,))
    s = int(R*symbol_frac)
    sym = SYM.resize((s, s), Image.LANCZOS)
    canvas.alpha_composite(sym, ((R-s)//2, (R-s)//2))
    return canvas.convert("RGB").resize((size, size), Image.LANCZOS)

def transparent_icon(size, symbol_frac):
    canvas = Image.new("RGBA", (R, R), (0, 0, 0, 0))
    s = int(R*symbol_frac)
    sym = SYM.resize((s, s), Image.LANCZOS)
    canvas.alpha_composite(sym, ((R-s)//2, (R-s)//2))
    return canvas.resize((size, size), Image.LANCZOS)

# ── PWA / app icons (dark, full-bleed square) ─────────────────────────────────
icon(192, 0.92).save(f"{OUT}/icon-192.png")
icon(512, 0.92).save(f"{OUT}/icon-512.png")
icon(512, 0.62).save(f"{OUT}/icon-maskable-512.png")   # extra padding = safe zone
icon(180, 0.92).save(f"{OUT}/apple-touch-icon.png")
icon(512, 0.92).save(f"{OUT}/icon.png")
# favicons
icon(32, 0.98).save(f"{OUT}/favicon-32.png")
icon(16, 1.00).save(f"{OUT}/favicon-16.png")
transparent_icon(512, 0.98).save(f"{OUT}/icon-symbol.png")  # for reference

# ── share / link-preview image (1200×630) ─────────────────────────────────────
def font(path, size):
    return ImageFont.truetype(path, size)

def og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), DARK)
    d = ImageDraw.Draw(img)
    # subtle gradient glow behind the mark (very faint)
    # symbol on the left
    s = 360
    sym = SYM.resize((s, s), Image.LANCZOS)
    img.paste(sym, (150, (H-s)//2), sym)
    # wordmark + tagline on the right
    tx = 560
    try:
        f_word = font("/System/Library/Fonts/SFNSRounded.ttf", 200)
    except Exception:
        f_word = font("/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf", 190)
    # "Fix" in white, "It" in gradient-orange for a two-tone wordmark
    word_y = 205
    d.text((tx, word_y), "Fix", font=f_word, fill=(243, 244, 246))
    fixw = d.textlength("Fix", font=f_word)
    d.text((tx+fixw, word_y), "It", font=f_word, fill=ORANGE)
    # tagline, auto-sized so it never runs off the edge
    tagline = "AI home repair — snap, diagnose, book"
    tsize = 42
    while tsize > 24:
        f_tag = font("/System/Library/Fonts/Supplemental/Arial.ttf", tsize)
        if d.textlength(tagline, font=f_tag) <= (W - tx - 60):
            break
        tsize -= 2
    d.text((tx+4, word_y+232), tagline, font=f_tag, fill=(148, 148, 155))
    return img

og_image().save(f"{OUT}/og.png")
print("wrote icons to", OUT)
for fn in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, fn)
    print(f"  {fn:26} {os.path.getsize(p):>7} bytes")
