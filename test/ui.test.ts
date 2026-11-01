import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { journalEntries, passkeys, pushSubscriptions, states } from "../src/db/schema";
import type { Deps } from "../src/env";
import { ASSET_VERSION, contentVersion, ICON } from "../src/routes/assets";
import { INLINE_SCRIPT, INLINE_SCRIPT_SHA256 } from "../src/ui/layout";
import { SOURCE_ICON_SHA256 } from "../src/routes/icons";
import { base64urlEncode } from "../src/lib/util";
import { ORIGIN, setup } from "./helpers";

async function loggedIn(overrides: Partial<Deps> = {}) {
  const ctx = await setup(overrides);
  await ctx.db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
  const cookie = await ctx.ownerCookie();
  const get = (path: string, extraCookie?: string) =>
    ctx.app.request(path, { headers: { Cookie: extraCookie ? `${cookie}; ${extraCookie}` : cookie } });
  const post = (path: string, fields: Record<string, string>, origin = ORIGIN) =>
    ctx.app.request(path, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  return { ...ctx, cookie, get, post };
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

  it("stores LF for CRLF form submissions", async () => {
    const { db, post } = await loggedIn();
    await post("/states", { title: "X", id: "x", goal: "Ship it" });
    await post("/s/x/journal", { kind: "note", body: "a\r\nb" });
    await post("/s/x/status", { status: "waiting", statusNote: "q1\r\nq2" });
    const bodies = (await db.select().from(journalEntries).where(eq(journalEntries.stateId, "x"))).map((e) => e.body);
    expect(bodies).toContain("a\nb");
    expect(bodies.some((b) => b.includes("\r"))).toBe(false);
    const row = (await db.select().from(states).where(eq(states.id, "x")))[0];
    expect(row?.statusNote).toBe("q1\nq2");
  });

  it("pages the journal newest first", async () => {
    const { get, post } = await loggedIn();
    await post("/states", { title: "X", id: "x", goal: "Ship it" });
    for (let i = 1; i <= 23; i++) await post("/s/x/journal", { kind: "note", body: `entry-${i}-end` });
    const entries = (html: string) => [...html.matchAll(/entry-(\d+)-end/g)].map((m) => Number(m[1]));
    const range = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

    const first = await (await get("/s/x?section=goal")).text();
    expect(entries(first)).toEqual(range(23, 14));
    expect(first).toContain("Page 1 of 3 · 23 entries");
    expect(first).toContain('href="/s/x?section=goal&amp;jpage=2#journal"');
    expect(first).not.toContain("← Newer");

    const second = await (await get("/s/x?jpage=2")).text();
    expect(entries(second)).toEqual(range(13, 4));
    expect(second).toContain('href="/s/x?section=goal&amp;jpage=2"');

    const last = await (await get("/s/x?jpage=3")).text();
    expect(entries(last)).toEqual(range(3, 1));
    expect(last).toContain('href="/s/x?jpage=2#journal"');
    expect(last).not.toContain("Older →");

    expect(await (await get("/s/x?jpage=99")).text()).toContain("Page 3 of 3");
    expect(await (await get("/s/x?jpage=abc")).text()).toContain("Page 1 of 3");

    const added = await post("/s/x/journal", { kind: "note", body: "entry-24-end" });
    expect(added.headers.get("Location")).toBe("/s/x#j24");
    expect(await (await get("/s/x")).text()).toContain('id="j24"');
  });

  it("puts the menu in a side nav that can stay collapsed", async () => {
    const { app, get } = await loggedIn();
    const home = await (await get("/")).text();
    expect(home).toContain('<nav id="sidenav" class="side" aria-label="Main"><a href="/" aria-current="page">States</a>');
    expect(home).toContain('<a href="/settings">Settings</a>');
    expect(home).toContain('action="/logout"');
    expect(home).toContain('aria-controls="sidenav"');
    expect(home).not.toContain("nav-collapsed");
    expect(await (await get("/", "dura_nav=open")).text()).not.toContain("nav-collapsed");

    const settings = await (await get("/settings")).text();
    expect(settings).toContain('<a href="/">States</a>');
    expect(settings).toContain('<a href="/settings" aria-current="page">Settings</a>');

    const collapsed = await (await get("/", "dura_nav=collapsed")).text();
    expect(collapsed).toContain('<body class="nav-collapsed">');

    const login = await (await app.request("/login", { headers: { Cookie: "dura_nav=collapsed" } })).text();
    expect(login).not.toContain("sidenav");
    expect(login).not.toContain("nav-collapsed");

    const js = await (await app.request("/static/app.js")).text();
    expect(js).toContain('document.querySelector("[data-nav-toggle]")');
  });

  it("versions the CSS and JS URLs so a cached copy is not paired with newer HTML", async () => {
    const { app, get } = await loggedIn();
    const home = await (await get("/")).text();
    const css = /href="(\/static\/app\.css\?v=\w+)"/.exec(home)?.[1];
    const js = /src="(\/static\/app\.js\?v=\w+)"/.exec(home)?.[1];
    expect(css).toBeDefined();
    expect(js).toBeDefined();
    expect(css).toBe(`/static/app.css?v=${ASSET_VERSION}`);
    expect(js).toBe(`/static/app.js?v=${ASSET_VERSION}`);
    const cssBody = await (await app.request(css!)).text();
    const jsBody = await (await app.request(js!)).text();
    expect(cssBody).toContain(".nav-toggle");
    expect(jsBody).toContain("[data-nav-toggle]");
    expect(ASSET_VERSION).toBe(contentVersion(cssBody, jsBody));
    // A change to either file gives a new version.
    expect(contentVersion(cssBody + " ", jsBody)).not.toBe(ASSET_VERSION);
    expect(contentVersion(cssBody, jsBody + " ")).not.toBe(ASSET_VERSION);
    expect(contentVersion("ab", "c")).not.toBe(contentVersion("a", "bc"));
    expect(contentVersion("😀")).not.toBe(contentVersion("😁"));
  });

  it("sends a Content-Security-Policy that the pages keep to", async () => {
    const { app, get, post, call } = await loggedIn();
    const fresh = await setup();
    const setupPage = await fresh.app.request("/setup");
    const csp = setupPage.headers.get("Content-Security-Policy") ?? "";
    for (const directive of [
      "default-src 'self'",
      `script-src 'self' 'sha256-${INLINE_SCRIPT_SHA256}'`,
      "style-src 'self'",
      "img-src *",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp.split("; ")).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(setupPage.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(setupPage.headers.get("X-Frame-Options")).toBe("DENY");
    expect(setupPage.headers.get("Strict-Transport-Security")).toBe("max-age=15552000");
    expect(setupPage.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    // no-referrer would make browsers send "Origin: null" on form posts, which the CSRF checks reject.
    expect(setupPage.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(createHash("sha256").update(INLINE_SCRIPT).digest("base64")).toBe(INLINE_SCRIPT_SHA256);

    const setupHtml = await setupPage.text();
    // Without an inline onsubmit to stop it, Enter in a field would submit a form, so the setup fields are not in one.
    expect(setupHtml).toContain('id="setup-token"');
    expect(setupHtml).not.toContain("<form");

    await fresh.db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
    const pages = [setupHtml, await (await fresh.app.request("/login")).text()];
    expect(pages.at(-1)).toContain('data-action="login"');

    // Text that only looks like an attribute must not trip the checks below.
    await post("/states", { title: "X", id: "x", goal: '<div style="color:red" onclick="x">' });
    await post("/s/x/journal", { kind: "note", body: "hello" });
    await post("/settings/webhooks", { name: "phone", kind: "json", url: "https://hooks.example/x" });
    for (const path of ["/", "/s/x", "/s/x/new-section", "/s/x/sections/goal/edit", "/s/x/sections/goal/history", "/settings"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      pages.push(await res.text());
    }
    expect(pages.at(-1)).toContain("hooks.example");
    await post("/s/x/sections/plan", { content: "a", version: "0" });
    const conflict = await post("/s/x/sections/plan", { content: "b", version: "0" });
    expect(conflict.status).toBe(409);
    pages.push(await conflict.text());
    for (const html of pages) {
      // Inline style attributes and event handlers in tags would be blocked by the policy.
      expect(html).not.toMatch(/<[a-z][^>]*\s(style|on[a-z]+)=/i);
      const inline = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(inline).toEqual([INLINE_SCRIPT]);
    }
    expect(pages.join("")).toContain("&#60;div style=");

    const preview = await app.request("/preview", {
      method: "POST",
      headers: { Cookie: "dura_session=test-session", Origin: ORIGIN, "Content-Type": "text/plain" },
      body: "|a|b|\n|:-:|-:|\n|1|2|\n\n![i](https://example.com/i.png)",
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).not.toMatch(/<[a-z][^>]*\s(style|on[a-z]+)=/i);

    // API responses, errors, static files and 404s carry the headers too.
    expect((await call(null, "GET", "/api/states")).headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await app.request("/static/app.css")).headers.get("Content-Security-Policy")).toBe(csp);
    const missing = await get("/no-such-page");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Security-Policy")).toBe(csp);
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

  it("shows form errors as a page, not JSON", async () => {
    const { app, cookie, post } = await loggedIn();
    const browserPost = (path: string, fields: Record<string, string>, referer?: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: ORIGIN,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Content-Type": "application/x-www-form-urlencoded",
          ...(referer ? { Referer: referer } : {}),
        },
        body: new URLSearchParams(fields).toString(),
      });
    await post("/states", { title: "First" });

    // 409 already_exists: an HTML page with the message and a link back to the form's page.
    const dup = await browserPost("/states", { title: "Again", id: "first" }, `${ORIGIN}/?x=1`);
    expect(dup.status).toBe(409);
    expect(dup.headers.get("Content-Type")).toContain("text/html");
    const html = await dup.text();
    expect(html).toContain("State &quot;first&quot; already exists.");
    expect(html).toContain("already_exists");
    expect(html).toContain('href="/?x=1" data-action="back"');
    expect(html).toContain('id="sidenav"');

    // 400 from a form, with the message HTML-escaped and a back link only to this origin.
    const bad = await browserPost("/s/first/status", { status: "<b>nope</b>" }, "https://evil.example/");
    expect(bad.status).toBe(400);
    const badHtml = await bad.text();
    expect(badHtml).not.toContain("<b>nope</b>");
    expect(badHtml).toContain('href="/" data-action="back"');

    // 404 pages too.
    const missing = await app.request("/s/nope", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("<h1>Not found</h1>");

    // fetch() from app.js does not ask for HTML and keeps the JSON; so does the API.
    const json = await post("/states", { title: "Again", id: "first" });
    expect(json.status).toBe(409);
    expect((await json.json()).error.code).toBe("already_exists");
    const api = await app.request("/api/states/nope", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(api.status).toBe(404);
    expect((await api.json()).error.code).toBe("not_found");
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
