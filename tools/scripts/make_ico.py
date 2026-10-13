"""Builds app/src-tauri/icons/icon.ico from the per-size logo PNGs.

Each size uses its own rendering (the bold small-size logo at 16-32 px) instead
of a blurry downscale. Run after app/scripts/render-logo.mjs.
"""
from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[2]
sizes = [16, 24, 32, 48, 64, 128, 256]
imgs = [Image.open(root / "branding" / "png" / f"logo-{s}.png").convert("RGBA") for s in sizes]
icons = root / "app" / "src-tauri" / "icons"
imgs[-1].save(icons / "icon.ico", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
imgs[2].save(icons / "32x32.png")
print("wrote", icons / "icon.ico")
