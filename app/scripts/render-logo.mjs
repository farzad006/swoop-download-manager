// Renders the logo SVGs into every icon the app, extension and installer need.
// usage: node app/scripts/render-logo.mjs  (sources in branding/)
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const big = readFileSync(join(root, "branding", "logo.svg"), "utf8");
const small = readFileSync(join(root, "branding", "logo-small.svg"), "utf8");

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
const out = (rel, data) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};

// Master for `tauri icon` and the installer art.
out("branding/png/logo-1024.png", png(big, 1024));
for (const s of [16, 24, 32, 48, 64, 128, 256]) out(`branding/png/logo-${s}.png`, png(s <= 32 ? small : big, s));

// Browser extension icons.
for (const s of [16, 32, 48, 128]) out(`extension/public/icon/${s}.png`, png(s <= 32 ? small : big, s));

// Preview sheet: sizes side by side on light and dark.
const sizes = [256, 128, 64, 48, 32, 16];
const tiles = sizes
  .map((s, i) => {
    const x = 40 + sizes.slice(0, i).reduce((a, b) => a + b + 40, 0);
    const svg = (s <= 32 ? small : big).replace("<svg ", `<svg x="${x}" y="${(296 - s) / 2}" width="${s}" height="${s}" `);
    return svg + svg.replace(`y="${(296 - s) / 2}"`, `y="${296 + (296 - s) / 2}"`);
  })
  .join("");
const W = 40 + sizes.reduce((a, b) => a + b + 40, 0);
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="592"><rect width="${W}" height="296" fill="#F4F6FA"/><rect y="296" width="${W}" height="296" fill="#15181E"/>${tiles}</svg>`;
out("branding/png/preview.png", new Resvg(sheet).render().asPng());
console.log("rendered icons");
