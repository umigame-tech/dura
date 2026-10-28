import { drizzle } from "drizzle-orm/d1";
import { createApp } from "./app";
import type { DB } from "./db";
import * as schema from "./db/schema";

type Bindings = {
  DB: D1Database;
  DURA_SETUP_TOKEN?: string;
  DURA_ORIGIN?: string;
  DURA_NAME?: string;
  DURA_VAPID_SUBJECT?: string;
};

export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    const app = createApp({
      db: drizzle(env.DB, { schema }) as unknown as DB,
      config: {
        setupToken: env.DURA_SETUP_TOKEN,
        origin: env.DURA_ORIGIN,
        rpName: env.DURA_NAME,
        vapidSubject: env.DURA_VAPID_SUBJECT,
      },
      waitUntil: (p) => ctx.waitUntil(p),
    });
    return app.fetch(request);
  },
} satisfies ExportedHandler<Bindings>;
