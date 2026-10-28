import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createApp } from "./app";
import type { DB } from "./db";
import * as schema from "./db/schema";

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  const here = dirname(fileURLToPath(import.meta.url));
  migrate(db, { migrationsFolder: process.env.DURA_MIGRATIONS ?? resolve(here, "../drizzle") });
  return db as unknown as DB;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const db = openDatabase(process.env.DURA_DB_PATH ?? "./data/dura.db");
  const app = createApp({
    db,
    config: {
      setupToken: process.env.DURA_SETUP_TOKEN,
      origin: process.env.DURA_ORIGIN,
      rpName: process.env.DURA_NAME,
      vapidSubject: process.env.DURA_VAPID_SUBJECT,
    },
  });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, (info) => {
    console.log(`dura listening on http://localhost:${info.port}`);
  });
}
