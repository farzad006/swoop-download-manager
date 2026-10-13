// Opens the "Connect your browsers" window through the app's own IPC and reports
// whether its page actually loaded. Needs Swoop started with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<PORT>.
// usage: node e2e/window-open.check.mjs <PORT>
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "9555";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
for (let i = 0; i < 40 && !browser; i++) {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
  if (!browser) await sleep(250);
}
if (!browser) throw new Error("could not attach to the app's WebView2");
const pages = () => browser.contexts().flatMap((c) => c.pages());
const main = pages().find((p) => !p.url().includes("#/"));
console.log("main window:", main?.url());
// Same call the "Connect a browser" button makes; don't await it (the bug is a hang).
main.evaluate(() => window.__TAURI_INTERNALS__.invoke("open_browser_setup_window", { selected: [] })).catch(() => {});
let result = "window never appeared";
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const target = pages().find((p) => p.url().includes("#/browsers"));
  if (!target) continue;
  const state = await Promise.race([
    target.evaluate(() => ({ ready: document.readyState, text: document.body.innerText.slice(0, 60) })).catch((e) => ({ error: String(e) })),
    sleep(3000).then(() => ({ error: "page not responding" })),
  ]);
  result = JSON.stringify({ url: target.url(), ...state });
  if (state.text?.includes("Connect Swoop")) break;
}
const responsive = await Promise.race([main.evaluate(() => 1).then(() => "yes"), sleep(3000).then(() => "NO (frozen)")]);
console.log("browsers window:", result);
console.log("main window still responsive:", responsive);
await browser.close().catch(() => {});
process.exit(0);
