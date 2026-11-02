import { describe, expect, it, vi } from "vitest";
import { passkeys } from "../src/db/schema";
import { setup } from "./helpers";

// The error page itself fails to render: the original error still reaches the browser, as text.
vi.mock("../src/ui/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/layout")>()),
  errorPage: () => {
    throw new Error("render failed");
  },
}));

describe("error page fallback", () => {
  it("returns the error as text when the page cannot be rendered", async () => {
    const ctx = await setup();
    await ctx.db.insert(passkeys).values({ id: "cred", name: "laptop", publicKey: "x" });
    const cookie = await ctx.ownerCookie();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await ctx.app.request("/s/nope", { headers: { Cookie: cookie, Accept: "text/html" } });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Error (not_found): State "nope" was not found.\n');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
