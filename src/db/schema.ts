import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const STATE_STATUSES = ["active", "waiting", "completed", "abandoned"] as const;
export type StateStatus = (typeof STATE_STATUSES)[number];

export const states = sqliteTable(
  "states",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", { enum: STATE_STATUSES }).notNull().default("active"),
    statusNote: text("status_note"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("states_status_idx").on(t.status, t.updatedAt)],
);

// The latest content of each section. Every write also lands in sectionRevisions.
export const sections = sqliteTable(
  "sections",
  {
    stateId: text("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull(),
    version: integer("version").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.stateId, t.name] })],
);

// Full snapshot per version. The primary key doubles as the optimistic lock:
// only one writer can claim version N+1.
export const sectionRevisions = sqliteTable(
  "section_revisions",
  {
    stateId: text("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.stateId, t.name, t.version] })],
);

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    stateId: text("state_id")
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.stateId, t.seq] })],
);

// Named bearer tokens for agents. Only the SHA-256 hash of the secret is stored.
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    // "read" or "write" (write implies read)
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    // JSON array of state ids, or null for every state
    stateIds: text("state_ids", { mode: "json" }).$type<string[] | null>(),
    createdAt: text("created_at").notNull().default(now),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("tokens_hash_idx").on(t.tokenHash)],
);

// Passkeys of the (single) owner of this instance.
export const passkeys = sqliteTable("passkeys", {
  id: text("id").primaryKey(), // credential id, base64url
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(), // base64url
  counter: integer("counter").notNull().default(0),
  transports: text("transports", { mode: "json" }).$type<string[] | null>(),
  createdAt: text("created_at").notNull().default(now),
  lastUsedAt: text("last_used_at"),
});

export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  createdAt: text("created_at").notNull().default(now),
  expiresAt: text("expires_at").notNull(),
});

export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  id: text("id").primaryKey(),
  challenge: text("challenge").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  label: text("label"),
  createdAt: text("created_at").notNull().default(now),
});

export const WEBHOOK_KINDS = ["json", "ntfy", "slack", "discord"] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: WEBHOOK_KINDS }).notNull(),
  url: text("url").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

// Instance-level key/value settings (e.g. generated VAPID keys).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
