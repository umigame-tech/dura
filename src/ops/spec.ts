/**
 * Every operation of dura, described once. The REST API registers its routes from this list, and the
 * CLI and the MCP server build their commands and tools from it, so a new operation or parameter
 * reaches all three by being added here (test/ops.test.ts checks that nothing is left out).
 *
 * This file must stay free of imports: the CLI is bundled on its own and must not pull in server code.
 */

export const STATUSES = ["active", "waiting", "completed", "abandoned"] as const;

/** Page sizes of the journal. The store applies them; the spec tells clients. */
export const JOURNAL_LIMIT = { default: 200, max: 1000 } as const;
export const SEARCH_LIMIT = { default: 20, max: 100 } as const;

export type ParamType = "string" | "integer" | "boolean" | "record";

export interface CliParam {
  /** Flag name without the dashes. Default: the param name in kebab case. */
  readonly flag?: string;
  /** Take the value from the positional arguments after the command; "rest" joins all of them. */
  readonly positional?: true | "rest";
  /** How "rest" joins the words: with spaces, or quoting a word that has spaces so it stays a phrase. */
  readonly join?: "words" | "phrases";
  /** Read the value from --file or stdin (after positional arguments, if any). */
  readonly stdin?: true;
  /** The value is the state id from --state / $DURA_STATE. */
  readonly state?: true;
  /** Placeholder in the help, e.g. "<seq>". */
  readonly label?: string;
  /** Help for the flag. Default: the param description. */
  readonly help?: string;
  /** Overrides `required` for the CLI. */
  readonly required?: boolean;
  /** A record flag: repeatable `--flag name=<file>`, each file read into the record. */
  readonly files?: true;
}

export interface McpParam {
  /** Argument name. Default: the param name. */
  readonly name?: string;
  /** Overrides `required` for MCP. */
  readonly required?: boolean;
}

export interface Param {
  /** The name in the HTTP request: path segment, query parameter or JSON field. */
  readonly name: string;
  readonly type: ParamType;
  /** "ifMatch" is the version sent as If-Match. */
  readonly in: "path" | "query" | "body" | "ifMatch";
  readonly required?: boolean;
  /** JSON null is accepted (and passed on as null). */
  readonly nullable?: boolean;
  readonly default?: string | number | boolean;
  readonly enum?: readonly string[];
  /** Checked by the server. */
  readonly minimum?: number;
  /** Told to clients; the server clamps larger values. */
  readonly maximum?: number;
  /** A blank string counts as not given. */
  readonly omitBlank?: boolean;
  /** Clients reject a blank value before sending. */
  readonly nonBlank?: boolean;
  readonly description: string;
  readonly cli?: CliParam;
  readonly mcp?: McpParam;
}

export interface Operation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH";
  /** Path under /api. Path params are `:name`. */
  readonly path: string;
  /** public: no token. token: any valid token. read / write: the state in the path. create: write without a state. */
  readonly auth: "public" | "token" | "read" | "write" | "create";
  /** Whether `Accept: text/markdown` gives Markdown ("only": nothing else). */
  readonly markdown: "yes" | "no" | "only";
  /** One line for the endpoint list of the guide. */
  readonly doc: string;
  readonly params: readonly Param[];
  /** When the request body is not JSON, the whole body is this param; the other body params come from the query. */
  readonly rawBody?: string;
  /** At most one of these params may be given. */
  readonly exclusive?: readonly string[];
  /** At least one of these params must be given. */
  readonly anyOf?: readonly string[];
  /** The server's message when none of `anyOf` is given. */
  readonly anyOfMessage?: string;
  /**
   * How the CLI and MCP offer the operation: one command and one tool, or several that each take some
   * of the params (e.g. PATCH /states/:id as `dura status` and `dura title`). Together they take every param.
   */
  readonly cli: CliCommand | readonly CliCommand[];
  readonly mcp: McpTool | readonly McpTool[];
}

export interface CliCommand {
  readonly command: string;
  readonly summary: string;
  /** The params this command takes (default: all). */
  readonly params?: readonly string[];
}

export interface McpTool {
  readonly tool: string;
  readonly description: string;
  /** The params this tool takes (default: all). */
  readonly params?: readonly string[];
}

const list = <T extends object>(v: T | readonly T[]): readonly T[] => (Array.isArray(v) ? (v as readonly T[]) : [v as T]);

/** The CLI commands of an operation, each with its params. */
export const cliCommands = (op: Operation) =>
  list(op.cli).map((c) => ({ ...c, params: op.params.filter((p) => !c.params || c.params.includes(p.name)) }));

/** The MCP tools of an operation, each with its params. */
export const mcpTools = (op: Operation) =>
  list(op.mcp).map((t) => ({ ...t, params: op.params.filter((p) => !t.params || t.params.includes(p.name)) }));

const stateId = {
  name: "id",
  type: "string",
  in: "path",
  required: true,
  description: "State id",
  cli: { state: true },
  mcp: { name: "state" },
} as const satisfies Param;

const sectionName = {
  name: "name",
  type: "string",
  in: "path",
  required: true,
  description: "Section name, e.g. goal, plan, design, tasks",
  cli: { positional: true, label: "<name>" },
} as const satisfies Param;

const after = {
  name: "after",
  type: "integer",
  in: "query",
  description: "Only journal entries after this seq (default 0). Omit it when you pass before",
  cli: { label: "<seq>", help: "only entries after this seq" },
} as const satisfies Param;

const before = {
  name: "before",
  type: "integer",
  in: "query",
  description: "Only the newest journal entries before this seq (a large value gives the latest). Not with after",
  cli: { label: "<seq>", help: "the newest entries before this seq (a large value gives the latest)" },
} as const satisfies Param;

const limit = {
  name: "limit",
  type: "integer",
  in: "query",
  minimum: 1,
  maximum: JOURNAL_LIMIT.max,
  description: `At most this many journal entries (default ${JOURNAL_LIMIT.default})`,
  cli: { label: "<n>", help: "at most n entries" },
} as const satisfies Param;

const maxChars = {
  name: "maxChars",
  type: "integer",
  in: "query",
  minimum: 1,
  description:
    "Cut journal bodies longer than this many characters; the cut is marked with the length and get_journal_entry reads the whole entry",
  cli: { label: "<n>", help: "cut longer entry bodies to n characters (the cut is marked)" },
} as const satisfies Param;

const revisionChars = {
  name: "maxChars",
  type: "integer",
  in: "query",
  minimum: 1,
  description: "In Markdown, cut each version longer than this many characters; the cut is marked (JSON always has the whole text)",
  cli: { label: "<n>", help: "cut each version to n characters (the cut is marked)" },
} as const satisfies Param;

const version = (what: string, required = false) =>
  ({
    name: "version",
    type: "integer",
    in: "ifMatch",
    required,
    description: `The ${what} version you read`,
    cli: { label: "<n>", help: "the version you read" },
  }) as const satisfies Param;

const status = {
  name: "status",
  type: "string",
  in: "body",
  enum: STATUSES,
  description: "The new status",
} as const satisfies Param;

export const OPERATIONS = {
  guide: {
    method: "GET",
    path: "/guide",
    auth: "public",
    markdown: "only",
    doc: "this document",
    params: [],
    cli: { command: "guide", summary: "Print the usage guide served by the server (no token needed)" },
    mcp: {
      tool: "get_guide",
      description: "Read the usage guide served by this dura server: the model, the reading procedure, the CLI, the REST API and every endpoint.",
    },
  },
  listStates: {
    method: "GET",
    path: "/states",
    auth: "token",
    markdown: "yes",
    doc: "list states",
    params: [
      {
        name: "status",
        type: "string",
        in: "query",
        enum: STATUSES,
        omitBlank: true,
        description: "Only states with this status",
        cli: { label: "<status>", help: "only states with this status" },
      },
    ],
    cli: { command: "list", summary: "List the states the token can read" },
    mcp: { tool: "list_states", description: "List the states this token can read, with their status and status note." },
  },
  createState: {
    method: "POST",
    path: "/states",
    auth: "create",
    markdown: "no",
    doc: "create a state",
    params: [
      {
        name: "id",
        type: "string",
        in: "body",
        description: "State id: lowercase letters, digits, - and _ (default: made from the title)",
        cli: { label: "<id>", help: "the new state id (default: made from the title)" },
      },
      { name: "title", type: "string", in: "body", required: true, description: "Title", cli: { label: "<text>", help: "the title" } },
      { ...status, description: "Initial status (default: active)", cli: { label: "<status>", help: "the initial status (default: active)" } },
      {
        name: "statusNote",
        type: "string",
        in: "body",
        nullable: true,
        description: "Status note",
        cli: { flag: "note", label: "<text>", help: "the status note" },
        mcp: { name: "note" },
      },
      {
        name: "sections",
        type: "record",
        in: "body",
        description: "Initial sections: section name to Markdown, e.g. {\"goal\": \"...\"}",
        cli: { flag: "section", files: true, label: "<name>=<file>", help: "an initial section read from a file (repeatable)" },
      },
    ],
    cli: { command: "create", summary: "Create a state (--title, optionally --id, --status, --note, --section)" },
    mcp: {
      tool: "create_state",
      description:
        "Create a state with a title and, optionally, an id, status, status note and initial sections (e.g. goal). Ask the user before creating one.",
    },
  },
  showState: {
    method: "GET",
    path: "/states/:id",
    auth: "read",
    markdown: "yes",
    doc: "state, summary, sections and journal",
    params: [stateId, after, limit, maxChars],
    cli: { command: "show", summary: "Print the state: every section and the journal (Markdown)" },
    mcp: {
      tool: "show_state",
      description:
        "Read a state as Markdown: status, every section with its version, and journal entries after `after` (oldest first). The output ends with the last journal seq; pass it as `after` next time.",
    },
  },
  readJournal: {
    method: "GET",
    path: "/states/:id/journal",
    auth: "read",
    markdown: "yes",
    doc: "journal entries",
    params: [stateId, after, before, limit, maxChars],
    exclusive: ["after", "before"],
    cli: { command: "journal", summary: "Print journal entries after --after, or the newest before --before" },
    mcp: {
      tool: "read_journal",
      description:
        "Read journal entries after `after`, oldest first. If the page holds as many entries as `limit`, call again with the last seq shown. " +
        "With `before` instead, read the newest `limit` entries before that seq (still oldest first); if older entries remain, the output says so and gives the next `before`.",
    },
  },
  getJournalEntry: {
    method: "GET",
    path: "/states/:id/journal/:seq",
    auth: "read",
    markdown: "yes",
    doc: "one whole entry",
    params: [
      stateId,
      { name: "seq", type: "integer", in: "path", required: true, minimum: 1, description: "Journal seq", cli: { positional: true, label: "<seq>" } },
    ],
    cli: { command: "journal", summary: "Print one whole journal entry" },
    mcp: { tool: "get_journal_entry", description: "Read one whole journal entry by its seq, e.g. one that read_journal or show_state cut with maxChars." },
  },
  searchJournal: {
    method: "GET",
    path: "/states/:id/journal/search",
    auth: "read",
    markdown: "yes",
    doc: "search the journal, newest first",
    params: [
      stateId,
      {
        name: "q",
        type: "string",
        in: "query",
        omitBlank: true,
        description: "Keywords separated by spaces; all must occur",
        cli: { positional: "rest", join: "phrases", label: "[keywords...]" },
      },
      {
        name: "kind",
        type: "string",
        in: "query",
        omitBlank: true,
        description: "Only entries of this kind, e.g. decision",
        cli: { label: "<kind>", help: "only entries of this kind" },
      },
      { ...before, description: "Only matches with seq below this (the next page)" },
      { ...limit, maximum: SEARCH_LIMIT.max, description: `At most this many matches (default ${SEARCH_LIMIT.default})` },
      maxChars,
    ],
    anyOf: ["q", "kind"],
    anyOfMessage: "Pass q (keywords) and/or kind to search the journal.",
    cli: { command: "search", summary: "Search the journal, newest first (every keyword must occur; --kind filters)" },
    mcp: {
      tool: "search_journal",
      description:
        "Search past journal entries of a state, newest first: every keyword in `q` must occur in the body (\"double quotes\" keep a phrase; ASCII letters ignore case), and `kind` filters by kind. " +
        "If more matches remain, the output gives the next `before`. Search finds past decisions; it does not replace reading the journal after the summary's covered seq.",
    },
  },
  getSection: {
    method: "GET",
    path: "/states/:id/sections/:name",
    auth: "read",
    markdown: "yes",
    doc: "one section",
    params: [stateId, sectionName],
    cli: { command: "section get", summary: "Print a section (its version goes to stderr)" },
    mcp: { tool: "get_section", description: "Read one section as Markdown, with the version to pass when you write it." },
  },
  putSection: {
    method: "PUT",
    path: "/states/:id/sections/:name",
    auth: "write",
    markdown: "no",
    doc: "write a whole section",
    params: [
      stateId,
      sectionName,
      { name: "content", type: "string", in: "body", required: true, description: "Markdown", cli: { stdin: true } },
      version("section"),
    ],
    rawBody: "content",
    cli: { command: "section put", summary: "Write a whole section from stdin or --file" },
    mcp: {
      tool: "put_section",
      description:
        "Write a whole section. Omit `version` only to create a new section; to overwrite, pass the version you read. Prefer replace_in_section for partial edits so nothing gets dropped.",
    },
  },
  replaceInSection: {
    method: "POST",
    path: "/states/:id/sections/:name/replace",
    auth: "write",
    markdown: "no",
    doc: "replace text in a section",
    params: [
      stateId,
      sectionName,
      version("section", true),
      { name: "old", type: "string", in: "body", required: true, description: "Exact text to replace", cli: { label: "<text>", help: "text to replace (must occur once)" } },
      { name: "new", type: "string", in: "body", required: true, description: "Replacement text", cli: { label: "<text>", help: "replacement text" } },
      { name: "replaceAll", type: "boolean", in: "body", description: "Replace every occurrence", cli: { flag: "all", help: "replace every occurrence" } },
    ],
    cli: { command: "section replace", summary: "Replace --old with --new in a section" },
    mcp: {
      tool: "replace_in_section",
      description: "Replace `old` with `new` in a section. `old` must occur exactly once unless replaceAll is true. Pass the version you read.",
    },
  },
  listSectionRevisions: {
    method: "GET",
    path: "/states/:id/sections/:name/revisions",
    auth: "read",
    markdown: "yes",
    doc: "every version of a section, newest first",
    params: [stateId, sectionName, revisionChars],
    cli: { command: "section revisions", summary: "Print every version of a section, newest first" },
    mcp: {
      tool: "list_section_revisions",
      description: "Read every version of a section, newest first, with who wrote each and when. Use it to see what changed or to recover dropped text.",
    },
  },
  getSummary: {
    method: "GET",
    path: "/states/:id/summary",
    auth: "read",
    markdown: "yes",
    doc: "journal summary and its coveredThroughSeq",
    params: [stateId],
    cli: { command: "summary get", summary: "Print the journal summary (its version and covered seq go to stderr)" },
    mcp: {
      tool: "get_summary",
      description:
        "Read the journal summary: what the journal says so far, condensed for resuming, with the journal seq it covers through. Read it, then only the journal entries after that seq.",
    },
  },
  putSummary: {
    method: "PUT",
    path: "/states/:id/summary",
    auth: "write",
    markdown: "no",
    doc: "write the journal summary",
    params: [
      stateId,
      {
        name: "content",
        type: "string",
        in: "body",
        required: true,
        description: "Markdown: current situation, key decisions, open questions, next steps",
        cli: { stdin: true },
      },
      {
        name: "coveredThroughSeq",
        type: "integer",
        in: "body",
        required: true,
        description: "The last journal seq reflected in content",
        cli: { flag: "covered", label: "<seq>", help: "the last journal seq the summary reflects" },
      },
      version("summary"),
    ],
    cli: { command: "summary put", summary: "Write the journal summary from stdin or --file, with --covered" },
    mcp: {
      tool: "put_summary",
      description:
        "Write the whole journal summary together with coveredThroughSeq, the last journal seq the summary reflects. Never set it beyond the entries you actually read. Omit `version` only to create the summary; to overwrite, pass the version you read.",
    },
  },
  listSummaryRevisions: {
    method: "GET",
    path: "/states/:id/summary/revisions",
    auth: "read",
    markdown: "yes",
    doc: "every version of the summary, newest first",
    params: [stateId, revisionChars],
    cli: { command: "summary revisions", summary: "Print every version of the journal summary, newest first" },
    mcp: {
      tool: "list_summary_revisions",
      description: "Read every version of the journal summary, newest first, each with the journal seq it covered through.",
    },
  },
  appendJournal: {
    method: "POST",
    path: "/states/:id/journal",
    auth: "write",
    markdown: "no",
    doc: "append to the journal",
    params: [
      stateId,
      {
        name: "kind",
        type: "string",
        in: "body",
        default: "note",
        description: "report | decision | note | ... (default: note)",
        cli: { label: "<kind>", help: "report | decision | note | ... (default: note)" },
      },
      {
        name: "body",
        type: "string",
        in: "body",
        required: true,
        nonBlank: true,
        description: "Markdown",
        cli: { positional: "rest", join: "words", stdin: true, label: "[message...]" },
      },
    ],
    rawBody: "body",
    cli: { command: "log", summary: "Append to the journal (message from args, stdin or --file)" },
    mcp: {
      tool: "append_journal",
      description:
        "Append an entry to the journal. Use kind report for work reports (what changed, the result, links, the next step) and decision for decisions.",
    },
  },
  updateState: {
    method: "PATCH",
    path: "/states/:id",
    auth: "write",
    markdown: "no",
    doc: "change the title, status or status note",
    params: [
      stateId,
      {
        name: "title",
        type: "string",
        in: "body",
        description: "New title",
        cli: { positional: true, required: true, label: "<title>" },
        mcp: { required: true },
      },
      { ...status, cli: { positional: true, required: true, label: "<status>" }, mcp: { required: true } },
      {
        name: "statusNote",
        type: "string",
        in: "body",
        nullable: true,
        description: "What the human should know or decide",
        cli: { flag: "note", label: "<text>", help: "what the human should know or decide" },
        mcp: { name: "note" },
      },
    ],
    cli: [
      { command: "status", summary: `Set the status: ${STATUSES.join(" | ")}`, params: ["id", "status", "statusNote"] },
      { command: "title", summary: "Change the title of the state", params: ["id", "title"] },
    ],
    mcp: [
      {
        tool: "set_status",
        description: "Set the status. waiting (with the question for the human in `note`) and completed (with a summary) notify the human.",
        params: ["id", "status", "statusNote"],
      },
      { tool: "set_title", description: "Change the title of the state.", params: ["id", "title"] },
    ],
  },
} as const satisfies Record<string, Operation>;

export type OperationId = keyof typeof OPERATIONS;

export const operations = (): [OperationId, Operation][] => Object.entries(OPERATIONS) as [OperationId, Operation][];

/** Whether an operation is about the journal summary (its errors get summary hints in the CLI and MCP). */
export const isSummaryOperation = (op: Operation) => op.path.includes("/summary");

/** The CLI flag of a param. */
export const flagOf = (p: Param) => p.cli?.flag ?? p.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The MCP argument name of a param. */
export const argOf = (p: Param) => p.mcp?.name ?? p.name;

/** Path with its params filled in (each value is encoded as one segment). */
export function fillPath(op: Operation, values: Record<string, string | number>): string {
  return op.path.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(String(values[name])));
}

/** The query string of the given params, in the order the operation lists them. */
export function queryString(op: Operation, values: Record<string, unknown>): string {
  const pairs = op.params
    .filter((p) => p.in === "query" && values[p.name] !== undefined)
    .map((p) => [p.name, String(values[p.name])] as [string, string]);
  return pairs.length ? `?${new URLSearchParams(pairs)}` : "";
}

const TYPE_NAMES = { string: "a string", integer: "a non-negative integer", boolean: "a boolean", record: "an object of strings" };

/** "a string", "a non-negative integer or null", ... */
export const typeName = (p: Param) => `${TYPE_NAMES[p.type]}${p.nullable ? " or null" : ""}`;

/** Whether a JSON value has the param's type (null is checked by the caller). */
export function hasType(p: Param, v: unknown): boolean {
  switch (p.type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    case "boolean":
      return typeof v === "boolean";
    case "record":
      return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
  }
}

/** The If-Match header for the version param, if one was given. */
export function ifMatchHeader(op: Operation, values: Record<string, unknown>): Record<string, string> {
  const p = op.params.find((x) => x.in === "ifMatch");
  return p && values[p.name] !== undefined ? { "If-Match": String(values[p.name]) } : {};
}

/** The JSON body of the given params, or undefined when the operation has none. */
export function jsonBody(op: Operation, values: Record<string, unknown>): string | undefined {
  const fields = op.params.filter((p) => p.in === "body");
  if (fields.length === 0) return undefined;
  return JSON.stringify(Object.fromEntries(fields.filter((p) => values[p.name] !== undefined).map((p) => [p.name, values[p.name]])));
}
