import { createApp } from "../src/app";
import { createToken } from "../src/auth";
import { sessions } from "../src/db/schema";
import type { Deps } from "../src/env";
import { nowIso, sha256 } from "../src/lib/util";
import { openDatabase } from "../src/node";

export const ORIGIN = "http://localhost";

// Test responses are inspected loosely; workers-types makes json() return unknown.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TestResponse = Omit<Response, "json"> & { json(): Promise<any> };

export async function setup(overrides: Partial<Deps> = {}) {
  const db = openDatabase(":memory:");
  const pending: Promise<unknown>[] = [];
  const deps: Deps = { db, config: { setupToken: "setup-secret" }, waitUntil: (p) => pending.push(p), ...overrides };
  const hono = createApp(deps);
  const app = { request: (path: string, init?: RequestInit) => hono.request(path, init) as unknown as Promise<TestResponse> };

  const tokenFor = async (name: string, scope: "read" | "write" = "write", stateIds: string[] | null = null) =>
    (await createToken(db, { name, scope, stateIds })).secret;

  const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    let payload: string | undefined;
    if (typeof body === "string") payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["Content-Type"] ??= "application/json";
    }
    return app.request(path, { method, headers: h, body: payload }) as unknown as Promise<TestResponse>;
  };

  const ownerCookie = async () => {
    const sid = "test-session";
    await db.insert(sessions).values({
      idHash: await sha256(sid),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    return `dura_session=${sid}`;
  };

  return { db, app, deps, call, tokenFor, ownerCookie, flush: () => Promise.all(pending) };
}
