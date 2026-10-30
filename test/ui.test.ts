import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { passkeys, pushSubscriptions } from "../src/db/schema";
import type { Deps } from "../src/env";
import { ICON } from "../src/routes/assets";
import { SOURCE_ICON_SHA256 } from "../src/routes/icons";
import { base64urlEncode } from "../src/lib/util";
import { ORIGIN, setup } from "./helpers";

async function loggedIn(overrides: Partial<Deps> = {}) {
  const ctx = await setup(overrides);
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

    // Browsers drop tabs and newlines inside a URL and control characters at its ends.
    for (const href of ["<java\tscript:alert(4)>", "<java\nscript:alert(5)>", "\x01javascript:alert(6)"]) {
      await call(t, "POST", "/api/states/x/journal", { body: `[bad](${href}) [ok](https://example.com/a?b=1)` });
      const page = await (await get("/s/x")).text();
      expect(page).not.toMatch(/href="[^"]*script:/i);
      expect(page).toContain('href="https://example.com/a?b=1"');
    }
  });

  it("only follows a same-site next after login", async () => {
    const { app } = await setup();
    const js = await (await app.request("/static/app.js")).text();
    expect(js).toContain("location.href = sameSitePath(");
    const source = /function sameSitePath[\s\S]*?\n}\n/.exec(js)![0];
    const sameSitePath = new Function(`${source}; return sameSitePath;`)() as (next: string | null, origin: string) => string;
    const origin = "https://dura.example";
    expect(sameSitePath(null, origin)).toBe("/");
    expect(sameSitePath("/s/x?section=goal#j3", origin)).toBe(`${origin}/s/x?section=goal#j3`);
    expect(sameSitePath("/settings", origin)).toBe(`${origin}/settings`);
    const outside = ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example"];
    for (const bad of [...outside, "javascript:alert(1)", "https://evil.example", "https://dura.example@evil.example"]) {
      expect(sameSitePath(bad, origin)).toBe("/");
    }
    // Same origin, but the path normalizes to "//host", which location.href would read as another host.
    for (const tricky of ["/.//evil.example", "/./\\evil.example", "/a/..//evil.example", "/%2e//evil.example", `${origin}//evil.example`]) {
      expect(new URL(sameSitePath(tricky, origin), origin).origin).toBe(origin);
    }
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

  it("sends a test push to one device", async () => {
    const requests: Request[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      return new Response(null, { status: req.url.includes("gone") ? 410 : 201 });
    }) as typeof fetch;
    const { db, post, get } = await loggedIn({ fetch: fakeFetch });
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const keys = {
      p256dh: base64urlEncode((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
      auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    await db.insert(pushSubscriptions).values([
      { endpoint: "https://push.example.com/live", ...keys },
      { endpoint: "https://push.example.com/gone", ...keys },
    ]);
    expect(await (await get("/settings")).text()).toContain('action="/settings/push/test"');

    const ok = await (await post("/settings/push/test", { endpoint: "https://push.example.com/live" })).text();
    expect(ok).toContain("Sent a test to push.example.com.");
    expect(requests.map((r) => r.url)).toEqual(["https://push.example.com/live"]);
    expect(requests[0]!.headers.get("Content-Encoding")).toBe("aes128gcm");

    const gone = await post("/settings/push/test", { endpoint: "https://push.example.com/gone" });
    expect(gone.status).toBe(400);
    expect(await gone.text()).toContain("subscription has expired, so it was removed");
    const subs = await db.select().from(pushSubscriptions);
    expect(subs.map((s) => s.endpoint)).toEqual(["https://push.example.com/live"]);

    expect((await post("/settings/push/test", { endpoint: "https://push.example.com/unknown" })).headers.get("Location")).toBe("/settings");
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
    const manifest = await (await app.request("/manifest.webmanifest")).json();
    expect(manifest.display).toBe("standalone");

    // Each PNG must exist and have the size it is declared with.
    const pngs: [string, number][] = [
      ...manifest.icons
        .filter((i: { type: string }) => i.type === "image/png")
        .map((i: { src: string; sizes: string }) => [i.src, Number(i.sizes.split("x")[0])]),
      ["/apple-touch-icon.png", 180],
      ["/badge-96.png", 96],
    ];
    expect(pngs.map(([path]) => path)).toContain("/icon-maskable-512.png");
    for (const [path, size] of pngs) {
      const res = await app.request(path);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      const view = new DataView(await res.arrayBuffer());
      expect(view.getUint32(0)).toBe(0x89504e47);
      expect([view.getUint32(16), view.getUint32(20)]).toEqual([size, size]);
    }

    // Fails when ICON changed without rerunning scripts/render-icons.cjs.
    expect(createHash("sha256").update(ICON).digest("hex")).toBe(SOURCE_ICON_SHA256);

    const html = await (await app.request("/setup")).text();
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    const sw = await (await app.request("/sw.js")).text();
    expect(sw).toContain('icon: "/icon-192.png"');
    expect(sw).toContain('badge: "/badge-96.png"');
  });
});
