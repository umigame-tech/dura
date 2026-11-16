import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { journalSummaryRevisions, passkeys } from "../src/db/schema";
import { RESUME } from "../src/ops/spec";
import { ORIGIN, setup } from "./helpers";

async function withJournal(entries = 3) {
  const ctx = await setup();
  const t = await ctx.tokenFor("orchestrator");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "g" } });
  for (let i = 1; i <= entries; i++) await ctx.call(t, "POST", "/api/states/s/journal", { kind: "report", body: `entry ${i}` });
  return { ...ctx, t };
}

describe("journal summary API", () => {
  it("creates without If-Match, then requires the version, and keeps every revision", async () => {
    const { call, t, db } = await withJournal();
    const none = await call(t, "GET", "/api/states/s/summary");
    expect(none.status).toBe(404);
    expect((await none.json()).error).toMatchObject({ code: "summary_not_found", message: expect.stringContaining("after=0") });
    expect((await (await call(t, "GET", "/api/states/nope/summary")).json()).error.code).toBe("not_found");
    expect((await call(t, "GET", "/api/states/s/summary/revisions")).status).toBe(404);

    const created = await call(t, "PUT", "/api/states/s/summary", { content: "Done 1-2.", coveredThroughSeq: 2 });
    expect(created.status).toBe(200);
    expect(created.headers.get("ETag")).toBe('"1"');
    expect((await created.json()).summary).toMatchObject({ content: "Done 1-2.", coveredThroughSeq: 2, version: 1, updatedBy: "orchestrator" });

    const noIfMatch = await call(t, "PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 3 });
    expect(noIfMatch.status).toBe(428);
    expect((await noIfMatch.json()).error.currentVersion).toBe(1);

    const stale = await call(t, "PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 3 }, { "If-Match": "0" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: "version_conflict", currentVersion: 1 });

    const updated = await call(t, "PUT", "/api/states/s/summary", { content: "Done 1-3.", coveredThroughSeq: 3 }, { "If-Match": '"1"' });
    expect((await updated.json()).summary).toMatchObject({ coveredThroughSeq: 3, version: 2 });

    const md = await call(t, "GET", "/api/states/s/summary", undefined, { Accept: "text/markdown" });
    expect(await md.text()).toBe("Done 1-3.");
    expect(md.headers.get("ETag")).toBe('"2"');
    expect(md.headers.get("X-Covered-Through-Seq")).toBe("3");

    const revisions = await db.select().from(journalSummaryRevisions);
    expect(revisions.map((r) => [r.version, r.coveredThroughSeq, r.content])).toEqual([
      [1, 2, "Done 1-2."],
      [2, 3, "Done 1-3."],
    ]);
    const listed = (await (await call(t, "GET", "/api/states/s/summary/revisions")).json()).revisions;
    expect(listed.map((r: { version: number; coveredThroughSeq: number }) => [r.version, r.coveredThroughSeq])).toEqual([
      [2, 3],
      [1, 2],
    ]);

    const badIfMatch = await call(t, "PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 3 }, { "If-Match": "abc" });
    expect(badIfMatch.status).toBe(400);
    expect((await badIfMatch.json()).error.message).toContain("If-Match must be a version number");
  });

  it("never lets coveredThroughSeq pass the last journal entry", async () => {
    const { call, t } = await withJournal(2);
    const ahead = await call(t, "PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 3 });
    expect(ahead.status).toBe(422);
    expect((await ahead.json()).error).toMatchObject({ code: "seq_out_of_range", lastSeq: 2 });
    expect((await call(t, "GET", "/api/states/s/summary")).status).toBe(404);

    // A summary of a state with no journal yet covers nothing.
    await call(t, "POST", "/api/states", { id: "empty", title: "E" });
    const zero = await call(t, "PUT", "/api/states/empty/summary", { content: "Nothing yet.", coveredThroughSeq: 0 });
    expect(zero.status).toBe(200);
  });

  it("validates the body", async () => {
    const { call, t } = await withJournal();
    const put = (body: unknown) => call(t, "PUT", "/api/states/s/summary", body);
    for (const body of [
      { coveredThroughSeq: 1 },
      { content: 1, coveredThroughSeq: 1 },
      { content: "x" },
      { content: "x", coveredThroughSeq: "1" },
      { content: "x", coveredThroughSeq: -1 },
      { content: "x", coveredThroughSeq: 1.5 },
      { content: "  ", coveredThroughSeq: 1 },
      [],
    ]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(t, "PUT", "/api/states/nope/summary", { content: "x", coveredThroughSeq: 0 })).status).toBe(404);
  });

  it("lets exactly one of two concurrent writers win", async () => {
    const { call, t } = await withJournal();
    const results = await Promise.all(
      [1, 2].map((i) => call(t, "PUT", "/api/states/s/summary", { content: `writer ${i}`, coveredThroughSeq: 3 }, { "If-Match": "0" })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("applies the token's permissions", async () => {
    const { call, t, tokenFor } = await withJournal();
    await call(t, "PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 1 });
    const reader = await tokenFor("reader", "read");
    expect((await call(reader, "GET", "/api/states/s/summary")).status).toBe(200);
    expect((await call(reader, "GET", "/api/states/s/summary/revisions")).status).toBe(200);
    expect((await call(reader, "PUT", "/api/states/s/summary", { content: "y", coveredThroughSeq: 2 }, { "If-Match": "1" })).status).toBe(403);
    const other = await tokenFor("other", "write", ["other"]);
    expect((await call(other, "GET", "/api/states/s/summary")).status).toBe(403);
    expect((await call(other, "GET", "/api/states/s/summary/revisions")).status).toBe(403);
  });

  it("leads the state view with the summary and points to the unread entries", async () => {
    const { call, t } = await withJournal();
    const plain = await (await call(t, "GET", "/api/states/s")).json();
    expect(plain.summary).toBeNull();
    expect(await (await call(t, "GET", "/api/states/s", undefined, { Accept: "text/markdown" })).text()).not.toContain("## Journal summary");

    await call(t, "PUT", "/api/states/s/summary", { content: "Entries 1-2 in short.", coveredThroughSeq: 2 });
    const json = await (await call(t, "GET", "/api/states/s?after=2")).json();
    expect(json.summary).toMatchObject({ content: "Entries 1-2 in short.", coveredThroughSeq: 2, version: 1 });
    expect(json.journal.map((e: { seq: number }) => e.seq)).toEqual([3]);

    const md = await (await call(t, "GET", "/api/states/s?after=2", undefined, { Accept: "text/markdown" })).text();
    expect(md).toContain("## Journal summary");
    expect(md).toContain("covers journal through #2");
    expect(md).toContain("after=2");
    expect(md.indexOf("## Journal summary")).toBeLessThan(md.indexOf("## Section: goal"));
    expect(md).toContain("entry 3");
    expect(md).not.toContain("entry 2\n");
  });
});

describe("journal summary over MCP", () => {
  it("reads and writes the summary with hints on errors", async () => {
    const { app, t } = await withJournal();
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

    const missing = await tool("get_summary", { state: "s" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("put_summary without version");
    const noState = await tool("get_summary", { state: "nope" });
    expect(noState.text).toContain("Check the state id");
    expect(noState.text).not.toContain("put_summary");

    expect((await tool("put_summary", { state: "s", content: "Short.", coveredThroughSeq: 2 })).text).toBe(
      "Wrote the journal summary (version 1, covers the journal through #2).",
    );
    const read = await tool("get_summary", { state: "s" });
    expect(read.text).toBe("<!-- version: 1, covers journal through #2; read the journal with after=2 -->\n\nShort.");

    const stale = await tool("put_summary", { state: "s", content: "x", coveredThroughSeq: 3, version: 0 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("version_conflict");
    expect(stale.text).toContain("get_summary");
    expect(stale.text).toContain("retry with version 1");

    const exists = await tool("put_summary", { state: "s", content: "x", coveredThroughSeq: 3 });
    expect(exists.text).toContain("pass version 1");

    const ahead = await tool("put_summary", { state: "s", content: "x", coveredThroughSeq: 9, version: 1 });
    expect(ahead.text).toContain("seq_out_of_range");
    expect(ahead.text).toContain("actually read");

    expect((await tool("put_summary", { state: "s", content: "x" })).text).toContain("coveredThroughSeq is required");
  });
});

describe("journal summary in the CLI", () => {
  it("gets and puts the summary", async () => {
    const ctx = await withJournal();
    const exec = async (argv: string[], stdin = "") => {
      let stdout = "";
      let stderr = "";
      const io: Io = {
        env: { DURA_URL: "http://localhost", DURA_TOKEN: ctx.t, DURA_STATE: "s" },
        fetch: (url, init) => ctx.app.request(url, init) as unknown as Promise<Response>,
        readStdin: async () => stdin,
        readFile: async (path) => `file:${path}`,
        stdout: (s) => (stdout += s),
        stderr: (s) => (stderr += s),
      };
      return { code: await run(argv, io), stdout, stderr };
    };

    const none = await exec(["summary", "get"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("dura journal --after 0");
    const noState = await exec(["summary", "get", "--state", "nope"]);
    expect(noState.stderr).toContain("Check the state id (nope)");
    expect(noState.stderr).not.toContain("summary put");
    expect((await exec(["summary", "put", "--state", "nope", "--covered", "0"], "x")).stderr).toContain("Check the state id (nope)");

    expect((await exec(["summary", "put"], "x")).stderr).toContain("needs --covered");
    const put = await exec(["summary", "put", "--covered", "2"], "Entries 1-2.");
    expect(put.code).toBe(0);
    expect(put.stderr).toContain("version 1, covers the journal through #2");

    const get = await exec(["summary", "get"]);
    expect(get.stdout).toBe("Entries 1-2.\n");
    expect(get.stderr).toContain(`version: 1, covers journal through #2 (read on with --after 2 --limit ${RESUME.page} --max-chars ${RESUME.maxChars}`);
    expect(JSON.parse((await exec(["summary", "get", "--json"])).stdout).summary.coveredThroughSeq).toBe(2);

    const stale = await exec(["summary", "put", "--covered", "3", "--version", "0"], "x");
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("dura summary get");
    expect(stale.stderr).toContain("--version 1");

    const exists = await exec(["summary", "put", "--covered", "3"], "x");
    expect(exists.stderr).toContain("pass --version 1");

    const ahead = await exec(["summary", "put", "--covered", "9", "--version", "1"], "x");
    expect(ahead.stderr).toContain("seq_out_of_range");

    const fromFile = await exec(["summary", "put", "--covered", "3", "--version", "1", "--file", "s.md", "--json"]);
    expect(JSON.parse(fromFile.stdout).summary).toMatchObject({ content: "file:s.md", version: 2, coveredThroughSeq: 3 });
    expect((await exec(["summary", "nope"])).stderr).toContain("dura summary get|put");
  });
});

describe("journal summary in the web UI", () => {
  it("shows the summary above the journal", async () => {
    const ctx = await withJournal();
    await ctx.db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
    const cookie = await ctx.ownerCookie();
    const page = async () => (await ctx.app.request("/s/s", { headers: { Cookie: cookie, Origin: ORIGIN } })).text();
    expect(await page()).not.toContain("journal-summary");
    await ctx.call(ctx.t, "PUT", "/api/states/s/summary", { content: "**Short** <script>x</script>", coveredThroughSeq: 2 });
    const html = await page();
    expect(html).toContain("covers through #2");
    expect(html).toContain("<strong>Short</strong>");
    expect(html).not.toContain("<script>x</script>");
  });
});
