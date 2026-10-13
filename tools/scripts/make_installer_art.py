"""Draws the NSIS installer artwork (24-bit BMPs, the format NSIS needs).

usage: python make_installer_art.py <out_dir>
  sidebar.bmp 164x314 - welcome/finish pages
  header.bmp  150x57  - top-right of the other pages
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
FONTS = Path("C:/Windows/Fonts")


def font(name, size):
    try:
        return ImageFont.truetype(str(FONTS / name), size)
    except OSError:
        return ImageFont.load_default()


LOGO = Path(__file__).resolve().parents[2] / "branding" / "png" / "logo-256.png"


def logo(size):
    """The app logo (rendered by app/scripts/render-logo.mjs), else a drawn fallback."""
    if LOGO.is_file():
        return Image.open(LOGO).convert("RGBA").resize((size, size), Image.LANCZOS)
    s = size * 4  # supersample for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=(37, 99, 235, 255))
    w = (255, 255, 255, 255)
    d.rounded_rectangle([s * 0.44, s * 0.2, s * 0.56, s * 0.58], radius=s * 0.04, fill=w)
    d.polygon([(s * 0.29, s * 0.5), (s * 0.71, s * 0.5), (s * 0.5, s * 0.73)], fill=w)
    d.rounded_rectangle([s * 0.27, s * 0.78, s * 0.73, s * 0.85], radius=s * 0.035, fill=w)
    return img.resize((size, size), Image.LANCZOS)


# Sidebar: deep blue gradient, logo, name, tagline.
W, H = 164, 314
side = Image.new("RGB", (W, H))
top, bottom = (67, 56, 202), (15, 23, 42)
px = side.load()
for y in range(H):
    t = y / (H - 1)
    for x in range(W):
        k = min(1, t + x / W * 0.15)
        px[x, y] = tuple(int(top[i] + (bottom[i] - top[i]) * k) for i in range(3))
d = ImageDraw.Draw(side)
for r, a in ((120, 18), (80, 14)):  # soft glow circles
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse([W - r, -r // 2, W + r, r + r // 2], fill=a)
    side.paste((96, 165, 250), (0, 0), glow)
tile = logo(56)
side.paste(tile, (24, 40), tile)
d.text((24, 110), "Swoop", font=font("segoeuib.ttf", 26), fill=(255, 255, 255))
d.text((24, 146), "Fast, resumable\ndownloads and\nweb videos.", font=font("segoeui.ttf", 12), fill=(191, 219, 254), spacing=3)
d.text((24, H - 34), "by Ali Studio", font=font("segoeuisb.ttf", 11), fill=(165, 180, 252))
side.save(out / "sidebar.bmp")

# Header: white, logo at the right.
hdr = Image.new("RGB", (150, 57), (255, 255, 255))
small = logo(36)
hdr.paste(small, (150 - 36 - 10, (57 - 36) // 2), small)
hdr.save(out / "header.bmp")
print("wrote", out / "sidebar.bmp", out / "header.bmp")
