import { and, eq, isNull, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DB } from "./db";
import { sessions, tokens } from "./db/schema";
import type { AppEnv } from "./env";
import { ApiError } from "./lib/errors";
import { nowIso, randomToken, sha256 } from "./lib/util";

export const HUMAN_ACTOR = "human";
const SESSION_COOKIE = "dura_session";
const SESSION_DAYS = 30;

export type Actor =
  | { type: "owner"; name: string }
  | { type: "token"; id: string; name: string; scope: "read" | "write"; stateIds: string[] | null };

export type Token = typeof tokens.$inferSelect;

// ---------------------------------------------------------------------------
// Agent tokens

export async function createToken(
  db: DB,
  input: { name: string; scope: "read" | "write"; stateIds: string[] | null },
): Promise<{ token: Token; secret: string }> {
  const name = input.name.trim();
  if (!name) throw new ApiError(400, "bad_request", "Token name is required.");
  if (input.scope !== "read" && input.scope !== "write") {
    throw new ApiError(400, "bad_request", "scope must be read or write.");
  }
  const secret = `dura_${randomToken(24)}`;
  const id = randomToken(9);
  await db.insert(tokens).values({
    id,
    name,
    scope: input.scope,
    stateIds: input.stateIds && input.stateIds.length > 0 ? input.stateIds : null,
    tokenHash: await sha256(secret),
    createdAt: nowIso(),
  });
  const [token] = await db.select().from(tokens).where(eq(tokens.id, id));
  return { token: token!, secret };
}

export async function listTokens(db: DB): Promise<Token[]> {
  return db.select().from(tokens).where(isNull(tokens.revokedAt)).orderBy(tokens.createdAt);
}

export async function revokeToken(db: DB, id: string) {
  await db.update(tokens).set({ revokedAt: nowIso() }).where(eq(tokens.id, id));
}

async function actorFromBearer(db: DB, secret: string): Promise<Actor | null> {
  const [row] = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.tokenHash, await sha256(secret)), isNull(tokens.revokedAt)));
  if (!row) return null;
  // Record usage at most once a minute to keep writes cheap.
  if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > 60_000) {
    await db.update(tokens).set({ lastUsedAt: nowIso() }).where(eq(tokens.id, row.id));
  }
  return { type: "token", id: row.id, name: row.name, scope: row.scope, stateIds: row.stateIds ?? null };
}

// ---------------------------------------------------------------------------
// Browser sessions (after passkey login)

export async function startSession(c: Context<AppEnv>) {
  const { db } = c.get("deps");
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(sessions).values({ idHash: await sha256(id), createdAt: nowIso(), expiresAt: expires.toISOString() });
  await db.delete(sessions).where(lt(sessions.expiresAt, nowIso()));
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    expires,
  });
}

export async function endSession(c: Context<AppEnv>) {
  const id = getCookie(c, SESSION_COOKIE);
  if (id) await c.get("deps").db.delete(sessions).where(eq(sessions.idHash, await sha256(id)));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(c) });
}

async function actorFromSession(db: DB, id: string): Promise<Actor | null> {
  const [row] = await db.select().from(sessions).where(eq(sessions.idHash, await sha256(id)));
  if (!row || row.expiresAt < nowIso()) return null;
  return { type: "owner", name: HUMAN_ACTOR };
}

function isSecure(c: Context<AppEnv>) {
  return new URL(publicOrigin(c)).protocol === "https:";
}

/** The origin the browser sees. Configure DURA_ORIGIN when running behind a reverse proxy. */
export function publicOrigin(c: Context<AppEnv>): string {
  const configured = c.get("deps").config.origin;
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(c.req.url).origin;
}

// ---------------------------------------------------------------------------
// Middleware & permission checks

export async function resolveActor(c: Context<AppEnv>): Promise<Actor | null> {
  const { db } = c.get("deps");
  const header = c.req.header("Authorization");
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) throw new ApiError(401, "unauthorized", "Malformed Authorization header. Use: Authorization: Bearer <token>.");
    const actor = await actorFromBearer(db, m[1]!);
    if (!actor) throw new ApiError(401, "unauthorized", "The token is invalid or has been revoked.");
    return actor;
  }
  const sid = getCookie(c, SESSION_COOKIE);
  return sid ? actorFromSession(db, sid) : null;
}

export function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.get("actor");
  if (!actor) {
    throw new ApiError(
      401,
      "unauthorized",
      "Authentication required. Send Authorization: Bearer <token> (set DURA_TOKEN). Tokens are issued in the web UI under Settings.",
    );
  }
  return actor;
}

export function canRead(actor: Actor, stateId: string): boolean {
  return actor.type === "owner" || actor.stateIds === null || actor.stateIds.includes(stateId);
}

export function assertRead(actor: Actor, stateId: string) {
  if (!canRead(actor, stateId)) {
    throw new ApiError(403, "forbidden", `Token "${actor.name}" is not allowed to access state "${stateId}".`);
  }
}

export function assertWrite(actor: Actor, stateId: string | null) {
  if (actor.type === "owner") return;
  if (actor.scope !== "write") {
    throw new ApiError(403, "forbidden", `Token "${actor.name}" is read-only.`);
  }
  if (stateId === null) {
    if (actor.stateIds !== null) {
      throw new ApiError(403, "forbidden", `Token "${actor.name}" is limited to specific states and cannot create new ones.`);
    }
    return;
  }
  assertRead(actor, stateId);
}
