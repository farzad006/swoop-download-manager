"""Builds app/src-tauri/installer/installer.nsi from Tauri's stock NSIS template.

The only change is OurIDM's "Browser integration" page (installer/browser-page.nsi),
inserted right before the installation page. After upgrading the Tauri CLI, fetch
the matching template and rerun:

  curl -L https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v<VERSION>/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi -o tauri-installer.nsi
  python tools/scripts/splice_installer.py tauri-installer.nsi
"""
import pathlib
import sys

ANCHOR = "; 7. Installation page"
here = pathlib.Path(__file__).resolve().parents[2] / "app" / "src-tauri" / "installer"
template = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
block = (here / "browser-page.nsi").read_text(encoding="utf-8")

if template.count(ANCHOR) != 1:
    sys.exit(f"anchor {ANCHOR!r} not found exactly once; the Tauri template changed, update this script")
if "PassiveMode" not in template.split(ANCHOR)[0]:
    sys.exit("PassiveMode is no longer declared before the installation page; check browser-page.nsi")

out = template.replace(ANCHOR, block + ANCHOR)
(here / "installer.nsi").write_text(out, encoding="utf-8", newline="\n")
print(f"wrote {here / 'installer.nsi'}")
