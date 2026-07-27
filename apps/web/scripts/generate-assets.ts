import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";

const publicDir = resolve(import.meta.dir, "../public");
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
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: "#1d3b31" })
  .png()
  .toFile(resolve(publicDir, "maskable-512.png"));

const social = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#1d3b31"/>
  <circle cx="1040" cy="-30" r="380" fill="#29a383" opacity=".18"/>
  <circle cx="1100" cy="610" r="310" fill="#efacb8" opacity=".12"/>
  <image href="data:image/svg+xml;base64,${mark.toString("base64")}" x="100" y="135" width="360" height="360"/>
  <text x="520" y="285" fill="#fff" font-size="88" font-weight="750" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Expenses</text>
  <text x="525" y="365" fill="#adf0d4" font-size="37" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Shared fairly. Reconciled clearly.</text>
</svg>`;
await sharp(Buffer.from(social)).png().toFile(resolve(publicDir, "og-image.png"));

console.info("Generated PWA and social assets from public/brand-mark.svg");
