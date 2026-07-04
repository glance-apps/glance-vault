import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Store,
  SyncRowInput,
  SyncRowRecord,
  BatchResult,
  ListResult,
  IntentEventInput,
  IntentEventRecord,
  IntentBatchResult,
  IntentListResult,
  SaltRecord,
  BlobRecord,
  UploadSessionRecord,
  UploadPartRecord,
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

// Shape of an intent_events row as it comes back from better-sqlite3.
interface IntentRowDb {
  event_id: string;
  envelope: Buffer;
  seq: number;
  expires_at: string;
  server_mtime: string;
}

function toIntentRecord(row: IntentRowDb): IntentEventRecord {
  return {
    eventId: row.event_id,
    envelope: row.envelope,
    seq: row.seq,
    expiresAt: row.expires_at,
    serverMtime: row.server_mtime,
  };
}

// Shape of a blobs row as it comes back from better-sqlite3. zero_ref_seq is
// nullable (NULL while the blob holds at least one reference).
interface BlobRowDb {
  account_id: string;
  blob_hash: string;
  size: number;
  ref_count: number;
  zero_ref_seq: number | null;
  created_at: string;
  last_reference_activity_at: string;
}

function toBlobRecord(row: BlobRowDb): BlobRecord {
  return {
    accountId: row.account_id,
    blobHash: row.blob_hash,
    size: row.size,
    refCount: row.ref_count,
    zeroRefSeq: row.zero_ref_seq,
    createdAt: row.created_at,
    lastReferenceActivityAt: row.last_reference_activity_at,
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

  // Current latest seq for an account, read-only (never advances the counter).
  // Returns 0 when the account has no account_seq row yet — i.e. nothing has
  // ever been written for it, so its position is the pre-first-write baseline.
  latestSeq(accountId: string): number {
    const row = this.db
      .prepare(`SELECT value FROM account_seq WHERE account_id = ?`)
      .get(accountId) as { value: number } | undefined;
    return row ? row.value : 0;
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
    // For insertOnly rows we check existence first so an already-present entity
    // is skipped without consuming a seq. The enclosing transaction is IMMEDIATE
    // (the write lock is held), so this check-then-insert cannot race another
    // writer.
    const exists = this.db.prepare(
      `SELECT 1 FROM sync_rows WHERE account_id = ? AND app = ? AND entity_id = ?`,
    );

    return this.transaction(() => {
      let written = 0;
      let maxSeq = 0;
      for (const row of rows) {
        if (row.insertOnly && exists.get(accountId, app, row.entityId)) {
          // First-write-wins: the entity already exists, so leave it untouched
          // and do not advance the seq. Not counted in written.
          continue;
        }
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

  // Insert-only batch of intent events. Mirrors batchUpsert's structure: each
  // newly inserted event gets a freshly bumped seq inside one IMMEDIATE
  // transaction, so seq and row commit together and a batch of K new events
  // advances the account seq by exactly K. Unlike sync, a re-sent event_id is a
  // strict no-op (insert-only, never an update) and consumes no seq: it is
  // skipped exactly the way an already-present insertOnly sync row is. The
  // existence check is safe under the held IMMEDIATE write lock; the ON CONFLICT
  // DO NOTHING clause is a belt-and-suspenders guarantee of insert-only
  // semantics. Expired rows for this account are pruned lazily in the same
  // transaction (intents are disposable; a slightly late prune is harmless).
  insertIntents(accountId: string, events: IntentEventInput[]): IntentBatchResult {
    const exists = this.db.prepare(
      `SELECT 1 FROM intent_events WHERE account_id = ? AND event_id = ?`,
    );
    const insert = this.db.prepare(
      `INSERT INTO intent_events (account_id, event_id, seq, envelope, expires_at, server_mtime)
       VALUES (@account_id, @event_id, @seq, @envelope, @expires_at, @server_mtime)
       ON CONFLICT (account_id, event_id) DO NOTHING`,
    );

    return this.transaction(() => {
      let written = 0;
      let maxSeq = 0;
      for (const ev of events) {
        if (exists.get(accountId, ev.eventId)) {
          // Insert-only: the event_id was already accepted, so this is a
          // harmless re-send. Leave the stored row untouched and do not advance
          // the seq. Not counted in written.
          continue;
        }
        const seq = this.nextSeq(accountId);
        insert.run({
          account_id: accountId,
          event_id: ev.eventId,
          seq,
          envelope: ev.envelope,
          expires_at: ev.expiresAt,
          server_mtime: new Date().toISOString(),
        });
        written += 1;
        if (seq > maxSeq) {
          maxSeq = seq;
        }
      }
      this.pruneExpiredIntents(accountId);
      return { written, maxSeq };
    });
  }

  // Incremental intents fetch. Mirrors listRows (over-fetch by one to compute
  // hasMore without a COUNT), with two differences from sync: no app scope
  // (intents are the cross-app channel) and an expires_at > now filter so an
  // expired-but-not-yet-pruned row never reaches a client.
  listIntents(accountId: string, since: number, limit: number): IntentListResult {
    const now = new Date().toISOString();
    const dbRows = this.db
      .prepare(
        `SELECT event_id, envelope, seq, expires_at, server_mtime
         FROM intent_events
         WHERE account_id = ? AND seq > ? AND expires_at > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(accountId, since, now, limit + 1) as IntentRowDb[];

    const hasMore = dbRows.length > limit;
    const page = hasMore ? dbRows.slice(0, limit) : dbRows;
    return { rows: page.map(toIntentRecord), hasMore };
  }

  // Hard-delete expired intent events. Scoped to one account when accountId is
  // given (the lazy-on-write path), otherwise a global sweep. The single DELETE
  // is atomic on its own and also composes inside an outer transaction (the
  // insert path calls it within its IMMEDIATE transaction).
  pruneExpiredIntents(accountId?: string): number {
    const now = new Date().toISOString();
    const info =
      accountId === undefined
        ? this.db.prepare(`DELETE FROM intent_events WHERE expires_at <= ?`).run(now)
        : this.db
            .prepare(`DELETE FROM intent_events WHERE account_id = ? AND expires_at <= ?`)
            .run(accountId, now);
    return info.changes;
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

  // --- Blob metadata + reference tracking (Phase 7) ---

  getBlob(accountId: string, blobHash: string): BlobRecord | null {
    const row = this.db
      .prepare(
        `SELECT account_id, blob_hash, size, ref_count, zero_ref_seq,
                created_at, last_reference_activity_at
         FROM blobs WHERE account_id = ? AND blob_hash = ?`,
      )
      .get(accountId, blobHash) as BlobRowDb | undefined;
    return row ? toBlobRecord(row) : null;
  }

  // Idempotent insert of the metadata row for a freshly stored blob. INSERT OR
  // IGNORE never overwrites an existing row, so a re-finalize of a known hash
  // leaves the existing metadata (and its reference state) untouched. On first
  // insert the blob is at zero references, and zero_ref_seq is stamped from the
  // per-account seq source: the blob is at zero from creation, so its zero point
  // is meaningful immediately (a blob uploaded and never referenced is still
  // trackable toward reclaim later). Both steps run in one IMMEDIATE
  // transaction, and the row is read back AFTER the insert attempt so the
  // returned record is always the stored one.
  insertBlobIfAbsent(
    accountId: string,
    blobHash: string,
    size: number,
  ): { record: BlobRecord; created: boolean } {
    return this.transaction(() => {
      const existing = this.getBlob(accountId, blobHash);
      if (existing) {
        return { record: existing, created: false };
      }
      const now = new Date().toISOString();
      const zeroRefSeq = this.nextSeq(accountId);
      this.db
        .prepare(
          `INSERT INTO blobs
             (account_id, blob_hash, size, ref_count, zero_ref_seq,
              created_at, last_reference_activity_at)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(accountId, blobHash, size, zeroRefSeq, now, now);
      const record = this.getBlob(accountId, blobHash) as BlobRecord;
      return { record, created: true };
    });
  }

  // Reference ADD. Increment the count, clear zero_ref_seq (the blob is no
  // longer at zero), and refresh last_reference_activity_at, all in one
  // transaction. Returns null if the blob is not stored (blobs-before-reference:
  // the bytes must exist before a reference to them is reported).
  addBlobReference(accountId: string, blobHash: string): BlobRecord | null {
    return this.transaction(() => {
      const existing = this.getBlob(accountId, blobHash);
      if (!existing) {
        return null;
      }
      this.db
        .prepare(
          `UPDATE blobs
           SET ref_count = ref_count + 1,
               zero_ref_seq = NULL,
               last_reference_activity_at = ?
           WHERE account_id = ? AND blob_hash = ?`,
        )
        .run(new Date().toISOString(), accountId, blobHash);
      return this.getBlob(accountId, blobHash);
    });
  }

  // Reference RELEASE. Decrement the count (clamped at zero so a duplicate or
  // out-of-order release can never drive it negative) and refresh
  // last_reference_activity_at. Only a true 1 -> 0 transition stamps a fresh
  // zero_ref_seq (the cursor point reclaim later checks device acks against); a
  // release of an already-zero blob is a harmless no-op that leaves the existing
  // zero point in place. NO deletion happens here: at zero the blob is merely
  // eligible, and the default policy is RETAIN. Returns null if not stored.
  releaseBlobReference(accountId: string, blobHash: string): BlobRecord | null {
    return this.transaction(() => {
      const existing = this.getBlob(accountId, blobHash);
      if (!existing) {
        return null;
      }
      const now = new Date().toISOString();
      if (existing.refCount <= 0) {
        // Already at zero: refresh activity but do not re-stamp the zero point.
        this.db
          .prepare(
            `UPDATE blobs SET last_reference_activity_at = ?
             WHERE account_id = ? AND blob_hash = ?`,
          )
          .run(now, accountId, blobHash);
        return this.getBlob(accountId, blobHash);
      }
      const newCount = existing.refCount - 1;
      // Stamp the zero point only on the 1 -> 0 transition.
      const zeroRefSeq = newCount === 0 ? this.nextSeq(accountId) : existing.zeroRefSeq;
      this.db
        .prepare(
          `UPDATE blobs
           SET ref_count = ?, zero_ref_seq = ?, last_reference_activity_at = ?
           WHERE account_id = ? AND blob_hash = ?`,
        )
        .run(newCount, zeroRefSeq, now, accountId, blobHash);
      return this.getBlob(accountId, blobHash);
    });
  }

  // --- Resumable upload sessions (Phase 7) ---

  createUploadSession(
    accountId: string,
    uploadId: string,
    blobHash: string,
    declaredSize: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO blob_upload_sessions
           (upload_id, account_id, blob_hash, declared_size, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(uploadId, accountId, blobHash, declaredSize, new Date().toISOString());
  }

  getUploadSession(accountId: string, uploadId: string): UploadSessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT upload_id, account_id, blob_hash, declared_size, created_at
         FROM blob_upload_sessions WHERE upload_id = ? AND account_id = ?`,
      )
      .get(uploadId, accountId) as
      | {
          upload_id: string;
          account_id: string;
          blob_hash: string;
          declared_size: number;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      uploadId: row.upload_id,
      accountId: row.account_id,
      blobHash: row.blob_hash,
      declaredSize: row.declared_size,
      createdAt: row.created_at,
    };
  }

  // Idempotent part record: a re-sent part (resume / retry) updates its size and
  // timestamp rather than duplicating, so the acked-parts set stays accurate.
  recordUploadPart(uploadId: string, partIndex: number, size: number): void {
    this.db
      .prepare(
        `INSERT INTO blob_upload_parts (upload_id, part_index, size, received_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (upload_id, part_index) DO UPDATE SET
           size = excluded.size,
           received_at = excluded.received_at`,
      )
      .run(uploadId, partIndex, size, new Date().toISOString());
  }

  listUploadParts(uploadId: string): UploadPartRecord[] {
    const rows = this.db
      .prepare(
        `SELECT part_index, size, received_at
         FROM blob_upload_parts WHERE upload_id = ?
         ORDER BY part_index ASC`,
      )
      .all(uploadId) as { part_index: number; size: number; received_at: string }[];
    return rows.map((r) => ({ partIndex: r.part_index, size: r.size, receivedAt: r.received_at }));
  }

  // Delete the session; the parts rows cascade (FK ON DELETE CASCADE). The
  // staged part bytes are removed separately via the BlobStore.
  deleteUploadSession(uploadId: string): void {
    this.db.prepare(`DELETE FROM blob_upload_sessions WHERE upload_id = ?`).run(uploadId);
  }

  // --- Blob reclaim (Phase 7 final step) ---

  // Eligible-blob query: the three reclaim conditions as a single statement.
  // Condition (c) is the NOT EXISTS subquery — a blob is blocked if ANY non-dead
  // device in its account is still behind the zero point. With no devices (or no
  // non-dead device behind the point) the subquery is empty and (c) holds. This
  // reads only blobs and devices; it never writes.
  listReclaimableBlobs(graceCutoff: string, deadCutoff: string): BlobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT b.account_id, b.blob_hash, b.size, b.ref_count, b.zero_ref_seq,
                b.created_at, b.last_reference_activity_at
         FROM blobs b
         WHERE b.ref_count = 0
           AND b.zero_ref_seq IS NOT NULL
           AND b.last_reference_activity_at <= @graceCutoff
           AND NOT EXISTS (
             SELECT 1 FROM devices d
             WHERE d.account_id = b.account_id
               AND d.last_active > @deadCutoff
               AND d.last_seen_seq < b.zero_ref_seq
           )`,
      )
      .all({ graceCutoff, deadCutoff }) as BlobRowDb[];
    return rows.map(toBlobRecord);
  }

  // Idempotent row delete. changes is 0 when the row was already gone, so a
  // repeated sweep neither errors nor double-counts. Reclaim leaves NO tombstone
  // or other state behind: a future upload of the same hash inserts a fresh row
  // (insertBlobIfAbsent) and is accepted, so a reclaimed blob can be re-uploaded
  // and self-heal later.
  deleteBlob(accountId: string, blobHash: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM blobs WHERE account_id = ? AND blob_hash = ?`)
      .run(accountId, blobHash);
    return info.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
