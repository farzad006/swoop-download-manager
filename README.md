# OurIDM

A personal Internet Download Manager–style app for Windows: segmented multi-connection downloads with resume, queues and a scheduler, clipboard monitoring, and browser integration for Chrome, Edge, Opera, Brave and Firefox that catches downloads and web videos.

Built from scratch (no IDM code): Rust download engine, Tauri + React desktop app, a native-messaging host, and a WXT browser extension. Site videos (YouTube, Instagram, X, Vimeo, HLS/DASH streams…) go through [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg.

DRM-protected streams (Netflix, Prime Video, Disney+, Spotify…) can't be downloaded; OurIDM says so instead of failing silently.

## Install

1. Run `target\release\bundle\nsis\OurIDM_0.2.0_x64-setup.exe` (per-user, no admin). The **Browser integration** page lists the browsers Windows knows about; tick the ones you use.
2. When OurIDM starts, its **Connect your browsers** window walks through each ticked browser: *Open <browser>* (the extensions-page address is copied — press Ctrl+L, Ctrl+V, Enter), turn on Developer mode, then drag the extension folder that *Show the extension folder* selects onto the page. The card turns green when the extension reports in. Reopen it any time from Options → Browsers → *Set up browsers…*.
3. Video sites need **yt-dlp** and **ffmpeg** on `PATH` (already the case on this PC: yt-dlp via pip, ffmpeg via winget). With *Options → Video → Keep yt-dlp up to date* on, OurIDM upgrades yt-dlp once a day (`pip install -U yt-dlp` for pip installs).

Why the extension step isn't fully automatic: Chrome, Edge, Opera and Brave only let installers add extensions that come from their web stores (anything else needs the one-time developer-mode load), and they refuse to open `edge://`/`chrome://` pages for other programs. Firefox only installs Mozilla-signed add-ons. Publishing to the stores would turn this into a one-click "Enable extension?" prompt, the way IDM does it.

- **Firefox** (140+): the setup window offers `about:debugging` → **Load Temporary Add-on** with the manifest path. Temporary add-ons vanish on restart; for a permanent install, sign it for free as an *unlisted* add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) (`npx web-ext sign --channel unlisted` in `extension/.output/firefox-mv2`) and save it as `extension/.output/ouridm-firefox.xpi` before building the installer — the setup window then shows a one-click **Install in Firefox**.
- The Chromium extension ID must be `fhnkijclhenhpkpllphcclallnnkkiib` (fixed by `extension/extension-key.json`); Firefox's is `ouridm@local`.

## Using it

| IDM feature | In OurIDM |
| --- | --- |
| Browser download takeover | Matching file types are cancelled in the browser and handed over with cookies, referrer and user-agent. Hold **Alt** while clicking to let the browser keep it. |
| "Download this video" panel | Button over playing/hovered videos; pick quality (or audio-only MP3). |
| Right-click menu | *Download with OurIDM*, *Download all links* (link grabber with type filters), *Download video from this page*. |
| Download File Info dialog | Category, folder, name, description; **Start download** or **Download later** (main queue). |
| Progress window | Speed, ETA, per-connection segment bar, pause/resume; turns into *Download complete*. |
| Dynamic segmentation | Up to 32 connections; idle connections take over half of the slowest range. |
| Resume | Survives pauses, crashes and reboots; If-Range detects files changed on the server and restarts cleanly. |
| Expired links | Right-click → *Refresh download address…*, keeps downloaded data. |
| Queues & scheduler | Named queues, concurrency, start/stop times and days, then nothing / exit / sleep / shut down (1-minute warning; `shutdown /a` cancels). |
| Clipboard monitor | Copying a link to a capturable file opens the dialog. |
| Categories | Compressed, Documents, Music, Programs, Video, General — each with its own `Downloads\<Category>` folder. |
| Speed limiter, proxy | Options → Connection (global KB/s limit; http/https/socks5 proxy or system proxy). |
| Tray | Closing the window keeps OurIDM in the tray; *Exit* pauses downloads first so they resume next time. |

## Layout

```
crates/engine      segmented, resumable HTTP(S) engine (idm-engine)
crates/host        idm-host.exe: browser native-messaging ⇄ \\.\pipe\ouridm relay
app/src-tauri      desktop backend: SQLite, manager, queues, scheduler, yt-dlp, pipe server
app/src            React UI (main window, progress, capture, video picker, link grabber)
extension          WXT extension (Chromium MV3 + Firefox MV2 builds)
tools/testserver   local HTTP server with range/throttle/drop/ETag knobs for tests
tools/scripts      fake_browser.py (talks to idm-host like a browser), make_icon.py
```

## Development

```bash
cargo test --workspace                              # engine, app, host
cargo test -p ouridm -- --ignored public_hls        # real HLS download via yt-dlp + ffmpeg (network)
npm --prefix extension test                         # extension rules
npm --prefix extension run build                    # .output/chrome-mv3 and firefox-mv2
npm --prefix app run tauri dev                      # run the app with hot reload
npm --prefix app run installer                      # release build + NSIS installer
```

UI preview without the Rust backend: `npm --prefix app run dev` and open http://localhost:1420 — a dev-only mock (`app/src/dev/mockBackend.ts`) supplies sample downloads; it's never included in builds.

Extension end-to-end test (needs OurIDM running and `cargo run -p idm-testserver`): `BROWSER=edge node extension/e2e/chromium.e2e.mjs` (or `opera`). It drives a throwaway browser profile; Chrome 137+ ignores `--load-extension`, so Chrome can't be automated this way.

The Chromium extension ID is fixed by the public key in `extension/extension-key.json`; the native host only accepts that ID (and `ouridm@local` for Firefox).

Tests that run the app (`OURIDM_DATA_DIR=<temp folder>` keeps them away from your real download list — set it on the app and on the e2e script). Only one OurIDM runs at a time, so close an installed copy first.

The installer is Tauri's stock NSIS template plus one page (`app/src-tauri/installer/browser-page.nsi`). After upgrading the Tauri CLI, re-fetch its template and rerun `python tools/scripts/splice_installer.py <template>` (instructions in the script).
