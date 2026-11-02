import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} was not found.`);
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, "bad_request", message, details);

// Only UNIQUE / PRIMARY KEY violations. D1 puts "SQLITE_CONSTRAINT" in the message of every constraint error
// (FOREIGN KEY, NOT NULL, triggers too), so matching that would report them as conflicts.
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) return true;
  }
  return false;
}
