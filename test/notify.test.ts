import { describe, expect, it } from "vitest";
import { pushSubscriptions, webhooks } from "../src/db/schema";
import { base64urlEncode } from "../src/lib/util";
import { setup } from "./helpers";

async function uaKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { p256dh: base64urlEncode(raw), auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))) };
}

describe("notifications", () => {
  it("fans out to push and webhooks when a state starts waiting", async () => {
    const requests: Request[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push(req);
      return new Response(null, { status: req.url.includes("gone") ? 410 : 201 });
    }) as typeof fetch;
    const { db, call, tokenFor, flush } = await setup({ fetch: fakeFetch });

    await db.insert(pushSubscriptions).values([
      { endpoint: "https://push.example.com/live", ...(await uaKeys()) },
      { endpoint: "https://push.example.com/gone", ...(await uaKeys()) },
    ]);
    await db.insert(webhooks).values([
      { id: "1", name: "phone", kind: "ntfy", url: "https://ntfy.sh/topic" },
      { id: "2", name: "team", kind: "slack", url: "https://hooks.slack.com/x" },
    ]);

    const t = await tokenFor("orchestrator");
    await call(t, "POST", "/api/states", { id: "s", title: "検索の改善" });
    await call(t, "PATCH", "/api/states/s", { title: "検索の改善" }); // no status change: no notification
    await flush();
    expect(requests).toHaveLength(0);

    await call(t, "PATCH", "/api/states/s", { status: "waiting", statusNote: "Pick A or B" });
    await flush();
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://hooks.slack.com/x",
      "https://ntfy.sh/topic",
      "https://push.example.com/gone",
      "https://push.example.com/live",
    ]);

    const push = requests.find((r) => r.url.endsWith("/live"))!;
    expect(push.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(push.headers.get("Authorization")).toMatch(/^vapid t=.+, k=.+$/);

    const ntfy = requests.find((r) => r.url.includes("ntfy"))!;
    expect(ntfy.headers.get("Title")).toMatch(/^=\?UTF-8\?B\?/);
    expect(ntfy.headers.get("Click")).toBe("http://localhost/s/s");
    expect(await ntfy.text()).toBe("Pick A or B");

    const slack = (await requests.find((r) => r.url.includes("slack"))!.json()) as { text: string };
    expect(slack.text).toContain("Waiting for you: 検索の改善");

    // The subscription that answered 410 was removed.
    const subs = await db.select().from(pushSubscriptions);
    expect(subs.map((s) => s.endpoint)).toEqual(["https://push.example.com/live"]);

    requests.length = 0;
    await call(t, "PATCH", "/api/states/s", { status: "active" });
    await flush();
    expect(requests).toHaveLength(0);
  });
});
