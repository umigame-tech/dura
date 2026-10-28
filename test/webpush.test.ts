import { describe, expect, it } from "vitest";
import { encryptPayload, generateVapidKeys, vapidAuthorization } from "../src/lib/webpush";
import { base64urlDecode, base64urlEncode } from "../src/lib/util";

describe("web push", () => {
  it("matches the RFC 8291 Appendix A test vector", async () => {
    const body = await encryptPayload(
      {
        endpoint: "https://push.example.net/x",
        p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      {
        asPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
        asPublicKey: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        salt: "DGv6ra1nlYgDCS1FRnbzlw",
      },
    );
    expect(base64urlEncode(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("produces a verifiable VAPID JWT", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:a@example.com");
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(m[2]!)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    const pub = await crypto.subtle.importKey("raw", base64urlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      base64urlDecode(m[3]!),
      new TextEncoder().encode(`${m[1]}.${m[2]}`),
    );
    expect(ok).toBe(true);
  });
});
