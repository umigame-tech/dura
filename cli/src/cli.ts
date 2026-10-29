import { parseArgs } from "node:util";
import { version } from "../package.json";

/** Everything the CLI touches outside itself, so tests can run it against an in-process app. */
export interface Io {
  env: Record<string, string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  readStdin: () => Promise<string>;
  readFile: (path: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const VERSION = version;

const STATUSES = ["active", "waiting", "completed", "abandoned"];

const USAGE = `Usage: dura <command> [options]

Commands:
  show                          Print the state: every section and the journal (Markdown)
  list                          List the states the token can read
  section get <name>            Print a section (its version goes to stderr)
  section put <name>            Write a whole section from stdin or --file
  section replace <name>        Replace --old with --new in a section
  log [message...]              Append to the journal (message from args, stdin or --file)
  journal                       Print journal entries after --after
  status <status>               Set the status: ${STATUSES.join(" | ")}
  guide                         Print the usage guide served by the server

Options:
  -s, --state <id>              State id (default: $DURA_STATE)
      --after <seq>             show / journal: only entries after this seq
      --limit <n>               show / journal: at most n entries
      --version <n>             section put / replace: the version you read
      --file <path>             section put / log: read the body from a file
      --old <text>              section replace: text to replace (must occur once)
      --new <text>              section replace: replacement text
      --all                     section replace: replace every occurrence
      --kind <kind>             log: report | decision | note | ... (default: note)
      --note <text>             status: what the human should know or decide
      --status <status>         list: only states with this status
      --json                    Print the JSON response instead of Markdown
  -h, --help                    Show this help
  -V                            Show the CLI version

Environment:
  DURA_URL                      Server URL, e.g. https://dura.example.com
  DURA_TOKEN                    Bearer token (only read from the environment)
  DURA_STATE                    Default state id
`;

export class CliError extends Error {}

interface Config {
  url: string;
  token: string;
}

/** Reads DURA_URL and DURA_TOKEN. The token is never taken from flags so it stays out of shell history. */
export function loadConfig(env: Io["env"]): Config {
  const url = env.DURA_URL?.trim();
  const token = env.DURA_TOKEN?.trim();
  const missing = [!url && "DURA_URL", !token && "DURA_TOKEN"].filter(Boolean);
  if (missing.length > 0) {
    throw new CliError(`${missing.join(" and ")} must be set in the environment.`);
  }
  if (!/^https?:\/\//.test(url!)) throw new CliError(`DURA_URL must start with http:// or https:// (got ${url}).`);
  return { url: url!.replace(/\/+$/, ""), token: token! };
}

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError(`--${name} must be a non-negative integer.`);
  return Number(value);
}

function query(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : "";
}

interface ApiErrorBody {
  code: string;
  message: string;
  currentVersion?: number;
}

class Client {
  constructor(
    private readonly config: Config,
    private readonly io: Io,
  ) {}

  async request(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
    const url = `${this.config.url}/api${path}`;
    let res: Response;
    try {
      res = await this.io.fetch(url, {
        method,
        body: init.body,
        headers: { Authorization: `Bearer ${this.config.token}`, ...init.headers },
      });
    } catch (err) {
      const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new CliError(`Could not reach ${this.config.url}: ${cause}`);
    }
    const text = await res.text();
    if (!res.ok) throw new ResponseError(res.status, parseError(res.status, text));
    return { res, text };
  }
}

class ResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}

function parseError(status: number, text: string): ApiErrorBody {
  try {
    const json = JSON.parse(text) as { error?: ApiErrorBody };
    if (json.error?.code) return json.error;
  } catch {
    // Not JSON: the Markdown error format, a proxy, or a misconfigured URL.
  }
  const md = /^Error \(([a-z_]+)\): ([\s\S]*)$/.exec(text.trim());
  if (md) return { code: md[1]!, message: md[2]! };
  return { code: `http_${status}`, message: text.trim().slice(0, 500) || `HTTP ${status} with an empty body.` };
}

/** What to do next, phrased for the CLI instead of raw HTTP. */
function hint(err: ResponseError, ctx: { command: string; name?: string; stateId?: string }): string | undefined {
  const get = ctx.name ? `dura section get ${ctx.name}` : undefined;
  switch (err.body.code) {
    case "version_conflict":
      return `Run \`${get}\`, re-apply your change to the latest content, and retry with --version ${err.body.currentVersion ?? "<new version>"}.`;
    case "precondition_required":
      return err.body.currentVersion !== undefined
        ? `The section already exists. Read it with \`${get}\` and pass --version ${err.body.currentVersion}.`
        : "Pass --version with the version you read.";
    case "old_not_found":
    case "old_not_unique":
      return `Run \`${get}\` and copy the text to replace exactly, with enough surrounding text to be unique (or pass --all).`;
    case "unauthorized":
      return "Check DURA_TOKEN: it may be missing, mistyped or revoked.";
    case "forbidden":
      return "The token lacks the permission (read-only, or limited to other states).";
    case "not_found":
      if (ctx.name) return `\`dura show\` lists the sections of ${ctx.stateId}; \`section put\` without --version creates one.`;
      return ctx.stateId ? `Check the state id (${ctx.stateId}); \`dura list\` shows the states you can read.` : undefined;
  }
  return undefined;
}

const MD = { Accept: "text/markdown" };

const OPTIONS = {
  state: { type: "string", short: "s" },
  after: { type: "string" },
  limit: { type: "string" },
  version: { type: "string" },
  file: { type: "string" },
  old: { type: "string" },
  new: { type: "string" },
  all: { type: "boolean" },
  kind: { type: "string" },
  note: { type: "string" },
  status: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "cli-version": { type: "boolean", short: "V" },
} as const;

/**
 * Joins `--old "- [ ] a"` into `--old=- [ ] a`. parseArgs rejects option values that start
 * with "-", but Markdown list items are exactly what --old / --new usually carry.
 */
function joinStringOptions(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.startsWith("--") ? arg.slice(2) : undefined;
    const opt = name !== undefined ? (OPTIONS as Record<string, { type: string }>)[name] : undefined;
    if (opt?.type === "string" && i + 1 < argv.length) out.push(`${arg}=${argv[++i]}`);
    else out.push(arg);
  }
  return out;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: joinStringOptions(argv), allowPositionals: true, options: OPTIONS });
  } catch (err) {
    io.stderr(`dura: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (opts["cli-version"]) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (opts.help || !command || command === "help") {
    io.stdout(USAGE);
    return command || opts.help ? 0 : 2;
  }

  const ctx: { command: string; name?: string; stateId?: string } = { command };
  try {
    const client = new Client(loadConfig(io.env), io);
    const stateId = () => {
      const id = (opts.state ?? io.env.DURA_STATE)?.trim();
      if (!id) throw new CliError("No state given. Pass --state <id> or set DURA_STATE.");
      ctx.stateId = id;
      return encodeURIComponent(id);
    };
    const body = async () => (opts.file !== undefined ? io.readFile(opts.file) : io.readStdin());
    const print = (text: string) => io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    const accept = opts.json ? {} : MD;

    switch (command) {
      case "show": {
        const q = query({ after: intOption(opts.after, "after"), limit: intOption(opts.limit, "limit") });
        print((await client.request("GET", `/states/${stateId()}${q}`, { headers: accept })).text);
        return 0;
      }
      case "list": {
        print((await client.request("GET", `/states${query({ status: opts.status })}`, { headers: accept })).text);
        return 0;
      }
      case "journal": {
        const q = query({ after: intOption(opts.after, "after"), limit: intOption(opts.limit, "limit") });
        print((await client.request("GET", `/states/${stateId()}/journal${q}`, { headers: accept })).text);
        return 0;
      }
      case "guide": {
        if (opts.json) throw new CliError("guide is only available as Markdown; drop --json.");
        print((await client.request("GET", "/guide")).text);
        return 0;
      }
      case "section":
        return await section(client, rest, opts, { stateId, body, print, ctx, io });
      case "log": {
        const text = rest.length > 0 ? rest.join(" ") : await body();
        if (!text.trim()) throw new CliError("The journal entry is empty. Pass a message, --file, or pipe it on stdin.");
        const kind = opts.kind ?? "note";
        const { text: res } = await client.request("POST", `/states/${stateId()}/journal`, {
          body: JSON.stringify({ kind, body: text }),
          headers: { "Content-Type": "application/json" },
        });
        if (opts.json) print(res);
        else io.stderr(`Appended ${kind} #${(JSON.parse(res) as { entry: { seq: number } }).entry.seq}.\n`);
        return 0;
      }
      case "status": {
        const status = rest[0];
        if (!status || !STATUSES.includes(status)) {
          throw new CliError(`status must be one of ${STATUSES.join(", ")}.`);
        }
        const payload: { status: string; statusNote?: string } = { status };
        if (opts.note !== undefined) payload.statusNote = opts.note;
        const { text: res } = await client.request("PATCH", `/states/${stateId()}`, {
          body: JSON.stringify(payload),
          headers: { "Content-Type": "application/json" },
        });
        if (opts.json) print(res);
        else io.stderr(`Status of ${ctx.stateId} is now ${status}.\n`);
        return 0;
      }
      default:
        throw new CliError(`Unknown command "${command}". Run \`dura --help\`.`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`dura: ${err.message}\n`);
      return 2;
    }
    if (err instanceof ResponseError) {
      const next = hint(err, ctx);
      io.stderr(`dura: ${err.body.code} (HTTP ${err.status}): ${err.body.message}\n${next ? `Next: ${next}\n` : ""}`);
      return 1;
    }
    throw err;
  }
}

async function section(
  client: Client,
  args: string[],
  opts: { version?: string; old?: string; new?: string; all?: boolean; json?: boolean },
  h: {
    stateId: () => string;
    body: () => Promise<string>;
    print: (text: string) => void;
    ctx: { name?: string };
    io: Io;
  },
): Promise<number> {
  const [sub, name] = args;
  if (!sub || !["get", "put", "replace"].includes(sub)) {
    throw new CliError("Use `dura section get|put|replace <name>`.");
  }
  if (!name) throw new CliError(`Missing the section name: dura section ${sub} <name>.`);
  h.ctx.name = name;
  const path = `/states/${h.stateId()}/sections/${encodeURIComponent(name)}`;
  const version = intOption(opts.version, "version");
  const ifMatch: Record<string, string> = version !== undefined ? { "If-Match": String(version) } : {};
  const written = (text: string) => {
    if (opts.json) return h.print(text);
    const s = (JSON.parse(text) as { section: { name: string; version: number } }).section;
    h.io.stderr(`Wrote section ${s.name} (version ${s.version}).\n`);
  };

  if (sub === "get") {
    if (opts.json) {
      h.print((await client.request("GET", path)).text);
      return 0;
    }
    const { res, text } = await client.request("GET", path, { headers: MD });
    h.io.stdout(text);
    h.io.stderr(`version: ${/(\d+)/.exec(res.headers.get("ETag") ?? "")?.[1] ?? "?"}\n`);
    return 0;
  }
  if (sub === "put") {
    const content = await h.body();
    written((await client.request("PUT", path, { body: content, headers: { "Content-Type": "text/markdown", ...ifMatch } })).text);
    return 0;
  }
  if (version === undefined) throw new CliError("section replace needs --version <the version you read>.");
  if (opts.old === undefined || opts.new === undefined) throw new CliError("section replace needs --old and --new.");
  const payload = JSON.stringify({ old: opts.old, new: opts.new, replaceAll: opts.all ?? false });
  written((await client.request("POST", `${path}/replace`, { body: payload, headers: { "Content-Type": "application/json", ...ifMatch } })).text);
  return 0;
}
