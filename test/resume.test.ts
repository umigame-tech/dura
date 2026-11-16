import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { RESUME } from "../src/ops/spec";
import { setup } from "./helpers";

// Walks through the resume procedure of /api/guide (Reading) on a long journal: summary first, then every entry
// after it a page at a time, keeping the progress in the summary, and never the whole history at once.

const UNREAD = "are not shown and have not been read";
const LONG = "x".repeat(RESUME.maxChars * 3);

async function withLongJournal(n: number) {
  const ctx = await setup();
  const t = await ctx.tokenFor("orchestrator");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", sections: { goal: "g" } });
  for (let i = 1; i <= n; i++) {
    // Every 50th entry is long, and #120 is a decision that a summary must not lose.
    const body = i === 120 ? "decision: keep SQLite" : i % 50 === 0 ? `entry ${i} ${LONG}` : `entry ${i}`;
    await ctx.call(t, "POST", "/api/states/s/journal", { kind: i === 120 ? "decision" : "report", body });
  }
  const md = (path: string) =>
    ctx.call(t, "GET", path, undefined, { Accept: "text/markdown" }).then((r) => r.text());
  const lastSeq = (text: string) => Number(/Last journal seq: (\d+)\./.exec(text)?.[1]);
  return { ...ctx, t, md, lastSeq };
}

describe("resume procedure", () => {
  it("migrates a state without a summary page by page, never returning the whole history", async () => {
    const { call, t, md, lastSeq } = await withLongJournal(250);
    const page = `limit=${RESUME.page}&maxChars=${RESUME.maxChars}`;

    // No summary yet: C = 0.
    expect((await call(t, "GET", "/api/states/s/summary")).status).toBe(404);
    const first = await md(`/api/states/s?after=0&${page}`);
    expect(lastSeq(first)).toBe(100);
    expect(first).toContain(`Entries after #100 (through #250) ${UNREAD}. Continue with after=100.`);
    expect(first).not.toContain("### #101 ");
    // Long bodies are cut and point at the whole entry, so one page stays bounded.
    expect(first).toContain(`_[Truncated: showing ${RESUME.maxChars} of`);
    expect(first.length).toBeLessThan(RESUME.page * 100 + 2 * (RESUME.maxChars + 300) + 2000);
    const json = await (await call(t, "GET", `/api/states/s?after=0&${page}`)).json();
    expect(json.journal).toHaveLength(RESUME.page);
    expect(json.latestSeq).toBe(250);

    // The orchestrator keeps the progress in the summary after each page.
    let put = await call(t, "PUT", "/api/states/s/summary", { content: "Through #100.", coveredThroughSeq: 100 });
    expect(put.status).toBe(200);

    // The session ends here. The next one starts from the summary, not from #0 or a remembered seq.
    const summary = await call(t, "GET", "/api/states/s/summary", undefined, { Accept: "text/markdown" });
    const c = Number(summary.headers.get("X-Covered-Through-Seq"));
    expect(c).toBe(100);
    const second = await md(`/api/states/s?after=${c}&${page}`);
    expect(second).toContain("Through #100.");
    expect(second).not.toContain("### #100 ");
    expect(second).toContain("### #101 ");
    expect(second).toContain("decision: keep SQLite");
    expect(second).toContain(`Entries after #200 (through #250) ${UNREAD}. Continue with after=200.`);

    put = await call(t, "PUT", "/api/states/s/summary", { content: "Through #200; #120 decided SQLite.", coveredThroughSeq: 200 }, { "If-Match": "1" });
    expect(put.status).toBe(200);

    const third = await md(`/api/states/s/journal?after=200&${page}`);
    expect(third).toContain("### #250 ");
    expect(third).not.toContain(UNREAD);
    expect(third).toContain("Last journal seq: 250. No newer entries.");

    // A cut entry can be read whole before the summary covers it.
    expect((await md("/api/states/s/journal/250")).length).toBeGreaterThan(LONG.length);
  });

  it("leaves entries appended while the summary was written unread for the next session", async () => {
    const { call, t, md, lastSeq } = await withLongJournal(30);
    const read = await md(`/api/states/s?after=0&limit=${RESUME.page}&maxChars=${RESUME.maxChars}`);
    expect(lastSeq(read)).toBe(30);
    expect(read).not.toContain(UNREAD);

    // Someone appends while the orchestrator writes the summary of #1-#30.
    await call(t, "POST", "/api/states/s/journal", { kind: "report", body: "late report" });
    await call(t, "PUT", "/api/states/s/summary", { content: "Through #30.", coveredThroughSeq: lastSeq(read) });

    const next = await md(`/api/states/s?after=30&limit=${RESUME.page}`);
    expect(next).toContain("late report");
    expect(next).toContain("Last journal seq: 31. No newer entries.");
  });

  it("says the same in the CLI and over MCP, and keeps a page small", async () => {
    const { app, t } = await withLongJournal(150);

    const exec = async (argv: string[]) => {
      let stdout = "";
      let stderr = "";
      const io: Io = {
        env: { DURA_URL: "http://localhost/", DURA_TOKEN: t, DURA_STATE: "s" },
        fetch: (url, init) => app.request(url, init) as unknown as Promise<Response>,
        readStdin: async () => "",
        readFile: async () => "",
        stdout: (s) => (stdout += s),
        stderr: (s) => (stderr += s),
      };
      return { code: await run(argv, io), stdout, stderr };
    };
    const missing = await exec(["summary", "get"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain(`dura journal --after 0 --limit ${RESUME.page} --max-chars ${RESUME.maxChars}`);
    const shown = await exec(["show", "--after", "0", "--limit", String(RESUME.page), "--max-chars", String(RESUME.maxChars)]);
    expect(shown.stdout).toContain(`Entries after #100 (through #150) ${UNREAD}. Continue with after=100.`);
    const rest = await exec(["journal", "--after", "100", "--limit", String(RESUME.page), "--max-chars", String(RESUME.maxChars)]);
    expect(rest.stdout).toContain("Last journal seq: 150. No newer entries.");

    let id = 1;
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      });
      return (await res.json()).result;
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.instructions).toContain(`after=C, limit=${RESUME.page}, maxChars=${RESUME.maxChars}`);
    expect(init.instructions).toContain("not from a seq remembered from an earlier session");
    const page = await rpc("tools/call", { name: "show_state", arguments: { state: "s", after: 0, limit: RESUME.page, maxChars: RESUME.maxChars } });
    expect(page.content[0].text).toContain(`Entries after #100 (through #150) ${UNREAD}.`);
    const next = await rpc("tools/call", { name: "read_journal", arguments: { state: "s", after: 100, limit: RESUME.page } });
    expect(next.content[0].text).toContain("Last journal seq: 150. No newer entries.");
  });

  it("describes the same procedure in the guide", async () => {
    const { app } = await setup();
    const guide = await (await app.request("/api/guide")).text();
    expect(guide).toContain(`dura show --after C --limit ${RESUME.page} --max-chars ${RESUME.maxChars}`);
    expect(guide).toContain("### Many unread entries, or no summary yet");
    expect(guide).toContain("not from a seq you remember from");
    expect(guide).toContain(UNREAD);
  });
});
