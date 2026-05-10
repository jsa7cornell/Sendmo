#!/usr/bin/env node
// Generates favicon + PWA icons + OG card from src/assets/sendmo-logo.svg.
// Re-run with: node scripts/generate-brand-assets.mjs
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = await readFile(resolve(root, "src/assets/sendmo-logo.svg"));
const out = (p) => resolve(root, "public", p);
await mkdir(resolve(root, "public"), { recursive: true });

const PRIMARY = { r: 22, g: 129, b: 229 }; // hsl(214 89% 52%)

async function pngFromSvg(svgBuf, size, bg = null) {
  const pipe = sharp(svgBuf, { density: 384 }).resize(size, size);
  if (bg) pipe.flatten({ background: bg });
  return pipe.png().toBuffer();
}

// Square PNGs
const sizes = { "favicon-32.png": 32, "favicon-48.png": 48, "apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512, "icon-512-maskable.png": 512 };
for (const [name, size] of Object.entries(sizes)) {
  const buf = await pngFromSvg(src, size);
  await writeFile(out(name), buf);
  console.log("✓", name, `${size}x${size}`);
}

// favicon.ico (multi-size)
const ico = await pngToIco([await pngFromSvg(src, 16), await pngFromSvg(src, 32), await pngFromSvg(src, 48)]);
await writeFile(out("favicon.ico"), ico);
console.log("✓ favicon.ico (16/32/48)");

// OG image: 1200x630 with mark + wordmark + tagline on brand blue
const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="hsl(214 89% 52%)"/>
  <g transform="translate(420 130) scale(5.5)">
    <rect width="64" height="64" rx="14" fill="white" fill-opacity="0.12"/>
    <path d="M40 20 H28 a6 6 0 0 0 0 12 h8 a6 6 0 0 1 0 12 H24" fill="none" stroke="white" stroke-width="4.5" stroke-linecap="round"/>
    <circle cx="40" cy="20" r="4" fill="white" opacity="0.7"/>
    <circle cx="24" cy="44" r="4" fill="white"/>
  </g>
  <text x="600" y="510" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif" font-size="84" font-weight="800" fill="white" letter-spacing="-2">SendMo</text>
  <text x="600" y="568" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif" font-size="28" font-weight="500" fill="white" fill-opacity="0.85">Prepaid shipping made easy</text>
</svg>`;
await sharp(Buffer.from(ogSvg)).png().toFile(out("og-image.png"));
console.log("✓ og-image.png 1200x630");

console.log("\nDone. Source: src/assets/sendmo-logo.svg → public/");
