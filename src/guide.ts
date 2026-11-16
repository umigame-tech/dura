import { operations } from "./ops/spec";

/** Usage guide for agents, served at GET /api/guide as Markdown. */
export function guideMarkdown(origin: string): string {
  return `# dura: shared state for agent loops

dura keeps the state of a long-running task (goal, plan, design, tasks, findings...)
outside of any single agent session, so an orchestrator and its sub-agents can pick up
where the last one stopped.

Server: ${origin}

## Setup

You receive these from your prompt or environment:

- \`DURA_URL\` - the server above
- \`DURA_TOKEN\` - your bearer token. Its name is recorded as the author of everything you write.
- \`DURA_STATE\` - the id of the state you work on

The examples below use the \`dura\` CLI, which sends the bearer token for you.
Keep the token in the environment; never print it or put it in source control.
State commands use \`DURA_STATE\`; pass \`--state <id>\` to select another state.
Pass \`--url <url>\` to use another server than \`DURA_URL\`. The token is never taken as a
flag value, so it stays out of shell history: use \`DURA_TOKEN\`, or read it with
\`--token-file <path>\` or \`--token-stdin\` (then pass a body with \`--file\`).
If a required variable is missing, ask for configuration rather than guessing a state.

\`dura guide\` needs only the URL; every other command also needs \`DURA_TOKEN\`.
If the CLI is unavailable, read this public endpoint:

    curl -fsS "$DURA_URL/api/guide"

Install the CLI from npm (Node 20 or later):

    npm install -g @umigame-tech/dura

To use a locally built CLI instead, run \`npm run cli:build\` in the dura repository, then use
\`node /absolute/path/to/dura/cli/dist/dura.js\` in place of \`dura\` from any directory,
or run \`npm link ./cli\` there to make \`dura\` available on PATH.
A one-line instruction in your agent configuration can be:

    Manage work state with dura. First read $DURA_URL/api/guide, then follow its Reading procedure (summary first, then every unread journal page) before choosing work.

If your client is connected to dura over MCP (\`POST ${origin}/mcp\` with the same bearer token),
the tools map to the CLI commands below: ${toolMap()}. Pass the state id as \`state\` and
follow the same procedure.

## Model

A **state** has a status and two kinds of content:

- **Sections** (named Markdown documents such as \`goal\`, \`plan\`, \`design\`, \`tasks\`).
  They are overwritten and versioned. Every write needs the version you based it on,
  so a stale write is rejected instead of silently losing someone else's change.
  Usually only the orchestrator edits sections.
- **Journal** (append-only Markdown entries with a \`kind\` such as \`report\`, \`decision\`, \`note\`).
  Appends never conflict, so sub-agents running in parallel report here.
- **Journal summary** (optional, one per state): a Markdown summary of the journal for resuming,
  saved together with \`coveredThroughSeq\`, the last journal seq it reflects. It is versioned
  like a section. A new session reads the summary and only the journal entries after that seq.

Status is one of \`active\`, \`waiting\`, \`completed\`, \`abandoned\`.
Changing it to \`waiting\` or \`completed\` notifies the human.

## Reading

First check for a journal summary:

    dura summary get

If it exists, its covered seq is printed on stderr (\`covers journal through #41\`). Read it,
then start below with \`--after 41\` instead of 0: the summary stands in for the older entries.
If it does not exist (\`summary_not_found\`), read the whole journal as below.

Start with the sections and the first page of unread journal entries:

    dura show --after <last-read-seq> --limit 1000

Use the summary's covered seq, or 0 if there is no summary and you have no saved cursor. This returns at most
1000 journal entries, not necessarily the latest page. Complete the paging
procedure below before choosing work.

Read the goal, plan, tasks and journal before choosing work. If status is
\`waiting\`, read the status note and obtain the human's decision before resuming.

\`--after <seq>\` limits the journal to entries newer than one you have already read.
The document ends with the last journal seq; pass it next time:

    dura show --after 41 --limit 1000
    dura journal --after 41 --limit 1000

Journal entries are returned oldest first, with a default limit of 200 and a
maximum of 1000 per request. If a page contains as many entries as the limit,
continue with \`dura journal --after <last-page-seq> --limit 1000\`, using the
last seq from the page just read. Repeat until a page contains fewer than 1000
entries. Use \`journal\` for subsequent pages so sections are fetched only once.
Keep the last seq you read so you can resume without skipping entries.

To look back from the latest entries instead, pass \`--before\` (not together with \`--after\`).
It returns the newest entries before that seq, still oldest first; a large value gives the latest:

    dura journal --before 1000000000 --limit 20

If older entries remain, the output ends with
\`Older entries before #X are not shown and have not been read. Continue with before=X.\`
If you started below the latest entry, it also says which newer entries are not shown.
Entries you skipped this way are unread: do not treat them as read.

\`--max-chars <n>\` (show and journal) cuts longer entry bodies to n characters and marks each cut
with the full length. Read a whole entry by its seq:

    dura journal --before 1000000000 --limit 20 --max-chars 500
    dura journal 37

To find a past decision or report, search the journal (newest first). Every keyword must occur
in the body (ASCII letters ignore case; quote a phrase as one argument), and \`--kind\` filters by kind.
If more matches remain, the output gives the next \`--before\`. Search does not replace reading the
entries after the summary's covered seq:

    dura search sqlite migration --kind decision --limit 20 --max-chars 500
    dura search --kind decision --before 120

One section (raw Markdown on stdout; its version on stderr):

    dura section get plan
    dura section get plan --json

Every API command except \`guide\` supports \`--json\`, including \`log\`, \`status\`,
\`section put\` and \`section replace\`. Section write responses include the new
\`section.version\`; without \`--json\`, the CLI reports that version on stderr.
\`guide\` is Markdown only. List accessible states with \`dura list\`.

## Writing

Report your work at each milestone (sub-agents should do this when they finish):

    dura log --kind report < report.md

Include what changed, the result, relevant links and the next step.

Edit part of a section: prefer this over rewriting the whole section, so nothing gets dropped.
Read the section first and use the version reported by \`section get\` (or the version
comment in \`show\`). The example assumes you read version 7:

    dura section get tasks
    dura section replace tasks --version 7 --old "- [ ] write tests" --new "- [x] write tests"

\`--old\` must match exactly once; use \`--all\` only when you intend to replace every
occurrence. The CLI sends \`--version\` as the HTTP \`If-Match\` header.

Replace a whole section (omit \`--version\` only when creating a new section):

    dura section put plan --version 7 < plan.md

Update the journal summary when the journal has grown (the orchestrator does this).
Write the current situation, key decisions, open questions and next steps, and pass with
\`--covered\` the last seq you actually read and reflected. Never pass a newer seq: entries
appended while you were writing must stay unread for the next session. Pass the summary
version you read (omit \`--version\` only when creating the summary):

    dura summary get
    dura summary put --covered 41 --version 3 < summary.md

Change the status. Use \`waiting\` when you need a human decision and put the question
in \`--note\`; use \`completed\` with a short summary when all goal criteria are met:

    dura status waiting --note "Should the API keep v1 compatibility?"
    dura status active --note "Resuming after the human decision."
    dura status completed --note "All goal criteria are met."

The CLI does not create states. If the state does not exist, confirm its title and
goal with the human, then use the REST API below (with a token permitted to create states):

    curl -sS -X POST -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
      -d '{"id": "search-rewrite", "title": "Rewrite search", "sections": {"goal": "..."}}' \\
      "$DURA_URL/api/states"

## When a write is rejected

- \`409 version_conflict\`: someone changed the section after you read it. Read it again,
  re-apply your change to the new content, and retry with \`--version <new version>\`.
- \`422 old_not_found\` / \`old_not_unique\`: copy the text to replace exactly from a fresh read,
  with enough context to be unique.
- \`428 precondition_required\`: the section exists; read it and pass \`--version\`.
- \`422 seq_out_of_range\` (summary): \`--covered\` is beyond the last journal entry.

The same version rules apply to the journal summary: on a conflict, read it again with
\`dura summary get\`, read the journal after its covered seq, merge, and retry.

For a section error, run \`dura section get <name>\` to read the current content
and version before retrying. The CLI prints a next-step hint when a request fails.
\`401 unauthorized\` means the token is missing, invalid or revoked;
\`403 forbidden\` means it lacks permission for the operation or state.

REST error responses are JSON: \`{"error": {"code": "...", "message": "..."}}\`. The message says what to do next.

## Suggested loop

1. Orchestrator: run \`dura summary get\`, then \`dura show --after <seq> --limit 1000\`, where
   \`<seq>\` is the summary's covered seq (0 if there is no summary).
   If the journal page is full, continue with \`dura journal --after <last-page-seq> --limit 1000\`
   until a page contains fewer than 1000 entries. Read all pages before choosing work.
2. Pick the next task and hand it to a sub-agent together with \`DURA_STATE\`.
3. Sub-agent: do the work, then append a report with \`dura log --kind report\`.
4. Orchestrator: read new reports, update \`tasks\` / \`design\` with targeted replacements, repeat.
   When the journal has grown, update the summary with \`dura summary put --covered <seq>\`.
5. When the done-criteria in \`goal\` are met, set status \`completed\` with a summary.
   If you are blocked on a human decision, set \`waiting\` with the question and stop.

## API reference

The CLI is a client of this REST API. Direct HTTP requests use
\`Authorization: Bearer $DURA_TOKEN\`. The guide endpoint is public.

### Read with HTTP

Read the sections and the first journal page:

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE?after=0&limit=1000"

\`after=<seq>\` limits the journal to entries newer than one you have already read.
The document ends with the last returned journal seq. If a page has 1000 entries,
continue with the journal endpoint using that seq as after until a page has fewer
entries. Save the last seq for your next session; use the same procedure as Reading above.

The journal summary (raw Markdown; its version is in \`ETag\` and the covered seq in
\`X-Covered-Through-Seq\`; \`404 summary_not_found\` if there is none). The state document above also
starts with it. Read the journal after the covered seq:

    curl -sS -i -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/summary"

One section (raw Markdown; its version is in the \`ETag\` header):

    curl -sS -i -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/sections/plan"

New journal entries only:

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/journal?after=41&limit=1000"

The newest entries before a seq (oldest first; JSON has \`olderBefore\`, the next \`before\` or null, and
\`latestSeq\`, the newest seq in the state),
bodies cut to 500 characters, and one whole entry:

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/journal?before=1000000000&limit=20&maxChars=500"
    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/journal/37"

Search the journal, newest first (\`q\`: keywords that must all occur, \`"..."\` keeps a phrase; \`kind\`;
at least one of them; \`limit\` defaults to 20, at most 100; JSON has \`nextBefore\`, the next \`before\` or null):

    curl -sS -G -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      --data-urlencode "q=sqlite migration" -d kind=decision \\
      "$DURA_URL/api/states/$DURA_STATE/journal/search"

### Write with HTTP

Report your work (sub-agents should do this when they finish):

    curl -sS -X POST -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: text/markdown" \\
      --data-binary @report.md "$DURA_URL/api/states/$DURA_STATE/journal?kind=report"

Edit part of a section: prefer this over rewriting the whole section, so nothing gets dropped.
\`old\` must match exactly once (or set \`"replaceAll": true\`). \`If-Match\` is the version you read.

    curl -sS -X POST -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
      -H "If-Match: 7" -d '{"old": "- [ ] write tests", "new": "- [x] write tests"}' \\
      "$DURA_URL/api/states/$DURA_STATE/sections/tasks/replace"

Replace a whole section (omit \`If-Match\` only when creating a new section):

    curl -sS -X PUT -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: text/markdown" \\
      -H "If-Match: 7" --data-binary @plan.md "$DURA_URL/api/states/$DURA_STATE/sections/plan"

Write the journal summary with the last journal seq it reflects (omit \`If-Match\` only when creating it):

    jq -n --rawfile content summary.md '{content: $content, coveredThroughSeq: 41}' |
      curl -sS -X PUT -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
        -H "If-Match: 3" --data-binary @- "$DURA_URL/api/states/$DURA_STATE/summary"

Change the status. Use \`waiting\` when you need a human decision and put the question in \`statusNote\`;
use \`completed\` with a short summary when the goal's done-criteria are met:

    curl -sS -X PATCH -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
      -d '{"status": "waiting", "statusNote": "Should the API keep v1 compatibility?"}' \\
      "$DURA_URL/api/states/$DURA_STATE"

After confirming the title and goal with the human, create a new state
(only with a token that is not limited to specific states):

    curl -sS -X POST -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
      -d '{"id": "search-rewrite", "title": "Rewrite search", "sections": {"goal": "..."}}' \\
      "$DURA_URL/api/states"

### Endpoints

${endpointList()}
    POST   /mcp                                          MCP (Streamable HTTP, stateless, bearer token)

Send \`Accept: text/markdown\` to get Markdown instead of JSON where it makes sense.
`;
}

/** "`list_states` (list), `show_state` (show), ..." from the spec, so the guide lists every tool. */
function toolMap(): string {
  const items = operations().flatMap(([, op]) => {
    if ("skip" in op.mcp) return [];
    return [`\`${op.mcp.tool}\`${"command" in op.cli ? ` (${[op.cli.command, ...op.params.filter((p) => p.cli?.positional === true).map((p) => p.cli?.label ?? p.name)].join(" ")})` : ""}`];
  });
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One line per operation, from the spec. */
function endpointList(): string {
  return operations()
    .map(([, op]) => {
      const query = op.params.filter((p) => p.in === "query").map((p) => `?${p.name}=`);
      const body = op.params.filter((p) => p.in === "body").map((p) => `${p.name}${p.required ? "" : "?"}`);
      const version = op.params.find((p) => p.in === "ifMatch");
      const rawQuery = op.params.filter((p) => p.in === "body" && op.rawBody !== undefined && p.name !== op.rawBody).map((p) => `?${p.name}=`);
      const notes = [
        body.length ? `{${body.join(", ")}}${op.rawBody ? ` or a Markdown body${rawQuery.length ? ` with ${rawQuery.join(", ")}` : ""}` : ""}` : "",
        query.length ? `(${query.join(", ")})` : "",
        version ? (version.required ? "(If-Match required)" : "(If-Match: version)") : "",
      ].filter(Boolean);
      return `    ${op.method.padEnd(6)} ${`/api${op.path}`.padEnd(45)} ${[op.doc, ...notes].join(" ")}`;
    })
    .join("\n");
}
