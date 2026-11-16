/**
 * What the CLI and MCP say after a successful write, from the API's JSON response. Shared so both
 * interfaces word it the same way. No imports: the CLI bundles this file.
 */

export const versionFromEtag = (etag: string | null) => /(\d+)/.exec(etag ?? "")?.[1] ?? "?";

const WRITTEN: Record<string, (json: any, input: Record<string, unknown>) => string> = {
  createState: ({ state }) => `Created state ${state.id} (${state.status}).`,
  putSection: ({ section }) => `Wrote section ${section.name} (version ${section.version}).`,
  replaceInSection: ({ section }) => `Wrote section ${section.name} (version ${section.version}).`,
  putSummary: ({ summary }) =>
    `Wrote the journal summary (version ${summary.version}, covers the journal through #${summary.coveredThroughSeq}).`,
  appendJournal: ({ entry }) => `Appended ${entry.kind} #${entry.seq}.`,
  updateState: ({ state }, input) =>
    input.status === undefined && input.title !== undefined
      ? `Title of ${state.id} is now ${JSON.stringify(state.title)}.`
      : `Status of ${state.id} is now ${state.status}.`,
};

/** The operations that have a one-line report (test/ops.test.ts checks that they exist). */
export const WRITTEN_OPERATIONS = Object.keys(WRITTEN);

/** The one-line report of a write, or undefined when the response is best shown as it is. */
export function writtenMessage(operation: string, text: string, input: Record<string, unknown>): string | undefined {
  const message = WRITTEN[operation];
  return message ? message(JSON.parse(text), input) : undefined;
}
