import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const configuredApiUrl = process.env.VITE_API_URL?.trim();
const apiOrigin = configuredApiUrl ? new URL(configuredApiUrl).origin : undefined;
const connectSources = ["'self'", ...(apiOrigin ? [apiOrigin] : [])].join(" ");
const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; connect-src ${connectSources}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'

/index.html
  Cache-Control: no-cache

/release.json
  Cache-Control: no-store, no-cache, must-revalidate, max-age=0

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/tally-sw.js
  Cache-Control: no-cache
`;

writeFileSync(resolve(import.meta.dir, "../dist/_headers"), headers, { mode: 0o644 });
