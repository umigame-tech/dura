import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { publicOrigin, resolveActor } from "./auth";
import type { AppEnv, Deps } from "./env";
import { ApiError } from "./lib/errors";
import { handleMcp } from "./mcp";
import { api } from "./routes/api";
import { assets } from "./routes/assets";
import { authRoutes } from "./routes/webauthn";
import { ui } from "./ui/routes";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    c.set("deps", deps);
    c.set("actor", null);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      const isApi = c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/");
      if (!isApi && err.status === 401) return c.redirect("/login");
      if (/text\/(markdown|plain)/.test(c.req.header("Accept") ?? "")) {
        return c.text(`Error (${err.code}): ${err.message}\n`, err.status);
      }
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
    }
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal server error." } }, 500);
  });

  // API: bearer tokens (agents) or the browser session (web UI).
  app.use("/api/*", async (c, next) => {
    const actor = await resolveActor(c);
    // Cookie-authenticated writes must come from our own pages.
    if (actor?.type === "owner" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !c.req.header("Authorization")) {
      if (c.req.header("Origin") !== publicOrigin(c)) {
        throw new ApiError(403, "forbidden", "Cross-origin request rejected.");
      }
    }
    c.set("actor", actor);
    await next();
  });
  app.route("/api", api);

  // MCP (Streamable HTTP): a thin adapter that calls the API above with the same bearer token.
  app.post("/mcp", (c) => handleMcp(c, (req) => app.fetch(req)));
  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json({ error: { code: "method_not_allowed", message: "This MCP server is stateless: use POST." } }, 405);
  });

  // Everything else is the web UI, authenticated by the session cookie only.
  app.use("*", csrf({ origin: (origin, c) => origin === publicOrigin(c) }));
  app.use("*", async (c, next) => {
    if (!c.req.header("Authorization")) c.set("actor", await resolveActor(c));
    await next();
  });
  app.route("/", assets);
  app.route("/auth", authRoutes);
  app.route("/", ui);

  return app;
}
