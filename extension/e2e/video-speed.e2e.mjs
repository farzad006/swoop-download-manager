// Live check of the "Download this video" flow in the real app:
//  - how long after the click the quality list appears, without and with
//    "Get videos ready in advance";
//  - that a video whose title has ’ and – finishes as completed.
// Needs: swoop-testserver on 127.0.0.1:8899, Swoop started with SWOOP_DATA_DIR
// and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9557,
// `npm run build:chrome`. Run: SWOOP_DATA_DIR=... node e2e/video-speed.e2e.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_ID = "fhnkijclhenhpkpllphcclallnnkkiib";
const BASE = "http://127.0.0.1:8899";
const DATA = process.env.SWOOP_DATA_DIR;
if (!DATA) throw new Error("set SWOOP_DATA_DIR to the test Swoop's data folder");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// --- the app's own WebView2 (to drive settings and watch its windows)
let app;
for (let i = 0; i < 40 && !app; i++) {
  app = await chromium.connectOverCDP("http://127.0.0.1:9557").catch(() => undefined);
  if (!app) await sleep(250);
}
if (!app) throw new Error("couldn't attach to Swoop's WebView2 on port 9557");
const appPages = () => app.contexts().flatMap((c) => c.pages());
const main = appPages().find((p) => !p.url().includes("#/"));
const invoke = (cmd, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const setPrefetch = async (on) => {
  const s = await invoke("get_settings");
  await invoke("save_settings", { settings: { ...s, videoPrefetch: on, videoClickAction: "ask" } });
};

// --- Edge with the extension, throwaway profile
const ext = resolve("./.output/chrome-mv3");
const profile = mkdtempSync(join(tmpdir(), "swoop-video-"));
mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: join(profile, "dl"), prompt_for_download: false } }));
const edge = spawn("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
  `--user-data-dir=${profile}`, "--remote-debugging-port=9334", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`,
  "--window-position=-2400,0", "--no-first-run", "--no-default-browser-check", "about:blank",
]);
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9334").catch(() => undefined);
  if (!browser) await sleep(250);
}
const ctx = browser.contexts()[0];
for (let i = 0; i < 60 && !ctx.serviceWorkers().some((w) => w.url().includes(EXT_ID)); i++) await sleep(250);

/** Opens a fresh copy of the test page, waits `think` ms (a person moving to the
 *  button), clicks "Download this video" and times until the quality list shows. */
async function clickToQualityList(think) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/video-page?n=${Date.now()}`); // new URL each time: nothing cached
  const v = await page.locator("#v").boundingBox();
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2); // the button appears
  await sleep(think);
  const box = await page.locator("swoop-panel").boundingBox();
  const before = new Set(appPages());
  const t0 = Date.now();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  let dialog, ms = null;
  for (let i = 0; i < 300 && ms == null; i++) {
    dialog = appPages().find((p) => !before.has(p) && p.url().includes("#/video/"));
    if (dialog && (await dialog.evaluate(() => document.body.innerText.includes("Quality")).catch(() => false))) ms = Date.now() - t0;
    else await sleep(50);
  }
  return { page, dialog, ms };
}

try {
  await setPrefetch(false);
  const off = await clickToQualityList(1500);
  check("quality list appears (advance lookup off)", off.ms != null, `${off.ms} ms after the click`);
  await off.dialog?.close().catch(() => {});
  await off.page.close();

  await setPrefetch(true);
  const on = await clickToQualityList(1500);
  check("quality list appears (advance lookup on)", on.ms != null, `${on.ms} ms after the click`);
  check("advance lookup makes the list appear faster", on.ms != null && off.ms != null && on.ms < off.ms / 2, `${off.ms} ms → ${on.ms} ms`);

  // Download it: the title has ’ and –.
  await on.dialog.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Download").click());
  let row;
  for (let i = 0; i < 120; i++) {
    const db = new DatabaseSync(join(DATA, "swoop.db"), { readOnly: true });
    row = db.prepare("SELECT status, file_name, dest_dir, error FROM downloads WHERE kind = 'video' ORDER BY id DESC LIMIT 1").get();
    db.close();
    if (row && (row.status === "completed" || row.status === "failed")) break;
    await sleep(500);
  }
  check("video with ’ and – in its title finishes as completed", row?.status === "completed", `${row?.status}: ${row?.file_name}${row?.error ? " | " + row.error : ""}`);
  check("the file is on disk", !!row && existsSync(join(row.dest_dir, row.file_name)), row ? join(row.dest_dir, row.file_name) : "");
  await on.page.close();
} finally {
  await browser.close().catch(() => {});
  edge.kill();
  await app.close().catch(() => {});
  await sleep(1000);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {
    /* Edge may still hold the throwaway profile for a moment */
  }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
