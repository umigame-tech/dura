import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { StateStatus } from "../db/schema";
import { lineDiff, renderMarkdown } from "../lib/markdown";

export function Layout(props: { title: string; loggedIn?: boolean; path?: string; navCollapsed?: boolean; children: Child }) {
  const current = (href: string) =>
    (href === "/settings" ? props.path?.startsWith("/settings") : !props.path?.startsWith("/settings")) ? "page" : undefined;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title === "dura" ? "dura" : `${props.title} · dura`}</title>
        <link rel="stylesheet" href="/static/app.css" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#1f6f5c" />
        <script src="/static/app.js" defer></script>
      </head>
      <body class={props.loggedIn && props.navCollapsed ? "nav-collapsed" : undefined}>
        <header class="top">
          {props.loggedIn && (
            // A link so that the menu still opens through :target without JS; app.js turns it into a toggle.
            <a class="nav-toggle" href="#sidenav" aria-controls="sidenav" aria-label="Menu" data-nav-toggle>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </a>
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
