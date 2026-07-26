import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/rotate-generation.ts /absolute/path/to/restored.sqlite");
const databasePath = resolve(path);
const db = new Database(databasePath, { strict: true });
try {
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error("Restored database failed integrity_check");
  const generation = randomUUID();
  db.query(
    `INSERT INTO app_meta(key, value) VALUES ('generation', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(generation);
  console.info(`Rotated server generation for ${databasePath}`);
} finally {
  db.close();
}
