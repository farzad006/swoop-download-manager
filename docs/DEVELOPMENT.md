# Developing Swoop

## How it fits together

```
Browser extension (WXT, MV3/MV2)
   │  native messaging (stdio, length-prefixed JSON)
   ▼
swoop-host.exe ── one JSON line each way over \\.\pipe\swoop ──► Swoop.exe (Tauri)
                                                                  ├─ swoop-engine: segmented, resumable HTTP(S)
                                                                  ├─ yt-dlp + ffmpeg for site videos
                                                                  ├─ SQLite: downloads, queues, settings
                                                                  └─ React UI
```

| Folder | What's in it |
| --- | --- |
| `crates/engine` | `swoop-engine`: probes, splits files into ranges, dynamic segmentation (idle connections take half of the largest remaining range), If-Range validation, resume from `.part.meta`, speed limiter |
| `crates/host` | `swoop-host.exe`: the native-messaging relay browsers start; launches Swoop for real capture requests only |
| `app/src-tauri` | Backend: manager, queues/scheduler, clipboard monitor, browser detection and host registration (HKCU), yt-dlp integration, pipe server |
| `app/src` | React + Tailwind UI. Each window loads `index.html#/<route>` (main, progress, capture, video, grabber, browsers) |
| `extension` | Browser extension: download takeover, media sniffing, "Download this video" button, context menus, popup |
| `tools/testserver` | Local HTTP server with knobs for ranges, throttling, dropped connections, changing ETags, status codes, and a test page |
| `tools/scripts` | `fake_browser.py` (talks to swoop-host like a browser), installer helpers, icon builders |
| `branding` | Logo sources and renders ([branding/README.md](../branding/README.md)) |

## Tests

```bash
cargo test --workspace                          # engine, app, host
cargo test -p swoop -- --ignored public_hls     # real HLS download via yt-dlp + ffmpeg (network)
npm --prefix extension test                     # extension rules
```

Engine tests run against `tools/testserver` and check every file byte for byte against the server's generated pattern.

**Extension end-to-end** (Edge or Opera; Chrome 137+ ignores `--load-extension`):

```bash
cargo run -p swoop-testserver -- 127.0.0.1:8899
SWOOP_DATA_DIR=%TEMP%\swoop-test target\debug\Swoop.exe --background
SWOOP_DATA_DIR=%TEMP%\swoop-test BROWSER=edge node extension/e2e/chromium.e2e.mjs
```

Two more live checks use the same setup (start Swoop with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` so the scripts can see its windows):

- `node extension/e2e/window-open.check.mjs <port>` confirms windows opened from the app actually load (a window built from a synchronous command deadlocks WebView2).
- `node extension/e2e/video-speed.e2e.mjs` (port 9557) times "Download this video" with and without the advance lookup, and downloads the test server's `/video-page`, whose title contains ’ and –.

The script drives a throwaway browser profile. `SWOOP_DATA_DIR` keeps test runs away from your real download list; pre-create its `swoop.db` settings with `onboarded: true, showCaptureDialog: false` so no windows pop up. Only one Swoop runs at a time.

## UI preview without the backend

`npm --prefix app run dev`, then open http://localhost:1420. A dev-only mock (`app/src/dev/mockBackend.ts`, never bundled) supplies sample data. Add `?onboarding=1` for the welcome tour, `?empty=1` for a new user, or `?clip=1` for the copied-link hint. `node app/scripts/screenshots.mjs` regenerates `docs/screenshots` from it.

## Releasing

Releases are built by GitHub Actions ([.github/workflows/release.yml](../.github/workflows/release.yml)), not on a developer's PC:

1. Bump the version in `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json`, `extension/package.json` and `extension/wxt.config.ts`.
2. Optionally write release notes in `docs/release-notes/v<version>.md` (otherwise GitHub generates them).
3. Commit, push, then tag: `git tag v<version> && git push origin v<version>`.

The workflow checks the tag matches the app version, runs the tests, builds the installer and the extension zips, and publishes the release with `SHA256SUMS.txt`. The installer is always uploaded as **`Swoop-Setup-x64.exe`**, so the README's download button (`releases/latest/download/Swoop-Setup-x64.exe`) serves the newest version.

## Notes

- The Chromium extension ID is fixed by the public key in `extension/extension-key.json`; the native host only accepts that ID (and `swoop@alistudio` for Firefox).
- Browsers don't let installers add non-store extensions, and they ignore `edge://`/`chrome://` URLs passed on the command line. That's why setup is guided (installer page plus the "Connect your browsers" window).
- **Firefox signing:** sign the Firefox build for free as an unlisted add-on (`npx web-ext sign --channel unlisted` in `extension/.output/firefox-mv2`, with AMO API keys), save it as `extension/.output/swoop-firefox.xpi`, and build the installer; the setup window then offers one-click **Install in Firefox**.
- The installer is Tauri's stock NSIS template (`app/src-tauri/installer/tauri-2.12.2-installer.nsi`, MIT/Apache-2.0, © Tauri Programme within The Commons Conservancy) plus one page (`browser-page.nsi`). After upgrading the Tauri CLI, re-fetch its template and rerun `python tools/scripts/splice_installer.py <template>`.
- Swoop was called OurIDM before 1.0; the app copies OurIDM's data on first start.
