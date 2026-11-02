import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { StateStatus } from "../db/schema";
import { lineDiff, renderMarkdown } from "../lib/markdown";
import { ASSET_VERSION } from "../routes/assets";

// The only inline script. The Content-Security-Policy (src/app.ts) allows it by this hash; the tests check that it matches.
export const INLINE_SCRIPT = 'document.documentElement.classList.add("js")';
export const INLINE_SCRIPT_SHA256 = "qOhFsq0QMV2REqNwk5hGH5bZE9SkX6gt6yeyKdYPv+U=";

export function Layout(props: { title: string; loggedIn?: boolean; path?: string; navCollapsed?: boolean; children: Child }) {
  const inSettings = props.path === "/settings" || Boolean(props.path?.startsWith("/settings/"));
  const current = (href: string) => ((href === "/settings") === inSettings ? "page" : undefined);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title === "dura" ? "dura" : `${props.title} · dura`}</title>
        <link rel="stylesheet" href={`/static/app.css?v=${ASSET_VERSION}`} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#1f6f5c" />
        {/* Marks JS as available before the first paint, so the menu starts closed on a narrow screen without a flash. */}
        <script dangerouslySetInnerHTML={{ __html: INLINE_SCRIPT }} />
        <script src={`/static/app.js?v=${ASSET_VERSION}`} defer></script>
      </head>
      <body class={props.loggedIn && props.navCollapsed ? "nav-collapsed" : undefined}>
        <header class="top">
          {props.loggedIn && (
            // Shown only with JS (html.js); without it the menu is always shown.
            <button type="button" class="nav-toggle" aria-controls="sidenav" aria-label="Menu" data-nav-toggle>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          )}
          <a class="brand" href="/">
            <img src="/icon.svg" alt="" />
            dura
          </a>
        </header>
        {props.loggedIn ? (
          <div class="shell">
            <nav id="sidenav" class="side" aria-label="Main">
              <a href="/" aria-current={current("/")}>
                States
              </a>
              <a href="/settings" aria-current={current("/settings")}>
                Settings
              </a>
              <form method="post" action="/logout">
                <button class="link" type="submit">
                  Log out
                </button>
              </form>
            </nav>
            <div class="nav-backdrop" data-nav-close></div>
            <main>{props.children}</main>
          </div>
        ) : (
          <main>{props.children}</main>
        )}
      </body>
    </html>
  );
}

export const StatusBadge = (props: { status: StateStatus }) => <span class={`badge ${props.status}`}>{props.status}</span>;

export const Markdown = (props: { source: string }) => <div class="markdown">{raw(renderMarkdown(props.source))}</div>;

export const Flash = (props: { kind?: "ok" | "error"; children: Child }) => (
  <div class={`flash ${props.kind ?? ""}`}>{props.children}</div>
);

export function Diff(props: { before: string; after: string }) {
  const lines = lineDiff(props.before, props.after);
  if (!lines.some((l) => l.kind === "add" || l.kind === "del")) return <p class="muted">No changes.</p>;
  return (
    <div class="diff">
      {lines.map((l) =>
        l.kind === "gap" ? (
          <div class="gap">… {l.count} unchanged lines …</div>
        ) : (
          <div class={l.kind}>{l.text}</div>
        ),
      )}
    </div>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return iso.slice(0, 10);
}

export const Time = (props: { iso: string }) => <time datetime={props.iso} title={props.iso}>{timeAgo(props.iso)}</time>;

/**
 * The page a browser sees when a web UI request fails (src/app.ts), instead of the API's JSON.
 * `back` is where the "Go back" link points; app.js goes back in history instead, so the form keeps what was typed.
 */
export function errorPage(props: { status: number; code: string; message: string; back: string; loggedIn: boolean; navCollapsed: boolean }) {
  const title = props.status === 404 ? "Not found" : props.status >= 500 ? "Something went wrong" : "Could not complete the request";
  return (
    <Layout title={title} loggedIn={props.loggedIn} navCollapsed={props.navCollapsed}>
      <h1>{title}</h1>
      <Flash kind="error">
        <p>{props.message}</p>
        <p class="muted">
          HTTP {props.status} · {props.code}
        </p>
      </Flash>
      <p>
        <a href={props.back} data-action="back">
          ← Go back
        </a>
      </p>
    </Layout>
  );
}
