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
  excerpt,
  findSummary,
  getSection,
  getState,
  getJournalEntry,
  getSummary,
  journalEntryMarkdown,
  lastJournalSeq,
  listJournal,
  listJournalBefore,
  listRevisions,
  listSummaryRevisions,
  listSections,
  listStates,
  putSection,
  putSummary,
  renderStateMarkdown,
  replaceInSection,
  SEARCH_MAX_QUERY,
  SEARCH_MAX_TERMS,
  searchJournal,
  searchTerms,
  updateState,
  type JournalEntry,
  type JournalSummary,
  type Section,
} from "../store";

export const api = new Hono<AppEnv>();

const wantsMarkdown = (c: Context<AppEnv>) =>
  /text\/(markdown|plain)/.test(c.req.header("Accept") ?? "") || c.req.query("format") === "md";

const markdown = (c: Context<AppEnv>, body: string, status: 200 | 201 = 200) =>
  c.body(body, status, { "Content-Type": "text/markdown; charset=utf-8" });

function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw badRequest(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

/** Optional `maxChars`: cut longer journal bodies to this many characters (code points). */
function maxCharsParam(c: Context<AppEnv>): number | undefined {
  const n = intParam(c.req.query("maxChars"), "maxChars");
  if (n === 0) throw badRequest("maxChars must be at least 1.");
  return n;
}

/** Accepts `7`, `"7"` and `W/"7"`. */
function ifMatch(c: Context<AppEnv>): number | null {
  const raw = c.req.header("If-Match");
  if (raw === undefined) return null;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  if (!m) throw badRequest(`If-Match must be a version number such as 7 (got ${JSON.stringify(raw)}).`);
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

function summaryJson(s: JournalSummary) {
  return {
    content: s.content,
    coveredThroughSeq: s.coveredThroughSeq,
    version: s.version,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt,
  };
}

/** With maxChars, every entry also says whether its body was cut and how long the whole body is. */
function journalJson(e: JournalEntry, maxChars?: number) {
  const base = { seq: e.seq, actor: e.actor, kind: e.kind, body: e.body, createdAt: e.createdAt };
  if (maxChars === undefined) return base;
  const x = excerpt(e.body, maxChars);
  return { ...base, body: x.body, truncated: x.truncated, totalChars: x.totalChars };
}

function journalMarkdown(
  stateId: string,
  entries: JournalEntry[],
  page: { after: number } | { before: number; olderBefore: number | null; latestSeq: number },
  maxChars?: number,
) {
  if (entries.length === 0) {
    return "after" in page ? `_No journal entries after #${page.after}._\n` : `_No journal entries before #${page.before}._\n`;
  }
  const parts = entries.map((e) => `${journalEntryMarkdown(stateId, e, maxChars)}\n`);
  const last = entries.at(-1)!.seq;
  let text = `${parts.join("\n")}\n---\n\nLast journal seq: ${last}.\n`;
  if ("before" in page && page.latestSeq > last) {
    // Paging backwards from an older seq: say that newer entries exist, so "last" is not taken as the latest.
    text +=
      `Newer entries after #${last} (through #${page.latestSeq}) are not shown and have not been read. ` +
      `Read them with after=${last}.\n`;
  }
  if ("before" in page && page.olderBefore !== null) {
    text +=
      `Older entries before #${page.olderBefore} are not shown and have not been read. ` +
      `Continue with before=${page.olderBefore}.\n`;
  }
  return text;
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
  const maxChars = maxCharsParam(c);
  const state = await getState(db, id);
  const [sections, summary, journal] = await Promise.all([
    listSections(db, id),
    findSummary(db, id),
    listJournal(db, id, { after, limit }),
  ]);
  if (wantsMarkdown(c)) return markdown(c, renderStateMarkdown(state, sections, journal, after, summary, maxChars));
  return c.json({
    state,
    summary: summary ? summaryJson(summary) : null,
    sections: sections.map(sectionJson),
    journal: journal.map((e) => journalJson(e, maxChars)),
  });
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

api.get("/states/:id/summary", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const summary = await getSummary(c.get("deps").db, id);
  c.header("ETag", `"${summary.version}"`);
  if (wantsMarkdown(c)) {
    c.header("X-Covered-Through-Seq", String(summary.coveredThroughSeq));
    return markdown(c, summary.content);
  }
  return c.json({ summary: summaryJson(summary) });
});

api.get("/states/:id/summary/revisions", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const revisions = await listSummaryRevisions(c.get("deps").db, id);
  return c.json({
    revisions: revisions.map((r) => ({
      version: r.version,
      content: r.content,
      coveredThroughSeq: r.coveredThroughSeq,
      updatedBy: r.updatedBy,
      createdAt: r.createdAt,
    })),
  });
});

api.put("/states/:id/summary", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertWrite(actor, id);
  const body = objectBody(await jsonBody<unknown>(c));
  if (typeof body.content !== "string") throw badRequest("content must be a string.");
  if (typeof body.coveredThroughSeq !== "number") {
    throw badRequest("coveredThroughSeq is required and must be a number: the last journal seq the summary reflects.");
  }
  const summary = await putSummary(
    c.get("deps").db,
    id,
    { content: body.content, coveredThroughSeq: body.coveredThroughSeq },
    ifMatch(c),
    actor.name,
  );
  c.header("ETag", `"${summary.version}"`);
  return c.json({ summary: summaryJson(summary) });
});

api.get("/states/:id/journal", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const { db } = c.get("deps");
  const after = intParam(c.req.query("after"), "after");
  const before = intParam(c.req.query("before"), "before");
  const limit = intParam(c.req.query("limit"), "limit");
  const maxChars = maxCharsParam(c);
  if (after !== undefined && before !== undefined) {
    throw badRequest("Pass either after (newer entries) or before (older entries), not both.");
  }
  await getState(db, id);
  if (before !== undefined) {
    // Newest first in the query, oldest first in the response, like after.
    const [{ entries, olderBefore }, latestSeq] = await Promise.all([
      listJournalBefore(db, id, { before, limit }),
      lastJournalSeq(db, id),
    ]);
    if (wantsMarkdown(c)) return markdown(c, journalMarkdown(id, entries, { before, olderBefore, latestSeq }, maxChars));
    return c.json({ entries: entries.map((e) => journalJson(e, maxChars)), olderBefore, latestSeq });
  }
  const entries = await listJournal(db, id, { after: after ?? 0, limit });
  if (wantsMarkdown(c)) return markdown(c, journalMarkdown(id, entries, { after: after ?? 0 }, maxChars));
  return c.json({ entries: entries.map((e) => journalJson(e, maxChars)) });
});

function searchMarkdown(
  stateId: string,
  entries: JournalEntry[],
  search: { q?: string; kind?: string; before?: number; nextBefore: number | null },
  maxChars?: number,
) {
  const what = [search.q !== undefined && `q=${JSON.stringify(search.q)}`, search.kind !== undefined && `kind=${search.kind}`]
    .filter(Boolean)
    .join(", ");
  const range = search.before !== undefined ? ` before #${search.before}` : "";
  const reminder =
    "_Search finds past entries; it does not replace reading the journal after the summary's covered seq._\n";
  if (entries.length === 0) return `_No journal entries match ${what}${range}._\n\n${reminder}`;
  const parts = entries.map((e) => `${journalEntryMarkdown(stateId, e, maxChars)}\n`);
  let text = `# Journal search: ${what}${range} (newest first)\n\n${parts.join("\n")}\n---\n\n`;
  text +=
    search.nextBefore !== null
      ? `More matches before #${search.nextBefore} are not shown. Continue with before=${search.nextBefore}.\n`
      : "No more matches.\n";
  return `${text}${reminder}`;
}

api.get("/states/:id/journal/search", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const { db } = c.get("deps");
  const rawQ = c.req.query("q");
  const rawKind = c.req.query("kind");
  const q = rawQ?.trim() ? rawQ.trim() : undefined;
  const kind = rawKind?.trim() ? rawKind.trim() : undefined;
  const before = intParam(c.req.query("before"), "before");
  const limit = intParam(c.req.query("limit"), "limit");
  const maxChars = maxCharsParam(c);
  if (q !== undefined && [...q].length > SEARCH_MAX_QUERY) throw badRequest(`q must be at most ${SEARCH_MAX_QUERY} characters.`);
  const terms = q !== undefined ? searchTerms(q) : [];
  // q = '""' has no terms, so it would match everything like an empty q.
  if (terms.length === 0 && kind === undefined) throw badRequest("Pass q (keywords) and/or kind to search the journal.");
  if (terms.length > SEARCH_MAX_TERMS) throw badRequest(`q may have at most ${SEARCH_MAX_TERMS} terms.`);
  await getState(db, id);
  const { entries, nextBefore } = await searchJournal(db, id, { terms, kind, before, limit });
  if (wantsMarkdown(c)) return markdown(c, searchMarkdown(id, entries, { q, kind, before, nextBefore }, maxChars));
  return c.json({ entries: entries.map((e) => journalJson(e, maxChars)), nextBefore });
});

api.get("/states/:id/journal/:seq{[0-9]+}", async (c) => {
  const actor = requireActor(c);
  const id = c.req.param("id");
  assertRead(actor, id);
  const seq = intParam(c.req.param("seq"), "seq")!;
  const entry = await getJournalEntry(c.get("deps").db, id, seq);
  if (wantsMarkdown(c)) return markdown(c, `${journalEntryMarkdown(id, entry)}\n`);
  return c.json({ entry: journalJson(entry) });
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
