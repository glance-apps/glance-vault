import type Database from "better-sqlite3";

// Ordered list of migrations. Each migration moves the database from version
// (index) to (index + 1). The current version is tracked with SQLite's built-in
// PRAGMA user_version, so no separate bookkeeping table is needed.
//
// Phase 0 creates exactly the three sync-model tables from the spec plus the
// per-account sequence counter. No media or blob table is created in this phase:
// its design is not finalized.
//
// envelope is an opaque BLOB. The server stores and returns these bytes intact
// and never parses them.
interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- Durable per-entity state. One row per entity, or per event for
      -- insert-only types. The whole row is replaced on a higher seq (entity
      -- grain last writer wins); the server only orders, it never merges.
      CREATE TABLE sync_rows (
        account_id   TEXT    NOT NULL,           -- household/instance scope
        app          TEXT    NOT NULL,           -- 'dayglance' | 'lastglance' | 'lifeglance'
        entity_id    TEXT    NOT NULL,           -- stable client UUID
        seq          INTEGER NOT NULL,           -- server-assigned monotonic per account
        envelope     BLOB    NOT NULL,           -- opaque encrypted bytes
        deleted      INTEGER NOT NULL DEFAULT 0,
        server_mtime TEXT    NOT NULL,           -- ISO timestamp
        PRIMARY KEY (account_id, app, entity_id)
      );
      CREATE INDEX idx_sync_cursor ON sync_rows (account_id, app, seq);

      -- Cross-device intents. Insert-only, TTL-expiring, cross-app routing.
      CREATE TABLE intent_events (
        account_id   TEXT    NOT NULL,
        event_id     TEXT    NOT NULL,           -- client UUID
        seq          INTEGER NOT NULL,           -- server-assigned monotonic per account
        envelope     BLOB    NOT NULL,           -- opaque encrypted bytes
        expires_at   TEXT    NOT NULL,           -- ISO timestamp, TTL
        server_mtime TEXT    NOT NULL,
        PRIMARY KEY (account_id, event_id)
      );
      CREATE INDEX idx_intent_cursor ON intent_events (account_id, seq);

      -- Device cursors, for coordinated tombstone GC in a later phase.
      CREATE TABLE devices (
        account_id    TEXT    NOT NULL,
        device_id     TEXT    NOT NULL,
        last_seen_seq INTEGER NOT NULL DEFAULT 0,
        last_active   TEXT    NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );

      -- Per-account monotonic sequence source. Bumped inside the same
      -- transaction as the write it stamps so seq assignment commits atomically.
      CREATE TABLE account_seq (
        account_id TEXT    NOT NULL PRIMARY KEY,
        value      INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

// The schema version the migration set advances to. This must match the
// SCHEMA_VERSION constant exported from version.ts.
export const TARGET_SCHEMA_VERSION = MIGRATIONS.length;

export function currentVersion(db: Database.Database): number {
  const row = db.pragma("user_version", { simple: true });
  return Number(row);
}

// Apply every migration whose version is greater than the database's current
// user_version, each inside its own transaction, then advance user_version.
// Idempotent: re-running once already migrated does nothing.
export function runMigrations(db: Database.Database): void {
  const start = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= start) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // PRAGMA does not accept bound parameters, so the integer is inlined.
      // migration.version is a trusted literal from this file.
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}
