import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

export function runDomainMigrations(db: Database, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all();
  const names = new Set(applied.map(({ name }) => name));
  for (const filename of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    if (names.has(filename)) continue;
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)").run(
        filename,
        new Date().toISOString(),
      );
    })();
  }

  const generation = db.query<{ value: string }, [string]>("SELECT value FROM app_meta WHERE key = ?").get(
    "generation",
  );
  if (!generation) {
    db.query("INSERT INTO app_meta(key, value) VALUES ('generation', ?)").run(randomUUID());
  }
}
