import { Hono, type Context } from "hono";
import { assertRead, assertWrite, publicOrigin, requireActor } from "../auth";
import type { StateStatus } from "../db/schema";
import type { AppEnv } from "../env";
import { guideMarkdown } from "../guide";
import { ApiError, badRequest } from "../lib/errors";
import { notifyStatusChange } from "../notify";
import {
  appendJournal,
  createState,
  getSection,
  getState,
  listJournal,
  listRevisions,
  listSections,
  listStates,
  putSection,
  renderStateMarkdown,
  replaceInSection,
  updateState,
  type JournalEntry,
  type Section,
} from "../store";

export const api = new Hono<AppEnv>();

const wantsMarkdown = (c: Context<AppEnv>) =>
  /text\/(markdown|plain)/.test(c.req.header("Accept") ?? "") || c.req.query("format") === "md";

const markdown = (c: Context<AppEnv>, body: string, status: 200 | 201 = 200) =>
  c.body(body, status, { "Content-Type": "text/markdown; charset=utf-8" });

function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw badRequest(`${name} must be a non-negative integer.`);
  return Number(value);
}

/** Accepts `7`, `"7"` and `W/"7"`. */
function ifMatch(c: Context<AppEnv>): number | null {
  const raw = c.req.header("If-Match");
  if (raw === undefined) return null;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  if (!m) throw badRequest(`If-Match must be a section version number such as 7 (got ${JSON.stringify(raw)}).`);
  return Number(m[1]);
}

async function jsonBody<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
}

function objectBody(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest("Request body must be a JSON object.");
  return v as Record<string, unknown>;
}

function optString(o: Record<string, unknown>, key: string, nullable = false): string | undefined {
  const v = o[key];
  if (v === undefined || (nullable && v === null)) return undefined;
  if (typeof v !== "string") throw badRequest(`${key} must be a string${nullable ? " or null" : ""}.`);
  return v;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = optString(o, key);
  if (v === undefined) throw badRequest(`${key} is required and must be a string.`);
  return v;
}

const isJson = (c: Context<AppEnv>) => (c.req.header("Content-Type") ?? "").includes("application/json");

function sectionJson(s: Section) {
  return { name: s.name, content: s.content, version: s.version, updatedBy: s.updatedBy, updatedAt: s.updatedAt };
}

function journalJson(e: JournalEntry) {
  return { seq: e.seq, actor: e.actor, kind: e.kind, body: e.body, createdAt: e.createdAt };
}

function journalMarkdown(entries: JournalEntry[], after: number) {
  if (entries.length === 0) return `_No journal entries after #${after}._\n`;
  const parts = entries.map((e) => `### #${e.seq} ${e.kind} by ${e.actor} at ${e.createdAt}\n\n${e.body.trim()}\n`);
  return `${parts.join("\n")}\n---\n\nLast journal seq: ${entries.at(-1)!.seq}.\n`;
}

api.get("/guide", (c) => markdown(c, guideMarkdown(publicOrigin(c))));

api.get("/states", async (c) => {
  const actor = requireActor(c);
  const status = c.req.query("status") as StateStatus | undefined;
  const ids = actor.type === "token" ? actor.stateIds : null;
  const rows = await listStates(c.get("deps").db, { ids, status: status || undefined });
  if (wantsMarkdown(c)) {
    const lines = rows.map((s) => `- **${s.id}** [${s.status}] ${s.title}${s.statusNote ? ` - ${s.statusNote.split("\n")[0]}` : ""}`);
    return markdown(c, `# States\n\n${lines.join("\n") || "_No states._"}\n`);
  }
  return c.json({ states: rows });
});

api.post("/states", async (c) => {
  const actor = requireActor(c);
  assertWrite(actor, null);
  const body = objectBody(await jsonBody<unknown>(c));
  let sections: Record<string, string> | undefined;
  if (body.sections !== undefined) {
    const raw = objectBody(body.sections);
    for (const [k, v] of Object.entries(raw)) if (typeof v !== "string") throw badRequest(`sections.${k} must be a string.`);
    sections = raw as Record<string, string>;
  }
  const state = await createState(
    c.get("deps").db,
    {
      id: optString(body, "id"),
      title: reqString(body, "title"),
      status: optString(body, "status") as StateStatus | undefined,
      statusNote: optString(body, "statusNote", true),
      sections,
    },
    actor.name,
  );
  return c.json({ state }, 201);
});

api.get("/states/:id", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const { db } = c.get("deps");
  const after = intParam(c.req.query("after"), "after") ?? 0;
  const limit = intParam(c.req.query("limit"), "limit");
  const state = await getState(db, id);
  const [sections, journal] = await Promise.all([listSections(db, id), listJournal(db, id, { after, limit })]);
  if (wantsMarkdown(c)) return markdown(c, renderStateMarkdown(state, sections, journal, after));
  return c.json({ state, sections: sections.map(sectionJson), journal: journal.map(journalJson) });
});

api.patch("/states/:id", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertWrite(actor, id);
  const deps = c.get("deps");
  const body = objectBody(await jsonBody<unknown>(c));
  const patch = {
    title: optString(body, "title"),
    status: optString(body, "status") as StateStatus | undefined,
    statusNote: body.statusNote === null ? null : optString(body, "statusNote"),
  };
  const { state, previous } = await updateState(deps.db, id, patch, actor.name);
  notifyStatusChange(deps, state, previous, actor.name, publicOrigin(c));
  return c.json({ state });
});

api.get("/states/:id/sections/:name", async (c) => {
  const actor = requireActor(c);
  const { id, name } = c.req.param();
  assertRead(actor, id);
  const section = await getSection(c.get("deps").db, id, name);
  c.header("ETag", `"${section.version}"`);
  if (wantsMarkdown(c)) return markdown(c, section.content);
  return c.json({ section: sectionJson(section) });
});

api.put("/states/:id/sections/:name", async (c) => {
  const actor = requireActor(c);
  const { id, name } = c.req.param();
  assertWrite(actor, id);
  let content: string;
  if (isJson(c)) {
    const body = objectBody(await jsonBody<unknown>(c));
    if (typeof body.content !== "string") throw badRequest("content must be a string.");
    content = body.content;
  } else {
    content = await c.req.text();
  }
  const section = await putSection(c.get("deps").db, id, name, content, ifMatch(c), actor.name);
  c.header("ETag", `"${section.version}"`);
  return c.json({ section: sectionJson(section) });
});

api.post("/states/:id/sections/:name/replace", async (c) => {
  const actor = requireActor(c);
  const { id, name } = c.req.param();
  assertWrite(actor, id);
  const version = ifMatch(c);
  if (version === null) {
    throw new ApiError(428, "precondition_required", "replace requires If-Match: <version you read>.");
  }
  const body = objectBody(await jsonBody<unknown>(c));
  if (body.replaceAll !== undefined && typeof body.replaceAll !== "boolean") throw badRequest("replaceAll must be a boolean.");
  const edit = { old: reqString(body, "old"), new: reqString(body, "new"), replaceAll: body.replaceAll };
  const section = await replaceInSection(c.get("deps").db, id, name, edit, version, actor.name);
  c.header("ETag", `"${section.version}"`);
  return c.json({ section: sectionJson(section) });
});

api.get("/states/:id/sections/:name/revisions", async (c) => {
  const actor = requireActor(c);
  const { id, name } = c.req.param();
  assertRead(actor, id);
  const revisions = await listRevisions(c.get("deps").db, id, name);
  return c.json({
    revisions: revisions.map((r) => ({
      version: r.version,
      content: r.content,
      updatedBy: r.updatedBy,
      createdAt: r.createdAt,
    })),
  });
});

api.get("/states/:id/journal", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const { db } = c.get("deps");
  await getState(db, id);
  const after = intParam(c.req.query("after"), "after") ?? 0;
  const entries = await listJournal(db, id, { after, limit: intParam(c.req.query("limit"), "limit") });
  if (wantsMarkdown(c)) return markdown(c, journalMarkdown(entries, after));
  return c.json({ entries: entries.map(journalJson) });
});

api.post("/states/:id/journal", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertWrite(actor, id);
  let kind = c.req.query("kind") ?? "note";
  let body: string;
  if (isJson(c)) {
    const json = objectBody(await jsonBody<unknown>(c));
    body = reqString(json, "body");
    kind = optString(json, "kind") ?? kind;
  } else {
    body = await c.req.text();
  }
  const entry = await appendJournal(c.get("deps").db, id, actor.name, kind, body);
  return c.json({ entry: journalJson(entry) }, 201);
});

api.all("*", () => {
  throw new ApiError(404, "not_found", "Unknown API endpoint. See GET /api/guide.");
});
