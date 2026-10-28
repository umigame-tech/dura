import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

describe("states", () => {
  it("requires authentication", async () => {
    const { call } = await setup();
    const res = await call(null, "GET", "/api/states");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
    expect((await call("dura_bogus", "GET", "/api/states")).status).toBe(401);
  });

  it("creates, lists and patches states", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    const res = await call(t, "POST", "/api/states", { title: "Rewrite Search!", sections: { goal: "Fast search" } });
    expect(res.status).toBe(201);
    const { state } = await res.json();
    expect(state.id).toBe("rewrite-search");
    expect(state.status).toBe("active");

    const dup = await call(t, "POST", "/api/states", { title: "Rewrite Search!" });
    expect((await dup.json()).state.id).toBe("rewrite-search-2");
    expect((await call(t, "POST", "/api/states", { id: "rewrite-search", title: "x" })).status).toBe(409);

    await call(t, "PATCH", "/api/states/rewrite-search-2", { status: "completed" });
    const list = await (await call(t, "GET", "/api/states")).json();
    expect(list.states.map((s: { id: string }) => s.id)).toEqual(["rewrite-search", "rewrite-search-2"]);

    const bad = await call(t, "PATCH", "/api/states/rewrite-search", { status: "done" });
    expect(bad.status).toBe(400);
  });

  it("records status changes in the journal", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "S" });
    await call(t, "PATCH", "/api/states/s", { status: "waiting", statusNote: "Need a decision on X" });
    const { entries } = await (await call(t, "GET", "/api/states/s/journal")).json();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 1, kind: "status", actor: "orchestrator" });
    expect(entries[0].body).toContain("Need a decision on X");
  });
});

describe("sections", () => {
  async function withState() {
    const ctx = await setup();
    const t = await ctx.tokenFor("orchestrator");
    await ctx.call(t, "POST", "/api/states", { id: "s", title: "S" });
    return { ...ctx, t };
  }

  it("creates without If-Match and requires it afterwards", async () => {
    const { call, t } = await withState();
    const res = await call(t, "PUT", "/api/states/s/sections/plan", "# Plan\n\n1. a\n", { "Content-Type": "text/markdown" });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe('"1"');
    expect((await res.json()).section).toMatchObject({ version: 1, updatedBy: "orchestrator" });

    const again = await call(t, "PUT", "/api/states/s/sections/plan", "x", { "Content-Type": "text/markdown" });
    expect(again.status).toBe(428);

    const ok = await call(t, "PUT", "/api/states/s/sections/plan", { content: "v2" }, { "If-Match": '"1"' });
    expect((await ok.json()).section.version).toBe(2);
  });

  it("rejects stale versions with an actionable message", async () => {
    const { call, t } = await withState();
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "v1" });
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "v2" }, { "If-Match": "1" });
    const res = await call(t, "PUT", "/api/states/s/sections/plan", { content: "stale" }, { "If-Match": "1" });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toMatchObject({ code: "version_conflict", currentVersion: 2, sentVersion: 1 });
    expect(error.message).toContain("You sent version 1");
    expect(error.message).toContain("If-Match: 2");

    const md = await call(t, "PUT", "/api/states/s/sections/plan", { content: "stale" }, { "If-Match": "1", Accept: "text/markdown" });
    expect(await md.text()).toMatch(/^Error \(version_conflict\)/);
  });

  it("lets exactly one of two concurrent writers win", async () => {
    const { call, t } = await withState();
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "v1" });
    const results = await Promise.all(
      ["a", "b", "c"].map((x) => call(t, "PUT", "/api/states/s/sections/plan", { content: x }, { "If-Match": "1" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it("supports old/new replacement", async () => {
    const { call, t } = await withState();
    await call(t, "PUT", "/api/states/s/sections/tasks", { content: "- [ ] a\n- [ ] b\n" });
    const url = "/api/states/s/sections/tasks/replace";

    expect((await call(t, "POST", url, { old: "- [ ] a", new: "- [x] a" })).status).toBe(428);
    const ok = await call(t, "POST", url, { old: "- [ ] a", new: "- [x] a" }, { "If-Match": "1" });
    expect((await ok.json()).section).toMatchObject({ version: 2, content: "- [x] a\n- [ ] b\n" });

    const missing = await call(t, "POST", url, { old: "zzz", new: "y" }, { "If-Match": "2" });
    expect(missing.status).toBe(422);
    expect((await missing.json()).error.code).toBe("old_not_found");

    const multi = await call(t, "POST", url, { old: "- [", new: "* [" }, { "If-Match": "2" });
    expect((await multi.json()).error).toMatchObject({ code: "old_not_unique", occurrences: 2 });

    const all = await call(t, "POST", url, { old: "- [", new: "* [", replaceAll: true }, { "If-Match": "2" });
    expect((await all.json()).section.content).toBe("* [x] a\n* [ ] b\n");

    // "$&" must be inserted literally, not interpreted as a replacement pattern.
    const dollar = await call(t, "POST", url, { old: "a", new: "$&$&" }, { "If-Match": "3" });
    expect((await dollar.json()).section.content).toBe("* [x] $&$&\n* [ ] b\n");
  });

  it("keeps every revision", async () => {
    const { call, t } = await withState();
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "v1" });
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "v2" }, { "If-Match": "1" });
    const { revisions } = await (await call(t, "GET", "/api/states/s/sections/plan/revisions")).json();
    expect(revisions.map((r: { version: number; content: string }) => [r.version, r.content])).toEqual([
      [2, "v2"],
      [1, "v1"],
    ]);
  });

  it("returns raw markdown with the version in ETag", async () => {
    const { call, t } = await withState();
    await call(t, "PUT", "/api/states/s/sections/plan", { content: "# Plan" });
    const res = await call(t, "GET", "/api/states/s/sections/plan", undefined, { Accept: "text/markdown" });
    expect(res.headers.get("ETag")).toBe('"1"');
    expect(await res.text()).toBe("# Plan");
    expect((await call(t, "GET", "/api/states/s/sections/nope")).status).toBe(404);
    expect((await call(t, "PUT", "/api/states/s/sections/Bad Name", { content: "x" })).status).toBe(400);
  });
});

describe("journal", () => {
  it("appends with increasing seq, also when concurrent", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    const w1 = await tokenFor("worker-1", "write", ["s"]);
    await call(t, "POST", "/api/states", { id: "s", title: "S" });

    const res = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call(w1, "POST", "/api/states/s/journal?kind=report", `report ${i}`, { "Content-Type": "text/markdown" }),
      ),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    await call(t, "POST", "/api/states/s/journal", { kind: "decision", body: "Go with B" });

    const { entries } = await (await call(t, "GET", "/api/states/s/journal?after=9")).json();
    expect(entries.map((e: { seq: number }) => e.seq)).toEqual([10, 11]);
    expect(entries[1]).toMatchObject({ kind: "decision", actor: "orchestrator" });

    const all = await (await call(t, "GET", "/api/states/s/journal")).json();
    expect(all.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(all.entries[0].actor).toBe("worker-1");
  });

  it("validates input", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("o");
    await call(t, "POST", "/api/states", { id: "s", title: "S" });
    expect((await call(t, "POST", "/api/states/s/journal", { body: "  " })).status).toBe(400);
    expect((await call(t, "POST", "/api/states/s/journal", { kind: "Bad Kind", body: "x" })).status).toBe(400);
    expect((await call(t, "POST", "/api/states/zzz/journal", { body: "x" })).status).toBe(404);
  });
});

describe("markdown state view", () => {
  it("bundles status, sections and unread journal", async () => {
    const { call, tokenFor } = await setup();
    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "Search", sections: { goal: "Make it fast", plan: "1. index" } });
    await call(t, "POST", "/api/states/s/journal", { kind: "report", body: "old report" });
    await call(t, "POST", "/api/states/s/journal", { kind: "report", body: "new report" });

    const res = await call(t, "GET", "/api/states/s?after=1", undefined, { Accept: "text/markdown" });
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain("# Search");
    expect(md).toContain("## Section: goal");
    expect(md).toContain("Make it fast");
    expect(md).toContain("<!-- version: 1, updated by orchestrator");
    expect(md).toContain("new report");
    expect(md).not.toContain("old report");
    expect(md).toContain("Last journal seq: 2");
  });

  it("serves the guide without auth", async () => {
    const { call } = await setup();
    const res = await call(null, "GET", "/api/guide");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("If-Match");
  });
});

describe("token permissions", () => {
  it("enforces read-only and state limits", async () => {
    const { call, tokenFor, db } = await setup();
    const admin = await tokenFor("admin");
    await call(admin, "POST", "/api/states", { id: "a", title: "A" });
    await call(admin, "POST", "/api/states", { id: "b", title: "B" });

    const reader = await tokenFor("reader", "read");
    expect((await call(reader, "GET", "/api/states/a")).status).toBe(200);
    expect((await call(reader, "POST", "/api/states/a/journal", { body: "x" })).status).toBe(403);

    const scoped = await tokenFor("scoped", "write", ["a"]);
    const list = await (await call(scoped, "GET", "/api/states")).json();
    expect(list.states.map((s: { id: string }) => s.id)).toEqual(["a"]);
    expect((await call(scoped, "GET", "/api/states/b")).status).toBe(403);
    expect((await call(scoped, "POST", "/api/states/a/journal", { body: "x" })).status).toBe(201);
    expect((await call(scoped, "POST", "/api/states", { title: "C" })).status).toBe(403);

    const { revokeToken, listTokens } = await import("../src/auth");
    const row = (await listTokens(db)).find((x) => x.name === "scoped")!;
    await revokeToken(db, row.id);
    expect((await call(scoped, "GET", "/api/states")).status).toBe(401);
  });

  it("accepts the browser session but rejects cross-origin writes", async () => {
    const { call, ownerCookie } = await setup();
    const cookie = await ownerCookie();
    const ok = await call(null, "POST", "/api/states", { id: "s", title: "S" }, { Cookie: cookie, Origin: "http://localhost" });
    expect(ok.status).toBe(201);
    const evil = await call(null, "POST", "/api/states", { title: "x" }, { Cookie: cookie, Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const { entries } = await (await call(null, "GET", "/api/states/s/journal", undefined, { Cookie: cookie })).json();
    expect(entries).toEqual([]);
  });
});
