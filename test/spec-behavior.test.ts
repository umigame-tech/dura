import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { setup } from "./helpers";

/** The behavior that comes from src/ops/spec.ts: validation in the API, strict commands in the CLI, arguments in MCP. */

async function withState() {
  const ctx = await setup();
  const t = await ctx.tokenFor("agent");
  await ctx.call(t, "POST", "/api/states", { id: "s", title: "S", statusNote: "keep me", sections: { tasks: "- [ ] a\n" } });
  await ctx.call(t, "POST", "/api/states/s/journal", { body: "one" });
  return { ...ctx, t };
}

describe("API validation from the spec", () => {
  it("rejects values outside the spec with 400", async () => {
    const { call, t } = await withState();
    const cases: [string, string, unknown?][] = [
      ["GET", "/api/states?status=bogus"],
      ["GET", "/api/states/s?limit=0"],
      ["GET", "/api/states/s/journal?limit=0"],
      ["GET", "/api/states/s/journal/search?q=one&limit=0"],
      ["GET", "/api/states/s/journal/0"],
      ["GET", "/api/states/s/journal?after=x"],
      ["POST", "/api/states", { title: "x", sections: ["goal"] }],
      ["POST", "/api/states", { title: "x", sections: { goal: 1 } }],
      ["POST", "/api/states/s/journal", { body: "x", kind: null }],
      ["PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 1e21 }],
      ["PUT", "/api/states/s/summary", { content: "x", coveredThroughSeq: 1.5 }],
      ["PATCH", "/api/states/s", { status: "done" }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(t, method, path, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    }
    const nested = await call(t, "POST", "/api/states", { title: "x", sections: { goal: 1 } });
    expect((await nested.json()).error.message).toBe("sections.goal must be a string.");
    const covered = await call(t, "PUT", "/api/states/s/summary", { content: "x" });
    expect((await covered.json()).error.message).toContain("The last journal seq");
  });

  it("treats an empty status filter as none and keeps the other defaults", async () => {
    const { call, t } = await withState();
    expect((await (await call(t, "GET", "/api/states?status=")).json()).states).toHaveLength(1);
    const appended = await call(t, "POST", "/api/states/s/journal?kind=decision", { body: "json body, kind from the query" });
    expect((await appended.json()).entry.kind).toBe("decision");
    const raw = await call(t, "POST", "/api/states/s/journal", "raw body", { "Content-Type": "text/markdown" });
    expect((await raw.json()).entry.kind).toBe("note");
  });

  it("asks for If-Match before looking at the body", async () => {
    const { call, t } = await withState();
    const res = await call(t, "POST", "/api/states/s/sections/tasks/replace", "{broken", { "Content-Type": "application/json" });
    expect(res.status).toBe(428);
    expect((await res.json()).error.code).toBe("precondition_required");
  });
});

describe("CLI commands from the spec", () => {
  it("rejects flags and arguments the command does not take, before sending anything", async () => {
    const ctx = await withState();
    const exec = async (argv: string[]) => {
      let stderr = "";
      let stdinRead = false;
      const urls: string[] = [];
      const io: Io = {
        env: { DURA_URL: "http://localhost", DURA_TOKEN: ctx.t, DURA_STATE: "s" },
        fetch: (url, init) => {
          urls.push(url);
          return ctx.app.request(url, init) as unknown as Promise<Response>;
        },
        readStdin: async () => {
          stdinRead = true;
          return "body";
        },
        readFile: async () => "",
        stdout: () => {},
        stderr: (s) => (stderr += s),
      };
      return { code: await run(argv, io), stderr, urls, stdinRead };
    };

    for (const [argv, message] of [
      [["show", "--kind", "x"], "`dura show` does not take --kind."],
      [["section", "get", "tasks", "--version", "1"], "does not take --version"],
      [["journal", "1", "--limit", "3"], "`dura journal <seq>` does not take --limit."],
      [["status", "active", "--file", "x.md"], "does not take --file"],
      [["show", "extra"], "Too many arguments"],
      [["section", "get"], "Missing <name>"],
      [["section"], "Use `dura section get|put|replace|revisions`."],
      [["journal", "--after", "1", "--before", "2"], "Pass either --after or --before, not both."],
      [["list", "--status", "done"], "status must be one of"],
    ] as [string[], string][]) {
      const res = await exec(argv);
      expect(res.code, argv.join(" ")).toBe(2);
      expect(res.stderr, argv.join(" ")).toContain(message);
      expect(res.urls, argv.join(" ")).toEqual([]);
    }

    const noCovered = await exec(["summary", "put"]);
    expect(noCovered.code).toBe(2);
    expect(noCovered.stderr).toContain("needs --covered");
    expect(noCovered.stdinRead).toBe(false);

    const replaced = await exec(["section", "replace", "tasks", "--version", "1", "--old", "- [ ] a", "--new", "- [x] a", "--all"]);
    expect(replaced.code).toBe(0);
    expect(replaced.stderr).toBe("Wrote section tasks (version 2).\n");
  });
});

describe("MCP arguments from the spec", () => {
  it("checks types like the API and treats null as not given", async () => {
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

    expect(await tool("put_summary", { state: "s", content: "x", coveredThroughSeq: 1e21 })).toEqual({
      isError: true,
      text: "coveredThroughSeq must be a non-negative integer.",
    });
    expect((await tool("set_status", { state: "s", status: "active", note: null })).text).toBe("Status of s is now active.");
    const { state } = await (await ctx.call(ctx.t, "GET", "/api/states/s")).json();
    expect(state.statusNote).toBe("keep me");
    expect(await tool("read_journal", { state: "s", after: 0, before: 2 })).toEqual({ isError: true, text: "Pass either after or before, not both." });
  });
});
