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

Send \`Authorization: Bearer $DURA_TOKEN\` with every request.

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

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE?after=0"

\`after=<seq>\` limits the journal to entries newer than one you have already read.
The document ends with the last journal seq; pass it next time.

One section (raw Markdown; its version is in the \`ETag\` header):

    curl -sS -i -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/sections/plan"

New journal entries only:

    curl -sS -H "Authorization: Bearer $DURA_TOKEN" -H "Accept: text/markdown" \\
      "$DURA_URL/api/states/$DURA_STATE/journal?after=41"

## Writing

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

Create a new state (only with a token that is not limited to specific states):

    curl -sS -X POST -H "Authorization: Bearer $DURA_TOKEN" -H "Content-Type: application/json" \\
      -d '{"id": "search-rewrite", "title": "Rewrite search", "sections": {"goal": "..."}}' \\
      "$DURA_URL/api/states"

## When a write is rejected

- \`409 version_conflict\`: someone changed the section after you read it. Read it again,
  re-apply your change to the new content, and retry with the new version.
- \`422 old_not_found\` / \`old_not_unique\`: copy the text to replace exactly from a fresh read,
  with enough context to be unique.
- \`428 precondition_required\`: the section exists; send \`If-Match\`.

Error responses are JSON: \`{"error": {"code": "...", "message": "..."}}\`. The message says what to do next.

## Suggested loop

1. Orchestrator: read the state (sections + unread journal).
2. Pick the next task and hand it to a sub-agent together with \`DURA_STATE\`.
3. Sub-agent: do the work, then append a \`report\` to the journal.
4. Orchestrator: read new reports, update \`tasks\` / \`design\` with targeted replacements, repeat.
5. When the done-criteria in \`goal\` are met, set status \`completed\` with a summary.
   If you are blocked on a human decision, set \`waiting\` with the question and stop.

## API reference

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
