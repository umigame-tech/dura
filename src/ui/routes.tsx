import { count, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { createToken, endSession, HUMAN_ACTOR, listTokens, publicOrigin, revokeToken, type Token } from "../auth";
import { passkeys, pushSubscriptions, STATE_STATUSES, webhooks, WEBHOOK_KINDS, type StateStatus, type WebhookKind } from "../db/schema";
import type { AppEnv } from "../env";
import { ApiError } from "../lib/errors";
import { renderMarkdown } from "../lib/markdown";
import { nowIso, randomToken } from "../lib/util";
import { getVapidKeys, notifyStatusChange, pushTo, testNotification, webhookRequest } from "../notify";
import { passkeyCount } from "../routes/webauthn";
import {
  appendJournal,
  assertSectionName,
  countJournal,
  createState,
  findSection,
  getSection,
  getState,
  journalPage,
  listRevisions,
  listSections,
  listStates,
  putSection,
  updateState,
  type Section,
  type State,
} from "../store";
import { Diff, Flash, Layout, Markdown, StatusBadge, Time } from "./layout";

export const ui = new Hono<AppEnv>();

const JOURNAL_PAGE = 10;
/** Set by app.js when the side menu is collapsed on a wide screen, so the page renders collapsed without a flash. */
const NAV_COOKIE = "dura_nav";

// ---------------------------------------------------------------------------
// Login & setup

ui.get("/login", async (c) => {
  if ((await passkeyCount(c)) === 0) return c.redirect("/setup");
  if (c.get("actor")) return c.redirect("/");
  return c.html(
    <Layout title="Log in">
      <div class="card auth-card center">
        <h1>Log in</h1>
        <p class="muted">Use the passkey you registered for this dura instance.</p>
        <button type="button" data-action="login">
          Log in with passkey
        </button>
        <p id="error" class="flash error" hidden></p>
      </div>
    </Layout>,
  );
});

ui.get("/setup", async (c) => {
  if ((await passkeyCount(c)) > 0) return c.redirect("/login");
  const enabled = Boolean(c.get("deps").config.setupToken);
  return c.html(
    <Layout title="Set up">
      <div class="card auth-card">
        <h1>Welcome to dura</h1>
        {enabled ? (
          <div class="stack">
            <p class="muted">Register the passkey you will use to log in. You can add more passkeys later.</p>
            <label for="setup-token">Setup token</label>
            <input id="setup-token" type="password" autocomplete="off" placeholder="DURA_SETUP_TOKEN" />
            <label for="passkey-name">Passkey name</label>
            <input id="passkey-name" type="text" value="My device" />
            <button type="button" data-action="setup">
              Register passkey
            </button>
            <p id="error" class="flash error" hidden></p>
          </div>
        ) : (
          <p>
            Initial setup is disabled. Set the <code>DURA_SETUP_TOKEN</code> environment variable on the server, restart
            it, and reload this page.
          </p>
        )}
      </div>
    </Layout>,
  );
});

ui.post("/logout", async (c) => {
  await endSession(c);
  return c.redirect("/login");
});

// Everything below requires the owner's session.
ui.use("*", async (c, next) => {
  if (c.get("actor")?.type !== "owner") {
    if (c.req.method === "GET") {
      const next = c.req.path === "/" ? "" : `?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""))}`;
      return c.redirect(`/login${next}`);
    }
    throw new ApiError(401, "unauthorized", "Please log in again.");
  }
  await next();
});

const page = (c: Context<AppEnv>, title: string, body: unknown, status: 200 | 400 | 409 = 200) =>
  c.html(
    <Layout title={title} loggedIn path={c.req.path} navCollapsed={getCookie(c, NAV_COOKIE) === "collapsed"}>
      {body as never}
    </Layout>,
    status,
  );

async function form(c: Context<AppEnv>): Promise<Record<string, string>> {
  const data = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (typeof v === "string") out[k] = v;
  return out;
}

const stateUrl = (id: string, section?: string, jpage = 1) => {
  const q = new URLSearchParams();
  if (section) q.set("section", section);
  if (jpage > 1) q.set("jpage", String(jpage));
  return `/s/${encodeURIComponent(id)}${q.size ? `?${q}` : ""}`;
};
const sectionUrl = (id: string, name: string, suffix = "") =>
  `/s/${encodeURIComponent(id)}/sections/${encodeURIComponent(name)}${suffix}`;

// ---------------------------------------------------------------------------
// State list

ui.get("/", async (c) => {
  const states = await listStates(c.get("deps").db);
  const open = states.filter((s) => s.status === "waiting" || s.status === "active");
  const closed = states.filter((s) => s.status === "completed" || s.status === "abandoned");
  return page(
    c,
    "dura",
    <>
      <h1>States</h1>
      {states.length === 0 && <p class="muted">No states yet. Create one below, or let an agent create it via the API.</p>}
      <StateList states={open} />
      {closed.length > 0 && (
        <details>
          <summary class="muted">
            {closed.length} completed or abandoned
          </summary>
          <StateList states={closed} />
        </details>
      )}
      <h2>New state</h2>
      <form class="card stack" method="post" action="/states">
        <div class="grid2">
          <div>
            <label for="title">Title</label>
            <input id="title" name="title" type="text" required />
          </div>
          <div>
            <label for="id">ID (optional)</label>
            <input id="id" name="id" type="text" placeholder="derived from the title" pattern="[a-z0-9][a-z0-9_-]{0,63}" />
          </div>
        </div>
        <label for="goal">Goal (optional, becomes the goal section)</label>
        <textarea id="goal" name="goal" class="short" placeholder="What should be achieved, and how do we know it is done?"></textarea>
        <div>
          <button type="submit">Create</button>
        </div>
      </form>
    </>,
  );
});

function StateList(props: { states: State[] }) {
  return (
    <ul class="state-list">
      {props.states.map((s) => (
        <li class={s.status}>
          <a href={stateUrl(s.id)}>
            <div class="row">
              <StatusBadge status={s.status} />
              <span class="title">{s.title}</span>
              <span class="muted">
                {s.id} · <Time iso={s.updatedAt} />
              </span>
            </div>
            {s.statusNote && <div class="note">{s.statusNote.split("\n")[0]}</div>}
          </a>
        </li>
      ))}
    </ul>
  );
}

ui.post("/states", async (c) => {
  const f = await form(c);
  const sections = f.goal?.trim() ? { goal: f.goal } : undefined;
  const state = await createState(c.get("deps").db, { id: f.id || undefined, title: f.title ?? "", sections }, HUMAN_ACTOR);
  return c.redirect(stateUrl(state.id));
});

// ---------------------------------------------------------------------------
// State page

ui.get("/s/:id", async (c) => {
  const { db } = c.get("deps");
  const id = c.req.param("id");
  const state = await getState(db, id);
  const [sections, total] = await Promise.all([listSections(db, id), countJournal(db, id)]);
  const pages = Math.max(Math.ceil(total / JOURNAL_PAGE), 1);
  const jpage = Math.min(Math.max(Number.parseInt(c.req.query("jpage") ?? "", 10) || 1, 1), pages);
  const journal = await journalPage(db, id, { limit: JOURNAL_PAGE, offset: (jpage - 1) * JOURNAL_PAGE });
  const preferred = ["goal", "plan", "design", "tasks"];
  sections.sort((a, b) => {
    const [ia, ib] = [preferred.indexOf(a.name), preferred.indexOf(b.name)];
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
  });
  const sectionParam = c.req.query("section");
  const currentName = sectionParam ?? sections[0]?.name;
  const current = sections.find((s) => s.name === currentName);

  return page(
    c,
    state.title,
    <>
      <h1>{state.title}</h1>
      <p class="muted">
        {state.id} · updated <Time iso={state.updatedAt} />
      </p>

      <div class={`card status-box ${state.status}`}>
        <div class="row">
          <StatusBadge status={state.status} />
          {state.status === "waiting" && <strong>An agent is waiting for your decision.</strong>}
        </div>
        {state.statusNote ? <Markdown source={state.statusNote} /> : <p class="muted">No status note.</p>}
        <details>
          <summary class="muted">Change status</summary>
          <form class="stack" method="post" action={`/s/${encodeURIComponent(id)}/status`}>
            <select name="status">
              {STATE_STATUSES.map((s) => (
                <option value={s} selected={s === state.status}>
                  {s}
                </option>
              ))}
            </select>
            <textarea name="statusNote" class="short" placeholder="Status note">
              {state.statusNote ?? ""}
            </textarea>
            <div>
              <button type="submit">Save status</button>
            </div>
          </form>
        </details>
      </div>

      <nav class="tabs">
        {sections.map((s) => (
          <a href={stateUrl(id, s.name, jpage)} class={s === current ? "current" : ""}>
            {s.name}
          </a>
        ))}
        <a href={`/s/${encodeURIComponent(id)}/new-section`}>+ section</a>
      </nav>
      <div class="section-body">
        {current ? <SectionView stateId={id} section={current} /> : <p class="muted">No sections yet.</p>}
      </div>

      <h2 id="journal">Journal</h2>
      {journal.length === 0 && <p class="muted">No journal entries yet.</p>}
      <ol class="journal">
        {journal.map((e) => (
          <li class={e.kind} id={`j${e.seq}`}>
            <div class="entry-head">
              #{e.seq} <span class="kind">{e.kind}</span> by {e.actor} · <Time iso={e.createdAt} />
            </div>
            <Markdown source={e.body} />
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <nav class="pager">
          {jpage > 1 ? <a href={`${stateUrl(id, sectionParam, jpage - 1)}#journal`}>← Newer</a> : <span />}
          <span class="muted">
            Page {jpage} of {pages} · {total} entries
          </span>
          {jpage < pages ? <a href={`${stateUrl(id, sectionParam, jpage + 1)}#journal`}>Older →</a> : <span />}
        </nav>
      )}
      <details>
        <summary class="muted">Add a note</summary>
        <form class="stack" method="post" action={`/s/${encodeURIComponent(id)}/journal`}>
          <div class="row">
            <label for="kind">Kind</label>
            <input id="kind" name="kind" type="text" value="note" class="narrow kind" />
          </div>
          <textarea name="body" class="short" required></textarea>
          <div>
            <button type="submit">Append</button>
          </div>
        </form>
      </details>
    </>,
  );
});

function SectionView(props: { stateId: string; section: Section }) {
  const { stateId, section } = props;
  return (
    <>
      <div class="section-meta">
        <span class="muted">
          v{section.version} · {section.updatedBy} · <Time iso={section.updatedAt} />
        </span>
        <span class="row">
          <a href={sectionUrl(stateId, section.name, "/history")}>History</a>
          <a class="button secondary" href={sectionUrl(stateId, section.name, "/edit")}>
            Edit
          </a>
        </span>
      </div>
      {section.content.trim() ? <Markdown source={section.content} /> : <p class="muted">(empty)</p>}
    </>
  );
}

// Browsers submit textareas with CRLF; store LF so Markdown and diffs stay stable.
const crlfToLf = (v: string) => v.replace(/\r\n/g, "\n");

ui.post("/s/:id/status", async (c) => {
  const deps = c.get("deps");
  const id = c.req.param("id");
  const f = await form(c);
  const { state, previous } = await updateState(
    deps.db,
    id,
    { status: f.status as StateStatus, statusNote: f.statusNote == null ? null : crlfToLf(f.statusNote) },
    HUMAN_ACTOR,
  );
  notifyStatusChange(deps, state, previous, HUMAN_ACTOR, publicOrigin(c));
  return c.redirect(stateUrl(id));
});

ui.post("/s/:id/journal", async (c) => {
  const id = c.req.param("id");
  const f = await form(c);
  const entry = await appendJournal(c.get("deps").db, id, HUMAN_ACTOR, f.kind || "note", crlfToLf(f.body ?? ""));
  return c.redirect(`${stateUrl(id)}#j${entry.seq}`);
});

// ---------------------------------------------------------------------------
// Section editing

ui.get("/s/:id/new-section", async (c) => {
  const state = await getState(c.get("deps").db, c.req.param("id"));
  return page(
    c,
    "New section",
    <>
      <p>
        <a href={stateUrl(state.id)}>← {state.title}</a>
      </p>
      <h1>New section</h1>
      <form class="card stack" method="get" action={`/s/${encodeURIComponent(state.id)}/sections/_/edit`}>
        <label for="name">Name</label>
        <input id="name" name="name" type="text" required pattern="[a-z0-9][a-z0-9_.\-]{0,63}" placeholder="goal, plan, design, tasks, findings…" />
        <div>
          <button type="submit">Continue</button>
        </div>
      </form>
    </>,
  );
});

function EditPage(props: {
  state: State;
  name: string;
  content: string;
  version: number;
  conflict?: { current: Section; mine: string };
}) {
  const { state, name, conflict } = props;
  return (
    <>
      <p>
        <a href={stateUrl(state.id, name)}>← {state.title}</a>
      </p>
      <h1>
        {props.version === 0 ? "New section" : "Edit"}: {name}
      </h1>
      {conflict && (
        <Flash kind="error">
          <p>
            <strong>
              Someone else saved version {conflict.current.version} ({conflict.current.updatedBy},{" "}
              <Time iso={conflict.current.updatedAt} />) while you were editing.
            </strong>{" "}
            Your text is kept below. Review what changed between the latest version and your text, then save again.
          </p>
          <Diff before={conflict.current.content} after={conflict.mine} />
        </Flash>
      )}
      <form class="stack" method="post" action={sectionUrl(state.id, name)}>
        <input type="hidden" name="version" value={String(props.version)} />
        <textarea id="content" name="content" autofocus>
          {props.content}
        </textarea>
        <div class="row">
          <button type="submit">Save</button>
          <button type="button" class="secondary" data-action="preview" data-source="content" data-target="preview">
            Preview
          </button>
          <a href={stateUrl(state.id, name)}>Cancel</a>
        </div>
        <p id="error" class="flash error" hidden></p>
      </form>
      <div id="preview" class="card markdown" hidden></div>
    </>
  );
}

ui.get("/s/:id/sections/:name/edit", async (c) => {
  const { db } = c.get("deps");
  const { id, name } = c.req.param();
  // The "new section" form submits the name as a query parameter.
  if (name === "_") return c.redirect(sectionUrl(id, c.req.query("name")?.trim() ?? "", "/edit"));
  assertSectionName(name);
  const state = await getState(db, id);
  const section = await findSection(db, id, name);
  return page(
    c,
    `Edit ${name}`,
    <EditPage state={state} name={name} content={section?.content ?? ""} version={section?.version ?? 0} />,
  );
});

ui.post("/s/:id/sections/:name", async (c) => {
  const { db } = c.get("deps");
  const { id, name } = c.req.param();
  const f = await form(c);
  const content = crlfToLf(f.content ?? "");
  const version = Number(f.version ?? 0);
  try {
    await putSection(db, id, name, content, version, HUMAN_ACTOR);
  } catch (err) {
    if (err instanceof ApiError && err.code === "version_conflict") {
      const [state, current] = await Promise.all([getState(db, id), getSection(db, id, name)]);
      return page(
        c,
        `Edit ${name}`,
        <EditPage state={state} name={name} content={content} version={current.version} conflict={{ current, mine: content }} />,
        409,
      );
    }
    throw err;
  }
  return c.redirect(stateUrl(id, name));
});

ui.get("/s/:id/sections/:name/history", async (c) => {
  const { db } = c.get("deps");
  const { id, name } = c.req.param();
  const state = await getState(db, id);
  const revisions = await listRevisions(db, id, name);
  return page(
    c,
    `History of ${name}`,
    <>
      <p>
        <a href={stateUrl(id, name)}>← {state.title}</a>
      </p>
      <h1>History: {name}</h1>
      {revisions.map((r, i) => (
        <div class="card">
          <div class="row">
            <strong>v{r.version}</strong>
            <span class="muted">
              {r.updatedBy} · <Time iso={r.createdAt} />
            </span>
          </div>
          <Diff before={revisions[i + 1]?.content ?? ""} after={r.content} />
          <details>
            <summary class="muted">Full text of v{r.version}</summary>
            <Markdown source={r.content} />
          </details>
        </div>
      ))}
    </>,
  );
});

ui.post("/preview", async (c) => c.html(renderMarkdown(await c.req.text())));

// ---------------------------------------------------------------------------
// Settings: tokens, passkeys, notifications

ui.get("/settings", (c) => settingsPage(c));

async function settingsPage(c: Context<AppEnv>, flash?: { kind: "ok" | "error"; text: string; secret?: string }) {
  const { db } = c.get("deps");
  const [tokenRows, keys, subs, hooks, states] = await Promise.all([
    listTokens(db),
    db.select().from(passkeys),
    db.select().from(pushSubscriptions),
    db.select().from(webhooks),
    listStates(db),
  ]);
  return page(
    c,
    "Settings",
    <>
      <h1>Settings</h1>
      {flash && (
        <Flash kind={flash.kind}>
          <p>{flash.text}</p>
          {flash.secret && <p class="secret">{flash.secret}</p>}
        </Flash>
      )}

      <h2>Agent tokens</h2>
      <p class="muted">
        Agents authenticate with <code>Authorization: Bearer &lt;token&gt;</code>. The token name is recorded as the author
        of everything the agent writes. Point agents at <code>{publicOrigin(c)}/api/guide</code> for usage.
      </p>
      <TokenTable tokens={tokenRows} />
      <form class="card stack" method="post" action="/settings/tokens">
        <div class="grid2">
          <div>
            <label for="token-name">Name</label>
            <input id="token-name" name="name" type="text" required placeholder="claude-orchestrator" />
          </div>
          <div>
            <label for="token-scope">Access</label>
            <select id="token-scope" name="scope">
              <option value="write">read & write</option>
              <option value="read">read only</option>
            </select>
          </div>
        </div>
        <label for="token-states">Limit to states (optional, comma separated)</label>
        <input id="token-states" name="stateIds" type="text" list="state-ids" placeholder="all states" />
        <datalist id="state-ids">
          {states.map((s) => (
            <option value={s.id} />
          ))}
        </datalist>
        <div>
          <button type="submit">Issue token</button>
        </div>
      </form>

      <h2>Notifications</h2>
      <p class="muted">You are notified when a state becomes waiting or completed.</p>
      <div class="card">
        <div class="row">
          <button type="button" data-action="enable-push" data-error="push-error">
            Enable push on this device
          </button>
          <span id="push-status" class="muted">
            {subs.length} device{subs.length === 1 ? "" : "s"} subscribed
          </span>
        </div>
        <p id="push-error" class="flash error" hidden></p>
        {subs.length > 0 && (
          <table class="list">
            {subs.map((s) => (
              <tr>
                <td>
                  {new URL(s.endpoint).host}
                  <div class="muted">{s.label}</div>
                </td>
                <td class="row">
                  <form method="post" action="/settings/push/test">
                    <input type="hidden" name="endpoint" value={s.endpoint} />
                    <button class="secondary" type="submit">
                      Test
                    </button>
                  </form>
                  <form method="post" action="/settings/push/delete">
                    <input type="hidden" name="endpoint" value={s.endpoint} />
                    <button class="danger" type="submit">
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        )}
      </div>
      <div class="card">
        <strong>Webhooks</strong>
        {hooks.length > 0 && (
          <table class="list">
            {hooks.map((h) => (
              <tr>
                <td>
                  {h.name} <span class="muted">({h.kind})</span>
                  <div class="muted break-all">{h.url}</div>
                </td>
                <td class="row">
                  <form method="post" action={`/settings/webhooks/${h.id}/test`}>
                    <button class="secondary" type="submit">
                      Test
                    </button>
                  </form>
                  <form method="post" action={`/settings/webhooks/${h.id}/delete`}>
                    <button class="danger" type="submit">
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        )}
        <form class="stack spaced" method="post" action="/settings/webhooks">
          <div class="grid2">
            <div>
              <label for="hook-name">Name</label>
              <input id="hook-name" name="name" type="text" required placeholder="phone" />
            </div>
            <div>
              <label for="hook-kind">Format</label>
              <select id="hook-kind" name="kind">
                <option value="ntfy">ntfy</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="json">Generic JSON</option>
              </select>
            </div>
          </div>
          <label for="hook-url">URL</label>
          <input id="hook-url" name="url" type="url" required placeholder="https://ntfy.sh/your-topic" />
          <div>
            <button type="submit">Add webhook</button>
          </div>
        </form>
      </div>

      <h2>Passkeys</h2>
      <table class="list">
        {keys.map((k) => (
          <tr>
            <td>
              {k.name}
              <div class="muted">
                added <Time iso={k.createdAt} />
                {k.lastUsedAt && (
                  <>
                    , last used <Time iso={k.lastUsedAt} />
                  </>
                )}
              </div>
            </td>
            <td>
              {keys.length > 1 && (
                <form method="post" action={`/settings/passkeys/${encodeURIComponent(k.id)}/delete`}>
                  <button class="danger" type="submit">
                    Remove
                  </button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </table>
      <div class="card row">
        <input id="passkey-name" type="text" value="Another device" class="narrow" />
        <button type="button" data-action="add-passkey" data-error="passkey-error">
          Add passkey
        </button>
        <p id="passkey-error" class="flash error" hidden></p>
      </div>
    </>,
    flash?.kind === "error" ? 400 : 200,
  );
}

function TokenTable(props: { tokens: Token[] }) {
  if (props.tokens.length === 0) return <p class="muted">No tokens yet.</p>;
  return (
    <table class="list">
      <tr>
        <th>Name</th>
        <th>Access</th>
        <th>Last used</th>
        <th></th>
      </tr>
      {props.tokens.map((t) => (
        <tr>
          <td>{t.name}</td>
          <td>
            {t.scope === "write" ? "read & write" : "read only"}
            <div class="muted">{t.stateIds ? t.stateIds.join(", ") : "all states"}</div>
          </td>
          <td>{t.lastUsedAt ? <Time iso={t.lastUsedAt} /> : <span class="muted">never</span>}</td>
          <td>
            <form method="post" action={`/settings/tokens/${t.id}/revoke`}>
              <button class="danger" type="submit">
                Revoke
              </button>
            </form>
          </td>
        </tr>
      ))}
    </table>
  );
}

ui.post("/settings/tokens", async (c) => {
  const f = await form(c);
  const stateIds = (f.stateIds ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { token, secret } = await createToken(c.get("deps").db, {
    name: f.name ?? "",
    scope: f.scope === "read" ? "read" : "write",
    stateIds: stateIds.length ? stateIds : null,
  });
  return settingsPage(c, {
    kind: "ok",
    text: `Token "${token.name}" was issued. Copy it now; it will not be shown again.`,
    secret,
  });
});

ui.post("/settings/tokens/:id/revoke", async (c) => {
  await revokeToken(c.get("deps").db, c.req.param("id"));
  return c.redirect("/settings");
});

ui.post("/settings/passkeys/:id/delete", async (c) => {
  const { db } = c.get("deps");
  const [row] = await db.select({ n: count() }).from(passkeys);
  if ((row?.n ?? 0) <= 1) return settingsPage(c, { kind: "error", text: "You cannot remove your only passkey." });
  await db.delete(passkeys).where(eq(passkeys.id, c.req.param("id")));
  return c.redirect("/settings");
});

ui.post("/settings/webhooks", async (c) => {
  const f = await form(c);
  const kind = f.kind as WebhookKind;
  let url: URL;
  try {
    url = new URL(f.url ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    return settingsPage(c, { kind: "error", text: "Webhook URL must be an http(s) URL." });
  }
  if (!WEBHOOK_KINDS.includes(kind)) return settingsPage(c, { kind: "error", text: "Unknown webhook format." });
  await c
    .get("deps")
    .db.insert(webhooks)
    .values({ id: randomToken(9), name: f.name?.trim() || url.host, kind, url: url.toString(), createdAt: nowIso() });
  return c.redirect("/settings");
});

ui.post("/settings/webhooks/:id/delete", async (c) => {
  await c.get("deps").db.delete(webhooks).where(eq(webhooks.id, c.req.param("id")));
  return c.redirect("/settings");
});

ui.post("/settings/webhooks/:id/test", async (c) => {
  const deps = c.get("deps");
  const [hook] = await deps.db.select().from(webhooks).where(eq(webhooks.id, c.req.param("id")));
  if (!hook) return c.redirect("/settings");
  try {
    const res = await (deps.fetch ?? fetch)(webhookRequest(hook.kind, hook.url, testNotification(publicOrigin(c), HUMAN_ACTOR)));
    return settingsPage(c, {
      kind: res.ok ? "ok" : "error",
      text: res.ok ? `Sent a test to "${hook.name}".` : `"${hook.name}" responded with HTTP ${res.status}.`,
    });
  } catch (err) {
    return settingsPage(c, { kind: "error", text: `Could not reach "${hook.name}": ${(err as Error).message}` });
  }
});

ui.post("/settings/push/delete", async (c) => {
  const f = await form(c);
  await c.get("deps").db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, f.endpoint ?? ""));
  return c.redirect("/settings");
});

ui.post("/settings/push/test", async (c) => {
  const f = await form(c);
  const deps = c.get("deps");
  const [sub] = await deps.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, f.endpoint ?? ""));
  if (!sub) return c.redirect("/settings");
  const host = new URL(sub.endpoint).host;
  try {
    const status = await pushTo(deps, sub, testNotification(publicOrigin(c), HUMAN_ACTOR));
    if (status === 404 || status === 410) {
      return settingsPage(c, {
        kind: "error",
        text: `${host} says this subscription has expired, so it was removed. Enable push on that device again.`,
      });
    }
    return settingsPage(c, {
      kind: status < 400 ? "ok" : "error",
      text: status < 400 ? `Sent a test to ${host}.` : `${host} responded with HTTP ${status}.`,
    });
  } catch (err) {
    return settingsPage(c, { kind: "error", text: `Could not reach ${host}: ${(err as Error).message}` });
  }
});

ui.get("/push/key", async (c) => c.json({ publicKey: (await getVapidKeys(c.get("deps").db)).publicKey }));

ui.post("/push/subscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>();
  if (!body.endpoint?.startsWith("https://") || !body.keys?.p256dh || !body.keys.auth) {
    throw new ApiError(400, "bad_request", "Invalid push subscription.");
  }
  const values = { p256dh: body.keys.p256dh, auth: body.keys.auth, label: body.label?.slice(0, 200) ?? null };
  await c
    .get("deps")
    .db.insert(pushSubscriptions)
    .values({ endpoint: body.endpoint, ...values, createdAt: nowIso() })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
  return c.json({ ok: true });
});
