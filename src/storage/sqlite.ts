import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Store,
  SyncRowInput,
  SyncRowRecord,
  BatchResult,
  ListResult,
  SaltRecord,
  PurgeResult,
} from "./types.js";
import { runMigrations, currentVersion } from "./migrations.js";

// Shape of a sync_rows row as it comes back from better-sqlite3. envelope is a
// Buffer (BLOB) and deleted is a 0/1 integer.
interface SyncRowDb {
  entity_id: string;
  envelope: Buffer;
  seq: number;
  deleted: number;
  server_mtime: string;
}

function toRecord(row: SyncRowDb): SyncRowRecord {
  return {
    entityId: row.entity_id,
    envelope: row.envelope,
    seq: row.seq,
    deleted: row.deleted !== 0,
    serverMtime: row.server_mtime,
  };
}

// SQLite-backed Store. SQLite serializes all writes through a single writer, so
// a per-account counter bumped inside a transaction is naturally monotonic.
// WAL mode plus a busy timeout lets multiple connections (or processes sharing
// the mounted volume) contend safely without spurious SQLITE_BUSY errors.
export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(storagePath: string) {
    // ":memory:" is supported for tests; for a file path ensure its directory
    // exists so a fresh, empty volume works on first boot.
    if (storagePath !== ":memory:") {
      mkdirSync(dirname(storagePath), { recursive: true });
    }
    this.db = new Database(storagePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    // Wait up to 5 seconds for a competing writer rather than failing fast.
    this.db.pragma("busy_timeout = 5000");
  }

  migrate(): void {
    runMigrations(this.db);
  }

  schemaVersion(): number {
    return currentVersion(this.db);
  }

  // Single atomic upsert. INSERT ... ON CONFLICT ... RETURNING is one statement
  // and therefore atomic on its own, and it also composes correctly when called
  // from within an outer transaction() so the seq commits alongside its write.
  nextSeq(accountId: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO account_seq (account_id, value)
         VALUES (?, 1)
         ON CONFLICT(account_id) DO UPDATE SET value = value + 1
         RETURNING value`,
      )
      .get(accountId) as { value: number };
    return row.value;
  }

  // Use an IMMEDIATE transaction so the write lock is taken up front. This
  // avoids a deferred-to-write lock upgrade deadlocking against another writer.
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // Upsert a batch. Each row gets a freshly bumped seq, assigned inside the same
  // transaction as the write so seq and row commit together. On conflict the row
  // is replaced with the new envelope, seq, deleted, and server_mtime, using the
  // newly assigned seq (excluded.seq) rather than the original, so a re-upserted
  // row advances past its previous cursor position. A single batch of K rows
  // advances the account seq by exactly K, never more.
  batchUpsert(app: string, accountId: string, rows: SyncRowInput[]): BatchResult {
    // An identical re-send (same envelope bytes) intentionally advances seq
    // rather than no-opping. This is the designed behavior: it keeps every write
    // a uniform "assign a new seq and overwrite" so a partial-write retry is
    // always safe and self-healing (re-sent rows are simply re-applied, never
    // specially detected). Content-aware idempotency (skip the bump when bytes
    // are unchanged) was considered and rejected: it would require reading and
    // comparing each existing envelope inside the write path, and the only cost
    // of advancing seq is that other devices re-pull identical bytes, which they
    // apply harmlessly.
    const upsert = this.db.prepare(
      `INSERT INTO sync_rows (account_id, app, entity_id, seq, envelope, deleted, server_mtime)
       VALUES (@account_id, @app, @entity_id, @seq, @envelope, @deleted, @server_mtime)
       ON CONFLICT (account_id, app, entity_id) DO UPDATE SET
         envelope = excluded.envelope,
         seq = excluded.seq,
         deleted = excluded.deleted,
         server_mtime = excluded.server_mtime`,
    );

    return this.transaction(() => {
      let written = 0;
      let maxSeq = 0;
      for (const row of rows) {
        const seq = this.nextSeq(accountId);
        upsert.run({
          account_id: accountId,
          app,
          entity_id: row.entityId,
          seq,
          envelope: row.envelope,
          deleted: row.deleted ? 1 : 0,
          server_mtime: new Date().toISOString(),
        });
        written += 1;
        if (seq > maxSeq) {
          maxSeq = seq;
        }
      }
      return { written, maxSeq };
    });
  }

  // Incremental fetch. Over-fetch by one row to determine hasMore without a
  // separate COUNT, then trim back to the requested limit.
  listRows(app: string, accountId: string, since: number, limit: number): ListResult {
    const dbRows = this.db
      .prepare(
        `SELECT entity_id, envelope, seq, deleted, server_mtime
         FROM sync_rows
         WHERE account_id = ? AND app = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(accountId, app, since, limit + 1) as SyncRowDb[];

    const hasMore = dbRows.length > limit;
    const page = hasMore ? dbRows.slice(0, limit) : dbRows;
    return { rows: page.map(toRecord), hasMore };
  }

  getRow(app: string, accountId: string, entityId: string): SyncRowRecord | null {
    const row = this.db
      .prepare(
        `SELECT entity_id, envelope, seq, deleted, server_mtime
         FROM sync_rows
         WHERE account_id = ? AND app = ? AND entity_id = ?`,
      )
      .get(accountId, app, entityId) as SyncRowDb | undefined;
    return row ? toRecord(row) : null;
  }

  // Soft-delete: mark the row deleted, assign a new seq, and update server_mtime
  // inside one transaction. Returns null if the row does not exist.
  softDeleteRow(app: string, accountId: string, entityId: string): { seq: number } | null {
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT 1 FROM sync_rows WHERE account_id = ? AND app = ? AND entity_id = ?`,
        )
        .get(accountId, app, entityId);
      if (!existing) {
        return null;
      }
      const seq = this.nextSeq(accountId);
      this.db
        .prepare(
          `UPDATE sync_rows
           SET deleted = 1, seq = ?, server_mtime = ?
           WHERE account_id = ? AND app = ? AND entity_id = ?`,
        )
        .run(seq, new Date().toISOString(), accountId, app, entityId);
      return { seq };
    });
  }

  getSalt(accountId: string): SaltRecord | null {
    const row = this.db
      .prepare(`SELECT account_id, salt, created_at FROM account_salts WHERE account_id = ?`)
      .get(accountId) as { account_id: string; salt: string; created_at: string } | undefined;
    if (!row) {
      return null;
    }
    return { accountId: row.account_id, salt: row.salt, createdAt: row.created_at };
  }

  // First-write-wins. INSERT OR IGNORE never overwrites an existing row, so a
  // racing second writer for the same account is a no-op. Both steps run in one
  // transaction and the value is read back AFTER the insert attempt, so the
  // returned salt is always whatever is actually stored, never the supplied
  // value. created reflects whether this call is the one that inserted, derived
  // from the row's change count.
  putSaltIfAbsent(accountId: string, salt: string): SaltRecord & { created: boolean } {
    return this.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT OR IGNORE INTO account_salts (account_id, salt, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(accountId, salt, new Date().toISOString());
      const stored = this.getSalt(accountId);
      // getSalt cannot be null here: either this call inserted the row or one
      // already existed. The non-null assertion documents that invariant.
      const record = stored as SaltRecord;
      return { ...record, created: info.changes > 0 };
    });
  }

  // Remove every trace of an account in one transaction so a half-purged
  // account can never be observed. Each DELETE is scoped by account_id; the
  // returned count is the rows actually removed from that table (0 when the
  // account had none). Tables are independent, so order does not matter, but the
  // salt is deleted last to mirror "data first, then the key-derivation salt".
  purgeAccount(accountId: string): PurgeResult {
    return this.transaction(() => {
      const del = (sql: string): number =>
        (this.db.prepare(sql).run(accountId) as { changes: number }).changes;
      return {
        syncRows: del(`DELETE FROM sync_rows WHERE account_id = ?`),
        intentEvents: del(`DELETE FROM intent_events WHERE account_id = ?`),
        devices: del(`DELETE FROM devices WHERE account_id = ?`),
        accountSeq: del(`DELETE FROM account_seq WHERE account_id = ?`),
        salt: del(`DELETE FROM account_salts WHERE account_id = ?`),
      };
    });
  }

  // Forward-only device cursor. The single upsert is atomic on its own: on
  // conflict, last_seen_seq becomes MAX(existing, supplied) so a stale or
  // out-of-order report can never move a cursor backward. last_active is always
  // refreshed to now.
  updateDeviceCursor(accountId: string, deviceId: string, lastSeenSeq: number): void {
    this.db
      .prepare(
        `INSERT INTO devices (account_id, device_id, last_seen_seq, last_active)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, device_id) DO UPDATE SET
           last_seen_seq = MAX(last_seen_seq, excluded.last_seen_seq),
           last_active = excluded.last_active`,
      )
      .run(accountId, deviceId, lastSeenSeq, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
