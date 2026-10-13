// End-to-end check of the extension in a Chromium browser with a throwaway profile.
// BROWSER=edge (default) | opera | chrome — note Chrome 137+ ignores --load-extension.
// Needs: OurIDM running (native host registered), test server on 127.0.0.1:8899,
// `npm run build:chrome` done. Run: node e2e/chromium.e2e.mjs
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EXT_ID = "fhnkijclhenhpkpllphcclallnnkkiib";
const ext = resolve("./.output/chrome-mv3");
const profile = mkdtempSync(join(tmpdir(), "ouridm-edge-"));
const BASE = "http://127.0.0.1:8899";
// Downloads the browser keeps go to the throwaway profile, not the user's folder.
const browserDownloads = join(profile, "downloads");
mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(
  join(profile, "Default", "Preferences"),
  JSON.stringify({ download: { default_directory: browserDownloads, prompt_for_download: false } }),
);
const startedAt = Math.floor(Date.now() / 1000) - 1;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Edge is started directly (not via launchPersistentContext) because Playwright
// would otherwise intercept downloads before the extension sees them.
const BROWSERS = {
  edge: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  opera: join(process.env.LOCALAPPDATA ?? "", "Programs/Opera/opera.exe"),
  chrome: "C:/Program Files/Google/Chrome/Application/chrome.exe",
};
const EDGE = BROWSERS[process.env.BROWSER ?? "edge"];
console.log(`browser: ${process.env.BROWSER ?? "edge"}`);
const PORT = 9333;
const edge = spawn(EDGE, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${ext}`,
  `--load-extension=${ext}`,
  "--window-position=-2400,0",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
]);
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  await sleep(250);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => undefined);
}
const ctx = browser.contexts()[0];
// Playwright routes downloads into its own folder even over CDP; hand control
// back to the browser so the extension's download hooks fire as for a user.
const cdp = await browser.newBrowserCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
try {
  // Edge runs its own built-in extension workers too; find ours by ID.
  let sw;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().includes(EXT_ID));
    if (!sw) await sleep(250);
  }
  const ids = ctx.serviceWorkers().map((w) => new URL(w.url()).host);
  check("extension loads with the fixed ID", !!sw, ids.join(", "));
  if (!sw) throw new Error("extension did not load");
  sw.on("console", (m) => process.env.DEBUG && console.log("  [sw]", m.type(), m.text()));

  const ping = await sw.evaluate(() => chrome.runtime.sendNativeMessage("com.ouridm.host", { type: "ping" }));
  check("native host reachable from the browser", ping?.ok === true, JSON.stringify(ping));

  // On install the extension says hello; OurIDM stores it for its setup window.
  const want = process.env.BROWSER ?? "edge";
  let seenAt;
  for (let i = 0; i < 20 && !seenAt; i++) {
    const dataDir = process.env.OURIDM_DATA_DIR ?? join(process.env.APPDATA ?? "", "com.ouridm.app");
    const db = new DatabaseSync(join(dataDir, "ouridm.db"), { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
    db.close();
    seenAt = row ? JSON.parse(row.value).connectedBrowsers?.[want] : undefined;
    if (!seenAt || seenAt < startedAt) {
      seenAt = undefined;
      await sleep(250);
    }
  }
  check(`OurIDM recorded the extension as connected in ${want}`, !!seenAt, seenAt ? new Date(seenAt * 1000).toLocaleTimeString() : "not recorded");

  const page = await ctx.newPage();
  await page.goto(`${BASE}/page`);

  // Video request → media sniffing.
  await page.evaluate(() => document.getElementById("v").load());
  await sleep(1500);
  const media = await sw.evaluate(async (tabUrl) => {
    const [tab] = await chrome.tabs.query({ url: tabUrl });
    const key = `media:${tab.id}`;
    return Object.values((await chrome.storage.session.get(key))[key] ?? {});
  }, `${BASE}/page`);
  check("video stream detected on the page", media.some((m) => m.url.includes("clip.mp4") && m.kind === "file"), `${media.length} item(s)`);

  // Floating button over the video.
  await page.hover("#v");
  await sleep(300);
  const panelShown = await page.evaluate(() => {
    const host = document.querySelector("ouridm-panel");
    return !!host && getComputedStyle(host).display !== "none";
  });
  check("'Download this video' button appears on hover", panelShown);
  if (!panelShown)
    console.log("  geometry:", JSON.stringify(await page.evaluate(() => {
      const r = document.getElementById("v").getBoundingClientRect();
      return { iw: innerWidth, ih: innerHeight, video: [r.width, r.height, r.top], host: !!document.querySelector("ouridm-panel") };
    })));

  // Captured download: browser cancels, OurIDM gets it.
  await page.click("#zip");
  await sleep(4000);
  const leftInBrowser = await sw.evaluate(() => chrome.downloads.search({ query: ["from-browser"] }));
  check("browser download handed to OurIDM and removed from the browser", leftInBrowser.length === 0, `${leftInBrowser.length} left`);
  if (leftInBrowser.length) console.log("  leftover:", JSON.stringify(leftInBrowser.map(({ state, error, filename, byExtensionId }) => ({ state, error, filename, byExtensionId }))));

  // Non-matching type stays in the browser.
  await page.click("#html");
  await sleep(2000);
  const kept = await sw.evaluate(() => chrome.downloads.search({ query: ["notes"] }));
  check("other file types stay with the browser", kept.length === 1, `${kept.length} found`);

  // Alt+click bypass.
  await page.click("#zip", { modifiers: ["Alt"] });
  await sleep(2500);
  const bypassed = await sw.evaluate(() => chrome.downloads.search({ query: ["from-browser"] }));
  check("Alt+click lets the browser keep a capturable download", bypassed.length >= 1, `${bypassed.length} found`);

  // Popup reports the connection.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await sleep(800);
  const status = await popup.textContent("#status");
  check("popup shows connected status", /Connected/.test(status ?? ""), status ?? "");
} finally {
  await browser.close().catch(() => {});
  edge.kill();
  await sleep(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
