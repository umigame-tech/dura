import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { publicOrigin, resolveActor } from "./auth";
import type { AppEnv, Deps } from "./env";
import { ApiError } from "./lib/errors";
import { handleMcp } from "./mcp";
import { api } from "./routes/api";
import { assets } from "./routes/assets";
import { authRoutes } from "./routes/webauthn";
import { errorPage, INLINE_SCRIPT_SHA256 } from "./ui/layout";
import { NAV_COOKIE, ui } from "./ui/routes";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Scripts and styles come only from /static (plus the one inline script, by hash).
  // Markdown written by agents may show images from anywhere, so img-src stays open, as before this policy. The risk:
  // an agent can put data in an image URL that the browser then requests. Close it with img-src 'self' (or a list of
  // hosts, or an image proxy) if that matters more than external images.
  // Referrer-Policy must not be no-referrer: browsers then send "Origin: null" on form posts, and the CSRF checks
  // reject them. hono's defaults also send Cross-Origin-Resource-Policy: same-origin, so other sites cannot embed
  // these responses; nothing here is meant to be embedded.
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", `'sha256-${INLINE_SCRIPT_SHA256}'`],
        styleSrc: ["'self'"],
        imgSrc: ["*"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: "same-origin",
      strictTransportSecurity: "max-age=15552000",
      xFrameOptions: "DENY",
      // Passkeys (publickey-credentials-*) stay allowed.
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );

  app.use(async (c, next) => {
    c.set("deps", deps);
    c.set("actor", null);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      const isApi = isApiPath(c.req.path);
      if (!isApi && err.status === 401) return c.redirect("/login");
      if (!isApi && wantsHtml(c)) return htmlError(c, err.status, err.code, err.message);
      if (/text\/(markdown|plain)/.test(c.req.header("Accept") ?? "")) {
        return c.text(`Error (${err.code}): ${err.message}\n`, err.status);
      }
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      // e.g. the CSRF check's 403 for a form post from another origin.
      if (!isApiPath(c.req.path) && wantsHtml(c)) {
        return htmlError(c, err.status as ContentfulStatusCode, "rejected", err.message || "The request was rejected.");
      }
      return err.getResponse();
    }
    console.error(err);
    if (!isApiPath(c.req.path) && wantsHtml(c)) return htmlError(c, 500, "internal", "Internal server error.");
    return c.json({ error: { code: "internal", message: "Internal server error." } }, 500);
  });

  app.notFound((c) => {
    if (!isApiPath(c.req.path) && wantsHtml(c)) return htmlError(c, 404, "not_found", "There is no page at this address.");
    return c.text("404 Not Found", 404);
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

const isApiPath = (path: string) => path.startsWith("/api/") || path.startsWith("/auth/") || path === "/mcp";

// Pages and form posts from a browser ask for HTML; fetch() from app.js (preview, push) does not, and keeps the JSON.
const wantsHtml = (c: Context<AppEnv>) => /text\/html/.test(c.req.header("Accept") ?? "");

function htmlError(c: Context<AppEnv>, status: ContentfulStatusCode, code: string, message: string) {
  try {
    return c.html(
      errorPage({
        status,
        code,
        message,
        back: backLink(c),
        loggedIn: c.get("actor")?.type === "owner",
        navCollapsed: getCookie(c, NAV_COOKIE) === "collapsed",
      }),
      status,
    );
  } catch (err) {
    // An error page that fails to render must not hide the original error.
    console.error(err);
    return c.text(`Error (${code}): ${message}\n`, status);
  }
}

// The page the form was on, when the browser says so (Referrer-Policy is same-origin), else the state list.
function backLink(c: Context<AppEnv>): string {
  const referer = c.req.header("Referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    return url.origin === publicOrigin(c) ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}
