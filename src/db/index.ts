import type { BatchItem } from "drizzle-orm/batch";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "./schema";

// Works for both better-sqlite3 (sync) and D1 (async): every query is awaited.
export type DB = BaseSQLiteDatabase<"sync" | "async", unknown, typeof schema>;

export type Write = BatchItem<"sqlite">;

/**
 * Runs the given write queries all-or-nothing: if any of them fails, none of them take effect.
 * Pass the query builders without awaiting them.
 *
 * D1 has no interactive transactions, but `batch` runs the statements in one transaction.
 * better-sqlite3 has no `batch`; there a synchronous transaction runs them on the same connection,
 * so no other request's query can interleave.
 */
export async function atomic(db: DB, queries: readonly [Write, ...Write[]]): Promise<void> {
  const batchable = db as unknown as { batch?: (q: readonly [Write, ...Write[]]) => Promise<unknown> };
  if (typeof batchable.batch === "function") {
    await batchable.batch(queries);
    return;
  }
  db.transaction(() => {
    for (const q of queries) (q as unknown as { run(): unknown }).run();
  });
}

export * as schema from "./schema";
