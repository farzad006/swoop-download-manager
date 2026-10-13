"""Draws the OurIDM icon (download arrow on a blue rounded square) at 1024px."""
import sys
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# Vertical gradient blue tile
tile = Image.new("RGBA", (S, S))
td = ImageDraw.Draw(tile)
top, bottom = (40, 140, 230), (10, 80, 170)
for y in range(S):
    t = y / (S - 1)
    td.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
img.paste(tile, (0, 0), mask)
w = (255, 255, 255, 255)
# Arrow shaft + head
d.rounded_rectangle([452, 210, 572, 600], radius=40, fill=w)
d.polygon([(292, 520), (732, 520), (512, 760)], fill=w)
# Tray line
d.rounded_rectangle([262, 800, 762, 880], radius=40, fill=w)
img.save(sys.argv[1])
for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(f"{sys.argv[2]}/{size}.png")
