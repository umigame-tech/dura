import { describe, expect, it } from "vitest";
import { passkeys } from "../src/db/schema";
import { ORIGIN, setup } from "./helpers";

async function loggedIn() {
  const ctx = await setup();
  await ctx.db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
  const cookie = await ctx.ownerCookie();
  const get = (path: string) => ctx.app.request(path, { headers: { Cookie: cookie } });
  const post = (path: string, fields: Record<string, string>, origin = ORIGIN) =>
    ctx.app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  return { ...ctx, get, post };
}

describe("web UI", () => {
  it("sends visitors to setup, then login", async () => {
    const { app, db } = await setup();
    expect((await app.request("/")).headers.get("Location")).toBe("/login");
    expect((await app.request("/login")).headers.get("Location")).toBe("/setup");
    const setupPage = await (await app.request("/setup")).text();
    expect(setupPage).toContain("setup-token");

    await db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
    expect((await app.request("/setup")).headers.get("Location")).toBe("/login");
    expect((await app.request("/s/x")).headers.get("Location")).toBe("/login?next=%2Fs%2Fx");
  });

  it("rejects the first passkey registration without the setup token", async () => {
    const { app } = await setup();
    const res = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ setupToken: "wrong" }),
    });
    expect(res.status).toBe(403);
    const ok = await app.request("/auth/register/options", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ setupToken: "setup-secret" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).rp.id).toBe("localhost");
  });

  it("creates a state and shows waiting states first", async () => {
    const { get, post } = await loggedIn();
    const created = await post("/states", { title: "First", goal: "Ship it" });
    expect(created.headers.get("Location")).toBe("/s/first");
    await post("/states", { title: "Second" });
    await post("/s/second/status", { status: "waiting", statusNote: "Need input" });

    const html = await (await get("/")).text();
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("First"));
    expect(html).toContain("Need input");

    const state = await (await get("/s/first")).text();
    expect(state).toContain("Ship it");
    expect(state).toContain("v1 · human");
  });

  it("escapes HTML written by agents", async () => {
    const { get, post, call, tokenFor } = await loggedIn();
    await post("/states", { title: "X", id: "x" });
    const t = await tokenFor("agent");
    await call(t, "POST", "/api/states/x/journal", {
      body: '<script>alert(1)</script> [click](javascript:alert(2)) <img src=x onerror=alert(3)>',
    });
    const html = await (await get("/s/x")).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img src=x");
  });

  it("shows a diff instead of overwriting on conflict", async () => {
    const { get, post } = await loggedIn();
    await post("/states", { title: "X", id: "x" });
    expect((await post("/s/x/sections/plan", { content: "line one\nline two", version: "0" })).status).toBe(302);
    await post("/s/x/sections/plan", { content: "line one\nline 2 by agent", version: "1" });

    const res = await post("/s/x/sections/plan", { content: "line one\nmy edit", version: "1" });
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("Someone else saved version 2");
    expect(html).toContain('name="version" value="2"');
    expect(html).toContain("my edit");

    const history = await (await get("/s/x/sections/plan/history")).text();
    expect(history).toContain("v2");
    expect(history).toContain('class="del"');
  });

  it("issues tokens that work against the API", async () => {
    const { post, call } = await loggedIn();
    await post("/states", { title: "X", id: "x" });
    const html = await (await post("/settings/tokens", { name: "codex", scope: "write", stateIds: "x" })).text();
    const secret = /dura_[A-Za-z0-9_-]+/.exec(html)![0];
    const res = await call(secret, "POST", "/api/states/x/journal", { kind: "report", body: "done" });
    expect((await res.json()).entry.actor).toBe("codex");
  });

  it("routes the new-section form to the editor", async () => {
    const { get, post } = await loggedIn();
    await post("/states", { title: "X", id: "x" });
    expect((await get("/s/x/sections/_/edit?name=findings")).headers.get("Location")).toBe("/s/x/sections/findings/edit");
    const html = await (await get("/s/x/sections/findings/edit")).text();
    expect(html).toContain('name="version" value="0"');
    expect((await get("/s/x/sections/Bad%20Name/edit")).status).toBe(400);
  });

  it("blocks cross-site form posts", async () => {
    const { post } = await loggedIn();
    expect((await post("/states", { title: "X" }, "https://evil.example")).status).toBe(403);
  });

  it("serves PWA assets", async () => {
    const { app } = await setup();
    expect((await app.request("/sw.js")).status).toBe(200);
    expect((await (await app.request("/manifest.webmanifest")).json()).display).toBe("standalone");
  });
});
