# Swoop

*by Ali Studio*

A download manager for Windows in the spirit of IDM: segmented multi-connection downloads with resume, queues and a scheduler, clipboard monitoring, and browser integration for Chrome, Edge, Opera, Brave and Firefox that catches downloads and web videos.

Built from scratch (no IDM code): Rust download engine, Tauri + React desktop app, a native-messaging host, and a WXT browser extension. Site videos (YouTube, Instagram, X, Vimeo, HLS/DASH streams…) go through [yt-dlp](https://github.com/yt-dlp/yt-dlp) and ffmpeg.

DRM-protected streams (Netflix, Prime Video, Disney+, Spotify…) can't be downloaded; Swoop says so instead of failing silently.

## Install

1. Run `target\release\bundle\nsis\Swoop_0.4.0_x64-setup.exe` (per-user, no admin). The **Browser integration** page lists the browsers Windows knows about; tick the ones you use.
2. When Swoop starts, its **Connect your browsers** window walks through each ticked browser: *Open <browser>* (the extensions-page address is copied — press Ctrl+L, Ctrl+V, Enter), turn on Developer mode, then drag the extension folder that *Show the extension folder* selects onto the page. The card turns green when the extension reports in. Reopen it any time from Options → Browsers → *Set up browsers…*.
3. Video sites need **yt-dlp** and **ffmpeg** on `PATH` (already the case on this PC: yt-dlp via pip, ffmpeg via winget). With *Options → Video → Keep yt-dlp up to date* on, Swoop upgrades yt-dlp once a day (`pip install -U yt-dlp` for pip installs).

Why the extension step isn't fully automatic: Chrome, Edge, Opera and Brave only let installers add extensions that come from their web stores (anything else needs the one-time developer-mode load), and they refuse to open `edge://`/`chrome://` pages for other programs. Firefox only installs Mozilla-signed add-ons. Publishing to the stores would turn this into a one-click "Enable extension?" prompt, the way IDM does it.

- **Firefox** (140+): the setup window offers `about:debugging` → **Load Temporary Add-on** with the manifest path. Temporary add-ons vanish on restart; for a permanent install, sign it for free as an *unlisted* add-on on [addons.mozilla.org](https://addons.mozilla.org/developers/) (`npx web-ext sign --channel unlisted` in `extension/.output/firefox-mv2`) and save it as `extension/.output/swoop-firefox.xpi` before building the installer — the setup window then shows a one-click **Install in Firefox**.
- The Chromium extension ID must be `fhnkijclhenhpkpllphcclallnnkkiib` (fixed by `extension/extension-key.json`); Firefox's is `swoop@alistudio`.

**Upgrading from OurIDM** (Swoop's earlier name): install Swoop, then uninstall "OurIDM" from Windows Settings → Apps. Swoop brings over OurIDM's download list and settings on its first start. Reload the browser extension from Swoop's folder (Swoop shows the path) since the connector's name changed; the Chrome/Edge/Opera extension ID stays the same.

## Using it

| IDM feature | In Swoop |
| --- | --- |
| Browser download takeover | Matching file types are cancelled in the browser and handed over with cookies, referrer and user-agent. Hold **Alt** while clicking to let the browser keep it. |
| "Download this video" panel | Button over playing/hovered videos; pick quality (or audio-only MP3). |
| Right-click menu | *Download with Swoop*, *Download all links* (link grabber with type filters), *Download video from this page*. |
| Add URL | Paste into the bar at the top, press **Ctrl+V** anywhere in the window, or drag a link in from the browser. Copied links are offered automatically. |
| Download file dialog | Name, folder and type chips; **Download now** or **Later** (adds to the queue). |
| Download list | Cards with progress, speed and "about 2 min left"; the right button for each state (Pause, Resume, Open, Show in folder, Fix link, Try again). Search, sort, and select several with Ctrl/Shift for bulk actions; Del deletes, Ctrl+F searches, Ctrl+A selects all. |
| Progress window | Big percentage, speed, time left, optional per-connection view; turns into *Download complete*. |
| Dynamic segmentation | Up to 32 connections; idle connections take over half of the slowest range. |
| Resume | Survives pauses, crashes and reboots; If-Range detects files changed on the server and restarts cleanly. |
| Errors | Explained in plain words with a next step, e.g. an expired link shows **Fix link** (keeps downloaded data). |
| Queues & scheduler | Named queues, files at a time, start/stop times and days with a plain-English summary, then nothing / close / sleep / shut down (1-minute warning; `shutdown /a` cancels). |
| Categories | Videos, Music, Documents, Programs, Archives, Other — each with its own `Downloads\<Category>` folder. |
| Settings | Sections with a one-line explanation per option: General, Downloads, Browsers, Speed, Videos, File types, Advanced. |
| First run | A welcome tour: what Swoop does, where files go, connecting browsers, how to download. Settings → General → *Welcome tour* shows it again. |
| Tray | Closing the window keeps Swoop in the tray; *Exit* pauses downloads first so they resume next time. |

## Layout

```
crates/engine      segmented, resumable HTTP(S) engine (swoop-engine)
crates/host        swoop-host.exe: browser native-messaging ⇄ \\.\pipe\swoop relay
app/src-tauri      desktop backend: SQLite, manager, queues, scheduler, yt-dlp, pipe server
app/src            React UI (main window, progress, capture, video picker, link grabber)
extension          WXT extension (Chromium MV3 + Firefox MV2 builds)
tools/testserver   local HTTP server with range/throttle/drop/ETag knobs for tests
tools/scripts      fake_browser.py (talks to swoop-host like a browser), make_icon.py
```

## Development

```bash
cargo test --workspace                              # engine, app, host
cargo test -p swoop -- --ignored public_hls        # real HLS download via yt-dlp + ffmpeg (network)
npm --prefix extension test                         # extension rules
npm --prefix extension run build                    # .output/chrome-mv3 and firefox-mv2
npm --prefix app run tauri dev                      # run the app with hot reload
npm --prefix app run installer                      # release build + NSIS installer
```

UI preview without the Rust backend: `npm --prefix app run dev` and open http://localhost:1420 (add `?onboarding=1` for the welcome tour, `?empty=1` for a new user, `?clip=1` for the copied-link hint) — a dev-only mock (`app/src/dev/mockBackend.ts`) supplies sample downloads; it's never included in builds.

Extension end-to-end test (needs Swoop running and `cargo run -p swoop-testserver`): `BROWSER=edge node extension/e2e/chromium.e2e.mjs` (or `opera`). It drives a throwaway browser profile; Chrome 137+ ignores `--load-extension`, so Chrome can't be automated this way.

The Chromium extension ID is fixed by the public key in `extension/extension-key.json`; the native host only accepts that ID (and `swoop@alistudio` for Firefox).

Tests that run the app (`SWOOP_DATA_DIR=<temp folder>` keeps them away from your real download list — set it on the app and on the e2e script). Only one Swoop runs at a time, so close an installed copy first.

The installer is Tauri's stock NSIS template plus one page (`app/src-tauri/installer/browser-page.nsi`). After upgrading the Tauri CLI, re-fetch its template and rerun `python tools/scripts/splice_installer.py <template>` (instructions in the script).
