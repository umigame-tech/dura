import { and, asc, count, desc, eq, gt, inArray, lt, max, sql } from "drizzle-orm";
import { atomic, type DB, type Write } from "./db";
import {
  journalEntries,
  journalSummaries,
  journalSummaryRevisions,
  sectionRevisions,
  sections,
  states,
  type StateStatus,
} from "./db/schema";
import { ApiError, badRequest, isUniqueViolation, notFound } from "./lib/errors";
import { ID_PATTERN, nowIso, SECTION_NAME_PATTERN, slugify } from "./lib/util";

export type State = typeof states.$inferSelect;
export type Section = typeof sections.$inferSelect;
export type SectionRevision = typeof sectionRevisions.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalSummary = typeof journalSummaries.$inferSelect;
export type JournalSummaryRevision = typeof journalSummaryRevisions.$inferSelect;

const STATUS_ORDER = sql`case ${states.status} when 'waiting' then 0 when 'active' then 1 when 'completed' then 2 else 3 end`;

export async function listStates(db: DB, opts: { ids?: string[] | null; status?: StateStatus } = {}): Promise<State[]> {
  const conds = [];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    conds.push(inArray(states.id, opts.ids));
  }
  if (opts.status) conds.push(eq(states.status, opts.status));
  return db
    .select()
    .from(states)
    .where(and(...conds))
    .orderBy(STATUS_ORDER, desc(states.updatedAt));
}

export async function findState(db: DB, id: string): Promise<State | undefined> {
  const [row] = await db.select().from(states).where(eq(states.id, id));
  return row;
}

export async function getState(db: DB, id: string): Promise<State> {
  const row = await findState(db, id);
  if (!row) throw notFound(`State "${id}"`);
  return row;
}

export function assertStatus(status: unknown): asserts status is StateStatus {
  if (!["active", "waiting", "completed", "abandoned"].includes(status as string)) {
    throw badRequest(`status must be one of active, waiting, completed, abandoned (got ${JSON.stringify(status)}).`);
  }
}

export function assertSectionName(name: string) {
  if (!SECTION_NAME_PATTERN.test(name)) {
    throw badRequest(
      `Invalid section name "${name}". Use lowercase letters, digits, "-", "_" or "." (max 64 chars), e.g. "goal", "plan", "tasks".`,
    );
  }
}

export async function createState(
  db: DB,
  input: { id?: string; title: string; status?: StateStatus; statusNote?: string | null; sections?: Record<string, string> },
  actor: string,
): Promise<State> {
  const title = input.title?.trim();
  if (!title) throw badRequest("title is required.");
  if (input.status !== undefined) assertStatus(input.status);
  for (const name of Object.keys(input.sections ?? {})) assertSectionName(name);

  let id = input.id?.trim();
  if (id) {
    if (!ID_PATTERN.test(id)) {
      throw badRequest(`Invalid id "${id}". Use lowercase letters, digits, "-" or "_" (max 64 chars).`);
    }
  } else {
    id = await uniqueSlug(db, slugify(title) || "state");
  }

  const ts = nowIso();
  // The state and its initial sections are written together, so a failure never leaves a half-created state.
  const writes: [Write, ...Write[]] = [
    db.insert(states).values({
      id,
      title,
      status: input.status ?? "active",
      statusNote: input.statusNote ?? null,
      createdAt: ts,
      updatedAt: ts,
    }),
  ];
  for (const [name, content] of Object.entries(input.sections ?? {})) {
    writes.push(...sectionWrites(db, { stateId: id, name, content, version: 1, actor, ts }));
  }
  try {
    await atomic(db, writes);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, "already_exists", `State "${id}" already exists.`);
    throw err;
  }
  return getState(db, id);
}

async function uniqueSlug(db: DB, base: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!(await findState(db, candidate))) return candidate;
  }
}

export async function updateState(
  db: DB,
  id: string,
  patch: { title?: string; status?: StateStatus; statusNote?: string | null },
  actor: string,
): Promise<{ state: State; previous: State }> {
  const previous = await getState(db, id);
  const values: Partial<State> = { updatedAt: nowIso() };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw badRequest("title must not be empty.");
    values.title = patch.title.trim();
  }
  if (patch.status !== undefined) {
    assertStatus(patch.status);
    values.status = patch.status;
  }
  if (patch.statusNote !== undefined) values.statusNote = patch.statusNote || null;
  // Not atomic with the status journal entry below: if appending fails, the status change stays without its entry.
  // Doing both in one atomic() needs the journal seq assigned up front; left for the updateState race task (#5-8).
  await db.update(states).set(values).where(eq(states.id, id));
  const state = await getState(db, id);

  if (state.status !== previous.status || (patch.statusNote !== undefined && state.statusNote !== previous.statusNote)) {
    const head =
      state.status !== previous.status
        ? `Status changed from **${previous.status}** to **${state.status}**.`
        : `Status note updated (status: **${state.status}**).`;
    await appendJournal(db, id, actor, "status", state.statusNote ? `${head}\n\n${state.statusNote}` : head);
  }
  return { state, previous };
}

/** A query that bumps the state's updatedAt; run it with atomic() alongside the write it records. */
function touchState(db: DB, id: string) {
  return db.update(states).set({ updatedAt: nowIso() }).where(eq(states.id, id));
}

// ---------------------------------------------------------------------------
// Sections

export async function listSections(db: DB, stateId: string): Promise<Section[]> {
  return db.select().from(sections).where(eq(sections.stateId, stateId)).orderBy(asc(sections.name));
}

export async function findSection(db: DB, stateId: string, name: string): Promise<Section | undefined> {
  const [row] = await db
    .select()
    .from(sections)
    .where(and(eq(sections.stateId, stateId), eq(sections.name, name)));
  return row;
}

export async function getSection(db: DB, stateId: string, name: string): Promise<Section> {
  await getState(db, stateId);
  const row = await findSection(db, stateId, name);
  if (!row) throw notFound(`Section "${name}" of state "${stateId}"`);
  return row;
}

type Versioned = { version: number; updatedBy: string; updatedAt: string };

/**
 * 409 for a stale write to a versioned document (a section or the journal summary).
 * `what` names it mid-sentence; `reread` says how to re-read it and re-apply the change.
 */
function versionConflict(what: string, reread: string, sent: number, current: Versioned | undefined): ApiError {
  const currentVersion = current?.version ?? 0;
  const who = current ? ` (last written by ${current.updatedBy} at ${current.updatedAt})` : "";
  return new ApiError(
    409,
    "version_conflict",
    `You sent version ${sent}, but ${what} is now at version ${currentVersion}${who}. ` +
      `${reread}, and retry with If-Match: ${currentVersion}.`,
    { currentVersion, sentVersion: sent },
  );
}

/** 428 for a write without If-Match to a versioned document that already exists. `What` starts the sentence. */
function versionRequired(What: string, current: Versioned): ApiError {
  return new ApiError(
    428,
    "precondition_required",
    `${What} already exists (version ${current.version}). Send If-Match: ${current.version} ` +
      `with the version you based your edit on, so concurrent edits are not lost.`,
    { currentVersion: current.version },
  );
}

function conflict(stateId: string, name: string, sent: number, current: Section | undefined): ApiError {
  return versionConflict(
    `section "${name}"`,
    `Re-read it with GET /api/states/${stateId}/sections/${name}, re-apply your change to the latest content`,
    sent,
    current,
  );
}

/**
 * The queries that store one version of a section: its revision, then the latest content.
 * The revision goes first so that its primary key (the optimistic lock) fails before anything else is written.
 */
function sectionWrites(
  db: DB,
  w: { stateId: string; name: string; content: string; version: number; actor: string; ts: string },
): [Write, Write] {
  const { stateId, name, content, version, actor, ts } = w;
  return [
    db.insert(sectionRevisions).values({ stateId, name, version, content, updatedBy: actor, createdAt: ts }),
    db
      .insert(sections)
      .values({ stateId, name, content, version, updatedBy: actor, updatedAt: ts })
      .onConflictDoUpdate({
        target: [sections.stateId, sections.name],
        set: { content, version, updatedBy: actor, updatedAt: ts },
      }),
  ];
}

/**
 * Writes the full content of a section.
 * expectedVersion is the version the caller based its edit on (0 = section must not exist yet);
 * null means the caller sent no If-Match, which is only allowed when creating.
 */
export async function putSection(
  db: DB,
  stateId: string,
  name: string,
  content: string,
  expectedVersion: number | null,
  actor: string,
): Promise<Section> {
  assertSectionName(name);
  await getState(db, stateId);
  const current = await findSection(db, stateId, name);
  if (expectedVersion === null) {
    if (current) throw versionRequired(`Section "${name}"`, current);
    expectedVersion = 0;
  }
  if ((current?.version ?? 0) !== expectedVersion) throw conflict(stateId, name, expectedVersion, current);

  const version = expectedVersion + 1;
  const ts = nowIso();
  try {
    // Claiming the revision row is the lock: only one writer can create version N+1.
    // The revision, the latest content and the state's updatedAt are written together,
    // so a failure never leaves a revision without the matching section (or the reverse).
    await atomic(db, [...sectionWrites(db, { stateId, name, content, version, actor, ts }), touchState(db, stateId)]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(stateId, name, expectedVersion, await findSection(db, stateId, name));
    throw err;
  }
  return (await findSection(db, stateId, name))!;
}

/** old/new partial replacement, the same model as the edit tools of coding agents. */
export async function replaceInSection(
  db: DB,
  stateId: string,
  name: string,
  edit: { old: string; new: string; replaceAll?: boolean },
  expectedVersion: number,
  actor: string,
): Promise<Section> {
  if (typeof edit.old !== "string" || edit.old === "") throw badRequest("old must be a non-empty string.");
  if (typeof edit.new !== "string") throw badRequest("new must be a string.");
  if (edit.old === edit.new) throw badRequest("old and new are identical; nothing to change.");
  const current = await getSection(db, stateId, name);
  if (current.version !== expectedVersion) throw conflict(stateId, name, expectedVersion, current);

  const count = current.content.split(edit.old).length - 1;
  if (count === 0) {
    throw new ApiError(
      422,
      "old_not_found",
      `The old text was not found in section "${name}" (version ${current.version}). ` +
        `Re-read the section and copy the text to replace exactly, including whitespace.`,
    );
  }
  if (count > 1 && !edit.replaceAll) {
    throw new ApiError(
      422,
      "old_not_unique",
      `The old text occurs ${count} times in section "${name}". ` +
        `Include more surrounding text to make it unique, or set replaceAll to replace every occurrence.`,
      { occurrences: count },
    );
  }
  const content = edit.replaceAll
    ? current.content.split(edit.old).join(edit.new)
    : current.content.replace(edit.old, () => edit.new);
  return putSection(db, stateId, name, content, expectedVersion, actor);
}

export async function listRevisions(db: DB, stateId: string, name: string): Promise<SectionRevision[]> {
  await getSection(db, stateId, name);
  return db
    .select()
    .from(sectionRevisions)
    .where(and(eq(sectionRevisions.stateId, stateId), eq(sectionRevisions.name, name)))
    .orderBy(desc(sectionRevisions.version));
}

// ---------------------------------------------------------------------------
// Journal

export async function listJournal(
  db: DB,
  stateId: string,
  opts: { after?: number; limit?: number } = {},
): Promise<JournalEntry[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  return db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.stateId, stateId), gt(journalEntries.seq, opts.after ?? 0)))
    .orderBy(asc(journalEntries.seq))
    .limit(limit);
}

/**
 * The newest `limit` entries with seq < before, returned oldest first. `olderBefore` is the
 * smallest seq returned when older entries remain (pass it as the next `before`), or null.
 */
export async function listJournalBefore(
  db: DB,
  stateId: string,
  opts: { before: number; limit?: number },
): Promise<{ entries: JournalEntry[]; olderBefore: number | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.stateId, stateId), lt(journalEntries.seq, opts.before)))
    .orderBy(desc(journalEntries.seq))
    .limit(limit + 1);
  const entries = rows.slice(0, limit).reverse();
  return { entries, olderBefore: rows.length > limit ? entries[0]!.seq : null };
}

export async function getJournalEntry(db: DB, stateId: string, seq: number): Promise<JournalEntry> {
  await getState(db, stateId);
  const [row] = await db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.stateId, stateId), eq(journalEntries.seq, seq)));
  if (!row) {
    // A code of its own, so clients can tell "no such entry" from "no such state" (not_found).
    throw new ApiError(404, "journal_entry_not_found", `State "${stateId}" has no journal entry #${seq}.`);
  }
  return row;
}

/** Character count used by maxChars: Unicode code points, so an excerpt never splits a surrogate pair. */
export function excerpt(body: string, maxChars: number | undefined): { body: string; truncated: boolean; totalChars: number } {
  // Callers only read totalChars when maxChars is set, so skip counting otherwise.
  if (maxChars === undefined) return { body, truncated: false, totalChars: body.length };
  const chars = Array.from(body);
  if (chars.length <= maxChars) return { body, truncated: false, totalChars: chars.length };
  return { body: chars.slice(0, maxChars).join(""), truncated: true, totalChars: chars.length };
}

/** The fence of a code block left open at the end of `text` (CommonMark: closed by the same character, at least as long). */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (open === undefined) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = undefined;
  }
  return open;
}

/** One journal entry as Markdown. With maxChars, a longer body is cut and the cut is stated with where to read it all. */
export function journalEntryMarkdown(stateId: string, e: JournalEntry, maxChars?: number): string {
  // Counted on the stored body, like the JSON response, so both report the same totalChars.
  const x = excerpt(e.body, maxChars);
  let text = x.body.trim();
  // A cut inside a fenced code block would leave it open and swallow the notice and the next entries.
  if (x.truncated) {
    const fence = openFence(text);
    if (fence) text += `\n${fence}`;
  }
  const lines = [`### #${e.seq} ${e.kind} by ${e.actor} at ${e.createdAt}`, "", text];
  if (x.truncated) {
    lines.push(
      "",
      `_[Truncated: showing ${maxChars} of ${x.totalChars} characters. Read the whole entry with ` +
        `GET /api/states/${encodeURIComponent(stateId)}/journal/${e.seq} (CLI: \`dura journal ${e.seq}\`, MCP: get_journal_entry).]_`,
    );
  }
  return lines.join("\n");
}

/** A page of entries, newest first, for the web UI. The REST API keeps the oldest-first `listJournal`. */
// Offset paging shifts when entries are appended while someone is paging, so an entry can show on two pages.
// The UI pages by number (?jpage=), which is fine for reading; a seq cursor (seq < before) would avoid the shift.
export async function journalPage(
  db: DB,
  stateId: string,
  opts: { limit: number; offset: number },
): Promise<JournalEntry[]> {
  return db
    .select()
    .from(journalEntries)
    .where(eq(journalEntries.stateId, stateId))
    .orderBy(desc(journalEntries.seq))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function countJournal(db: DB, stateId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(journalEntries).where(eq(journalEntries.stateId, stateId));
  return row?.n ?? 0;
}

export async function lastJournalSeq(db: DB, stateId: string): Promise<number> {
  const [row] = await db
    .select({ seq: max(journalEntries.seq) })
    .from(journalEntries)
    .where(eq(journalEntries.stateId, stateId));
  return row?.seq ?? 0;
}

/** Append-only, so concurrent writers never conflict; seq is assigned by the server. */
export async function appendJournal(
  db: DB,
  stateId: string,
  actor: string,
  kind: string,
  body: string,
): Promise<JournalEntry> {
  kind = kind.trim() || "note";
  if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(kind)) {
    throw badRequest(`Invalid kind "${kind}". Use a short lowercase word such as report, decision or note.`);
  }
  if (!body.trim()) throw badRequest("body must not be empty.");
  await getState(db, stateId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const seq = (await lastJournalSeq(db, stateId)) + 1;
    const entry = { stateId, seq, actor, kind, body, createdAt: nowIso() };
    try {
      await atomic(db, [db.insert(journalEntries).values(entry), touchState(db, stateId)]);
      return entry;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another writer took this seq; try the next one.
    }
  }
  throw new ApiError(503, "busy", "Could not append to the journal because of heavy concurrent writes. Please retry.");
}

// ---------------------------------------------------------------------------
// Journal summary: what a new session reads instead of the whole journal.

export async function findSummary(db: DB, stateId: string): Promise<JournalSummary | undefined> {
  const [row] = await db.select().from(journalSummaries).where(eq(journalSummaries.stateId, stateId));
  return row;
}

export async function getSummary(db: DB, stateId: string): Promise<JournalSummary> {
  await getState(db, stateId);
  const row = await findSummary(db, stateId);
  if (!row) {
    // A code of its own, so clients can tell "no summary yet" from "no such state" (not_found).
    throw new ApiError(
      404,
      "summary_not_found",
      `State "${stateId}" has no journal summary yet. Read the journal from the start (after=0), ` +
        `then write one with PUT /api/states/${stateId}/summary.`,
    );
  }
  return row;
}

function summaryConflict(stateId: string, sent: number, current: JournalSummary | undefined): ApiError {
  return versionConflict(
    "the journal summary",
    `Re-read it with GET /api/states/${stateId}/summary, read the journal after its coveredThroughSeq, ` +
      `merge your summary into it`,
    sent,
    current,
  );
}

export async function listSummaryRevisions(db: DB, stateId: string): Promise<JournalSummaryRevision[]> {
  await getSummary(db, stateId);
  return db
    .select()
    .from(journalSummaryRevisions)
    .where(eq(journalSummaryRevisions.stateId, stateId))
    .orderBy(desc(journalSummaryRevisions.version));
}

/**
 * Writes the journal summary and the journal seq it covers, as one version.
 * expectedVersion works as in putSection: 0 = must not exist yet, null = no If-Match (only allowed when creating).
 * coveredThroughSeq is never moved by the server: the writer states which entries the content reflects,
 * so entries appended while the summary was being written are not skipped by the next session.
 */
export async function putSummary(
  db: DB,
  stateId: string,
  input: { content: string; coveredThroughSeq: number },
  expectedVersion: number | null,
  actor: string,
): Promise<JournalSummary> {
  const { content, coveredThroughSeq } = input;
  if (!Number.isSafeInteger(coveredThroughSeq) || coveredThroughSeq < 0) {
    throw badRequest("coveredThroughSeq must be a non-negative integer: the last journal seq the summary reflects.");
  }
  if (!content.trim()) throw badRequest("content must not be empty.");
  await getState(db, stateId);
  const current = await findSummary(db, stateId);
  if (expectedVersion === null) {
    if (current) throw versionRequired("The journal summary", current);
    expectedVersion = 0;
  }
  if ((current?.version ?? 0) !== expectedVersion) throw summaryConflict(stateId, expectedVersion, current);
  const lastSeq = await lastJournalSeq(db, stateId);
  if (coveredThroughSeq > lastSeq) {
    throw new ApiError(
      422,
      "seq_out_of_range",
      `coveredThroughSeq ${coveredThroughSeq} is beyond the last journal seq ${lastSeq}. ` +
        `Set it to the last seq you actually read and reflected in the summary.`,
      { lastSeq },
    );
  }

  const version = expectedVersion + 1;
  const ts = nowIso();
  try {
    // As in putSection, claiming the revision row is the lock, and everything is written together.
    await atomic(db, [
      db
        .insert(journalSummaryRevisions)
        .values({ stateId, version, content, coveredThroughSeq, updatedBy: actor, createdAt: ts }),
      db
        .insert(journalSummaries)
        .values({ stateId, content, coveredThroughSeq, version, updatedBy: actor, updatedAt: ts })
        .onConflictDoUpdate({
          target: journalSummaries.stateId,
          set: { content, coveredThroughSeq, version, updatedBy: actor, updatedAt: ts },
        }),
      touchState(db, stateId),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw summaryConflict(stateId, expectedVersion, await findSummary(db, stateId));
    throw err;
  }
  return (await findSummary(db, stateId))!;
}

// ---------------------------------------------------------------------------
// Markdown export: everything an agent needs to resume work, in one document.

export function renderStateMarkdown(
  state: State,
  secs: Section[],
  journal: JournalEntry[],
  after: number,
  summary?: JournalSummary,
  maxChars?: number,
): string {
  const lines: string[] = [];
  lines.push(`# ${state.title}`, "");
  lines.push(`- id: ${state.id}`);
  lines.push(`- status: ${state.status}`);
  lines.push(`- updated: ${state.updatedAt}`);
  if (state.statusNote) lines.push("", "## Status note", "", state.statusNote.trim());
  lines.push("");
  if (summary) {
    lines.push("## Journal summary", "");
    lines.push(
      `<!-- version: ${summary.version}, covers journal through #${summary.coveredThroughSeq}, ` +
        `updated by ${summary.updatedBy} at ${summary.updatedAt} -->`,
      "",
    );
    lines.push(summary.content.trim() || "_(empty)_", "");
    lines.push(
      `_This summary reflects the journal through #${summary.coveredThroughSeq}. ` +
        `To resume, read only the entries after it (after=${summary.coveredThroughSeq})._`,
      "",
    );
  }
  if (secs.length === 0) {
    lines.push("_No sections yet._", "");
  }
  for (const s of secs) {
    lines.push(`## Section: ${s.name}`, "");
    lines.push(`<!-- version: ${s.version}, updated by ${s.updatedBy} at ${s.updatedAt} -->`, "");
    lines.push(s.content.trim() || "_(empty)_", "");
  }
  lines.push(after > 0 ? `## Journal (after #${after})` : "## Journal", "");
  if (journal.length === 0) lines.push("_No entries._", "");
  for (const e of journal) lines.push(journalEntryMarkdown(state.id, e, maxChars), "");
  const last = journal.at(-1)?.seq ?? after;
  lines.push("---", "", `Last journal seq: ${last}. Next time, read only newer entries with after=${last}.`, "");
  return lines.join("\n");
}
