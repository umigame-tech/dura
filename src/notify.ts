import { eq } from "drizzle-orm";
import type { DB } from "./db";
import { pushSubscriptions, settings, webhooks, type StateStatus, type WebhookKind } from "./db/schema";
import type { Deps } from "./env";
import { generateVapidKeys, sendPush, type VapidKeys } from "./lib/webpush";
import type { State } from "./store";

/** Status changes that wake up the human. */
export const NOTIFY_STATUSES: StateStatus[] = ["completed", "waiting"];

export type Notification = {
  title: string;
  body: string;
  url: string;
  stateId: string;
  status: StateStatus;
  previousStatus: StateStatus;
  actor: string;
};

export function buildNotification(state: State, previousStatus: StateStatus, actor: string, origin: string): Notification {
  const verb = state.status === "completed" ? "Completed" : "Waiting for you";
  return {
    title: `${verb}: ${state.title}`,
    body: state.statusNote?.trim() || `${actor} set the status to ${state.status}.`,
    url: `${origin}/s/${encodeURIComponent(state.id)}`,
    stateId: state.id,
    status: state.status,
    previousStatus,
    actor,
  };
}

export async function getVapidKeys(db: DB): Promise<VapidKeys> {
  const rows = await db.select().from(settings).where(eq(settings.key, "vapid"));
  if (rows[0]) return JSON.parse(rows[0].value) as VapidKeys;
  const keys = await generateVapidKeys();
  // If another request raced us, keep whichever was stored first.
  await db.insert(settings).values({ key: "vapid", value: JSON.stringify(keys) }).onConflictDoNothing();
  const [stored] = await db.select().from(settings).where(eq(settings.key, "vapid"));
  return JSON.parse(stored!.value) as VapidKeys;
}

export function webhookRequest(kind: WebhookKind, url: string, n: Notification): Request {
  const json = (body: unknown) =>
    new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  switch (kind) {
    case "ntfy":
      return new Request(url, {
        method: "POST",
        headers: {
          Title: encodeHeader(n.title),
          Click: n.url,
          Tags: n.status === "completed" ? "white_check_mark" : "raising_hand",
          Priority: n.status === "waiting" ? "high" : "default",
        },
        body: n.body,
      });
    case "slack":
      return json({ text: `*${n.title}*\n${n.body}\n<${n.url}|Open in dura>` });
    case "discord":
      return json({ content: `**${n.title}**\n${n.body}\n${n.url}`.slice(0, 2000) });
    default:
      return json({ event: "state.status_changed", ...n });
  }
}

// HTTP header values must be ISO-8859-1; ntfy accepts RFC 2047 encoded words for anything else.
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return `=?UTF-8?B?${b64}?=`;
}

/** Fan out to every push subscription and webhook. Never throws; failures are logged. */
export async function deliver(deps: Deps, n: Notification): Promise<void> {
  const { db } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const jobs: Promise<unknown>[] = [];

  const subs = await db.select().from(pushSubscriptions);
  if (subs.length > 0) {
    const keys = await getVapidKeys(db);
    const subject = deps.config.vapidSubject || new URL(n.url).origin;
    for (const sub of subs) {
      jobs.push(
        sendPush(sub, n, keys, subject, fetchImpl).then(async (status) => {
          if (status === 404 || status === 410) {
            await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, sub.endpoint));
          } else if (status >= 400) {
            console.warn(`dura: push to ${new URL(sub.endpoint).host} failed with HTTP ${status}`);
          }
        }),
      );
    }
  }

  for (const hook of await db.select().from(webhooks)) {
    jobs.push(
      fetchImpl(webhookRequest(hook.kind, hook.url, n)).then((res) => {
        if (!res.ok) console.warn(`dura: webhook "${hook.name}" failed with HTTP ${res.status}`);
      }),
    );
  }

  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === "rejected") console.warn("dura: notification failed:", r.reason);
  }
}

export function runInBackground(deps: Deps, work: Promise<unknown>) {
  const guarded = work.catch((err) => console.error("dura: background task failed:", err));
  if (deps.waitUntil) deps.waitUntil(guarded);
}

/** Called after any status change, from the API or the web UI. */
export function notifyStatusChange(deps: Deps, state: State, previous: State, actor: string, origin: string) {
  if (state.status === previous.status || !NOTIFY_STATUSES.includes(state.status)) return;
  runInBackground(deps, deliver(deps, buildNotification(state, previous.status, actor, origin)));
}
