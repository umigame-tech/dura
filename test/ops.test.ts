import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { guideMarkdown } from "../src/guide";
import { honoPath } from "../src/ops/http";
import { argOf, flagOf, operations } from "../src/ops/spec";
import { api } from "../src/routes/api";
import { setup } from "./helpers";

/**
 * What the CLI or MCP does not offer yet. Every operation and parameter of the API should be
 * available from all three interfaces; the next step (journal #37) empties this list.
 */
const KNOWN_GAPS = [
  "guide: mcp",
  "createState: cli",
  "createState: mcp",
  "listSectionRevisions: cli",
  "listSectionRevisions: mcp",
  "listSummaryRevisions: cli",
  "listSummaryRevisions: mcp",
  "updateState.title: cli",
  "updateState.title: mcp",
];

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("one spec for the API, the CLI and MCP", () => {
  it("registers exactly the routes of the spec", () => {
    const routes = api.routes.filter((r) => r.path !== "/*").map((r) => `${r.method} ${r.path}`);
    expect(routes.sort()).toEqual(operations().map(([, op]) => `${op.method} ${honoPath(op)}`).sort());
  });

  it("offers every operation and parameter in the CLI and MCP", () => {
    const gaps: string[] = [];
    for (const [id, op] of operations()) {
      if ("skip" in op.cli) gaps.push(`${id}: cli`);
      if ("skip" in op.mcp) gaps.push(`${id}: mcp`);
      for (const p of op.params) {
        if (p.cli?.skip && !("skip" in op.cli)) gaps.push(`${id}.${p.name}: cli`);
        if (p.mcp?.skip && !("skip" in op.mcp)) gaps.push(`${id}.${p.name}: mcp`);
      }
    }
    expect(gaps).toEqual(KNOWN_GAPS);
  });

  it("gives every CLI flag one type and every tool and command a unique name", () => {
    const types = new Map<string, string>();
    for (const [id, op] of operations()) {
      for (const p of op.params) {
        if (p.cli?.positional || p.cli?.state || p.cli?.stdin || p.cli?.skip) continue;
        const type = p.type === "boolean" ? "boolean" : "string";
        expect(types.get(flagOf(p)) ?? type, `--${flagOf(p)} in ${id}`).toBe(type);
        types.set(flagOf(p), type);
      }
      const args = op.params.filter((p) => !p.mcp?.skip).map(argOf);
      expect(new Set(args).size, `arguments of ${id}`).toBe(args.length);
    }
    const tools = operations().flatMap(([, op]) => ("tool" in op.mcp ? [op.mcp.tool] : []));
    expect(new Set(tools).size).toBe(tools.length);
    const commands = operations().flatMap(([, op]) =>
      "command" in op.cli ? [`${op.cli.command} ${op.params.filter((p) => p.cli?.positional).length}`] : [],
    );
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("lists every tool over MCP with a schema of its parameters", async () => {
    const ctx = await setup();
    const token = await ctx.tokenFor("t");
    const res = await ctx.app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const { result } = await res.json();
    const listed = new Map<string, { inputSchema: { properties: Record<string, unknown> } }>(
      result.tools.map((t: { name: string }) => [t.name, t]),
    );
    for (const [, op] of operations()) {
      if (!("tool" in op.mcp)) continue;
      const tool = listed.get(op.mcp.tool);
      expect(tool, op.mcp.tool).toBeDefined();
      expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual(op.params.filter((p) => !p.mcp?.skip).map(argOf).sort());
    }
  });

  it("lists every command and flag in the CLI help", async () => {
    let help = "";
    const io: Io = {
      env: {},
      fetch: async () => new Response(""),
      readStdin: async () => "",
      readFile: async () => "",
      stdout: (s) => (help += s),
      stderr: () => {},
    };
    expect(await run(["--help"], io)).toBe(0);
    for (const [, op] of operations()) {
      if (!("command" in op.cli)) continue;
      expect(help).toContain(`  ${op.cli.command}`);
      for (const p of op.params) {
        if (!p.cli?.positional && !p.cli?.state && !p.cli?.stdin && !p.cli?.skip) expect(help).toContain(`--${flagOf(p)}`);
      }
    }
  });

  it("mentions every tool and command in the guide, the READMEs and the skill", () => {
    const guide = guideMarkdown("https://dura.example");
    const docs = { readme: read("README.md"), cli: read("cli/README.md"), skill: read(".agents/skills/dura/SKILL.md") };
    for (const [, op] of operations()) {
      expect(guide, op.path).toContain(`/api${op.path}`);
      if ("tool" in op.mcp) {
        expect(guide).toContain(`\`${op.mcp.tool}\``);
        expect(docs.readme, `README.md: ${op.mcp.tool}`).toContain(op.mcp.tool);
        expect(docs.skill, `SKILL.md: ${op.mcp.tool}`).toContain(op.mcp.tool);
      }
      if ("command" in op.cli) {
        for (const [name, text] of Object.entries(docs)) expect(text, `${name}: dura ${op.cli.command}`).toContain(`dura ${op.cli.command}`);
      }
    }
  });

  it("reads the request only through the spec in the API handlers", () => {
    // Handlers get their params from the spec (reading an undeclared one throws, see declaredOnly).
    // Reading the request directly would add a param the CLI and MCP never learn about.
    const reads = [...read("src/routes/api.ts").matchAll(/c\.req\.\w+\([^)]*\)/g)].map((m) => m[0]);
    expect(new Set(reads)).toEqual(new Set(['c.req.header("Accept")', 'c.req.query("format")']));
    for (const [id, op] of operations()) {
      if (op.auth === "read" || op.auth === "write") expect(op.path, `${id} checks access to the state in its path`).toMatch(/^\/states\/:id(\/|$)/);
    }
  });

  it("names only commands and tools that exist, in the docs, hints and instructions", () => {
    const commands = operations().flatMap(([, op]) => ("command" in op.cli ? [op.cli.command] : []));
    const tools = new Set(operations().flatMap(([, op]) => ("tool" in op.mcp ? [op.mcp.tool] : [])));
    const files = ["README.md", "cli/README.md", ".agents/skills/dura/SKILL.md", "src/guide.ts", "src/mcp.ts", "cli/src/cli.ts"];
    for (const file of files) {
      const text = read(file);
      // Inline code, fenced code blocks and indented code: where a command is shown, not prose.
      let fenced = false;
      const snippets = text.split("\n").flatMap((line) => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        const inline = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
        return fenced || /^ {4}/.test(line) ? [line, ...inline] : inline;
      });
      for (const snippet of snippets) {
        for (const m of snippet.matchAll(/(?:^|[\s(|&;])dura ([a-z]+(?: [a-z]+)*)(?=$|[\s"'`)|&;\\])/g)) {
          const words = m[1]!;
          expect(commands.some((c) => words === c || words.startsWith(`${c} `)), `${file}: dura ${words}`).toBe(true);
        }
      }
      for (const m of text.matchAll(/\b(?:list|show|read|get|search|put|replace|append|set)_[a-z_]+\b/g)) {
        expect(tools.has(m[0]), `${file}: ${m[0]}`).toBe(true);
      }
    }
  });

  it("keeps the shared files free of imports, so the CLI bundle does not pull in server code", () => {
    for (const file of ["src/ops/spec.ts", "src/ops/messages.ts"]) expect(read(file), file).not.toMatch(/^\s*import\s/m);
  });
});
