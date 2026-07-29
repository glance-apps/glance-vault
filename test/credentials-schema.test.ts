import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/storage/sqlite.js";
import { runMigrations, currentVersion, TARGET_SCHEMA_VERSION } from "../src/storage/migrations.js";
import { SCHEMA_VERSION } from "../src/version.js";

// The credential store added in this phase is STORAGE ONLY: no code reads or
// writes it. What these tests hold down is therefore not behavior but the
// migration's promises — it is idempotent, it leaves the existing account-scoped
// tables and their composite keys exactly as they were, and the table it adds
// has the shape the identity constraint requires.

interface TableInfo {
  name: string;
  sql: string;
}

// The full CREATE statement of every table and index, straight from
// sqlite_master. This is the fingerprint an "existing tables are untouched"
// claim has to be made against: it captures column order, types, constraints,
// and the composite primary keys.
function schemaSnapshot(db: Database.Database): TableInfo[] {
  return db
    .prepare(
      `SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as TableInfo[];
}

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-credentials-"));
  return {
    path: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the version constant matches the migration set", () => {
  // index.ts refuses to boot when these disagree, so a migration added without
  // bumping the constant is a startup failure rather than a subtle drift.
  assert.equal(SCHEMA_VERSION, TARGET_SCHEMA_VERSION);
});

test("migrating twice is a no-op", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new SqliteStore(path);
    store.migrate();
    store.close();

    const db = new Database(path);
    const versionAfterFirst = currentVersion(db);
    const schemaAfterFirst = schemaSnapshot(db);

    // Re-run against the already-migrated database, exactly as a restart would.
    runMigrations(db);

    assert.equal(currentVersion(db), versionAfterFirst, "user_version did not move");
    assert.deepEqual(schemaSnapshot(db), schemaAfterFirst, "schema is byte-identical");
    db.close();
  } finally {
    cleanup();
  }
});

test("the credential migration leaves the account-scoped tables untouched", () => {
  const { path, cleanup } = tempDb();
  try {
    // Build a database at the pre-credential schema (version 4), seed the
    // account-scoped tables, then migrate forward and compare.
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    const before = [...MIGRATIONS_THROUGH_4];
    for (const sql of before) {
      db.exec(sql);
    }
    db.pragma("user_version = 4");

    db.prepare(
      `INSERT INTO sync_rows
         (account_id, app, entity_id, seq, envelope, deleted, server_mtime, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("house-1", "dayglance", "entity-a", 1, Buffer.from("opaque"), 0, "2026-01-01T00:00:00Z", null);
    db.prepare(
      `INSERT INTO intent_events
         (account_id, event_id, seq, envelope, expires_at, server_mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("house-1", "event-a", 2, Buffer.from("opaque"), "2099-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    db.prepare(
      `INSERT INTO devices (account_id, device_id, last_seen_seq, last_active) VALUES (?, ?, ?, ?)`,
    ).run("house-1", "device-a", 2, "2026-01-01T00:00:00Z");

    const existing = ["sync_rows", "intent_events", "devices"];
    const schemaBefore = schemaSnapshot(db).filter((t) => existing.includes(t.name));
    const dataBefore = existing.map((t) => db.prepare(`SELECT * FROM ${t}`).all());

    runMigrations(db);

    assert.equal(currentVersion(db), TARGET_SCHEMA_VERSION, "advanced to the target version");
    assert.deepEqual(
      schemaSnapshot(db).filter((t) => existing.includes(t.name)),
      schemaBefore,
      "existing table definitions (and their composite primary keys) are unchanged",
    );
    assert.deepEqual(
      existing.map((t) => db.prepare(`SELECT * FROM ${t}`).all()),
      dataBefore,
      "existing table data is unchanged",
    );

    // The composite primary keys still behave as keys, not merely as text in a
    // schema dump: a duplicate (account_id, app, entity_id) is still rejected.
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO sync_rows
               (account_id, app, entity_id, seq, envelope, deleted, server_mtime)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("house-1", "dayglance", "entity-a", 9, Buffer.from("x"), 0, "2026-01-02T00:00:00Z"),
      /UNIQUE constraint failed/,
    );

    db.close();
  } finally {
    cleanup();
  }
});

test("device_credentials maps a credential to an account without becoming one", () => {
  const { path, cleanup } = tempDb();
  try {
    const store = new SqliteStore(path);
    store.migrate();
    store.close();

    const db = new Database(path);
    db.pragma("foreign_keys = ON");

    const columns = (
      db.prepare(`PRAGMA table_info(device_credentials)`).all() as { name: string }[]
    ).map((c) => c.name);
    assert.deepEqual(columns, [
      "credential_id",
      "account_id",
      "device_id",
      "credential_hash",
      "created_at",
    ]);

    const insert = db.prepare(
      `INSERT INTO device_credentials
         (credential_id, account_id, device_id, credential_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    // The household model: several devices, distinct credentials, one account.
    // No devices row exists for either device — issuance must not depend on the
    // tombstone-GC cursor table, which is why there is no foreign key.
    insert.run("cred-1", "house-1", "device-a", "hash-a", "2026-01-01T00:00:00Z");
    insert.run("cred-2", "house-1", "device-b", "hash-b", "2026-01-01T00:00:00Z");
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM devices`).get() as { n: number }).n,
      0,
      "no devices row was required",
    );

    const forAccount = db
      .prepare(`SELECT credential_id FROM device_credentials WHERE account_id = ? ORDER BY 1`)
      .all("house-1") as { credential_id: string }[];
    assert.deepEqual(
      forAccount.map((r) => r.credential_id),
      ["cred-1", "cred-2"],
      "the account is the many-to-one side: credentials map to it",
    );

    // A verifier must resolve to at most one credential.
    assert.throws(
      () => insert.run("cred-3", "house-2", "device-c", "hash-a", "2026-01-01T00:00:00Z"),
      /UNIQUE constraint failed/,
    );

    // Nothing constrains a credential value to be unique *as an identity*: two
    // accounts are free to hold credentials, and the account_id column is what
    // separates them. This is the shape that lets a later license key map to an
    // existing account_id rather than re-key anything.
    insert.run("cred-3", "house-2", "device-c", "hash-c", "2026-01-01T00:00:00Z");
    const accounts = db
      .prepare(`SELECT DISTINCT account_id FROM device_credentials ORDER BY 1`)
      .all() as { account_id: string }[];
    assert.deepEqual(accounts.map((r) => r.account_id), ["house-1", "house-2"]);

    db.close();
  } finally {
    cleanup();
  }
});

// The schema as it stood at version 4, inlined so this test can build a
// pre-credential database without depending on the migration list's internals.
const MIGRATIONS_THROUGH_4: string[] = [
  `
    CREATE TABLE sync_rows (
      account_id   TEXT    NOT NULL,
      app          TEXT    NOT NULL,
      entity_id    TEXT    NOT NULL,
      seq          INTEGER NOT NULL,
      envelope     BLOB    NOT NULL,
      deleted      INTEGER NOT NULL DEFAULT 0,
      server_mtime TEXT    NOT NULL,
      PRIMARY KEY (account_id, app, entity_id)
    );
    CREATE INDEX idx_sync_cursor ON sync_rows (account_id, app, seq);
    CREATE TABLE intent_events (
      account_id   TEXT    NOT NULL,
      event_id     TEXT    NOT NULL,
      seq          INTEGER NOT NULL,
      envelope     BLOB    NOT NULL,
      expires_at   TEXT    NOT NULL,
      server_mtime TEXT    NOT NULL,
      PRIMARY KEY (account_id, event_id)
    );
    CREATE INDEX idx_intent_cursor ON intent_events (account_id, seq);
    CREATE TABLE devices (
      account_id    TEXT    NOT NULL,
      device_id     TEXT    NOT NULL,
      last_seen_seq INTEGER NOT NULL DEFAULT 0,
      last_active   TEXT    NOT NULL,
      PRIMARY KEY (account_id, device_id)
    );
    CREATE TABLE account_seq (
      account_id TEXT    NOT NULL PRIMARY KEY,
      value      INTEGER NOT NULL DEFAULT 0
    );
  `,
  `
    CREATE TABLE account_salts (
      account_id TEXT NOT NULL PRIMARY KEY,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE blobs (
      account_id                 TEXT    NOT NULL,
      blob_hash                  TEXT    NOT NULL,
      size                       INTEGER NOT NULL,
      ref_count                  INTEGER NOT NULL DEFAULT 0,
      zero_ref_seq               INTEGER,
      created_at                 TEXT    NOT NULL,
      last_reference_activity_at TEXT    NOT NULL,
      PRIMARY KEY (account_id, blob_hash)
    );
    CREATE INDEX idx_blobs_account ON blobs (account_id);
    CREATE TABLE blob_upload_sessions (
      upload_id     TEXT    NOT NULL PRIMARY KEY,
      account_id    TEXT    NOT NULL,
      blob_hash     TEXT    NOT NULL,
      declared_size INTEGER NOT NULL,
      created_at    TEXT    NOT NULL
    );
    CREATE INDEX idx_blob_sessions_account ON blob_upload_sessions (account_id);
    CREATE TABLE blob_upload_parts (
      upload_id   TEXT    NOT NULL,
      part_index  INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      received_at TEXT    NOT NULL,
      PRIMARY KEY (upload_id, part_index),
      FOREIGN KEY (upload_id) REFERENCES blob_upload_sessions (upload_id) ON DELETE CASCADE
    );
  `,
  `ALTER TABLE sync_rows ADD COLUMN deleted_at INTEGER;`,
];
