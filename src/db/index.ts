import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

// Works for both better-sqlite3 (sync) and D1 (async): every query is awaited.
export type DB = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export * as schema from "./schema";
