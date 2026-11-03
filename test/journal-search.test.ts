import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { setup } from "./helpers";

async function withJournal(entries: [kind: string, body: string][]) {
  const ctx = await setup();
  const t = await ctx.tokenFor("orchestrator");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "g" } });
  for (const [kind, body] of entries) await ctx.call(t, "POST", "/api/states/s/journal", { kind, body });
  return { ...ctx, t };
}

const seqs = (entries: { seq: number }[]) => entries.map((e) => e.seq);
const MD = { Accept: "text/markdown" };

const JOURNAL: [string, string][] = [
  ["decision", "Use SQLite for the store."], // 1
  ["report", "Added CI with sqlite tests."], // 2
  ["note", "100% coverage is not a goal_yet."], // 3
  ["decision", "Keep the REST API as the source of truth."], // 4
  ["report", "Store: moved to D1 (SQLite on Workers)."], // 5
  ["decision", "Tokens are never flags: use --token-file."], // 6
];

describe("journal search", () => {
  it("finds entries containing every term, newest first, ignoring ASCII case", async () => {
    const { call, t } = await withJournal(JOURNAL);
    const one = await (await call(t, "GET", "/api/states/s/journal/search?q=sqlite")).json();
    expect(seqs(one.entries)).toEqual([5, 2, 1]);
    expect(one.nextBefore).toBeNull();
    expect(one.entries[0]).toMatchObject({ seq: 5, kind: "report", actor: "orchestrator" });

    const both = await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent("sqlite store")}`)).json();
    expect(seqs(both.entries)).toEqual([5, 1]);

    const phrase = await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent('"source of truth"')}`)).json();
    expect(seqs(phrase.entries)).toEqual([4]);
    const split = await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent("truth source")}`)).json();
    expect(seqs(split.entries)).toEqual([4]);
    const noPhrase = await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent('"truth source"')}`)).json();
    expect(noPhrase.entries).toEqual([]);
  });

  it("treats % and _ as plain characters and filters by kind", async () => {
    const { call, t } = await withJournal(JOURNAL);
    const pct = await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent("100%")}`)).json();
    expect(seqs(pct.entries)).toEqual([3]);
    expect((await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent("%")}`)).json()).entries).toHaveLength(1);
    expect((await (await call(t, "GET", "/api/states/s/journal/search?q=goal_")).json()).entries).toHaveLength(1);
    // "_" would match any single character as a LIKE wildcard ("goal yet" does not occur).
    expect((await (await call(t, "GET", "/api/states/s/journal/search?q=a_g")).json()).entries).toEqual([]);
    expect((await (await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent("\\")}`)).json()).entries).toEqual([]);

    const decisions = await (await call(t, "GET", "/api/states/s/journal/search?kind=decision")).json();
    expect(seqs(decisions.entries)).toEqual([6, 4, 1]);
    const sqliteDecisions = await (await call(t, "GET", "/api/states/s/journal/search?kind=decision&q=sqlite")).json();
    expect(seqs(sqliteDecisions.entries)).toEqual([1]);
  });

  it("pages with before and nextBefore without skipping or repeating", async () => {
    const { call, t } = await withJournal(JOURNAL);
    const first = await (await call(t, "GET", "/api/states/s/journal/search?kind=decision&limit=2")).json();
    expect(seqs(first.entries)).toEqual([6, 4]);
    expect(first.nextBefore).toBe(4);
    // An entry appended while paging does not shift the next page.
    await call(t, "POST", "/api/states/s/journal", { kind: "decision", body: "late" });
    const next = await (await call(t, "GET", `/api/states/s/journal/search?kind=decision&limit=2&before=${first.nextBefore}`)).json();
    expect(seqs(next.entries)).toEqual([1]);
    expect(next.nextBefore).toBeNull();
    // Exactly limit matches left: no nextBefore.
    const exact = await (await call(t, "GET", "/api/states/s/journal/search?kind=decision&limit=2&before=5")).json();
    expect(seqs(exact.entries)).toEqual([4, 1]);
    expect(exact.nextBefore).toBeNull();
  });

  it("returns Markdown with the next page and a reminder that search does not replace reading", async () => {
    const { call, t } = await withJournal([...JOURNAL, ["report", "x".repeat(30) + " sqlite"]]);
    const md = await (await call(t, "GET", "/api/states/s/journal/search?q=sqlite&limit=2&maxChars=10", undefined, MD)).text();
    expect(md).toMatch(/^# Journal search: q="sqlite" \(newest first\)\n/);
    expect(md.indexOf("### #7 report")).toBeLessThan(md.indexOf("### #5 report"));
    expect(md).not.toContain("### #2");
    expect(md).toContain("_[Truncated: showing 10 of 37 characters.");
    expect(md).toContain("More matches before #5 are not shown. Continue with before=5.");
    expect(md).toContain("does not replace reading the journal after the summary's covered seq");

    const last = await (await call(t, "GET", "/api/states/s/journal/search?q=sqlite&kind=decision&before=5", undefined, MD)).text();
    expect(last).toMatch(/^# Journal search: q="sqlite", kind=decision before #5 \(newest first\)/);
    expect(last).toContain("No more matches.");
    const none = await (await call(t, "GET", "/api/states/s/journal/search?q=nothing", undefined, MD)).text();
    expect(none).toContain('_No journal entries match q="nothing"._');
  });

  it("validates the query and checks permissions", async () => {
    const { call, t, tokenFor } = await withJournal(JOURNAL);
    for (const q of ["", "q=", "q=%20%20", `q=${encodeURIComponent('""')}`, "kind=%20"]) {
      const res = await call(t, "GET", `/api/states/s/journal/search?${q}`);
      expect(res.status, q).toBe(400);
      expect((await res.json()).error.message).toContain("q (keywords) and/or kind");
    }
    const tooMany = Array.from({ length: 11 }, (_, i) => `w${i}`).join(" ");
    expect((await call(t, "GET", `/api/states/s/journal/search?q=${encodeURIComponent(tooMany)}`)).status).toBe(400);
    expect((await call(t, "GET", `/api/states/s/journal/search?q=${"a".repeat(501)}`)).status).toBe(400);
    expect((await call(t, "GET", `/api/states/s/journal/search?q=${"a".repeat(500)}`)).status).toBe(200);
    expect((await call(t, "GET", "/api/states/s/journal/search?q=a&before=-1")).status).toBe(400);
    expect((await call(t, "GET", "/api/states/s/journal/search?q=a&maxChars=0")).status).toBe(400);
    expect((await call(t, "GET", "/api/states/nope/journal/search?q=a")).status).toBe(404);

    // limit is clamped to 1..100.
    const big = await (await call(t, "GET", "/api/states/s/journal/search?kind=decision&limit=1000")).json();
    expect(big.entries).toHaveLength(3);

    const reader = await tokenFor("reader", "read", ["s"]);
    expect((await call(reader, "GET", "/api/states/s/journal/search?q=sqlite")).status).toBe(200);
    const other = await tokenFor("other", "read", ["x"]);
    expect((await call(other, "GET", "/api/states/s/journal/search?q=sqlite")).status).toBe(403);
  });
});

describe("journal search from the CLI and MCP", () => {
  it("runs dura search", async () => {
    const { app, t } = await withJournal(JOURNAL);
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

    const res = await exec(["search", "sqlite", "--kind", "decision", "--limit", "5", "--max-chars", "50"]);
    expect(res.code).toBe(0);
    expect(res.urls[0]).toContain("/api/states/s/journal/search?q=sqlite&kind=decision&limit=5&maxChars=50");
    expect(res.stdout).toContain("### #1 decision");
    expect(res.stdout).not.toContain("### #5");

    // An argument with spaces stays one phrase.
    const phrase = await exec(["search", "source of truth", "--json"]);
    expect(seqs(JSON.parse(phrase.stdout).entries)).toEqual([4]);
    const words = await exec(["search", "truth", "source", "--json"]);
    expect(seqs(JSON.parse(words.stdout).entries)).toEqual([4]);

    const paged = await exec(["search", "--kind", "decision", "--limit", "1", "--before", "6"]);
    expect(paged.stdout).toContain("Continue with before=4.");

    const empty = await exec(["search"]);
    expect(empty.code).toBe(2);
    expect(empty.urls).toEqual([]);
    expect((await exec(["search", "x", "--before", "x"])).code).toBe(2);
    const tooMany = await exec(["search", ...Array.from({ length: 11 }, (_, i) => `w${i}`)]);
    expect(tooMany.code).toBe(1);
    expect(tooMany.stderr).toContain("at most 10 terms");
  });

  it("offers search_journal over MCP", async () => {
    const { app, t } = await withJournal(JOURNAL);
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

    const found = await tool("search_journal", { state: "s", q: "sqlite", kind: "report", limit: 1 });
    expect(found.isError).toBe(false);
    expect(found.text).toContain("### #5 report");
    expect(found.text).toContain("Continue with before=5.");
    expect((await tool("search_journal", { state: "s" })).isError).toBe(true);
    expect((await tool("search_journal", { state: "s", q: " " })).text).toContain("Pass q, kind, or both.");
    expect((await tool("search_journal", { state: "s", q: "x", maxChars: 0 })).text).toContain("maxChars must be at least 1");
  });
});
