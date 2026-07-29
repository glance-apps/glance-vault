import type Database from "better-sqlite3";

// Ordered list of migrations. Each migration moves the database from version
// (index) to (index + 1). The current version is tracked with SQLite's built-in
// PRAGMA user_version, so no separate bookkeeping table is needed.
//
// Phase 0 (version 1) creates the three sync-model tables plus the per-account
// sequence counter; version 2 adds the per-account key-derivation salt; version
// 3 adds the Phase 7 content-addressed blob store (metadata + reference
// tracking + resumable upload sessions); version 4 adds the nullable
// sync_rows.deleted_at tombstone timestamp used for client-side tombstone LWW;
// version 5 adds the per-device credential store, which is STORAGE ONLY at this
// phase — nothing reads or writes it yet.
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
      --
      -- TOMBSTONE-GC INVARIANT (for whoever implements the deferred GC): a
      -- soft-delete row (sync_rows with deleted = 1) must NEVER be hard-deleted
      -- while its seq is still above ANY registered device's last_seen_seq. A
      -- device offline past its client-side tombstone horizon relies entirely on
      -- these server rows to learn what was deleted; removing a delete row whose
      -- seq exceeds a lagging (or merely stale-but-registered) cursor causes that
      -- device to resurrect deleted entities on reconnect. Only ages-out a device
      -- from the min(last_seen_seq) calculation once it is provably dead (see spec
      -- section 9); never drop a delete row on a live/registered cursor's watch.
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
  {
    version: 2,
    sql: `
      -- One key-derivation salt per account. The salt is not secret: its only
      -- jobs are uniqueness and defeating precomputation, so storing it on an
      -- untrusted host is safe (a salt without the passphrase is useless). The
      -- server treats the salt as an opaque base64 string and never decodes it.
      -- A new device fetches it to derive the same root key from the passphrase.
      CREATE TABLE account_salts (
        account_id TEXT NOT NULL PRIMARY KEY,
        salt       TEXT NOT NULL,   -- base64-encoded bytes, opaque to the server
        created_at TEXT NOT NULL    -- ISO timestamp
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Content-addressed blob metadata (Phase 7). The bytes live in the blob
      -- store (disk now, object storage later); this table is the queryable
      -- per-account metadata plus the reference-tracking state. The server never
      -- decrypts or inspects the bytes; blob_hash is the client-supplied hash of
      -- the CIPHERTEXT (the content address), verified against the reassembled
      -- bytes on finalize.
      --
      -- Reference tracking is TRACKING ONLY in this phase; reclaim/deletion is a
      -- separate later step that builds on these columns without a schema change.
      --   ref_count     live references reported by clients (add/release).
      --   zero_ref_seq  the per-account seq cursor at the moment the blob most
      --                 recently reached zero references, or NULL while it holds
      --                 at least one reference. Same account seq space the
      --                 devices table tracks, so reclaim condition 3 ("all
      --                 non-dead devices acked past the zero point") can be
      --                 evaluated later exactly like sync's tombstone GC.
      --   last_reference_activity_at  refreshed on every add/release; the
      --                 grace-window anchor reclaim condition 2 needs.
      CREATE TABLE blobs (
        account_id                 TEXT    NOT NULL,
        blob_hash                  TEXT    NOT NULL,   -- content address (ciphertext hash)
        size                       INTEGER NOT NULL,   -- bytes
        ref_count                  INTEGER NOT NULL DEFAULT 0,
        zero_ref_seq               INTEGER,            -- account seq when last at zero, NULL if >0
        created_at                 TEXT    NOT NULL,    -- ISO timestamp
        last_reference_activity_at TEXT    NOT NULL,    -- ISO timestamp
        PRIMARY KEY (account_id, blob_hash)
      );
      CREATE INDEX idx_blobs_account ON blobs (account_id);

      -- Resumable upload sessions (transfer-layer). One whole blob is uploaded
      -- in parts the server reassembles; the session declares the content
      -- address and total size so finalize can verify both. The staged part
      -- BYTES live in the blob store; these rows track which parts were acked so
      -- the resume point is a plain query.
      CREATE TABLE blob_upload_sessions (
        upload_id     TEXT    NOT NULL PRIMARY KEY,
        account_id    TEXT    NOT NULL,
        blob_hash     TEXT    NOT NULL,   -- declared content address
        declared_size INTEGER NOT NULL,   -- declared total bytes
        created_at    TEXT    NOT NULL    -- ISO timestamp
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
  },
  {
    version: 4,
    sql: `
      -- Client-supplied tombstone timestamp (epoch milliseconds) recorded when a
      -- row is soft-deleted. Nullable and never backfilled: rows deleted before
      -- this column existed (and any client that omits it) carry NULL, which the
      -- sync client reads as "delete wins" — the correct legacy semantics. When
      -- present, the client uses it for tombstone last-writer-wins against a
      -- concurrent edit. The server only stores and returns it; it never orders
      -- or merges on it (ordering stays purely by seq).
      ALTER TABLE sync_rows ADD COLUMN deleted_at INTEGER;
    `,
  },
  {
    version: 5,
    sql: `
      -- Per-device credentials, each bound to exactly one account. STORAGE ONLY
      -- at this phase: no code issues, reads, or validates a row here, and no
      -- request handler consults this table. It exists so issuance (a later
      -- phase) and server-side account derivation (the phase after that) are
      -- additions rather than migrations.
      --
      -- IDENTITY CONSTRAINT — the reason this table is shaped the way it is:
      -- account_id is the stable internal identity, and a credential only ever
      -- MAPS TO one. A credential value is NEVER the account identity. That is
      -- why the account scope is its own column rather than something derived
      -- from, or equal to, the credential: a second thing that maps to the same
      -- account_id (a purchased license key, later) is then one more row shape
      -- pointing at an identity that already exists, not a re-keying of every
      -- account-scoped table. Nothing downstream may treat credential_id or
      -- credential_hash as an account key.
      --
      --   credential_id    opaque server-generated identifier for the credential
      --                    record itself. An internal handle for referring to one
      --                    credential (revocation, later); NOT the secret and NOT
      --                    an account identity.
      --   account_id       the account this credential grants access to. Same
      --                    identity space as sync_rows/intent_events/devices.
      --   device_id        the client-generated device identifier, same space as
      --                    devices.device_id. Deliberately NOT a foreign key —
      --                    see the note below.
      --   credential_hash  the verifier: a hash of the credential secret. The
      --                    secret itself is never stored, so a database read
      --                    does not yield usable credentials. Opaque string, so
      --                    the hash construction is the issuing phase's choice
      --                    and is not frozen here.
      --   created_at       ISO timestamp.
      --
      -- NO FOREIGN KEY to devices(account_id, device_id), deliberately. This
      -- connection runs with PRAGMA foreign_keys = ON, so an FK here would be
      -- enforced behavior, not documentation: it would make issuing a credential
      -- require a pre-existing devices row. devices rows are the tombstone-GC
      -- cursors, created only when a device reports a sync cursor, so an FK would
      -- couple credential issuance to GC state and force a device to sync before
      -- it could enroll. The columns carry the association; no constraint links
      -- the tables.
      --
      -- Revocation state is deliberately absent (a later phase owns it).
      CREATE TABLE device_credentials (
        credential_id   TEXT NOT NULL PRIMARY KEY,
        account_id      TEXT NOT NULL,
        device_id       TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );

      -- Lookup by presented credential. UNIQUE because a verifier must resolve
      -- to at most one credential; an ambiguous match would be an authentication
      -- bug, so the database refuses to store one.
      CREATE UNIQUE INDEX idx_credentials_hash ON device_credentials (credential_hash);

      -- Lookup of an account's credentials (a household has several devices) and
      -- of a specific device's. NOT unique: whether one device may hold more
      -- than one credential at a time is an issuance-policy question the issuing
      -- phase decides, and a unique constraint here would decide it early.
      CREATE INDEX idx_credentials_account ON device_credentials (account_id, device_id);
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
