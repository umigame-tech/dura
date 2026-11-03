import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { DB } from "../src/db";
import * as schema from "../src/db/schema";
import {
  appendJournal,
  createState,
  findSection,
  findState,
  findSummary,
  getJournalEntry,
  listJournal,
  listJournalBefore,
  putSection,
  putSummary,
  searchJournal,
} from "../src/store";

// The same atomic writes as test/atomic.test.ts, on the real drizzle D1 driver (batch) against wrangler's local D1.
describe("atomic writes on D1", () => {
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
  let d1: D1Database;
  let db: DB;
  const persist = mkdtempSync(join(tmpdir(), "dura-d1-"));

  beforeAll(async () => {
    proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: resolve(__dirname, "../wrangler.toml"),
      persist: { path: persist },
    });
    d1 = proxy.env.DB;
    const dir = resolve(__dirname, "../drizzle");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
        if (stmt.trim()) await d1.prepare(stmt).run();
      }
    }
    db = drizzle(d1, { schema }) as unknown as DB;
  }, 60_000);

  afterAll(async () => {
    await proxy?.dispose();
    rmSync(persist, { recursive: true, force: true });
  });

  const count = async (table: string, stateId: string) =>
    (await d1.prepare(`SELECT count(*) AS n FROM ${table} WHERE state_id = ?`).bind(stateId).first<{ n: number }>())?.n;

  it("rolls back a state whose initial section fails, and reports a real duplicate as already_exists", async () => {
    await d1.exec(
      "CREATE TRIGGER fail_boom BEFORE INSERT ON sections WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    try {
      await expect(createState(db, { id: "c", title: "C", sections: { goal: "g", boom: "x" } }, "me")).rejects.toThrow(
        /boom/,
      );
      expect(await findState(db, "c")).toBeUndefined();
      expect(await count("section_revisions", "c")).toBe(0);
    } finally {
      await d1.exec("DROP TRIGGER fail_boom");
    }
    await createState(db, { id: "c", title: "C", sections: { goal: "g" } }, "me");
    await expect(createState(db, { id: "c", title: "C" }, "me")).rejects.toMatchObject({ code: "already_exists" });
  });

  it("rolls back a section write and a journal entry when touching the state fails", async () => {
    await createState(db, { id: "p", title: "P", sections: { plan: "v1" } }, "me");
    await d1.exec(
      "CREATE TRIGGER fail_touch BEFORE UPDATE ON states WHEN NEW.id = 'p' BEGIN SELECT RAISE(ABORT, 'touch'); END",
    );
    try {
      // A trigger failure is not a version conflict, even though D1 calls it SQLITE_CONSTRAINT.
      await expect(putSection(db, "p", "plan", "v2", 1, "me")).rejects.toThrow(/touch/);
      await expect(appendJournal(db, "p", "me", "note", "x")).rejects.toThrow(/touch/);
      expect(await count("section_revisions", "p")).toBe(1);
      expect(await count("journal_entries", "p")).toBe(0);
    } finally {
      await d1.exec("DROP TRIGGER fail_touch");
    }
    expect((await putSection(db, "p", "plan", "v2", 1, "me")).version).toBe(2);
  });

  it("lets exactly one concurrent section writer win with version_conflict for the other", async () => {
    await createState(db, { id: "r", title: "R", sections: { plan: "v1" } }, "me");
    const results = await Promise.allSettled([
      putSection(db, "r", "plan", "a", 1, "me"),
      putSection(db, "r", "plan", "b", 1, "me"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "version_conflict" });
    expect((await findSection(db, "r", "plan"))?.version).toBe(2);
  });

  it("retries concurrent journal appends on the next seq", async () => {
    await createState(db, { id: "j", title: "J" }, "me");
    await Promise.all(Array.from({ length: 5 }, (_, i) => appendJournal(db, "j", "me", "note", `n${i}`)));
    expect((await listJournal(db, "j")).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads the newest entries before a seq, and one entry by seq", async () => {
    await createState(db, { id: "b", title: "B" }, "me");
    for (let i = 1; i <= 5; i++) await appendJournal(db, "b", "me", "note", `n${i}`);
    const latest = await listJournalBefore(db, "b", { before: Number.MAX_SAFE_INTEGER, limit: 2 });
    expect(latest.entries.map((e) => e.seq)).toEqual([4, 5]);
    expect(latest.olderBefore).toBe(4);
    const oldest = await listJournalBefore(db, "b", { before: 3, limit: 2 });
    expect(oldest).toMatchObject({ entries: [{ seq: 1 }, { seq: 2 }], olderBefore: null });
    expect((await getJournalEntry(db, "b", 3)).body).toBe("n3");
    await expect(getJournalEntry(db, "b", 9)).rejects.toMatchObject({ code: "journal_entry_not_found" });
  });

  it("searches the journal with escaped LIKE patterns and kind", async () => {
    await createState(db, { id: "q", title: "Q" }, "me");
    for (const [kind, body] of [
      ["decision", "Use SQLite"],
      ["report", "100% done with sqlite"],
      ["decision", "a_b"],
    ]) {
      await appendJournal(db, "q", "me", kind!, body!);
    }
    expect((await searchJournal(db, "q", { terms: ["sqlite"] })).entries.map((e) => e.seq)).toEqual([2, 1]);
    expect((await searchJournal(db, "q", { terms: ["100%"] })).entries.map((e) => e.seq)).toEqual([2]);
    expect((await searchJournal(db, "q", { terms: ["a_b"] })).entries.map((e) => e.seq)).toEqual([3]);
    expect((await searchJournal(db, "q", { terms: ["e_s"] })).entries).toEqual([]);
    expect((await searchJournal(db, "q", { terms: [], kind: "decision", limit: 1 })).nextBefore).toBe(3);
  });

  it("writes the journal summary atomically and lets one concurrent writer win", async () => {
    await createState(db, { id: "m", title: "M" }, "me");
    await appendJournal(db, "m", "me", "note", "one");
    await d1.exec(
      "CREATE TRIGGER fail_touch_m BEFORE UPDATE ON states WHEN NEW.id = 'm' BEGIN SELECT RAISE(ABORT, 'touch'); END",
    );
    try {
      await expect(putSummary(db, "m", { content: "s", coveredThroughSeq: 1 }, null, "me")).rejects.toThrow(/touch/);
      expect(await count("journal_summary_revisions", "m")).toBe(0);
      expect(await findSummary(db, "m")).toBeUndefined();
    } finally {
      await d1.exec("DROP TRIGGER fail_touch_m");
    }
    const results = await Promise.allSettled([
      putSummary(db, "m", { content: "a", coveredThroughSeq: 1 }, 0, "me"),
      putSummary(db, "m", { content: "b", coveredThroughSeq: 1 }, 0, "me"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
      code: "version_conflict",
    });
    expect(await count("journal_summary_revisions", "m")).toBe(1);
    expect((await findSummary(db, "m"))?.version).toBe(1);
  });
});
