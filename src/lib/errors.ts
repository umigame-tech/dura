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

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message)) return true;
  }
  return false;
}
