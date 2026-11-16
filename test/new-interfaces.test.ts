import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { setup } from "./helpers";

/** What the API had and the CLI and MCP lacked before (journal #37): create, title, revisions and the guide. */

async function withState() {
  const ctx = await setup();
  const t = await ctx.tokenFor("agent");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", sections: { tasks: "- [ ] a\n" } });
  await ctx.call(t, "PUT", "/api/states/s/sections/tasks", { content: "- [x] a\n" }, { "If-Match": "1" });
  await ctx.call(t, "POST", "/api/states/s/journal", { body: "one" });
  await ctx.call(t, "PUT", "/api/states/s/summary", { content: "First.", coveredThroughSeq: 0 });
  await ctx.call(t, "PUT", "/api/states/s/summary", { content: "Second.", coveredThroughSeq: 1 }, { "If-Match": "1" });
  return { ...ctx, t };
}

describe("revisions in the API", () => {
  it("returns every version newest first, as JSON or Markdown", async () => {
    const { call, t } = await withState();
    const json = await (await call(t, "GET", "/api/states/s/sections/tasks/revisions")).json();
    expect(json.revisions.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    const md = await (await call(t, "GET", "/api/states/s/summary/revisions", undefined, { Accept: "text/markdown" })).text();
    expect(md).toContain("# Journal summary: 2 versions, newest first");
    expect(md.indexOf("## Version 2, covers journal through #1")).toBeLessThan(md.indexOf("## Version 1, covers journal through #0"));
    expect(md).toContain("Second.");
  });
});

describe("the CLI", () => {
  const exec = async (ctx: Awaited<ReturnType<typeof withState>>, argv: string[], files: Record<string, string> = {}) => {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      env: { DURA_URL: "http://localhost", DURA_TOKEN: ctx.t, DURA_STATE: "s" },
      fetch: (url, init) => ctx.app.request(url, init) as unknown as Promise<Response>,
      readStdin: async () => "",
      readFile: async (path) => {
        if (!(path in files)) throw new Error(`no ${path}`);
        return files[path]!;
      },
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
    };
    return { code: await run(argv, io), stdout, stderr };
  };

  it("creates a state with sections from files", async () => {
    const ctx = await withState();
    const created = await exec(ctx, ["create", "--id", "new", "--title", "New work", "--note", "Starting", "--section", "goal=g.md", "--section", "plan=p.md"], {
      "g.md": "# Goal\n",
      "p.md": "# Plan\n",
    });
    expect(created).toMatchObject({ code: 0, stderr: "Created state new (active).\n" });
    const shown = await exec(ctx, ["show", "--state", "new"]);
    expect(shown.stdout).toContain("## Section: goal");
    expect(shown.stdout).toContain("# Plan");
    expect(shown.stdout).toContain("New work");

    const json = await exec(ctx, ["create", "--title", "Generated id", "--json"]);
    expect(JSON.parse(json.stdout).state.id).toBe("generated-id");

    const bad = await exec(ctx, ["create", "--title", "x", "--section", "goal"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--section takes <name>=<file>");
    expect((await exec(ctx, ["create"])).stderr).toContain("create needs --title");
  });

  it("changes the title without touching the status", async () => {
    const ctx = await withState();
    const res = await exec(ctx, ["title", "Renamed"]);
    expect(res).toMatchObject({ code: 0, stderr: 'Title of s is now "Renamed".\n' });
    const { state } = await (await ctx.call(ctx.t, "GET", "/api/states/s")).json();
    expect(state).toMatchObject({ title: "Renamed", status: "active" });
    expect((await exec(ctx, ["title"])).stderr).toContain("Missing <title>");
  });

  it("prints the revisions of a section and of the summary", async () => {
    const ctx = await withState();
    const section = await exec(ctx, ["section", "revisions", "tasks"]);
    expect(section.code).toBe(0);
    expect(section.stdout).toContain("# Section tasks: 2 versions, newest first");
    expect(section.stdout).toContain("- [x] a");
    const summary = await exec(ctx, ["summary", "revisions", "--json"]);
    expect(JSON.parse(summary.stdout).revisions.map((r: { coveredThroughSeq: number }) => r.coveredThroughSeq)).toEqual([1, 0]);
    expect((await exec(ctx, ["section", "revisions", "nope"])).stderr).toContain("not_found");
  });
});

describe("MCP", () => {
  it("offers the guide, create_state, set_title and the revisions", async () => {
    const ctx = await withState();
    const tool = async (name: string, args: Record<string, unknown>) => {
      const res = await ctx.app.request("/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const { result } = await res.json();
      return { text: result.content[0].text as string, isError: result.isError === true };
    };

    expect((await tool("get_guide", {})).text).toContain("# dura: shared state for agent loops");
    expect(await tool("create_state", { id: "m", title: "From MCP", sections: { goal: "# Goal" } })).toEqual({
      isError: false,
      text: "Created state m (active).",
    });
    expect((await tool("show_state", { state: "m" })).text).toContain("# Goal");
    expect((await tool("create_state", { title: "x", sections: { goal: 1 } })).text).toBe("sections must be an object of strings.");
    expect((await tool("create_state", {})).text).toBe("title is required.");

    expect((await tool("set_title", { state: "s", title: "Renamed" })).text).toBe('Title of s is now "Renamed".');
    expect((await tool("set_title", { state: "s" })).text).toBe("title is required.");
    expect((await tool("set_status", { state: "s", status: "waiting", note: "Q?" })).text).toBe("Status of s is now waiting.");

    expect((await tool("list_section_revisions", { state: "s", name: "tasks" })).text).toContain("## Version 1");
    expect((await tool("list_summary_revisions", { state: "s" })).text).toContain("covers journal through #1");
    const missing = await tool("list_summary_revisions", { state: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("list_states");
  });
});
