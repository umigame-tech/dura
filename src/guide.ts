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

Read this guide with \`dura guide\`. For a locally built CLI, use
\`node cli/dist/dura.js\` in place of \`dura\` (build with \`npm run cli:build\`).
A one-line instruction in your agent configuration can be:

    Manage work state with dura. Start by running dura guide, then dura show --limit 1000.

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

Everything you need to resume, as one Markdown document:

    dura show --limit 1000

Read the goal, plan, tasks and journal before choosing work. If status is
\`waiting\`, read the status note and obtain the human's decision before resuming.

\`--after <seq>\` limits the journal to entries newer than one you have already read.
The document ends with the last journal seq; pass it next time:

    dura show --after 41 --limit 1000
    dura journal --after 41 --limit 1000

Journal entries are returned oldest first, with a default limit of 200 and a
maximum of 1000 per request. If a page contains as many entries as the limit,
continue with its last seq until a page contains fewer entries. Keep the last
seq you read so you can resume without skipping entries.

One section (raw Markdown on stdout; its version on stderr):

    dura section get plan
    dura section get plan --json

\`show\`, \`list\`, \`journal\` and \`section get\` support \`--json\` for structured
output. \`guide\` is Markdown only. List accessible states with \`dura list\`.

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

1. Orchestrator: run \`dura show\` (sections + unread journal).
2. Pick the next task and hand it to a sub-agent together with \`DURA_STATE\`.
3. Sub-agent: do the work, then append a report with \`dura log --kind report\`.
4. Orchestrator: read new reports, update \`tasks\` / \`design\` with targeted replacements, repeat.
5. When the done-criteria in \`goal\` are met, set status \`completed\` with a summary.
   If you are blocked on a human decision, set \`waiting\` with the question and stop.

## API reference

The CLI is a client of this REST API. Direct HTTP requests use
\`Authorization: Bearer $DURA_TOKEN\`. The guide endpoint is public.

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

Send \`Accept: text/markdown\` to get Markdown instead of JSON where it makes sense.
`;
}
