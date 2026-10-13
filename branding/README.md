# Logo

- `logo.svg` — main mark: a download arrow flanked by two speed streaks (several streams, one fast download) on a blue-to-violet tile.
- `logo-small.svg` — 16–32 px version: same arrow, bolder strokes, no streaks or fades, so it stays crisp in the taskbar and browser toolbar.
- `png/` — rendered sizes and `preview.png` (all sizes on light and dark).

Colours: `#60A5FA` → `#4F46E5` → `#7C3AED` (gradient), white mark. UI accent: `#2563EB`.

After editing either SVG, regenerate everything:

```bash
node app/scripts/render-logo.mjs                                  # PNGs + extension icons
npx --prefix app tauri icon branding/png/logo-1024.png            # app icons (then delete icons/android, icons/ios)
python tools/scripts/make_ico.py                                  # icon.ico with the bold 16-32 px version
python tools/scripts/make_installer_art.py app/src-tauri/installer  # installer sidebar/header
```

The in-app copy lives in `app/src/components/Logo.tsx`; keep it in sync with the SVGs.
