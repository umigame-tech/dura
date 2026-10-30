import { Hono } from "hono";
import type { AppEnv } from "../env";
import { APPLE_TOUCH_ICON, BADGE_96, ICON_192, ICON_512, ICON_MASKABLE_512 } from "./icons";

export const assets = new Hono<AppEnv>();

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f6f5c"/><path d="M18 16h14c11 0 18 6.5 18 16s-7 16-18 16H18z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><circle cx="32" cy="32" r="5" fill="#f4c95d"/></svg>`;

const CSS = `
:root {
  --bg: #f7f7f5; --surface: #fff; --text: #1d1f1e; --muted: #67706c; --border: #dfe2df;
  --accent: #1f6f5c; --accent-text: #fff; --code: #f0f1ee;
  --active: #2f6fdb; --waiting: #c27c0e; --completed: #2e8540; --abandoned: #7d8582;
  --add: #e3f4e5; --del: #fbe6e4;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141716; --surface: #1c201f; --text: #e6e9e7; --muted: #9aa39f; --border: #313735;
    --accent: #4fb39a; --accent-text: #0d1211; --code: #262b29;
    --active: #6d9df0; --waiting: #e3a33a; --completed: #5cb86c; --abandoned: #8d9693;
    --add: #1f3a26; --del: #43231f;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif; }
a { color: var(--accent); }
header.top { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface); }
header.top .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; color: var(--text); text-decoration: none; }
header.top .brand img { width: 24px; height: 24px; }
header.top nav { margin-left: auto; display: flex; gap: 14px; align-items: center; }
header.top nav form { margin: 0; }
main { max-width: 920px; margin: 0 auto; padding: 20px 16px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; line-height: 1.3; }
h2 { font-size: 1.15rem; margin: 28px 0 10px; }
.muted { color: var(--muted); font-size: 0.9em; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
.badge { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; color: #fff; vertical-align: middle; }
.badge.active { background: var(--active); } .badge.waiting { background: var(--waiting); }
.badge.completed { background: var(--completed); } .badge.abandoned { background: var(--abandoned); }
.state-list { list-style: none; padding: 0; margin: 0; }
.state-list li a { display: block; padding: 12px 16px; text-decoration: none; color: inherit; }
.state-list li { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin: 8px 0; }
.state-list li.waiting { border-left: 4px solid var(--waiting); }
.state-list .title { font-weight: 600; }
.state-list .note { color: var(--muted); font-size: 0.9em; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status-box { border-left: 4px solid var(--border); }
.status-box.waiting { border-left-color: var(--waiting); } .status-box.completed { border-left-color: var(--completed); }
.status-box.active { border-left-color: var(--active); } .status-box.abandoned { border-left-color: var(--abandoned); }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--border); margin-top: 24px; }
.tabs a { padding: 6px 14px; border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; text-decoration: none; color: var(--muted); }
.tabs a.current { background: var(--surface); border-color: var(--border); color: var(--text); font-weight: 600; margin-bottom: -1px; }
.section-body { background: var(--surface); border: 1px solid var(--border); border-top: none; border-radius: 0 0 10px 10px; padding: 6px 18px 14px; }
.section-meta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.markdown pre { background: var(--code); padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
.markdown code { background: var(--code); padding: 1px 4px; border-radius: 4px; font-size: 0.92em; }
.markdown pre code { background: none; padding: 0; }
.markdown table { border-collapse: collapse; } .markdown td, .markdown th { border: 1px solid var(--border); padding: 4px 8px; }
.markdown img { max-width: 100%; }
.markdown li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.2em; }
.markdown blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
.journal { list-style: none; padding: 0; margin: 0; }
.journal li { border-left: 2px solid var(--border); padding: 0 0 8px 16px; position: relative; }
.journal li::before { content: ""; position: absolute; left: -6px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--border); }
.journal li.report::before { background: var(--active); } .journal li.decision::before { background: var(--accent); }
.journal li.status::before { background: var(--waiting); }
.journal .entry-head { font-size: 0.85rem; color: var(--muted); }
.journal .kind { font-weight: 600; color: var(--text); }
form.stack { display: grid; gap: 10px; }
label { font-weight: 600; font-size: 0.9rem; }
input[type=text], input[type=url], input[type=password], select, textarea {
  width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit;
}
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; min-height: 50vh; resize: vertical; }
textarea.short { min-height: 6em; }
button, .button { display: inline-block; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.link { background: none; border: none; color: var(--accent); padding: 0; font-weight: normal; text-decoration: underline; }
button.danger { background: transparent; border-color: #c4473a; color: #c4473a; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } }
.flash { padding: 10px 14px; border-radius: 8px; margin: 12px 0; border: 1px solid var(--border); background: var(--surface); }
.flash.error { border-color: #c4473a; } .flash.ok { border-color: var(--completed); }
.secret { font-family: ui-monospace, monospace; word-break: break-all; background: var(--code); padding: 8px; border-radius: 6px; }
.diff { font-family: ui-monospace, monospace; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
.diff div { white-space: pre-wrap; padding: 0 10px; min-height: 1.4em; }
.diff .add { background: var(--add); } .diff .del { background: var(--del); } .diff .gap { color: var(--muted); font-style: italic; }
.diff .add::before { content: "+ "; } .diff .del::before { content: "- "; } .diff .same::before { content: "  "; }
table.list { width: 100%; border-collapse: collapse; } table.list td, table.list th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
details summary { cursor: pointer; }
`;

const CLIENT_JS = `
const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");

async function postJson(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || "Request failed (" + res.status + ")");
  return data;
}

function showError(el, err) {
  if (!el) return alert(err.message || err);
  el.textContent = err.message || String(err);
  el.hidden = false;
}

async function registerPasskey(extra) {
  const opts = await postJson("/auth/register/options", extra);
  opts.challenge = b64uToBuf(opts.challenge);
  opts.user.id = b64uToBuf(opts.user.id);
  opts.excludeCredentials = (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  const cred = await navigator.credentials.create({ publicKey: opts });
  const r = cred.response;
  const response = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : undefined,
    },
  };
  return postJson("/auth/register/verify", { ...extra, response });
}

async function loginWithPasskey() {
  const opts = await postJson("/auth/login/options");
  opts.challenge = b64uToBuf(opts.challenge);
  opts.allowCredentials = (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  const cred = await navigator.credentials.get({ publicKey: opts });
  const r = cred.response;
  const response = {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData),
      signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
    },
  };
  return postJson("/auth/login/verify", { response });
}

async function enablePush(statusEl) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("This browser does not support push notifications. On iPhone, add dura to the home screen first.");
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await fetch("/push/key").then((r) => r.json());
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBuf(publicKey) });
  const json = sub.toJSON();
  await postJson("/push/subscribe", { endpoint: json.endpoint, keys: json.keys, label: navigator.userAgent.slice(0, 120) });
  if (statusEl) statusEl.textContent = "Notifications are enabled on this device.";
}

document.addEventListener("click", async (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  ev.preventDefault();
  const errEl = document.getElementById(el.dataset.error || "error");
  if (errEl) errEl.hidden = true;
  el.disabled = true;
  try {
    const action = el.dataset.action;
    if (action === "login") {
      await loginWithPasskey();
      location.href = new URLSearchParams(location.search).get("next") || "/";
    } else if (action === "setup") {
      await registerPasskey({ setupToken: document.getElementById("setup-token").value, name: document.getElementById("passkey-name").value });
      location.href = "/";
    } else if (action === "add-passkey") {
      await registerPasskey({ name: document.getElementById("passkey-name").value });
      location.reload();
    } else if (action === "enable-push") {
      await enablePush(document.getElementById("push-status"));
    } else if (action === "preview") {
      const src = document.getElementById(el.dataset.source).value;
      const res = await fetch("/preview", { method: "POST", headers: { "Content-Type": "text/plain" }, body: src });
      const target = document.getElementById(el.dataset.target);
      target.innerHTML = await res.text();
      target.hidden = false;
    }
  } catch (err) {
    showError(errEl, err);
  } finally {
    el.disabled = false;
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
`;

const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "dura", body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "dura", {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    tag: data.stateId ? "state-" + data.stateId : undefined,
    renotify: true,
    data: { url: data.url || "/" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { await c.navigate(url).catch(() => {}); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
`;

const MANIFEST = {
  name: "dura",
  short_name: "dura",
  description: "Shared state for AI agent loops",
  start_url: "/",
  display: "standalone",
  background_color: "#f7f7f5",
  theme_color: "#1f6f5c",
  icons: [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

const cacheable = { "Cache-Control": "public, max-age=3600" };

assets.get("/static/app.css", (c) => c.body(CSS, 200, { "Content-Type": "text/css; charset=utf-8", ...cacheable }));
assets.get("/static/app.js", (c) =>
  c.body(CLIENT_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", ...cacheable }),
);
assets.get("/sw.js", (c) =>
  c.body(SERVICE_WORKER, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" }),
);
assets.get("/icon.svg", (c) => c.body(ICON, 200, { "Content-Type": "image/svg+xml", ...cacheable }));
const PNGS: Record<string, string> = {
  "/icon-192.png": ICON_192,
  "/icon-512.png": ICON_512,
  "/icon-maskable-512.png": ICON_MASKABLE_512,
  "/apple-touch-icon.png": APPLE_TOUCH_ICON,
  "/badge-96.png": BADGE_96,
};
for (const [path, base64] of Object.entries(PNGS)) {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  assets.get(path, (c) => c.body(bytes, 200, { "Content-Type": "image/png", ...cacheable }));
}
assets.get("/manifest.webmanifest", (c) =>
  c.body(JSON.stringify(MANIFEST), 200, { "Content-Type": "application/manifest+json", ...cacheable }),
);
