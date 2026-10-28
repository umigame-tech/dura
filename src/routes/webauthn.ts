import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { count, eq, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { publicOrigin, startSession } from "../auth";
import { passkeys, webauthnChallenges } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { base64urlDecode, base64urlEncode, nowIso, randomToken, sha256 } from "../lib/util";

export const authRoutes = new Hono<AppEnv>();

const CHALLENGE_COOKIE = "dura_challenge";
const OWNER_USER_ID = new TextEncoder().encode("dura-owner");

const rp = (c: Context<AppEnv>) => {
  const origin = publicOrigin(c);
  return { origin, rpID: new URL(origin).hostname, rpName: c.get("deps").config.rpName || "dura" };
};

export async function passkeyCount(c: Context<AppEnv>): Promise<number> {
  const [row] = await c.get("deps").db.select({ n: count() }).from(passkeys);
  return row?.n ?? 0;
}

async function sameSecret(a: string, b: string) {
  const [x, y] = [await sha256(a), await sha256(b)];
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0 && x.length === y.length;
}

/** Registering is allowed for the logged-in owner, or once with the setup token on a fresh instance. */
async function assertMayRegister(c: Context<AppEnv>, setupToken: unknown): Promise<"setup" | "add"> {
  if (c.get("actor")?.type === "owner") return "add";
  if ((await passkeyCount(c)) > 0) throw new ApiError(401, "unauthorized", "Log in to add another passkey.");
  const expected = c.get("deps").config.setupToken;
  if (!expected) {
    throw new ApiError(403, "setup_disabled", "Set DURA_SETUP_TOKEN on the server to register the first passkey.");
  }
  if (typeof setupToken !== "string" || !(await sameSecret(setupToken, expected))) {
    throw new ApiError(403, "forbidden", "The setup token is incorrect.");
  }
  return "setup";
}

async function saveChallenge(c: Context<AppEnv>, challenge: string) {
  const { db } = c.get("deps");
  const id = randomToken(16);
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, nowIso()));
  await db.insert(webauthnChallenges).values({
    id,
    challenge,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    secure: publicOrigin(c).startsWith("https:"),
    sameSite: "Strict",
    path: "/auth",
    maxAge: 300,
  });
}

async function takeChallenge(c: Context<AppEnv>): Promise<string> {
  const { db } = c.get("deps");
  const id = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/auth" });
  if (!id) throw new ApiError(400, "bad_request", "No passkey challenge in progress. Please try again.");
  const [row] = await db.select().from(webauthnChallenges).where(eq(webauthnChallenges.id, id));
  await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, id));
  if (!row || row.expiresAt < nowIso()) throw new ApiError(400, "bad_request", "The passkey challenge expired. Please try again.");
  return row.challenge;
}

authRoutes.post("/register/options", async (c) => {
  const body = await c.req.json<{ setupToken?: string }>().catch(() => ({}) as { setupToken?: string });
  await assertMayRegister(c, body.setupToken);
  const { rpID, rpName } = rp(c);
  const existing = await c.get("deps").db.select().from(passkeys);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: `${rpName} owner`,
    userID: OWNER_USER_ID,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.id,
      transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  await saveChallenge(c, options.challenge);
  return c.json(options);
});

authRoutes.post("/register/verify", async (c) => {
  const body = await c.req.json<{ response: RegistrationResponseJSON; name?: string; setupToken?: string }>();
  const mode = await assertMayRegister(c, body.setupToken);
  const { origin, rpID } = rp(c);
  const expectedChallenge = await takeChallenge(c);
  const result = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  }).catch((err: Error) => {
    throw new ApiError(400, "verification_failed", `Passkey registration failed: ${err.message}`);
  });
  if (!result.verified || !result.registrationInfo) {
    throw new ApiError(400, "verification_failed", "Passkey registration could not be verified.");
  }
  const { credential } = result.registrationInfo;
  await c.get("deps").db.insert(passkeys).values({
    id: credential.id,
    name: body.name?.trim() || "Passkey",
    publicKey: base64urlEncode(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? null,
    createdAt: nowIso(),
  });
  if (mode === "setup") await startSession(c);
  return c.json({ ok: true });
});

authRoutes.post("/login/options", async (c) => {
  const options = await generateAuthenticationOptions({ rpID: rp(c).rpID, userVerification: "preferred" });
  await saveChallenge(c, options.challenge);
  return c.json(options);
});

authRoutes.post("/login/verify", async (c) => {
  const { db } = c.get("deps");
  const body = await c.req.json<{ response: AuthenticationResponseJSON }>();
  const expectedChallenge = await takeChallenge(c);
  const [passkey] = await db.select().from(passkeys).where(eq(passkeys.id, body.response.id));
  if (!passkey) throw new ApiError(401, "unauthorized", "This passkey is not registered here.");
  const { origin, rpID } = rp(c);
  const result = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: {
      id: passkey.id,
      publicKey: base64urlDecode(passkey.publicKey),
      counter: passkey.counter,
      transports: (passkey.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    },
  }).catch((err: Error) => {
    throw new ApiError(401, "unauthorized", `Passkey login failed: ${err.message}`);
  });
  if (!result.verified) throw new ApiError(401, "unauthorized", "Passkey login could not be verified.");
  await db
    .update(passkeys)
    .set({ counter: result.authenticationInfo.newCounter, lastUsedAt: nowIso() })
    .where(eq(passkeys.id, passkey.id));
  await startSession(c);
  return c.json({ ok: true });
});
