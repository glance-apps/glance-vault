import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Store,
  AccountStore,
  CredentialRecord,
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

// Turn a failure to create/open the database file into an actionable message.
// The raw better-sqlite3 error ("unable to open database file", SQLITE_CANTOPEN)
// and a bare EACCES from mkdir are almost always a volume-permissions problem:
// the process user cannot write the data directory. This is common under Docker
// when the container runs as a custom uid/gid (e.g. Unraid's 99:100) that does
// not own the mounted volume. Point the operator at the fix rather than leaving
// them with an opaque native stack trace.
function permissionHint(storagePath: string, err: unknown): Error {
  const code = (err as { code?: string } | null)?.code;
  const likelyPermissions = code === "SQLITE_CANTOPEN" || code === "EACCES" || code === "EPERM";
  const dir = dirname(storagePath);
  const detail = err instanceof Error ? err.message : String(err);
  if (!likelyPermissions) {
    return err instanceof Error ? err : new Error(detail);
  }
  return new Error(
    `Could not open the database at ${storagePath}: ${detail}. ` +
      `The data directory (${dir}) is not writable by this process ` +
      `(uid ${process.getuid?.() ?? "?"}, gid ${process.getgid?.() ?? "?"}). ` +
      `In Docker, run the container as a user that owns the mounted directory: ` +
      `set 'user: "<uid>:<gid>"' in your compose file to match the directory's ` +
      `owner (for example user: "99:100" with a host directory you own on ` +
      `Unraid), or make the mounted directory writable by this uid.`,
  );
}

// Shape of a sync_rows row as it comes back from better-sqlite3. envelope is a
// Buffer (BLOB) and deleted is a 0/1 integer.
interface SyncRowDb {
  entity_id: string;
  envelope: Buffer;
  seq: number;
  deleted: number;
  server_mtime: string;
  deleted_at: number | null;
}

function toRecord(row: SyncRowDb): SyncRowRecord {
  return {
    entityId: row.entity_id,
    envelope: row.envelope,
    seq: row.seq,
    deleted: row.deleted !== 0,
    serverMtime: row.server_mtime,
    deletedAt: row.deleted_at ?? null,
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
      try {
        mkdirSync(dirname(storagePath), { recursive: true });
      } catch (err) {
        throw permissionHint(storagePath, err);
      }
    }
    try {
      this.db = new Database(storagePath);
    } catch (err) {
      throw permissionHint(storagePath, err);
    }
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
  private nextSeq(accountId: string): number {
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
  private latestSeq(accountId: string): number {
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
  private batchUpsert(app: string, accountId: string, rows: SyncRowInput[]): BatchResult {
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
      `INSERT INTO sync_rows (account_id, app, entity_id, seq, envelope, deleted, server_mtime, deleted_at)
       VALUES (@account_id, @app, @entity_id, @seq, @envelope, @deleted, @server_mtime, @deleted_at)
       ON CONFLICT (account_id, app, entity_id) DO UPDATE SET
         envelope = excluded.envelope,
         seq = excluded.seq,
         deleted = excluded.deleted,
         server_mtime = excluded.server_mtime,
         deleted_at = excluded.deleted_at`,
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
          // Only a deleted row carries a tombstone timestamp; a live upsert
          // clears any prior value. Coerce a non-finite/absent value to null.
          deleted_at:
            row.deleted && typeof row.deletedAt === "number" && Number.isFinite(row.deletedAt)
              ? row.deletedAt
              : null,
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
  private listRows(app: string, accountId: string, since: number, limit: number): ListResult {
    const dbRows = this.db
      .prepare(
        `SELECT entity_id, envelope, seq, deleted, server_mtime, deleted_at
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

  private getRow(app: string, accountId: string, entityId: string): SyncRowRecord | null {
    const row = this.db
      .prepare(
        `SELECT entity_id, envelope, seq, deleted, server_mtime, deleted_at
         FROM sync_rows
         WHERE account_id = ? AND app = ? AND entity_id = ?`,
      )
      .get(accountId, app, entityId) as SyncRowDb | undefined;
    return row ? toRecord(row) : null;
  }

  // Soft-delete: mark the row deleted, assign a new seq, update server_mtime, and
  // record the client-supplied deletedAt (epoch ms) inside one transaction.
  // deletedAt is null when the client omits it (legacy clients / delete-wins).
  // Returns null if the row does not exist.
  private softDeleteRow(
    app: string,
    accountId: string,
    entityId: string,
    deletedAt: number | null = null,
  ): { seq: number } | null {
    const deletedAtValue =
      typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
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
           SET deleted = 1, seq = ?, server_mtime = ?, deleted_at = ?
           WHERE account_id = ? AND app = ? AND entity_id = ?`,
        )
        .run(seq, new Date().toISOString(), deletedAtValue, accountId, app, entityId);
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
  private insertIntents(accountId: string, events: IntentEventInput[]): IntentBatchResult {
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
      this.pruneExpiredIntentsFor(accountId);
      return { written, maxSeq };
    });
  }

  // Incremental intents fetch. Mirrors listRows (over-fetch by one to compute
  // hasMore without a COUNT), with two differences from sync: no app scope
  // (intents are the cross-app channel) and an expires_at > now filter so an
  // expired-but-not-yet-pruned row never reaches a client.
  private listIntents(accountId: string, since: number, limit: number): IntentListResult {
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

  // Hard-delete expired intent events across ALL accounts — the occasional
  // global sweep. The single DELETE is atomic on its own. The per-account
  // lazy-on-write form is pruneExpiredIntentsFor below, which composes inside
  // insertIntents' IMMEDIATE transaction.
  pruneExpiredIntents(): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(`DELETE FROM intent_events WHERE expires_at <= ?`).run(now);
    return info.changes;
  }

  // The per-account form of the prune, run lazily inside insertIntents' write
  // transaction. Private: request-scoped pruning is an internal detail of the
  // intents write path, not part of either public interface.
  private pruneExpiredIntentsFor(accountId: string): number {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(`DELETE FROM intent_events WHERE account_id = ? AND expires_at <= ?`)
      .run(accountId, now);
    return info.changes;
  }

  private getSalt(accountId: string): SaltRecord | null {
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
  private putSaltIfAbsent(accountId: string, salt: string): SaltRecord & { created: boolean } {
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
  private updateDeviceCursor(accountId: string, deviceId: string, lastSeenSeq: number): void {
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

  private getBlob(accountId: string, blobHash: string): BlobRecord | null {
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
  private insertBlobIfAbsent(
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
  private addBlobReference(accountId: string, blobHash: string): BlobRecord | null {
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
  private releaseBlobReference(accountId: string, blobHash: string): BlobRecord | null {
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

  private createUploadSession(
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

  private getUploadSession(accountId: string, uploadId: string): UploadSessionRecord | null {
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
  // ACCOUNT-ENFORCED AT THE STATEMENT LEVEL (Phase 1.3a): the INSERT sources its
  // row from a SELECT that requires the session to belong to this account, so a
  // part can never be recorded against another account's session — the
  // statement affects zero rows. This closes, in SQL, what was previously only
  // guaranteed by every route checking getUploadSession first.
  private recordUploadPart(
    accountId: string,
    uploadId: string,
    partIndex: number,
    size: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO blob_upload_parts (upload_id, part_index, size, received_at)
         SELECT s.upload_id, @part_index, @size, @received_at
         FROM blob_upload_sessions s
         WHERE s.upload_id = @upload_id AND s.account_id = @account_id
         ON CONFLICT (upload_id, part_index) DO UPDATE SET
           size = excluded.size,
           received_at = excluded.received_at`,
      )
      .run({
        upload_id: uploadId,
        account_id: accountId,
        part_index: partIndex,
        size,
        received_at: new Date().toISOString(),
      });
  }

  // Statement-level scoped like recordUploadPart: the join makes another
  // account's session indistinguishable from an unknown uploadId (empty list).
  private listUploadParts(accountId: string, uploadId: string): UploadPartRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.part_index, p.size, p.received_at
         FROM blob_upload_parts p
         JOIN blob_upload_sessions s ON s.upload_id = p.upload_id
         WHERE p.upload_id = ? AND s.account_id = ?
         ORDER BY p.part_index ASC`,
      )
      .all(uploadId, accountId) as { part_index: number; size: number; received_at: string }[];
    return rows.map((r) => ({ partIndex: r.part_index, size: r.size, receivedAt: r.received_at }));
  }

  // Account-scoped session delete (the handler-side form). The account
  // predicate is in the DELETE itself, so another account's session is
  // untouched (zero rows), not merely unreached.
  private deleteUploadSessionFor(accountId: string, uploadId: string): void {
    this.db
      .prepare(`DELETE FROM blob_upload_sessions WHERE upload_id = ? AND account_id = ?`)
      .run(uploadId, accountId);
  }

  // Sweep-side session delete (upload reaper): the uploadId comes from
  // listStaleUploadSessions' own rows, never from a request. Parts rows cascade
  // (FK ON DELETE CASCADE); the staged bytes are removed separately via the
  // BlobStore. Handlers go through AccountStore.deleteUploadSession instead.
  deleteUploadSession(uploadId: string): void {
    this.db.prepare(`DELETE FROM blob_upload_sessions WHERE upload_id = ?`).run(uploadId);
  }

  // Sessions created at or before the cutoff — the stale set the reaper sweeps.
  // Read-only; the caller discards the staged bytes and then deletes each row.
  listStaleUploadSessions(cutoff: string): { uploadId: string; accountId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT upload_id, account_id FROM blob_upload_sessions WHERE created_at <= ?`,
      )
      .all(cutoff) as { upload_id: string; account_id: string }[];
    return rows.map((r) => ({ uploadId: r.upload_id, accountId: r.account_id }));
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

  // --- Credentials (Phase 1.2) — root-level auth metadata, not account data ---

  // Insert-only persistence of a freshly minted credential. No read, no
  // upsert: enrollment always mints fresh (non-idempotent by design), and the
  // UNIQUE index on credential_hash makes an astronomically-unlikely verifier
  // collision a loud constraint error rather than a silent overwrite. Consumes
  // no account seq and touches no other table.
  insertCredential(input: {
    credentialId: string;
    accountId: string;
    deviceId: string;
    credentialHash: string;
  }): CredentialRecord {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO device_credentials
           (credential_id, account_id, device_id, credential_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.credentialId, input.accountId, input.deviceId, input.credentialHash, createdAt);
    return { ...input, createdAt };
  }

  // Verifier-hash lookup for the enforcement phase (unique-index point read).
  getCredentialByHash(credentialHash: string): CredentialRecord | null {
    const row = this.db
      .prepare(
        `SELECT credential_id, account_id, device_id, credential_hash, created_at
         FROM device_credentials WHERE credential_hash = ?`,
      )
      .get(credentialHash) as
      | {
          credential_id: string;
          account_id: string;
          device_id: string;
          credential_hash: string;
          created_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      credentialId: row.credential_id,
      accountId: row.account_id,
      deviceId: row.device_id,
      credentialHash: row.credential_hash,
      createdAt: row.created_at,
    };
  }

  // The one gateway to account-scoped data (Phase 1.3a). Returns a STATELESS
  // parameter binder: every method simply calls the corresponding private
  // method with accountId pre-bound. No cache, no cursor, no transaction state
  // lives on the handle — in particular every nextSeq call still happens inside
  // the write transaction that stamps its row, exactly as before the split.
  // Constructing one per request is the intended usage.
  forAccount(accountId: string): AccountStore {
    return {
      accountId,
      nextSeq: () => this.nextSeq(accountId),
      latestSeq: () => this.latestSeq(accountId),
      batchUpsert: (app, rows) => this.batchUpsert(app, accountId, rows),
      listRows: (app, since, limit) => this.listRows(app, accountId, since, limit),
      getRow: (app, entityId) => this.getRow(app, accountId, entityId),
      softDeleteRow: (app, entityId, deletedAt) =>
        this.softDeleteRow(app, accountId, entityId, deletedAt),
      insertIntents: (events) => this.insertIntents(accountId, events),
      listIntents: (since, limit) => this.listIntents(accountId, since, limit),
      getSalt: () => this.getSalt(accountId),
      putSaltIfAbsent: (salt) => this.putSaltIfAbsent(accountId, salt),
      updateDeviceCursor: (deviceId, lastSeenSeq) =>
        this.updateDeviceCursor(accountId, deviceId, lastSeenSeq),
      getBlob: (blobHash) => this.getBlob(accountId, blobHash),
      insertBlobIfAbsent: (blobHash, size) => this.insertBlobIfAbsent(accountId, blobHash, size),
      addBlobReference: (blobHash) => this.addBlobReference(accountId, blobHash),
      releaseBlobReference: (blobHash) => this.releaseBlobReference(accountId, blobHash),
      createUploadSession: (uploadId, blobHash, declaredSize) =>
        this.createUploadSession(accountId, uploadId, blobHash, declaredSize),
      getUploadSession: (uploadId) => this.getUploadSession(accountId, uploadId),
      recordUploadPart: (uploadId, partIndex, size) =>
        this.recordUploadPart(accountId, uploadId, partIndex, size),
      listUploadParts: (uploadId) => this.listUploadParts(accountId, uploadId),
      deleteUploadSession: (uploadId) => this.deleteUploadSessionFor(accountId, uploadId),
    };
  }

  close(): void {
    this.db.close();
  }
}
