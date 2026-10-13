// Captures README screenshots of the UI (dev server + mock backend) with Edge.
// usage: npm run dev (in another terminal), then: node scripts/screenshots.mjs
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "screenshots");
mkdirSync(out, { recursive: true });
const BASE = "http://localhost:1420";
const shots = [
  { name: "main", url: "/", size: [1180, 720] },
  { name: "main-dark", url: "/", size: [1180, 720], dark: true },
  { name: "welcome", url: "/?onboarding=1", size: [1180, 720] },
  { name: "empty", url: "/?empty=1", size: [1180, 720] },
  { name: "download-dialog", url: "/#/capture/demo", size: [600, 470] },
  { name: "video-quality", url: "/#/video/demo", size: [680, 600] },
  { name: "progress", url: "/#/progress/1", size: [540, 420] },
  { name: "browsers", url: "/#/browsers/chrome,edge,opera,firefox", size: [700, 640] },
  { name: "settings", url: "/", size: [1180, 720], click: 'button[aria-label="Settings"]' },
  { name: "support", url: "/", size: [1180, 720], click: 'button[aria-label="Support Swoop"]' },
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: 2, colorScheme: s.dark ? "dark" : "light" });
  await page.goto(BASE + s.url);
  await page.waitForTimeout(1800);
  if (s.click) {
    await page.click(s.click);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: join(out, `${s.name}.png`) });
  await page.close();
  console.log("saved", s.name);
}
await browser.close();
