import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { guideMarkdown } from "../src/guide";
import { declaredOnly, honoPath } from "../src/ops/http";
import { WRITTEN_OPERATIONS } from "../src/ops/messages";
import { argOf, cliCommands, flagOf, mcpTools, OPERATIONS, operations } from "../src/ops/spec";
import { api } from "../src/routes/api";
import { setup } from "./helpers";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("one spec for the API, the CLI and MCP", () => {
  it("registers exactly the routes of the spec", () => {
    const routes = api.routes.filter((r) => r.path !== "/*").map((r) => `${r.method} ${r.path}`);
    expect(routes.sort()).toEqual(operations().map(([, op]) => `${op.method} ${honoPath(op)}`).sort());
  });

  it("offers every operation and parameter in the CLI and MCP", () => {
    // The API has nothing the CLI or MCP lacks (journal #37): every param is taken by some command and some tool.
    for (const [id, op] of operations()) {
      for (const [where, views] of [
        ["cli", cliCommands(op)],
        ["mcp", mcpTools(op)],
      ] as const) {
        expect(views.length, `${id}: ${where}`).toBeGreaterThan(0);
        for (const p of op.params) {
          expect(views.some((v) => v.params.includes(p)), `${id}.${p.name}: ${where}`).toBe(true);
        }
        // Each command and tool can build the request: every path param and every required param.
        for (const v of views) {
          for (const p of op.params.filter((x) => x.in === "path" || (x.required && x.default === undefined))) {
            expect(v.params, `${id} (${"command" in v ? v.command : v.tool}) takes ${p.name}`).toContain(p);
          }
        }
        // A command or tool must not name a param the operation does not have.
        for (const name of (Array.isArray(op[where]) ? op[where] : [op[where]]).flatMap((v: { params?: readonly string[] }) => v.params ?? [])) {
          expect(op.params.map((p) => p.name), `${id}: ${where} param ${name}`).toContain(name);
        }
      }
    }
  });

  it("gives every CLI flag one type and every tool and command a unique name", () => {
    const types = new Map<string, string>();
    for (const [id, op] of operations()) {
      for (const p of op.params) {
        if (p.cli?.positional || p.cli?.state || p.cli?.stdin) continue;
        const type = p.type === "boolean" ? "boolean" : p.cli?.files ? "string[]" : "string";
        expect(types.get(flagOf(p)) ?? type, `--${flagOf(p)} in ${id}`).toBe(type);
        types.set(flagOf(p), type);
      }
      for (const tool of mcpTools(op)) {
        const args = tool.params.map(argOf);
        expect(new Set(args).size, `arguments of ${tool.tool}`).toBe(args.length);
      }
    }
    const tools = operations().flatMap(([, op]) => mcpTools(op).map((t) => t.tool));
    expect(new Set(tools).size).toBe(tools.length);
    const commands = operations().flatMap(([, op]) =>
      cliCommands(op).map((c) => `${c.command} ${c.params.filter((p) => p.cli?.positional).length}`),
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
      for (const tool of mcpTools(op)) {
        expect(listed.get(tool.tool), tool.tool).toBeDefined();
        expect(Object.keys(listed.get(tool.tool)!.inputSchema.properties).sort()).toEqual(tool.params.map(argOf).sort());
      }
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
      for (const cmd of cliCommands(op)) {
        expect(help).toMatch(new RegExp(`^  ${cmd.command}( <| \\[| {2,})`, "m"));
        for (const p of cmd.params) {
          if (p.cli?.positional || p.cli?.state || p.cli?.stdin) continue;
          // The line of the flag names the commands that take it.
          const line = help.split("\n").find((l) => l.trimStart().startsWith(`--${flagOf(p)} `) || l.trim() === `--${flagOf(p)}`);
          expect(line, `--${flagOf(p)}`).toBeDefined();
          expect(line!.replace(/^\s*--\S+( <\S+>)?\s+/, ""), `--${flagOf(p)} for ${cmd.command}`).toMatch(
            new RegExp(`(^|; |/ )${cmd.command}( /|:)`),
          );
        }
      }
    }
  });

  it("mentions every tool and command in the guide, the READMEs and the skill", () => {
    const guide = guideMarkdown("https://dura.example");
    const docs = { readme: read("README.md"), cli: read("cli/README.md"), skill: read(".agents/skills/dura/SKILL.md") };
    for (const [, op] of operations()) {
      expect(guide, op.path).toContain(`/api${op.path}`);
      for (const { tool } of mcpTools(op)) {
        expect(guide).toContain(`\`${tool}\``);
        expect(docs.readme, `README.md: ${tool}`).toContain(tool);
        expect(docs.skill, `SKILL.md: ${tool}`).toContain(tool);
      }
      for (const { command } of cliCommands(op)) {
        for (const [name, text] of Object.entries(docs)) expect(text, `${name}: dura ${command}`).toContain(`dura ${command}`);
      }
    }
  });

  it("reads the request only through the spec in the API handlers", () => {
    // Handlers get their params from the spec (reading an undeclared one throws, see declaredOnly).
    // Reading the request directly would add a param the CLI and MCP never learn about.
    const source = read("src/routes/api.ts");
    const reads = [...source.matchAll(/\breq\b[^;\n]*/g)].map((m) => m[0]);
    expect(reads).toEqual(['req.header("Accept") ?? "") || c.req.query("format") === "md"']);
    for (const [id, op] of operations()) {
      if (op.auth === "read" || op.auth === "write") expect(op.path, `${id} checks access to the state in its path`).toMatch(/^\/states\/:id(\/|$)/);
      const writes = op.method !== "GET";
      expect(writes ? ["write", "create"] : ["public", "token", "read"], `${id}: ${op.method} with auth ${op.auth}`).toContain(op.auth);
    }
  });

  it("throws when a handler reads a param that is not in the spec", () => {
    const input = declaredOnly(OPERATIONS.getSection, { id: "s", name: "tasks" });
    expect(input.name).toBe("tasks");
    expect(() => input.version).toThrow('Param "version" is not in the spec of GET /states/:id/sections/:name.');
    expect(() => "version" in input).toThrow("not in the spec");
  });

  it("reports writes only for operations that exist", () => {
    for (const id of WRITTEN_OPERATIONS) expect(Object.keys(OPERATIONS), id).toContain(id);
  });

  it("names only commands and tools that exist, in the docs, hints and instructions", () => {
    const commands = operations().flatMap(([, op]) => cliCommands(op).map((c) => c.command));
    const tools = new Set(operations().flatMap(([, op]) => mcpTools(op).map((t) => t.tool)));
    const files = [
      "README.md",
      "cli/README.md",
      ".agents/skills/dura/SKILL.md",
      "src/guide.ts",
      "src/mcp.ts",
      "src/store.ts",
      "src/ops/spec.ts",
      "cli/src/cli.ts",
    ];
    // Tool names look like <verb>_<thing>; the verbs are those of the tools, plus ones a new tool would likely use.
    const verbs = new Set([...[...tools].map((t) => t.split("_")[0]!), "create", "delete", "update", "list"]);
    const toolName = new RegExp(`\\b(?:${[...verbs].join("|")})_[a-z_]+\\b`, "g");
    let checked = 0;
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
          checked++;
        }
      }
      for (const m of text.matchAll(toolName)) {
        expect(tools.has(m[0]), `${file}: ${m[0]}`).toBe(true);
        checked++;
      }
    }
    // The patterns still find what they look for.
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps the shared files free of imports, so the CLI bundle does not pull in server code", () => {
    for (const file of ["src/ops/spec.ts", "src/ops/messages.ts"]) expect(read(file), file).not.toMatch(/^\s*import\s/m);
  });
});
