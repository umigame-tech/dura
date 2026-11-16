import { parseArgs } from "node:util";
import { version } from "../package.json";
import { versionFromEtag, writtenMessage } from "../../src/ops/messages";
import { cliCommands, fillPath, flagOf, ifMatchHeader, isSummaryOperation, jsonBody, operations, queryString, RESUME, type Operation, type OperationId, type Param } from "../../src/ops/spec";

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

export class CliError extends Error {}

interface Config {
  url: string;
  /** Absent only for commands that read public endpoints (guide). */
  token?: string;
}

/**
 * Reads the server URL (--url, else DURA_URL) and the token (--token-file / --token-stdin, else DURA_TOKEN).
 * The token is never taken as a flag value so it stays out of shell history.
 */
export function loadConfig(env: Io["env"], opts: { url?: string; token?: string; requireToken?: boolean } = {}): Config {
  if (opts.url !== undefined && !opts.url.trim()) throw new CliError("--url must not be empty.");
  const url = (opts.url ?? env.DURA_URL)?.trim();
  const requireToken = opts.requireToken ?? true;
  // Commands that need no token (guide) do not read one, so a malformed DURA_TOKEN cannot break them.
  const token = requireToken ? (opts.token ?? env.DURA_TOKEN)?.trim() || undefined : undefined;
  const missing = [!url && "DURA_URL (or pass --url)", requireToken && !token && "DURA_TOKEN (or pass --token-file / --token-stdin)"].filter(Boolean);
  if (missing.length > 0) throw new CliError(`Set ${missing.join(" and ")}.`);
  // An invalid header value makes fetch throw with the value in its message, so reject it here without echoing it.
  if (token && !/^[\x21-\x7e]+$/.test(token)) throw new CliError("The token contains spaces, line breaks or non-ASCII characters.");
  const source = opts.url !== undefined ? "--url" : "DURA_URL";
  if (!/^https?:\/\//.test(url!)) throw new CliError(`${source} must start with http:// or https:// (got ${url}).`);
  return { url: url!.replace(/\/+$/, ""), token };
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
        headers: { ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}), ...init.headers },
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
function hint(err: ResponseError, ctx: { summary?: boolean; name?: string; stateId?: string }): string | undefined {
  if (ctx.summary) {
    switch (err.body.code) {
      case "version_conflict":
        return (
          `Run \`dura summary get\`, read the journal after its covered seq (\`dura journal --after <seq> --limit ${RESUME.page} --max-chars ${RESUME.maxChars}\`), ` +
          `merge your summary into it, and retry with --version ${err.body.currentVersion ?? "<new version>"}.`
        );
      case "precondition_required":
        return `The summary already exists. Read it with \`dura summary get\` and pass --version ${err.body.currentVersion ?? "<its version>"}.`;
      case "seq_out_of_range":
        return "Set --covered to the last journal seq you actually read and reflected in the summary.";
      case "summary_not_found":
        return `There is no summary yet: read the journal from the start a page at a time (\`dura journal --after 0 --limit ${RESUME.page} --max-chars ${RESUME.maxChars}\`), ` +
          "and write the summary with `dura summary put --covered <last seq read>` (no --version the first time) as you go. See `dura guide`, Reading.";
      case "not_found":
        return `Check the state id (${ctx.stateId}); \`dura list\` shows the states you can read.`;
    }
  }
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
      return "Check the token (DURA_TOKEN, --token-file or --token-stdin): it may be missing, mistyped or revoked.";
    case "forbidden":
      return "The token lacks the permission (read-only, or limited to other states).";
    case "journal_entry_not_found":
      return "Check the seq: `dura journal --before 1000000000 --limit 1` prints the latest entry and its seq.";
    case "not_found":
      if (ctx.name) return `\`dura show\` lists the sections of ${ctx.stateId}; \`section put\` without --version creates one.`;
      return ctx.stateId ? `Check the state id (${ctx.stateId}); \`dura list\` shows the states you can read.` : undefined;
  }
  return undefined;
}

const MD = { Accept: "text/markdown" };

/** A CLI command made from an operation of the spec. */
interface Command {
  id: OperationId;
  op: Operation;
  /** The command words, e.g. "section get". */
  name: string;
  words: string[];
  params: Param[];
  positionals: Param[];
  flags: Param[];
  /** Reads a param from --file or stdin. */
  stdin?: Param;
  usage: string;
  summary: string;
}

const labelOf = (p: Param) => p.cli?.label ?? `<${p.name}>`;

const COMMANDS: Command[] = operations().flatMap(([id, op]) =>
  cliCommands(op).map((c): Command => {
    const positionals = c.params.filter((p) => p.cli?.positional);
    return {
      id,
      op,
      name: c.command,
      words: c.command.split(" "),
      params: [...c.params],
      positionals,
      flags: c.params.filter((p) => !p.cli?.positional && !p.cli?.state && !p.cli?.stdin),
      stdin: c.params.find((p) => p.cli?.stdin),
      usage: [c.command, ...positionals.map(labelOf)].join(" "),
      summary: c.summary,
    };
  }),
);

const GLOBAL_OPTIONS = {
  state: { type: "string", short: "s" },
  url: { type: "string" },
  "token-file": { type: "string" },
  "token-stdin": { type: "boolean" },
  file: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "cli-version": { type: "boolean", short: "V" },
} as const;

type OptionSpec = { type: "string" | "boolean"; short?: string; multiple?: boolean };

/** Every flag of every command. A flag that several commands share must have one type (test/ops.test.ts). */
export const OPTIONS: Record<string, OptionSpec> = { ...GLOBAL_OPTIONS };
for (const cmd of COMMANDS) {
  for (const p of cmd.flags) {
    OPTIONS[flagOf(p)] = { type: p.type === "boolean" ? "boolean" : "string", ...(p.cli?.files ? { multiple: true } : {}) };
  }
}

function optionHelp(): string {
  const byFlag = new Map<string, { label: string; uses: { command: string; help: string }[] }>();
  for (const cmd of COMMANDS) {
    for (const p of cmd.flags) {
      const flag = flagOf(p);
      const entry = byFlag.get(flag) ?? { label: p.type === "boolean" ? "" : ` ${labelOf(p)}`, uses: [] };
      entry.uses.push({ command: cmd.name, help: p.cli?.help ?? p.description });
      byFlag.set(flag, entry);
    }
  }
  const line = (left: string, right: string) => `  ${left.padEnd(30)}${right}\n`;
  let text = "";
  for (const [flag, { label, uses }] of byFlag) {
    const groups = new Map<string, string[]>();
    for (const u of uses) groups.set(u.help, [...(groups.get(u.help) ?? []), u.command]);
    const desc = [...groups].map(([help, cmds]) => `${[...new Set(cmds)].join(" / ")}: ${help}`).join("; ");
    text += line(`    --${flag}${label}`, desc);
  }
  const fileCommands = COMMANDS.filter((c) => c.stdin).map((c) => c.name);
  text += line("    --file <path>", `${fileCommands.join(" / ")}: read the body from a file`);
  return text;
}

const USAGE = `Usage: dura <command> [options]

Commands:
${COMMANDS.map((c) => `  ${c.usage.padEnd(30)}${c.summary}\n`).join("")}
Options:
  -s, --state <id>              State id (default: $DURA_STATE)
      --url <url>               Server URL (default: $DURA_URL)
      --token-file <path>       Read the token from a file (default: $DURA_TOKEN)
      --token-stdin             Read the token from stdin (default: $DURA_TOKEN)
${optionHelp()}      --json                    Print the JSON response instead of Markdown
  -h, --help                    Show this help
  -V                            Show the CLI version

Environment:
  DURA_URL                      Server URL, e.g. https://dura.example.com
  DURA_TOKEN                    Bearer token (never taken as a flag value, to keep it out of shell history)
  DURA_STATE                    Default state id
`;

/**
 * Joins `--old "- [ ] a"` into `--old=- [ ] a`. parseArgs rejects option values that start
 * with "-", but Markdown list items are exactly what --old / --new usually carry.
 */
function joinStringOptions(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.startsWith("--") ? arg.slice(2) : undefined;
    const opt = name !== undefined ? OPTIONS[name] : undefined;
    if (opt?.type === "string" && i + 1 < argv.length) out.push(`${arg}=${argv[++i]}`);
    else out.push(arg);
  }
  return out;
}

/** Finds the command for the positional arguments; the rest are its own positional arguments. */
function resolve(positionals: string[]): { cmd: Command; args: string[] } {
  const matches = COMMANDS.filter((c) => c.words.every((w, i) => positionals[i] === w));
  if (matches.length === 0) {
    const group = COMMANDS.filter((c) => c.words.length > 1 && c.words[0] === positionals[0]);
    if (group.length > 0) throw new CliError(`Use \`dura ${positionals[0]} ${group.map((c) => c.words[1]).join("|")}\`.`);
    throw new CliError(`Unknown command "${positionals[0]}". Run \`dura --help\`.`);
  }
  const longest = Math.max(...matches.map((c) => c.words.length));
  const cands = matches.filter((c) => c.words.length === longest);
  const args = positionals.slice(longest);
  const fits = (c: Command) => c.positionals.some((p) => p.cli?.positional === "rest") || c.positionals.length === args.length;
  const cmd = cands.find((c) => c.positionals.length === args.length) ?? cands.find(fits) ?? (cands.length === 1 ? cands[0] : undefined);
  if (!cmd) throw new CliError(`Use ${cands.map((c) => `\`dura ${c.usage}\``).join(" or ")}.`);
  if (!fits(cmd)) {
    throw new CliError(args.length > cmd.positionals.length ? `Too many arguments: \`dura ${cmd.usage}\`.` : `Missing ${labelOf(cmd.positionals[args.length]!)}: \`dura ${cmd.usage}\`.`);
  }
  return { cmd, args };
}

/** How a param is named in CLI messages. */
const shown = (p: Param) => (p.cli?.positional ? labelOf(p) : p.cli?.stdin ? "the body (stdin or --file)" : `--${flagOf(p)}`);

function convert(p: Param, raw: string): string | number {
  if (p.type === "integer") {
    if (!/^\d+$/.test(raw)) throw new CliError(`${shown(p)} must be a non-negative integer.`);
    return Number(raw);
  }
  if (p.enum && !p.enum.includes(raw)) throw new CliError(`${p.name} must be one of ${p.enum.join(", ")}.`);
  return raw;
}

/** How a command shows a read whose headers matter (never with --json). Writes are reported by writtenMessage. */
const OUTPUT: Partial<Record<OperationId, (r: { res: Response; text: string }, io: Io, print: (text: string) => void) => void>> = {
  getSection: ({ res, text }, io) => {
    io.stdout(text);
    io.stderr(`version: ${versionFromEtag(res.headers.get("ETag"))}\n`);
  },
  getSummary: ({ res, text }, io, print) => {
    print(text);
    const covered = res.headers.get("X-Covered-Through-Seq") ?? "?";
    io.stderr(
      `version: ${versionFromEtag(res.headers.get("ETag"))}, covers journal through #${covered} ` +
        `(read on with --after ${covered} --limit ${RESUME.page} --max-chars ${RESUME.maxChars}; see \`dura guide\`, Reading)\n`,
    );
  },
};

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: joinStringOptions(argv), allowPositionals: true, options: OPTIONS });
  } catch (err) {
    // An argument that starts with "-" (e.g. a title) reads as an option unless it comes after "--".
    const dash = /Unknown option '-/.test((err as Error).message) ? `To pass an argument that starts with "-", put it after --, e.g. dura title -- "-draft".\n` : "";
    io.stderr(`dura: ${(err as Error).message}\n${dash}\n${USAGE}`);
    return 2;
  }
  const opts = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;

  if (opts["cli-version"]) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (opts.help || positionals.length === 0 || positionals[0] === "help") {
    io.stdout(USAGE);
    return positionals.length > 0 || opts.help ? 0 : 2;
  }

  const ctx: { summary?: boolean; name?: string; stateId?: string } = {};
  const str = (key: string) => opts[key] as string | undefined;
  try {
    const { cmd, args } = resolve(positionals);
    const { op } = cmd;
    ctx.summary = isSummaryOperation(op);
    const given = Object.keys(opts).filter((k) => opts[k] !== undefined && !(k in GLOBAL_OPTIONS));
    const unknown = given.find((k) => !cmd.flags.some((p) => flagOf(p) === k));
    if (unknown) throw new CliError(`\`dura ${cmd.usage}\` does not take --${unknown}.`);
    if (str("file") !== undefined && !cmd.stdin) throw new CliError(`\`dura ${cmd.usage}\` does not take --file.`);
    if (opts.json && op.markdown === "only") throw new CliError(`${cmd.name} is only available as Markdown; drop --json.`);

    if (str("token-file") !== undefined && opts["token-stdin"]) {
      throw new CliError("Pass either --token-file or --token-stdin, not both.");
    }
    // A public endpoint (guide) never gets the token, so it does not read one either (a revoked one would make it fail).
    const needsToken = op.auth !== "public";
    let token: string | undefined;
    if (!needsToken) {
      // Nothing to read.
    } else if (str("token-file") !== undefined) {
      token = (await io.readFile(str("token-file")!)).trim();
      if (!token) throw new CliError(`The token file ${str("token-file")} is empty.`);
    } else if (opts["token-stdin"]) {
      token = (await io.readStdin()).trim();
      if (!token) throw new CliError("--token-stdin read an empty token.");
    }
    const config = loadConfig(io.env, { url: str("url"), token, requireToken: needsToken });
    const client = new Client(needsToken ? config : { url: config.url }, io);

    const body = async () => {
      if (str("file") !== undefined) return io.readFile(str("file")!);
      if (opts["token-stdin"]) throw new CliError("stdin already carries the token (--token-stdin); pass the body with --file.");
      return io.readStdin();
    };

    const values: Record<string, unknown> = {};
    // The body is read last, so a missing flag is reported before the CLI waits on stdin.
    const ordered = [...cmd.params.filter((p) => !p.cli?.stdin), ...cmd.params.filter((p) => p.cli?.stdin)];
    for (const p of ordered) {
      let v: unknown;
      if (p.cli?.state) {
        const id = (str("state") ?? io.env.DURA_STATE)?.trim();
        if (!id) throw new CliError("No state given. Pass --state <id> or set DURA_STATE.");
        v = ctx.stateId = id;
      } else if (p.cli?.positional === "rest") {
        const words = args.slice(cmd.positionals.indexOf(p));
        // The shell already split the words; quote an argument with spaces so it stays one phrase.
        const joined = p.cli.join === "phrases" ? words.map((w) => (/\s/.test(w) && !w.includes('"') ? `"${w}"` : w)) : words;
        v = words.length > 0 ? joined.join(" ") : undefined;
      } else if (p.cli?.positional) {
        const raw = args[cmd.positionals.indexOf(p)];
        v = raw === undefined ? undefined : convert(p, raw);
      } else if (!p.cli?.stdin) {
        const raw = opts[flagOf(p)] as string | boolean | string[] | undefined;
        if (Array.isArray(raw)) {
          // --section goal=goal.md --section plan=plan.md
          const record: Record<string, string> = Object.create(null);
          for (const item of raw) {
            const eq = item.indexOf("=");
            if (eq <= 0) throw new CliError(`--${flagOf(p)} takes ${labelOf(p)} (got ${JSON.stringify(item)}).`);
            const name = item.slice(0, eq);
            if (name in record) throw new CliError(`--${flagOf(p)} names ${name} twice.`);
            record[name] = await io.readFile(item.slice(eq + 1));
          }
          v = record;
        } else v = typeof raw === "string" ? convert(p, raw) : raw;
      }
      if (v === undefined && p.cli?.stdin) v = await body();
      if (typeof v === "string" && p.omitBlank && !v.trim()) v = undefined;
      if (typeof v === "string" && p.nonBlank && !v.trim()) throw new CliError(`${shown(p)} is empty. Pass it as an argument, with --file, or on stdin.`);
      if (v === undefined && (p.cli?.required ?? p.required)) throw new CliError(`${cmd.name} needs ${shown(p)}${p.cli?.positional ? "" : ` ${labelOf(p)}`}.`);
      if (v !== undefined) values[p.name] = v;
    }
    if (typeof values.name === "string") ctx.name = values.name;
    const names = (list: readonly string[]) => list.map((n) => shown(cmd.params.find((p) => p.name === n)!));
    if (op.exclusive && op.exclusive.filter((n) => values[n] !== undefined).length > 1) {
      throw new CliError(`Pass either ${names(op.exclusive).join(" or ")}, not both.`);
    }
    if (op.anyOf && op.anyOf.every((n) => values[n] === undefined)) throw new CliError(`Pass ${names(op.anyOf).join(", ")}, or both.`);

    const payload = jsonBody(op, values);
    const headers = {
      ...(op.markdown === "yes" && !opts.json ? MD : {}),
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...ifMatchHeader(op, values),
    };
    const res = await client.request(op.method, `${fillPath(op, values as Record<string, string | number>)}${queryString(op, values)}`, {
      body: payload,
      headers,
    });
    const print = (text: string) => io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    const output = opts.json ? undefined : OUTPUT[cmd.id];
    const written = opts.json ? undefined : writtenMessage(cmd.id, res.text, values);
    if (output) output(res, io, print);
    else if (written) io.stderr(`${written}\n`);
    else print(res.text);
    return 0;
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
