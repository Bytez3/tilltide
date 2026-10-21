# Generates the Tilltide icon set (app icon, Android adaptive layers, splash, favicons).
# Usage: python3 docs/brand-icon.py apps/seeker-app/assets/images agent/public
import math, sys
from PIL import Image, ImageDraw

SEA = (14, 110, 107, 255)
SAND = (246, 243, 238, 255)
FOAM = (154, 214, 205, 255)
INK = (14, 110, 107, 255)

def mark(size, color_receipt=(255, 255, 255, 255), color_lines=INK, color_wave=FOAM, mono=False):
    """The Tilltide mark (receipt + wave) on a transparent canvas, drawn 4x and downsampled."""
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # Receipt: rounded top, zigzag tear at the bottom.
    left, right, top, bottom = S * 0.30, S * 0.70, S * 0.16, S * 0.76
    r = S * 0.05
    d.rounded_rectangle([left, top, right, bottom], radius=r, fill=color_receipt)
    teeth = 6
    w = (right - left) / teeth
    zig = [(left, bottom - 1)]
    for i in range(teeth):
        zig += [(left + w * (i + 0.5), bottom + S * 0.045), (left + w * (i + 1), bottom - 1)]
    d.polygon(zig + [(right, bottom - S * 0.02), (left, bottom - S * 0.02)], fill=color_receipt)
    if not mono:
        # Two "printed" lines and a total.
        lw = S * 0.028
        for y, x2 in [(0.29, 0.62), (0.37, 0.56)]:
            d.rounded_rectangle([left + S * 0.06, S * y, S * x2, S * y + lw], radius=lw / 2, fill=color_lines)
        d.rounded_rectangle([left + S * 0.06, S * 0.47, right - S * 0.06, S * 0.47 + lw * 1.4], radius=lw, fill=color_lines)
    # Two wave strokes washing across the bottom of the receipt: the tide.
    def wave(y0, amp, phase, x0=0.14, x1=0.86):
        return [(S * (x0 + (x1 - x0) * i / 200), S * y0 - S * amp * math.sin((i / 200) * math.pi * 2 + phase)) for i in range(201)]
    w1 = wave(0.66, 0.035, 0.5)
    w2 = wave(0.79, 0.030, 0.9, 0.20, 0.80)
    width1, width2 = S * 0.075, S * 0.06

    def band(pts, width, fill):
        """A smooth stroke: the curve offset by width/2 on each side, closed with round caps."""
        upper, lower = [], []
        for i, (x, y) in enumerate(pts):
            ax, ay = pts[max(i - 1, 0)]
            bx, by = pts[min(i + 1, len(pts) - 1)]
            tx, ty = bx - ax, by - ay
            n = math.hypot(tx, ty) or 1
            nx, ny = -ty / n, tx / n
            upper.append((x + nx * width / 2, y + ny * width / 2))
            lower.append((x - nx * width / 2, y - ny * width / 2))
        d.polygon(upper + lower[::-1], fill=fill)
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=fill)

    if mono:
        # Knock a gap out around the top wave so the one-colour mark still reads.
        band(w1, width1 + S * 0.05, (0, 0, 0, 0))
        band(w1, width1, color_receipt)
        band(w2, width2, color_receipt)
    else:
        band(w1, width1 + S * 0.03, (255, 255, 255, 255))
        band(w1, width1, color_wave)
        band(w2, width2, color_wave)
    return im.resize((size, size), Image.LANCZOS)

def square(size, bg, scale=1.0, radius=0.0):
    S = size * 4
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * radius, fill=bg)
    im = im.resize((size, size), Image.LANCZOS)
    m = mark(int(size * scale))
    off = (size - m.size[0]) // 2
    im.alpha_composite(m, (off, off))
    return im

out = sys.argv[1]
# App icon (iOS/web): full-bleed sea background, mark centred.
square(1024, SEA, scale=0.92).convert('RGB').save(f'{out}/icon.png')
# Android adaptive icon: background layer, foreground in the 66% safe zone, monochrome for themed icons.
Image.new('RGBA', (512, 512), SEA).save(f'{out}/android-icon-background.png')
fg = Image.new('RGBA', (512, 512), (0, 0, 0, 0)); m = mark(340); fg.alpha_composite(m, (86, 86)); fg.save(f'{out}/android-icon-foreground.png')
mono = Image.new('RGBA', (432, 432), (0, 0, 0, 0)); mm = mark(286, mono=True); mono.alpha_composite(mm, (73, 73)); mono.save(f'{out}/android-icon-monochrome.png')
# Splash: the rounded app tile on the sand background colour set in app.json.
square(1024, SEA, scale=0.92, radius=0.22).save(f'{out}/splash-icon.png')
# Favicons.
square(48, SEA, scale=0.95, radius=0.22).save(f'{out}/favicon.png')
square(192, SEA, scale=0.95, radius=0.22).save(f'{sys.argv[2]}/favicon.png')
print('ok')
