// Web Push with WebCrypto only, so it runs on Node and Cloudflare Workers alike.
// Payload encryption: RFC 8291 (aes128gcm, RFC 8188). Sender identification: VAPID (RFC 8292).
import { base64urlDecode, base64urlEncode } from "./util";

type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

function publicJwk(raw: Bytes): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Expected an uncompressed P-256 public key (65 bytes).");
  return {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(raw.slice(1, 33)),
    y: base64urlEncode(raw.slice(33, 65)),
  };
}

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export type EncryptOptions = {
  /** For tests only: fixed application-server key pair and salt. */
  asPrivateKey?: string;
  asPublicKey?: string;
  salt?: string;
};

/** Encrypts a payload for one subscription. Returns the full aes128gcm body. */
export async function encryptPayload(target: PushTarget, payload: Uint8Array, opts: EncryptOptions = {}): Promise<Bytes> {
  const uaPublic = base64urlDecode(target.p256dh);
  const authSecret = base64urlDecode(target.auth);
  const uaKey = await crypto.subtle.importKey("jwk", publicJwk(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);

  let asPrivate: CryptoKey;
  let asPublic: Bytes;
  if (opts.asPrivateKey && opts.asPublicKey) {
    asPublic = base64urlDecode(opts.asPublicKey);
    asPrivate = await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk(asPublic), d: opts.asPrivateKey },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = pair.privateKey;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }

  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1]));
  const ikm = await hmac(prkKey, keyInfo);

  const salt = opts.salt ? base64urlDecode(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Single record: payload followed by the 0x02 "last record" delimiter.
  const plaintext = concat(payload, new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

// ---------------------------------------------------------------------------
// VAPID

export type VapidKeys = { publicKey: string; privateKey: string }; // base64url raw public point, base64url d

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { publicKey: base64urlEncode(raw), privateKey: jwk.d! };
}

export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = base64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64urlEncode(
    enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    { ...publicJwk(base64urlDecode(keys.publicKey)), d: keys.privateKey },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `vapid t=${signingInput}.${base64urlEncode(sig)}, k=${keys.publicKey}`;
}

/** Sends one push message. Returns the push service's HTTP status (404/410 mean the subscription is gone). */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  keys: VapidKeys,
  subject: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(payload)));
  const res = await fetchImpl(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(target.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}
