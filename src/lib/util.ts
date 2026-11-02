export const nowIso = () => new Date().toISOString();

export function base64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return base64urlEncode(digest);
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// The HTML `pattern` attribute is compiled with the `v` flag, where an unescaped `-`
// at the end of a class is a syntax error and the browser silently skips validation.
// Keep `-` escaped so the same source works in forms and here.
export const ID_PATTERN_SOURCE = "[a-z0-9][a-z0-9_\\-]{0,63}";
export const SECTION_NAME_PATTERN_SOURCE = "[a-z0-9][a-z0-9_.\\-]{0,63}";
export const ID_PATTERN = new RegExp(`^${ID_PATTERN_SOURCE}$`);
export const SECTION_NAME_PATTERN = new RegExp(`^${SECTION_NAME_PATTERN_SOURCE}$`);
