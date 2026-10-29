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
If a required variable is missing, ask for configuration rather than guessing a state.

The CLI currently requires both \`DURA_URL\` and \`DURA_TOKEN\`, including for
\`dura guide\`. If the CLI or token is unavailable, read this public endpoint:

    curl -fsS "$DURA_URL/api/guide"

Install the CLI from npm (Node 20 or later):

    npm install -g @umigame-tech/dura

To use a locally built CLI instead, run \`npm run cli:build\` in the dura repository, then use
\`node /absolute/path/to/dura/cli/dist/dura.js\` in place of \`dura\` from any directory,
or run \`npm link ./cli\` there to make \`dura\` available on PATH.
A one-line instruction in your agent configuration can be:

    Manage work state with dura. First read $DURA_URL/api/guide, then follow its Reading procedure through every journal page before choosing work.

If your client is connected to dura over MCP (\`POST ${origin}/mcp\` with the same bearer token),
the tools map to the CLI commands below: \`list_states\` (list), \`show_state\` (show),
\`read_journal\` (journal), \`get_section\`, \`put_section\`, \`replace_in_section\` (section),
\`append_journal\` (log) and \`set_status\` (status). Pass the state id as \`state\` and
follow the same procedure.

## Model

A **state** has a status and two kinds of content:

- **Sections** (named Markdown documents such as \`goal\`, \`plan\`, \`design\`, \`tasks\`).
  They are overwritten and versioned. Every write needs the version you based it on,
  so a stale write is rejected instead of silently losing someone else's change.
  Usually only the orchestrator edits sections.
- **Journal** (append-only Markdown entries with a \`kind\` such as \`report\`, \`decision\`, \`note\`).
  Appends never conflict, so sub-agents running in parallel report here.

Status is one of \`active\`, \`waiting\`, \`completed\`, \`abandoned\`.
Changing it to \`waiting\` or \`completed\` notifies the human.

## Reading

Start with the sections and the first page of unread journal entries:

    dura show --after <last-read-seq> --limit 1000

Use 0 for \`<last-read-seq>\` if you have no saved cursor. This returns at most
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

For a section error, run \`dura section get <name>\` to read the current content
and version before retrying. The CLI prints a next-step hint when a request fails.
\`401 unauthorized\` means the token is missing, invalid or revoked;
\`403 forbidden\` means it lacks permission for the operation or state.

REST error responses are JSON: \`{"error": {"code": "...", "message": "..."}}\`. The message says what to do next.

## Suggested loop

1. Orchestrator: run \`dura show --after <last-read-seq> --limit 1000\` (use 0 if unknown).
   If the journal page is full, continue with \`dura journal --after <last-page-seq> --limit 1000\`
   until a page contains fewer than 1000 entries. Read all pages before choosing work.
2. Pick the next task and hand it to a sub-agent together with \`DURA_STATE\`.
3. Sub-agent: do the work, then append a report with \`dura log --kind report\`.
4. Orchestrator: read new reports, update \`tasks\` / \`design\` with targeted replacements, repeat.
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

One section (raw Markdown; its version is in the \`ETag\` header):

    curl -sS -i -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/sections/plan"

New journal entries only:

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/journal?after=41&limit=1000"

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

    GET    /api/states                                   list states (?status=)
    POST   /api/states                                   create {id?, title, status?, statusNote?, sections?}
    GET    /api/states/:id                               state, sections and journal (?after=, ?limit=)
    PATCH  /api/states/:id                               {title?, status?, statusNote?}
    GET    /api/states/:id/sections/:name                one section
    PUT    /api/states/:id/sections/:name                write whole section (If-Match: version)
    POST   /api/states/:id/sections/:name/replace        {old, new, replaceAll?} (If-Match required)
    GET    /api/states/:id/sections/:name/revisions      every version of a section
    GET    /api/states/:id/journal                       entries (?after=, ?limit=)
    POST   /api/states/:id/journal                       append {kind, body} or Markdown body with ?kind=
    GET    /api/guide                                    this document
    POST   /mcp                                          MCP (Streamable HTTP, stateless, bearer token)

Send \`Accept: text/markdown\` to get Markdown instead of JSON where it makes sense.
`;
}
