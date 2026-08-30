import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Store,
  AccountStore,
  AccountUsage,
  CredentialRecord,
  SyncRowInput,
  SyncRowRecord,
  BatchResult,
  ListResult,
  SoftDeleteResult,
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

// Shape of a device_credentials row as it comes back from better-sqlite3.
interface CredentialRowDb {
  credential_id: string;
  account_id: string;
  device_id: string;
  credential_hash: string;
  created_at: string;
  revoked_at: string | null;
}

function toCredentialRecord(row: CredentialRowDb): CredentialRecord {
  return {
    credentialId: row.credential_id,
    accountId: row.account_id,
    deviceId: row.device_id,
    credentialHash: row.credential_hash,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
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
  ): SoftDeleteResult | null {
    const deletedAtValue =
      typeof deletedAt === "number" && Number.isFinite(deletedAt) ? deletedAt : null;
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT seq, deleted FROM sync_rows WHERE account_id = ? AND app = ? AND entity_id = ?`,
        )
        .get(accountId, app, entityId) as { seq: number; deleted: number } | undefined;
      if (!existing) {
        return null;
      }
      // Idempotent re-delete: the row is already a tombstone, so there is
      // nothing new to publish. Return the seq it already carries and leave the
      // row completely untouched -- no nextSeq, no server_mtime, no deleted_at.
      // Re-tombstoning would mint a fresh seq and nudge every connected client,
      // and a client whose cleanup pass re-deletes the tombstones it just saw
      // then deletes them again on the next drain: a self-sustaining seq-churn
      // loop (observed live 2026-08-30, the dayGLANCE bridge plugin looping for
      // hours against the per-IP rate budget). A newer deletedAt on the
      // re-delete is deliberately ignored: the first tombstone's timestamp is
      // the one that already reached every client, and rewriting it in place
      // would silently change LWW outcomes without a seq for anyone to notice.
      if (existing.deleted === 1) {
        return { seq: existing.seq, alreadyDeleted: true };
      }
      const seq = this.nextSeq(accountId);
      this.db
        .prepare(
          `UPDATE sync_rows
           SET deleted = 1, seq = ?, server_mtime = ?, deleted_at = ?
           WHERE account_id = ? AND app = ? AND entity_id = ?`,
        )
        .run(seq, new Date().toISOString(), deletedAtValue, accountId, app, entityId);
      return { seq, alreadyDeleted: false };
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

  // --- Credentials (Phases 1.2 + 2.1) — root-level auth metadata, not account data ---

  // Persist a freshly minted credential, superseding predecessors (Phase
  // 2.1): one transaction stamps revoked_at on every still-active credential
  // for the same byte-exact (account_id, device_id), then inserts the fresh
  // row. Re-enrollment is rotation, not accumulation — the pre-2.1 behavior
  // left every superseded credential behind as a LIVE KEY. The UNIQUE index
  // on credential_hash still makes an astronomically-unlikely verifier
  // collision a loud constraint error. Consumes no account seq, touches no
  // table but device_credentials, and contains no nextSeq check-then-act —
  // this transaction is NOT one of the four seq landmines.
  issueCredential(input: {
    credentialId: string;
    accountId: string;
    deviceId: string;
    credentialHash: string;
  }): CredentialRecord & { superseded: number } {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const superseded = this.db
        .prepare(
          `UPDATE device_credentials SET revoked_at = ?
           WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.accountId, input.deviceId).changes;
      this.db
        .prepare(
          `INSERT INTO device_credentials
             (credential_id, account_id, device_id, credential_hash, created_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(input.credentialId, input.accountId, input.deviceId, input.credentialHash, now);
      return { ...input, createdAt: now, revokedAt: null, superseded };
    });
  }

  // Verifier-hash lookup for the enforcement path (unique-index point read).
  // Returns the row INCLUDING revoked_at: the store reports, the auth
  // middleware decides — revoked rows are not filtered here, so the response
  // policy stays in one visible place.
  getCredentialByHash(credentialHash: string): CredentialRecord | null {
    const row = this.db
      .prepare(
        `SELECT credential_id, account_id, device_id, credential_hash, created_at, revoked_at
         FROM device_credentials WHERE credential_hash = ?`,
      )
      .get(credentialHash) as CredentialRowDb | undefined;
    return row ? toCredentialRecord(row) : null;
  }

  // credential_id point read (Phase 2.1): powers SSE heartbeat revalidation
  // and the admin revoke's read-back.
  getCredentialById(credentialId: string): CredentialRecord | null {
    const row = this.db
      .prepare(
        `SELECT credential_id, account_id, device_id, credential_hash, created_at, revoked_at
         FROM device_credentials WHERE credential_id = ?`,
      )
      .get(credentialId) as CredentialRowDb | undefined;
    return row ? toCredentialRecord(row) : null;
  }

  // Every credential row, active and revoked, deterministically ordered.
  listCredentials(): CredentialRecord[] {
    const rows = this.db
      .prepare(
        `SELECT credential_id, account_id, device_id, credential_hash, created_at, revoked_at
         FROM device_credentials ORDER BY created_at, credential_id`,
      )
      .all() as CredentialRowDb[];
    return rows.map(toCredentialRecord);
  }

  // Idempotent revocation: the WHERE revoked_at IS NULL predicate means a
  // re-revoke changes ZERO rows and the original timestamp survives. Writes
  // exactly one cell of one row; touches no other table — deliberately never
  // the devices cursor row (a revoked-then-re-enrolled device returns with
  // the same package-owned deviceId, and its old cursor is what protects it
  // from tombstone-GC resurrection during the gap).
  revokeCredential(
    credentialId: string,
  ): { record: CredentialRecord; revokedNow: boolean } | null {
    const info = this.db
      .prepare(
        `UPDATE device_credentials SET revoked_at = ?
         WHERE credential_id = ? AND revoked_at IS NULL`,
      )
      .run(new Date().toISOString(), credentialId);
    const record = this.getCredentialById(credentialId);
    if (record === null) {
      return null;
    }
    return { record, revokedNow: info.changes > 0 };
  }

  // --- Usage reporting (Phase 3.1) — derived, read-only, aggregate-only ---
  //
  // Every method here is SELECT-only aggregates: nothing below opens a write
  // transaction, calls nextSeq, or adds a statement to any write path. That is
  // the phase's design: derived numbers cannot drift and add zero write-path
  // cost. The four seq landmines are untouched by construction.

  usageForAccount(accountId: string): AccountUsage {
    // Envelope bytes + row counts per app in one pass over the account's sync
    // rows (LENGTH() needs the row, so this is the one scan-shaped
    // derivation; it runs on an admin read, never on a write).
    const appRows = this.db
      .prepare(
        `SELECT app,
                COALESCE(SUM(LENGTH(envelope)), 0) AS bytes,
                COUNT(*) AS rows,
                COALESCE(SUM(deleted), 0) AS tombstones
         FROM sync_rows WHERE account_id = ? GROUP BY app ORDER BY app`,
      )
      .all(accountId) as { app: string; bytes: number; rows: number; tombstones: number }[];

    const envelopesByApp: Record<string, number> = {};
    let envelopes = 0;
    let rows = 0;
    let tombstones = 0;
    for (const r of appRows) {
      envelopesByApp[r.app] = r.bytes;
      envelopes += r.bytes;
      rows += r.rows;
      tombstones += r.tombstones;
    }

    // Intents: PHYSICAL bytes of rows present (incl. expired-but-unpruned),
    // LOGICAL current count (non-expired only).
    const intents = this.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(envelope)), 0) AS bytes,
                COALESCE(SUM(expires_at > ?), 0) AS current
         FROM intent_events WHERE account_id = ?`,
      )
      .get(new Date().toISOString(), accountId) as { bytes: number; current: number };

    // Blob bytes from metadata (attribution, not volume — see AccountUsage).
    const blobs = this.db
      .prepare(
        `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
         FROM blobs WHERE account_id = ?`,
      )
      .get(accountId) as { bytes: number; count: number };

    // In-flight staging: sessions are the live concurrency (reaper-bounded),
    // staged part bytes reported separately from stored.
    const uploads = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions FROM blob_upload_sessions WHERE account_id = ?`,
      )
      .get(accountId) as { sessions: number };
    const staged = this.db
      .prepare(
        `SELECT COALESCE(SUM(p.size), 0) AS bytes
         FROM blob_upload_parts p
         JOIN blob_upload_sessions s ON s.upload_id = p.upload_id
         WHERE s.account_id = ?`,
      )
      .get(accountId) as { bytes: number };

    return {
      accountId,
      storedBytes: {
        envelopesByApp,
        envelopes,
        intents: intents.bytes,
        blobs: blobs.bytes,
        total: envelopes + intents.bytes + blobs.bytes,
      },
      counts: {
        rows,
        liveRows: rows - tombstones,
        tombstones,
        blobs: blobs.count,
      },
      intents: { current: intents.current },
      uploads: { sessions: uploads.sessions, stagedBytes: staged.bytes },
    };
  }

  listUsage(): AccountUsage[] {
    const accounts = this.db
      .prepare(
        `SELECT DISTINCT account_id FROM (
           SELECT account_id FROM sync_rows
           UNION SELECT account_id FROM intent_events
           UNION SELECT account_id FROM blobs
           UNION SELECT account_id FROM blob_upload_sessions
           UNION SELECT account_id FROM account_salts
           UNION SELECT account_id FROM devices
           UNION SELECT account_id FROM account_seq
         ) ORDER BY account_id`,
      )
      .all() as { account_id: string }[];
    return accounts.map((a) => this.usageForAccount(a.account_id));
  }

  // --- Quota admission reads (Phase 3.2) — SELECT-only indexed aggregates ---
  // Like the usage reporting above: nothing here opens a transaction, calls
  // nextSeq, or adds a statement to any write path.

  blobFootprint(accountId: string): { blobBytes: number; sessionCount: number; declaredBytes: number } {
    const blobs = this.db
      .prepare(`SELECT COALESCE(SUM(size), 0) AS bytes FROM blobs WHERE account_id = ?`)
      .get(accountId) as { bytes: number };
    const sessions = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(declared_size), 0) AS declared
         FROM blob_upload_sessions WHERE account_id = ?`,
      )
      .get(accountId) as { count: number; declared: number };
    return { blobBytes: blobs.bytes, sessionCount: sessions.count, declaredBytes: sessions.declared };
  }

  syncRowCount(accountId: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM sync_rows WHERE account_id = ?`).get(accountId) as {
        n: number;
      }
    ).n;
  }

  // Both IN(...) probes below run in CHUNKS: SQLite caps bound variables
  // (32766 here, 999 on older builds), and a single sync batch can legally
  // carry more ids than that — the 16 MB body limit admits ~100k tiny rows.
  // One oversized IN() would throw "too many SQL variables" and turn a batch
  // that deserves a clean 413/200 into a 500. 900 per chunk stays under even
  // the oldest limit; the probe is the same indexed point-lookup count either
  // way, just issued in slices.
  private static readonly IN_CHUNK = 900;

  countExistingEntities(app: string, accountId: string, entityIds: string[]): number {
    let n = 0;
    for (let i = 0; i < entityIds.length; i += SqliteStore.IN_CHUNK) {
      const chunk = entityIds.slice(i, i + SqliteStore.IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      n += (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM sync_rows
             WHERE account_id = ? AND app = ? AND entity_id IN (${placeholders})`,
          )
          .get(accountId, app, ...chunk) as { n: number }
      ).n;
    }
    return n;
  }

  countExistingIntentEvents(accountId: string, eventIds: string[]): number {
    let n = 0;
    for (let i = 0; i < eventIds.length; i += SqliteStore.IN_CHUNK) {
      const chunk = eventIds.slice(i, i + SqliteStore.IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      n += (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM intent_events
             WHERE account_id = ? AND event_id IN (${placeholders})`,
          )
          .get(accountId, ...chunk) as { n: number }
      ).n;
    }
    return n;
  }

  intentCount(accountId: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM intent_events WHERE account_id = ? AND expires_at > ?`)
        .get(accountId, new Date().toISOString()) as { n: number }
    ).n;
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
