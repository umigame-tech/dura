import { Hono, type Context } from "hono";
import { publicOrigin } from "../auth";
import type { StateStatus } from "../db/schema";
import type { AppEnv } from "../env";
import { guideMarkdown } from "../guide";
import { ApiError, badRequest } from "../lib/errors";
import { notifyStatusChange } from "../notify";
import { registerOperations, type Handlers, type Input } from "../ops/http";
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

const str = (input: Input, key: string) => input[key] as string;
const optStr = (input: Input, key: string) => input[key] as string | undefined;
const optInt = (input: Input, key: string) => input[key] as number | undefined;

const handlers: Handlers = {
  guide: (c) => markdown(c, guideMarkdown(publicOrigin(c))),

  listStates: async (c, input, actor) => {
    const ids = actor.type === "token" ? actor.stateIds : null;
    const rows = await listStates(c.get("deps").db, { ids, status: input.status as StateStatus | undefined });
    if (wantsMarkdown(c)) {
      const lines = rows.map((s) => `- **${s.id}** [${s.status}] ${s.title}${s.statusNote ? ` - ${s.statusNote.split("\n")[0]}` : ""}`);
      return markdown(c, `# States\n\n${lines.join("\n") || "_No states._"}\n`);
    }
    return c.json({ states: rows });
  },

  createState: async (c, input, actor) => {
    const state = await createState(
      c.get("deps").db,
      {
        id: optStr(input, "id"),
        title: str(input, "title"),
        status: input.status as StateStatus | undefined,
        statusNote: (input.statusNote ?? undefined) as string | undefined,
        sections: input.sections as Record<string, string> | undefined,
      },
      actor.name,
    );
    return c.json({ state }, 201);
  },

  showState: async (c, input) => {
    const id = str(input, "id");
    const { db } = c.get("deps");
    const after = optInt(input, "after") ?? 0;
    const maxChars = optInt(input, "maxChars");
    const state = await getState(db, id);
    const [sections, summary, journal] = await Promise.all([
      listSections(db, id),
      findSummary(db, id),
      listJournal(db, id, { after, limit: optInt(input, "limit") }),
    ]);
    if (wantsMarkdown(c)) return markdown(c, renderStateMarkdown(state, sections, journal, after, summary, maxChars));
    return c.json({
      state,
      summary: summary ? summaryJson(summary) : null,
      sections: sections.map(sectionJson),
      journal: journal.map((e) => journalJson(e, maxChars)),
    });
  },

  updateState: async (c, input, actor) => {
    const deps = c.get("deps");
    const patch = {
      title: optStr(input, "title"),
      status: input.status as StateStatus | undefined,
      statusNote: input.statusNote as string | null | undefined,
    };
    const { state, previous } = await updateState(deps.db, str(input, "id"), patch, actor.name);
    notifyStatusChange(deps, state, previous, actor.name, publicOrigin(c));
    return c.json({ state });
  },

  getSection: async (c, input) => {
    const section = await getSection(c.get("deps").db, str(input, "id"), str(input, "name"));
    c.header("ETag", `"${section.version}"`);
    if (wantsMarkdown(c)) return markdown(c, section.content);
    return c.json({ section: sectionJson(section) });
  },

  putSection: async (c, input, actor) => {
    const version = optInt(input, "version") ?? null;
    const section = await putSection(c.get("deps").db, str(input, "id"), str(input, "name"), str(input, "content"), version, actor.name);
    c.header("ETag", `"${section.version}"`);
    return c.json({ section: sectionJson(section) });
  },

  replaceInSection: async (c, input, actor) => {
    const edit = { old: str(input, "old"), new: str(input, "new"), replaceAll: input.replaceAll as boolean | undefined };
    const section = await replaceInSection(c.get("deps").db, str(input, "id"), str(input, "name"), edit, input.version as number, actor.name);
    c.header("ETag", `"${section.version}"`);
    return c.json({ section: sectionJson(section) });
  },

  listSectionRevisions: async (c, input) => {
    const revisions = await listRevisions(c.get("deps").db, str(input, "id"), str(input, "name"));
    return c.json({
      revisions: revisions.map((r) => ({
        version: r.version,
        content: r.content,
        updatedBy: r.updatedBy,
        createdAt: r.createdAt,
      })),
    });
  },

  getSummary: async (c, input) => {
    const summary = await getSummary(c.get("deps").db, str(input, "id"));
    c.header("ETag", `"${summary.version}"`);
    if (wantsMarkdown(c)) {
      c.header("X-Covered-Through-Seq", String(summary.coveredThroughSeq));
      return markdown(c, summary.content);
    }
    return c.json({ summary: summaryJson(summary) });
  },

  listSummaryRevisions: async (c, input) => {
    const revisions = await listSummaryRevisions(c.get("deps").db, str(input, "id"));
    return c.json({
      revisions: revisions.map((r) => ({
        version: r.version,
        content: r.content,
        coveredThroughSeq: r.coveredThroughSeq,
        updatedBy: r.updatedBy,
        createdAt: r.createdAt,
      })),
    });
  },

  putSummary: async (c, input, actor) => {
    const summary = await putSummary(
      c.get("deps").db,
      str(input, "id"),
      { content: str(input, "content"), coveredThroughSeq: input.coveredThroughSeq as number },
      optInt(input, "version") ?? null,
      actor.name,
    );
    c.header("ETag", `"${summary.version}"`);
    return c.json({ summary: summaryJson(summary) });
  },

  readJournal: async (c, input) => {
    const id = str(input, "id");
    const { db } = c.get("deps");
    const after = optInt(input, "after");
    const before = optInt(input, "before");
    const limit = optInt(input, "limit");
    const maxChars = optInt(input, "maxChars");
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
  },

  searchJournal: async (c, input) => {
    const id = str(input, "id");
    const { db } = c.get("deps");
    const q = optStr(input, "q")?.trim();
    const kind = optStr(input, "kind")?.trim();
    const before = optInt(input, "before");
    const maxChars = optInt(input, "maxChars");
    if (q !== undefined && [...q].length > SEARCH_MAX_QUERY) throw badRequest(`q must be at most ${SEARCH_MAX_QUERY} characters.`);
    const terms = q !== undefined ? searchTerms(q) : [];
    // q = '""' has no terms, so it would match everything like an empty q.
    if (terms.length === 0 && kind === undefined) throw badRequest("Pass q (keywords) and/or kind to search the journal.");
    if (terms.length > SEARCH_MAX_TERMS) throw badRequest(`q may have at most ${SEARCH_MAX_TERMS} terms.`);
    await getState(db, id);
    const { entries, nextBefore } = await searchJournal(db, id, { terms, kind, before, limit: optInt(input, "limit") });
    if (wantsMarkdown(c)) return markdown(c, searchMarkdown(id, entries, { q, kind, before, nextBefore }, maxChars));
    return c.json({ entries: entries.map((e) => journalJson(e, maxChars)), nextBefore });
  },

  getJournalEntry: async (c, input) => {
    const id = str(input, "id");
    const entry = await getJournalEntry(c.get("deps").db, id, input.seq as number);
    if (wantsMarkdown(c)) return markdown(c, `${journalEntryMarkdown(id, entry)}\n`);
    return c.json({ entry: journalJson(entry) });
  },

  appendJournal: async (c, input, actor) => {
    const entry = await appendJournal(c.get("deps").db, str(input, "id"), actor.name, str(input, "kind"), str(input, "body"));
    return c.json({ entry: journalJson(entry) }, 201);
  },
};

registerOperations(api, handlers);

api.all("*", () => {
  throw new ApiError(404, "not_found", "Unknown API endpoint. See GET /api/guide.");
});
