import type { Context, Hono } from "hono";
import { assertRead, assertWrite, requireActor, type Actor } from "../auth";
import type { AppEnv } from "../env";
import { ApiError, badRequest } from "../lib/errors";
import { operations, type Operation, type OperationId, type Param } from "./spec";

/** The parsed input of an operation: every param that was given (or has a default), by its HTTP name. */
export type Input = Record<string, unknown>;

export type Handler = (c: Context<AppEnv>, input: Input, actor: Actor) => Response | Promise<Response>;

export type Handlers = Record<OperationId, Handler>;

/** The Hono path of an operation: integer path params only match digits, so `/journal/search` stays its own route. */
export function honoPath(op: Operation): string {
  return op.path.replace(/:([A-Za-z]+)/g, (m, name: string) => {
    const p = op.params.find((x) => x.name === name && x.in === "path");
    return p?.type === "integer" ? `${m}{[0-9]+}` : m;
  });
}

/** Registers a route for every operation, in the order of the spec. Each route checks auth and parses its input first. */
export function registerOperations(app: Hono<AppEnv>, handlers: Handlers) {
  for (const [id, op] of operations()) {
    const handler = handlers[id];
    app.on(op.method, honoPath(op), async (c) => {
      const actor = authorize(c, op);
      const input = await parseInput(c, op);
      return handler(c, input, actor as Actor);
    });
  }
}

function authorize(c: Context<AppEnv>, op: Operation): Actor | undefined {
  if (op.auth === "public") return undefined;
  const actor = requireActor(c);
  if (op.auth === "read") assertRead(actor, c.req.param("id")!);
  if (op.auth === "write") assertWrite(actor, c.req.param("id")!);
  if (op.auth === "create") assertWrite(actor, null);
  return actor;
}

export function intParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw badRequest(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

/** Accepts `7`, `"7"` and `W/"7"`. */
function ifMatch(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  if (!m) throw badRequest(`If-Match must be a version number such as 7 (got ${JSON.stringify(raw)}).`);
  return Number(m[1]);
}

const isJson = (c: Context<AppEnv>) => (c.req.header("Content-Type") ?? "").includes("application/json");

async function jsonObject(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let v: unknown;
  try {
    v = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest("Request body must be a JSON object.");
  return v as Record<string, unknown>;
}

const TYPE_NAMES = { string: "a string", integer: "a non-negative integer", boolean: "a boolean", record: "an object of strings" };

/** Checks a JSON value against its param. */
function fromJson(p: Param, v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null && p.nullable) return null;
  const ok =
    p.type === "string"
      ? typeof v === "string"
      : p.type === "integer"
        ? typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        : p.type === "boolean"
          ? typeof v === "boolean"
          : typeof v === "object" && v !== null && !Array.isArray(v);
  if (!ok) throw badRequest(`${p.name} must be ${TYPE_NAMES[p.type]}${p.nullable ? " or null" : ""}.`);
  if (p.type === "record") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x !== "string") throw badRequest(`${p.name}.${k} must be a string.`);
    }
  }
  return v;
}

/** Converts a path or query string to its param's type. */
function fromString(p: Param, v: string | undefined): unknown {
  if (v === undefined || v === "") return undefined;
  if (p.type === "integer") return intParam(v, p.name);
  if (p.type === "boolean") {
    if (v !== "true" && v !== "false") throw badRequest(`${p.name} must be true or false.`);
    return v === "true";
  }
  return v;
}

export async function parseInput(c: Context<AppEnv>, op: Operation): Promise<Input> {
  const input: Input = {};
  const bodyParams = op.params.filter((p) => p.in === "body");
  let json: Record<string, unknown> | undefined;
  if (bodyParams.length > 0) {
    if (op.rawBody !== undefined && !isJson(c)) input[op.rawBody] = await c.req.text();
    else json = await jsonObject(c);
  }

  for (const p of op.params) {
    let v: unknown;
    if (p.in === "path") v = fromString(p, c.req.param(p.name));
    else if (p.in === "query") v = fromString(p, c.req.query(p.name));
    else if (p.in === "ifMatch") v = ifMatch(c.req.header("If-Match"));
    else if (p.name === op.rawBody && json === undefined) v = input[p.name];
    else {
      v = json !== undefined ? fromJson(p, json[p.name]) : undefined;
      // With a raw body (or a JSON body without the field), the other fields may come from the query.
      if (v === undefined && op.rawBody !== undefined) v = fromString(p, c.req.query(p.name));
    }
    if (typeof v === "string" && p.omitBlank && !v.trim()) v = undefined;
    if (v !== undefined && v !== null && p.enum && !p.enum.includes(v as string)) {
      throw badRequest(`${p.name} must be one of ${p.enum.join(", ")}.`);
    }
    if (typeof v === "number" && p.minimum !== undefined && v < p.minimum) throw badRequest(`${p.name} must be at least ${p.minimum}.`);
    if (v === undefined && p.default !== undefined) v = p.default;
    if (v === undefined && p.required) {
      if (p.in === "ifMatch") {
        throw new ApiError(428, "precondition_required", "This request requires If-Match: <the version you read>.");
      }
      throw badRequest(`${p.name} is required and must be ${TYPE_NAMES[p.type]}.`);
    }
    input[p.name] = v;
  }

  if (op.exclusive && op.exclusive.filter((n) => input[n] !== undefined).length > 1) {
    throw badRequest(`Pass either ${op.exclusive.join(" or ")}, not both.`);
  }
  return input;
}
