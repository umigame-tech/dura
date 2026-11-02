import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { atomic, type DB, type Write } from "../src/db";
import { journalEntries, sectionRevisions, sections, states } from "../src/db/schema";
import { isUniqueViolation } from "../src/lib/errors";
import { setup } from "./helpers";

// A failure in the middle of a write must leave nothing behind. A SQLite trigger makes one statement fail.
async function failWhen(db: DB, trigger: string) {
  await db.run(sql.raw(trigger));
}

describe("atomic writes (Node / better-sqlite3)", () => {
  it("does not leave a half-created state when an initial section fails", async () => {
    const { db, call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await failWhen(
      db,
      `CREATE TRIGGER fail_boom BEFORE INSERT ON sections WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "# Goal", boom: "x" } });
    expect(res.status).toBe(500);
    expect(await db.select().from(states)).toEqual([]);
    expect(await db.select().from(sections)).toEqual([]);
    expect(await db.select().from(sectionRevisions)).toEqual([]);

    // The same id can be created once the failure is gone.
    await db.run(sql`DROP TRIGGER fail_boom`);
    const ok = await call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "# Goal", boom: "x" } });
    expect(ok.status).toBe(201);
    const created = (await db.select().from(sections)).map((s) => [s.name, s.version]).sort();
    expect(created).toEqual([
      ["boom", 1],
      ["goal", 1],
    ]);
    expect(await db.select().from(sectionRevisions)).toHaveLength(2);
  });

  it("does not leave an orphan revision when a section write fails", async () => {
    const { db, call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "S", sections: { plan: "v1" } });
    const [before] = await db.select().from(states);
    await failWhen(db, `CREATE TRIGGER fail_touch BEFORE UPDATE ON states BEGIN SELECT RAISE(ABORT, 'touch'); END`);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(t, "PUT", "/api/states/s/sections/plan", "v2", {
      "Content-Type": "text/markdown",
      "If-Match": "1",
    });
    expect(res.status).toBe(500);
    const [plan] = await db.select().from(sections);
    expect([plan?.content, plan?.version]).toEqual(["v1", 1]);
    expect(await db.select().from(sectionRevisions)).toHaveLength(1);
    expect((await db.select().from(states))[0]?.updatedAt).toBe(before?.updatedAt);

    // Version 2 was not claimed, so the retry with the same If-Match succeeds instead of conflicting.
    await db.run(sql`DROP TRIGGER fail_touch`);
    const retry = await call(t, "PUT", "/api/states/s/sections/plan", "v2", {
      "Content-Type": "text/markdown",
      "If-Match": "1",
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).section.version).toBe(2);
  });

  it("does not keep a journal entry when updating the state fails", async () => {
    const { db, call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "S" });
    await failWhen(db, `CREATE TRIGGER fail_touch BEFORE UPDATE ON states BEGIN SELECT RAISE(ABORT, 'touch'); END`);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await call(t, "POST", "/api/states/s/journal?kind=report", "done", { "Content-Type": "text/markdown" });
    expect(res.status).toBe(500);
    expect(await db.select().from(journalEntries)).toEqual([]);
  });

  it("still reports a concurrent section write as a version conflict", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "S", sections: { plan: "v1" } });
    const put = (body: string) =>
      call(t, "PUT", "/api/states/s/sections/plan", body, { "Content-Type": "text/markdown", "If-Match": "1" });
    const statuses = (await Promise.all([put("a"), put("b")])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("atomic writes (D1)", () => {
  it("sends the queries as one batch when the driver has batch()", async () => {
    const { db } = await setup();
    const batch = vi.fn(async () => []);
    const transaction = vi.fn();
    const d1Like = { batch, transaction } as unknown as DB;
    const queries: [Write, ...Write[]] = [
      db.insert(states).values({ id: "s", title: "S", createdAt: "t", updatedAt: "t" }),
      db.update(states).set({ updatedAt: "u" }),
    ];

    await atomic(d1Like, queries);
    expect(batch).toHaveBeenCalledWith(queries);
    expect(transaction).not.toHaveBeenCalled();
    // The queries were only handed over, not run on their own.
    expect(await db.select().from(states)).toEqual([]);
  });

  it("propagates a failed batch", async () => {
    const { db } = await setup();
    const d1Like = {
      batch: async () => {
        throw new Error("D1_ERROR: UNIQUE constraint failed: states.id: SQLITE_CONSTRAINT");
      },
    } as unknown as DB;
    await expect(
      atomic(d1Like, [db.insert(states).values({ id: "s", title: "S", createdAt: "t", updatedAt: "t" })]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });
});

describe("isUniqueViolation", () => {
  it("matches UNIQUE / PRIMARY KEY violations only, as D1 and better-sqlite3 word them", () => {
    const d1 = (m: string) => new Error("Failed query", { cause: new Error(`D1_ERROR: ${m}`) });
    expect(isUniqueViolation(d1("UNIQUE constraint failed: p.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)"))).toBe(true);
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: section_revisions.state_id"))).toBe(true);
    expect(isUniqueViolation(d1("FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)"))).toBe(false);
    expect(isUniqueViolation(d1("NOT NULL constraint failed: c.pid: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_NOTNULL)"))).toBe(false);
    expect(isUniqueViolation(d1("boom: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)"))).toBe(false);
  });
});
