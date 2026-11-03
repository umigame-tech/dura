import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

async function mcp() {
  const ctx = await setup();
  const token = await ctx.tokenFor("mcp-agent");
  await ctx.call(token, "POST", "/api/states", { id: "s", title: "S", sections: { tasks: "- [ ] a\n- [ ] b\n" } });

  let nextId = 1;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    ctx.app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const rpc = async (method: string, params?: unknown) => (await post({ jsonrpc: "2.0", id: nextId++, method, params })).json();
  const tool = async (name: string, args: Record<string, unknown>) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    return { text: result.content[0].text as string, isError: result.isError === true };
  };
  return { ...ctx, token, post, rpc, tool };
}

describe("mcp", () => {
  it("initializes and lists the tools", async () => {
    const { rpc, post } = await mcp();
    const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("dura");
    expect(init.result.capabilities.tools).toEqual({});
    expect(init.result.instructions).toContain("show_state");

    const unknownVersion = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(unknownVersion.result.protocolVersion).toBe("2025-06-18");

    const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);
    const response = await post({ jsonrpc: "2.0", id: 99, result: {} });
    expect(response.status).toBe(202);

    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
      "list_states",
      "show_state",
      "read_journal",
      "get_section",
      "put_section",
      "replace_in_section",
      "get_summary",
      "put_summary",
      "append_journal",
      "set_status",
    ]);

    expect((await rpc("nope")).error.code).toBe(-32601);
  });

  it("requires a valid bearer token and rejects other origins", async () => {
    const { app, post } = await mcp();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const none = await app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toContain("Bearer");

    const bad = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer dura_wrong", "Content-Type": "application/json" },
      body,
    });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.message).toContain("invalid");

    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await app.request("/mcp")).status).toBe(405);
  });

  it("reads and writes through the API", async () => {
    const { tool, call, token } = await mcp();

    expect((await tool("list_states", {})).text).toContain("**s**");

    const got = await tool("get_section", { state: "s", name: "tasks" });
    expect(got.text).toBe("<!-- version: 1 -->\n\n- [ ] a\n- [ ] b\n");

    const replaced = await tool("replace_in_section", { state: "s", name: "tasks", version: 1, old: "- [ ] a", new: "- [x] a" });
    expect(replaced).toEqual({ text: "Wrote section tasks (version 2).", isError: false });

    expect((await tool("put_section", { state: "s", name: "plan", content: "# Plan\n" })).text).toBe("Wrote section plan (version 1).");

    expect((await tool("append_journal", { state: "s", kind: "report", body: "did a" })).text).toBe("Appended report #1.");
    expect((await tool("read_journal", { state: "s" })).text).toContain("### #1 report by mcp-agent");

    const shown = (await tool("show_state", { state: "s", after: 0 })).text;
    expect(shown).toContain("- [x] a");
    expect(shown).toContain("Last journal seq: 1");

    expect((await tool("set_status", { state: "s", status: "waiting", note: "Which?" })).text).toBe("Status of s is now waiting.");
    const state = await (await call(token, "GET", "/api/states/s")).json();
    expect(state.state).toMatchObject({ status: "waiting", statusNote: "Which?" });
  });

  it("returns API errors as tool errors with the next step", async () => {
    const { tool, tokenFor, app } = await mcp();

    const conflict = await tool("replace_in_section", { state: "s", name: "tasks", version: 0, old: "- [ ] a", new: "x" });
    expect(conflict.isError).toBe(true);
    expect(conflict.text).toContain("version_conflict (HTTP 409)");
    expect(conflict.text).toContain("retry with version 1");

    const exists = await tool("put_section", { state: "s", name: "tasks", content: "x" });
    expect(exists.text).toContain("precondition_required");

    const missing = await tool("show_state", { state: "nope" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("not_found");
    expect(missing.text).toContain("list_states");

    expect((await tool("get_section", { name: "tasks" })).text).toBe("state is required.");
    expect(await tool("get_section", { state: "s", name: ".." })).toEqual({ isError: true, text: 'name must not be "..".' });
    expect(await tool("show_state", { state: "." })).toEqual({ isError: true, text: 'state must not be ".".' });
    expect((await tool("set_status", { state: "s", status: "done" })).isError).toBe(true);

    const reader = await tokenFor("reader", "read");
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${reader}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "append_journal", arguments: { state: "s", body: "x" } },
      }),
    });
    const { result } = await res.json();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("forbidden");
  });
});
