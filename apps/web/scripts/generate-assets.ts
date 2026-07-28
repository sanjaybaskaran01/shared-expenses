import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const mark = await readFile(resolve(publicDir, "brand-mark.svg"));

for (const [filename, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
] as const) {
  await sharp(mark).resize(size, size).png().toFile(resolve(publicDir, filename));
}

await sharp(mark)
  .resize(410, 410, { fit: "contain" })
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: "#132f3a" })
  .png()
  .toFile(resolve(publicDir, "maskable-512.png"));

const social = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#132f3a"/>
  <image href="data:image/svg+xml;base64,${mark.toString("base64")}" x="100" y="135" width="360" height="360"/>
  <text x="520" y="285" fill="#fbfaf8" font-size="88" font-weight="700" font-family="Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Tally</text>
  <text x="525" y="365" fill="#c6e0d4" font-size="37" font-family="Inter,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Shared fairly. Reconciled clearly.</text>
</svg>`;
await sharp(Buffer.from(social)).png().toFile(resolve(publicDir, "og-image.png"));

console.info("Generated PWA and social assets from public/brand-mark.svg");
