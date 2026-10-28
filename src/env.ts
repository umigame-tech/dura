import type { Actor } from "./auth";
import type { DB } from "./db";

export type Config = {
  /** Required to register the first passkey. Without it, initial setup is disabled. */
  setupToken?: string;
  /** Public origin, e.g. https://dura.example.com. Defaults to the request origin. */
  origin?: string;
  /** Display name shown in the passkey prompt. */
  rpName?: string;
  /** Contact for VAPID (mailto: or https: URL). */
  vapidSubject?: string;
};

export type Deps = {
  db: DB;
  config: Config;
  /** Keeps background work (notifications) alive after the response; Workers pass ctx.waitUntil. */
  waitUntil?: (p: Promise<unknown>) => void;
  fetch?: typeof fetch;
};

export type AppEnv = {
  Variables: {
    deps: Deps;
    actor: Actor | null;
  };
};
