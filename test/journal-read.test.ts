import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { setup } from "./helpers";

async function withJournal(entries: string[]) {
  const ctx = await setup();
  const t = await ctx.tokenFor("orchestrator");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "g" } });
  for (const body of entries) await ctx.call(t, "POST", "/api/states/s/journal", { kind: "report", body });
  return { ...ctx, t };
}

const seqs = (entries: { seq: number }[]) => entries.map((e) => e.seq);
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `entry ${i + 1}`);

describe("journal: before (newest entries, oldest first)", () => {
  it("returns the newest entries before a seq and points at the older ones", async () => {
    const { call, t } = await withJournal(numbered(5));
    const latest = await (await call(t, "GET", "/api/states/s/journal?before=999999&limit=2")).json();
    expect(seqs(latest.entries)).toEqual([4, 5]);
    expect(latest.olderBefore).toBe(4);

    const older = await (await call(t, "GET", `/api/states/s/journal?before=${latest.olderBefore}&limit=2`)).json();
    expect(seqs(older.entries)).toEqual([2, 3]);
    expect(older.olderBefore).toBe(2);

    const oldest = await (await call(t, "GET", "/api/states/s/journal?before=2&limit=2")).json();
    expect(seqs(oldest.entries)).toEqual([1]);
    expect(oldest.olderBefore).toBeNull();

    // Exactly limit entries left: nothing older, so no olderBefore.
    const exact = await (await call(t, "GET", "/api/states/s/journal?before=3&limit=2")).json();
    expect(seqs(exact.entries)).toEqual([1, 2]);
    expect(exact.olderBefore).toBeNull();

    const none = await (await call(t, "GET", "/api/states/s/journal?before=1")).json();
    expect(none).toEqual({ entries: [], olderBefore: null, latestSeq: 5 });
    expect(latest.latestSeq).toBe(5);
  });

  it("says in Markdown that older entries have not been read", async () => {
    const { call, t } = await withJournal(numbered(3));
    const md = await (await call(t, "GET", "/api/states/s/journal?before=999&limit=2", undefined, { Accept: "text/markdown" })).text();
    expect(md).toContain("### #2 report");
    expect(md).toContain("### #3 report");
    expect(md).not.toContain("### #1 report");
    expect(md.indexOf("### #2")).toBeLessThan(md.indexOf("### #3"));
    expect(md).toContain("Older entries before #2 are not shown and have not been read. Continue with before=2.");

    const all = await (await call(t, "GET", "/api/states/s/journal?before=999", undefined, { Accept: "text/markdown" })).text();
    expect(all).not.toContain("Older entries");
    expect(all).not.toContain("Newer entries");
    const middle = await (await call(t, "GET", "/api/states/s/journal?before=3", undefined, { Accept: "text/markdown" })).text();
    expect(middle).toContain("Last journal seq: 2.");
    expect(middle).toContain("Newer entries after #2 (through #3) are not shown and have not been read. Read them with after=2.");
    const empty = await (await call(t, "GET", "/api/states/s/journal?before=1", undefined, { Accept: "text/markdown" })).text();
    expect(empty).toBe("_No journal entries before #1._\n");
  });

  it("keeps after / limit as before, rejects after with before, and checks permissions", async () => {
    const { call, t, tokenFor } = await withJournal(numbered(4));
    const after = await (await call(t, "GET", "/api/states/s/journal?after=1&limit=2")).json();
    expect(after).toEqual({ entries: expect.any(Array) });
    expect(seqs(after.entries)).toEqual([2, 3]);
    expect(after.entries[0]).not.toHaveProperty("truncated");

    const both = await call(t, "GET", "/api/states/s/journal?after=1&before=3");
    expect(both.status).toBe(400);
    expect((await both.json()).error.message).toContain("not both");
    expect((await call(t, "GET", "/api/states/s/journal?before=-1")).status).toBe(400);
    expect((await call(t, "GET", "/api/states/s/journal?before=99999999999999999999")).status).toBe(400);
    expect((await call(t, "GET", "/api/states/nope/journal?before=5")).status).toBe(404);

    const other = await tokenFor("other", "read", ["x"]);
    expect((await call(other, "GET", "/api/states/s/journal?before=5")).status).toBe(403);
    expect((await call(other, "GET", "/api/states/s/journal/1")).status).toBe(403);
  });

  it("does not skip or repeat entries appended while paging backwards", async () => {
    const { call, t } = await withJournal(numbered(4));
    const first = await (await call(t, "GET", "/api/states/s/journal?before=999&limit=2")).json();
    await call(t, "POST", "/api/states/s/journal", { body: "late" });
    const next = await (await call(t, "GET", `/api/states/s/journal?before=${first.olderBefore}&limit=2`)).json();
    expect([...seqs(next.entries), ...seqs(first.entries)]).toEqual([1, 2, 3, 4]);
    // The late entry is found by reading on with after.
    const newer = await (await call(t, "GET", `/api/states/s/journal?after=${first.entries.at(-1).seq}`)).json();
    expect(seqs(newer.entries)).toEqual([5]);
  });
});

describe("journal: maxChars and one whole entry", () => {
  const long = `${"a".repeat(10)}😀${"b".repeat(10)}`; // 21 code points

  it("cuts longer bodies by code point and says so, in JSON and Markdown", async () => {
    const { call, t } = await withJournal(["short", long]);
    const json = await (await call(t, "GET", "/api/states/s/journal?maxChars=11")).json();
    expect(json.entries[0]).toMatchObject({ seq: 1, body: "short", truncated: false, totalChars: 5 });
    expect(json.entries[1]).toMatchObject({ seq: 2, body: `${"a".repeat(10)}😀`, truncated: true, totalChars: 21 });

    const md = await (await call(t, "GET", "/api/states/s/journal?maxChars=11", undefined, { Accept: "text/markdown" })).text();
    expect(md).toContain(`${"a".repeat(10)}😀\n\n_[Truncated: showing 11 of 21 characters.`);
    expect(md).toContain("GET /api/states/s/journal/2");
    expect(md).not.toContain("b".repeat(10));
    expect(md.match(/Truncated/g)).toHaveLength(1);

    const before = await (await call(t, "GET", "/api/states/s/journal?before=99&maxChars=3")).json();
    expect(before.entries.map((e: { body: string }) => e.body)).toEqual(["sho", "aaa"]);

    const state = await (await call(t, "GET", "/api/states/s?maxChars=3")).json();
    expect(state.journal[1]).toMatchObject({ body: "aaa", truncated: true, totalChars: 21 });
    const stateMd = await (await call(t, "GET", "/api/states/s?maxChars=3", undefined, { Accept: "text/markdown" })).text();
    expect(stateMd).toContain("_[Truncated: showing 3 of 21 characters.");

    expect((await call(t, "GET", "/api/states/s/journal?maxChars=0")).status).toBe(400);
    expect((await call(t, "GET", "/api/states/s?maxChars=x")).status).toBe(400);
  });

  it("closes a code fence that the cut left open", async () => {
    const fenced = "Log:\n````sh\nnpm test\n```\nstill code\n" + "x".repeat(50) + "\n````\nafter";
    const { call, t } = await withJournal([fenced, "next entry"]);
    const md = await (await call(t, "GET", "/api/states/s/journal?maxChars=40", undefined, { Accept: "text/markdown" })).text();
    // The inner ``` does not close the ```` block, so the closing fence is ````.
    expect(md).toContain("still code\nxxxx\n````\n\n_[Truncated: showing 40 of");
    const whole = await (await call(t, "GET", "/api/states/s/journal?maxChars=1000", undefined, { Accept: "text/markdown" })).text();
    expect(whole.match(/^````$/gm)).toHaveLength(1);
    const closed = await (await call(t, "GET", "/api/states/s/journal?maxChars=5", undefined, { Accept: "text/markdown" })).text();
    expect(closed).toContain("Log:\n\n_[Truncated:");
  });

  it("reads one whole entry by seq", async () => {
    const { call, t } = await withJournal(["first", long]);
    const one = await (await call(t, "GET", "/api/states/s/journal/2")).json();
    expect(one.entry).toMatchObject({ seq: 2, kind: "report", actor: "orchestrator", body: long });
    expect(one.entry).not.toHaveProperty("truncated");
    const md = await (await call(t, "GET", "/api/states/s/journal/2", undefined, { Accept: "text/markdown" })).text();
    expect(md).toMatch(/^### #2 report by orchestrator at .+\n\n/);
    expect(md).toContain(long);

    const missing = await call(t, "GET", "/api/states/s/journal/9");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("journal_entry_not_found");
    expect((await (await call(t, "GET", "/api/states/nope/journal/1")).json()).error.code).toBe("not_found");
    expect((await call(t, "GET", "/api/states/s/journal/abc")).status).toBe(404);
  });
});

describe("journal reading from the CLI and MCP", () => {
  it("passes --before / --max-chars and reads one entry", async () => {
    const { app, t } = await withJournal(["one", "two", "three long body"]);
    const exec = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const urls: string[] = [];
      const io: Io = {
        env: { DURA_URL: "http://localhost/", DURA_TOKEN: t, DURA_STATE: "s" },
        fetch: (url, init) => {
          urls.push(url);
          return app.request(url, init) as unknown as Promise<Response>;
        },
        readStdin: async () => "",
        readFile: async () => "",
        stdout: (s) => (stdout += s),
        stderr: (s) => (stderr += s),
      };
      return { code: await run(argv, io), stdout, stderr, urls };
    };

    const latest = await exec(["journal", "--before", "999", "--limit", "2", "--max-chars", "5"]);
    expect(latest.code).toBe(0);
    expect(latest.urls[0]).toContain("/api/states/s/journal?before=999&limit=2&maxChars=5");
    expect(latest.stdout).toContain("Continue with before=2.");
    expect(latest.stdout).toContain("dura journal 3");

    const one = await exec(["journal", "3"]);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain("three long body");
    const json = await exec(["journal", "3", "--json"]);
    expect(JSON.parse(json.stdout).entry.seq).toBe(3);

    const show = await exec(["show", "--max-chars", "3"]);
    expect(show.urls[0]).toContain("maxChars=3");
    expect(show.stdout).toContain("_[Truncated: showing 3 of 15 characters.");

    const missing = await exec(["journal", "9"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("journal_entry_not_found");
    expect(missing.stderr).toContain("--before");

    for (const argv of [
      ["journal", "--after", "1", "--before", "3"],
      ["journal", "--max-chars", "x"],
      ["show", "--max-chars", "-1"],
      ["journal", "x"],
      ["journal", "1", "2"],
      ["journal", "1", "--limit", "2"],
    ]) {
      const bad = await exec(argv);
      expect(bad.code, argv.join(" ")).toBe(2);
      expect(bad.urls).toEqual([]);
    }
  });

  it("offers before / maxChars and get_journal_entry over MCP", async () => {
    const { app, t } = await withJournal(["one", "two", "three long body"]);
    let id = 1;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      return { text: result.content[0].text as string, isError: result.isError === true };
    };

    const page = await tool("read_journal", { state: "s", before: 999, limit: 2, maxChars: 5 });
    expect(page.isError).toBe(false);
    expect(page.text).toContain("Continue with before=2.");
    expect(page.text).toContain("get_journal_entry");

    const one = await tool("get_journal_entry", { state: "s", seq: 3 });
    expect(one.text).toContain("three long body");
    const shown = await tool("show_state", { state: "s", maxChars: 3 });
    expect(shown.text).toContain("_[Truncated: showing 3 of 15 characters.");

    const missing = await tool("get_journal_entry", { state: "s", seq: 9 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("journal_entry_not_found");
    expect((await tool("get_journal_entry", { state: "s" })).isError).toBe(true);
    expect((await tool("read_journal", { state: "s", maxChars: 0 })).text).toContain("maxChars must be at least 1");
    expect((await tool("read_journal", { state: "s", after: 1, before: 3 })).text).toContain("not both");
  });
});
