// The SQLite database: users, sessions, usage events, study materials and their groups.
// Migrations are numbered and applied in order; `PRAGMA user_version` records how far we got.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const MATERIAL_TYPES = ["StudyGuide", "Worksheet", "Quiz", "Exam"] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export const STATUSES = ["draft", "private", "published"] as const;
export type Status = (typeof STATUSES)[number];
export const PLANS = ["free", "pro"] as const;
export type Plan = (typeof PLANS)[number];

const MIGRATIONS: string[] = [
    `
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
        is_admin INTEGER NOT NULL DEFAULT 0,
        stripe_customer_id TEXT,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE INDEX sessions_expires ON sessions(expires_at);

    CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        metadata TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX usage_user_kind ON usage_events(user_id, kind, created_at);

    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE material_groups (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id INTEGER REFERENCES material_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'private', 'published')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX groups_owner_parent ON material_groups(owner_id, parent_id);

    CREATE TABLE study_materials (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id INTEGER REFERENCES material_groups(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('StudyGuide', 'Worksheet', 'Quiz', 'Exam')),
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'private', 'published')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX materials_owner_group ON study_materials(owner_id, group_id);
    CREATE INDEX materials_status_type ON study_materials(status, type);

    CREATE TABLE material_tags (
        material_id INTEGER NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (material_id, tag)
    );
    CREATE INDEX material_tags_tag ON material_tags(tag);
    `,
    // Stripe: the current subscription, and whether the one-time free trial has been used.
    `
    ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT;
    ALTER TABLE users ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX users_stripe_customer ON users(stripe_customer_id);
    `,
    // Stripe subscription state for display (access reads only \`plan\`), the trial as a timestamp, and webhook idempotency.
    `
    ALTER TABLE users ADD COLUMN subscription_status TEXT;
    ALTER TABLE users ADD COLUMN subscription_created INTEGER;
    ALTER TABLE users ADD COLUMN price_id TEXT;
    ALTER TABLE users ADD COLUMN billing_interval TEXT;
    ALTER TABLE users ADD COLUMN current_period_end INTEGER;
    ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN trial_used_at INTEGER;
    UPDATE users SET trial_used_at = strftime('%s', 'now') WHERE trial_used = 1;
    ALTER TABLE users DROP COLUMN trial_used;
    DROP INDEX users_stripe_customer;
    CREATE UNIQUE INDEX users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

    CREATE TABLE processed_stripe_events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        received_at INTEGER NOT NULL
    );
    `,
];

/** Opens (creating if needed) the database at `path`, or in memory for ":memory:", and migrates it. */
export function openDb(path: string): Database {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
        db.transaction(() => {
            db.run(MIGRATIONS[i]!);
            db.run(`PRAGMA user_version = ${i + 1}`);
        })();
    }
    return db;
}

/** Seconds since the epoch. */
export const now = () => Math.floor(Date.now() / 1000);

export function getSetting(db: Database, key: string): string | null {
    return (db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

export function setSetting(db: Database, key: string, value: string): void {
    db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Records a billable or notable action; Stripe quotas and metering read from this. */
export function recordUsage(db: Database, userId: number, kind: string, quantity = 1, metadata?: unknown): void {
    db.query("INSERT INTO usage_events (user_id, kind, quantity, metadata, created_at) VALUES (?, ?, ?, ?, ?)").run(
        userId,
        kind,
        quantity,
        metadata === undefined ? null : JSON.stringify(metadata),
        now(),
    );
}

/** Total quantity of `kind` events since `since` (epoch seconds). */
export function usageSince(db: Database, userId: number, kind: string, since: number): number {
    const row = db.query("SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ?").get(userId, kind, since) as { n: number };
    return row.n;
}
