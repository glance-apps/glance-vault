// A row as accepted from a client for upsert. The server treats envelope as
// opaque bytes. createdAt is the client clock, advisory only; the server has no
// column for it and currently ignores it (there is nothing to parse and nothing
// to merge on at this phase). insertOnly requests first-write-wins for this row:
// if an entity with the same id already exists it is left untouched (no
// overwrite, no new seq). Used for write-once rows such as the key verifier.
export interface SyncRowInput {
  entityId: string;
  envelope: Buffer;
  deleted: boolean;
  createdAt?: number;
  insertOnly?: boolean;
}

// A stored row as returned to a client. envelope stays opaque bytes here; the
// HTTP layer is responsible for base64-encoding it on the way out.
export interface SyncRowRecord {
  entityId: string;
  envelope: Buffer;
  seq: number;
  deleted: boolean;
  serverMtime: string;
}

export interface BatchResult {
  written: number;
  maxSeq: number;
}

export interface ListResult {
  rows: SyncRowRecord[];
  hasMore: boolean;
}

// An intent event as accepted from a client for insert. The server treats
// envelope as opaque bytes (it never parses it, exactly like a sync envelope).
// expiresAt is the client-supplied TTL: a canonical ISO-8601 UTC timestamp,
// normalized by the HTTP layer before it reaches storage so it compares
// correctly against the server clock. Intents are cross-app (the channel that
// links the apps), so there is no app scope here, only account scope.
export interface IntentEventInput {
  eventId: string;
  envelope: Buffer;
  expiresAt: string;
}

// A stored intent event as returned to a client. envelope stays opaque bytes
// here; the HTTP layer base64-encodes it on the way out, like a sync row.
export interface IntentEventRecord {
  eventId: string;
  envelope: Buffer;
  seq: number;
  expiresAt: string;
  serverMtime: string;
}

// The result of an intents insert batch. written counts only the rows actually
// inserted (a re-sent event_id is a no-op and is not counted). maxSeq is the
// highest seq assigned in this batch, or 0 when nothing was inserted. Mirrors
// BatchResult so the intents write response matches the sync write response.
export interface IntentBatchResult {
  written: number;
  maxSeq: number;
}

// Incremental intents fetch result. Mirrors ListResult: a page of rows plus
// whether more remain past it.
export interface IntentListResult {
  rows: IntentEventRecord[];
  hasMore: boolean;
}

// The key-derivation salt stored for an account. salt is an opaque base64
// string; the server stores and returns it as-is and never decodes it.
export interface SaltRecord {
  accountId: string;
  salt: string;
  createdAt: string;
}

// Blob metadata, account-scoped (Phase 7). The bytes themselves live in the
// BlobStore (disk now, object storage later); this row is the queryable
// metadata plus the reference-tracking state.
//
// blobHash is the content address: the client-supplied hash of the CIPHERTEXT.
// The server stores it and verifies the reassembled bytes hash to it on
// finalize, but never decrypts or inspects the bytes.
//
// Reference tracking (tracking only in this step; reclaim is a separate later
// step that builds on this without a schema change):
//   refCount    — live references reported by clients (add/release).
//   zeroRefSeq  — the per-account seq cursor at the moment the blob most
//                 recently reached zero references, or null while it currently
//                 holds at least one reference. This is the coordination point
//                 reclaim condition 3 needs ("every non-dead device has acked
//                 past the cursor where the blob went to zero"); it lives in the
//                 SAME account seq space the devices table tracks, exactly like
//                 sync's tombstone GC. Stored now, consumed by reclaim later.
//   lastReferenceActivityAt — refreshed on every add/release; the grace-window
//                 anchor reclaim condition 2 needs.
export interface BlobRecord {
  accountId: string;
  blobHash: string;
  size: number;
  refCount: number;
  zeroRefSeq: number | null;
  createdAt: string;
  lastReferenceActivityAt: string;
}

// A resumable upload session. One whole blob is uploaded in parts that the
// server reassembles; the session carries the declared content address and
// total size so finalize can verify both. Transfer-layer state only.
export interface UploadSessionRecord {
  uploadId: string;
  accountId: string;
  blobHash: string;
  declaredSize: number;
  createdAt: string;
}

// One acked part of an in-flight upload. The bytes are staged in the BlobStore;
// this row records that the part was received and its size, so the resume point
// is a plain DB query and reassembly order is known.
export interface UploadPartRecord {
  partIndex: number;
  size: number;
  receivedAt: string;
}

// Thin storage interface. Request handlers depend only on this interface, never
// on a concrete database. SQLite is the only implementation in Phase 0; a
// Postgres implementation can be added later by satisfying this same contract
// without touching any handler code.
//
// The interface stays deliberately small. Sync data methods land in Phase 1;
// intents and media data methods arrive with their respective phases. What
// every backend must provide from day one is migration on boot, a per-account
// monotonic sequence source, a way to run work in a transaction, and clean
// shutdown.
export interface Store {
  // Apply any pending migrations. Safe to call on every boot; a no-op once the
  // database is already at the current schema version.
  migrate(): void;

  // The schema version the storage is currently at. Reported by /healthz.
  schemaVersion(): number;

  // Assign the next monotonic sequence number for an account. Strictly
  // increasing per account_id, with no duplicates. Intended to be called from
  // inside a write transaction so the assigned seq commits atomically with the
  // row it stamps.
  nextSeq(accountId: string): number;

  // Run fn inside a single write transaction. If fn throws, the transaction is
  // rolled back. Returns whatever fn returns.
  transaction<T>(fn: () => T): T;

  // Upsert a batch of sync rows for one app and account. Each row is assigned a
  // freshly bumped seq inside a single transaction, so seq assignment and the
  // row write commit atomically or not at all. On conflict the existing row's
  // envelope, seq, deleted, and server_mtime are replaced with the new values,
  // so a re-upserted row advances past its previous cursor position. A row marked
  // insertOnly is the exception: if its entity already exists it is skipped
  // entirely (not overwritten and not assigned a seq), so written counts only the
  // rows actually inserted or overwritten.
  batchUpsert(app: string, accountId: string, rows: SyncRowInput[]): BatchResult;

  // Incremental fetch: rows for this app and account with seq strictly greater
  // than since, ordered by seq ascending, capped at limit. hasMore reports
  // whether more rows remain past the returned page.
  listRows(app: string, accountId: string, since: number, limit: number): ListResult;

  // Fetch a single row by entity_id, or null if it does not exist.
  getRow(app: string, accountId: string, entityId: string): SyncRowRecord | null;

  // Soft-delete a row: mark deleted, assign a new seq, and update server_mtime,
  // all in one transaction. Returns the new seq, or null if the row does not
  // exist.
  softDeleteRow(app: string, accountId: string, entityId: string): { seq: number } | null;

  // Insert a batch of intent events for one account. INSERT-ONLY: a re-sent
  // event_id is a harmless no-op (INSERT ... ON CONFLICT (account_id, event_id)
  // DO NOTHING), never an update, and consumes no seq. Each newly inserted event
  // is assigned a freshly bumped seq from the same per-account source as sync, so
  // intents seq is strictly monotonic within intent_events. Returns the count
  // actually inserted and the highest seq assigned. Expired rows for this account
  // are pruned lazily as part of the same write.
  insertIntents(accountId: string, events: IntentEventInput[]): IntentBatchResult;

  // Incremental intents fetch: events for this account with seq strictly greater
  // than since, ordered by seq ascending, capped at limit. Only non-expired rows
  // (expires_at > now) are returned, so a client never sees an expired intent
  // even between prune sweeps. hasMore reports whether more rows remain past the
  // returned page. Mirrors listRows, minus the app scope (intents are cross-app).
  listIntents(accountId: string, since: number, limit: number): IntentListResult;

  // Hard-delete expired intent events (expires_at <= now). Scoped to one account
  // when accountId is given, otherwise a global sweep across all accounts.
  // Returns the number of rows deleted. Intents are disposable, so a slightly
  // late prune is harmless; this is called lazily on write and may also be run
  // as an occasional sweep.
  pruneExpiredIntents(accountId?: string): number;

  // Fetch the key-derivation salt for an account, or null if none is stored yet.
  // The salt is an opaque base64 string the server never decodes.
  getSalt(accountId: string): SaltRecord | null;

  // Store the salt for an account if and only if none exists yet, then return
  // whatever is stored. First-write-wins: an existing salt is never overwritten,
  // and the returned value is always the stored one, not necessarily the
  // supplied one. created is true when this call stored a new salt.
  putSaltIfAbsent(accountId: string, salt: string): SaltRecord & { created: boolean };

  // Move a device's cursor forward. Upserts the (account, device) row, advancing
  // last_seen_seq to the MAX of the stored and supplied values so the cursor
  // never goes backward, and refreshing last_active. The cursor is account
  // scoped (seq is assigned per account, shared across apps), not per app. Used
  // later for coordinated tombstone GC.
  updateDeviceCursor(accountId: string, deviceId: string, lastSeenSeq: number): void;

  // --- Blob metadata + reference tracking (Phase 7) ---

  // Fetch a blob's metadata row, or null if the server has no record of it for
  // this account.
  getBlob(accountId: string, blobHash: string): BlobRecord | null;

  // Insert the metadata row for a freshly stored blob, idempotently. If a row
  // already exists for (account, blobHash) it is left untouched (content-
  // addressing idempotency, analogous to an insert-only intent). On first
  // insert the blob starts at zero references with zeroRefSeq stamped from the
  // per-account seq source (it is at zero from creation until something
  // references it). created reports whether this call inserted the row.
  insertBlobIfAbsent(
    accountId: string,
    blobHash: string,
    size: number,
  ): { record: BlobRecord; created: boolean };

  // Report a reference ADD for (account, blobHash): increment refCount, clear
  // zeroRefSeq (the blob is no longer at zero), and refresh
  // lastReferenceActivityAt. Returns the updated row, or null if the blob is
  // not stored (the blobs-before-reference invariant means the blob must exist
  // first). NO deletion happens here.
  addBlobReference(accountId: string, blobHash: string): BlobRecord | null;

  // Report a reference RELEASE for (account, blobHash): decrement refCount
  // (clamped at zero) and refresh lastReferenceActivityAt. If this release
  // takes the blob from one reference to zero, stamp zeroRefSeq with a fresh
  // per-account seq (the cursor point reclaim later checks against device
  // acks). Returns the updated row, or null if the blob is not stored. NO
  // deletion happens here: at zero the blob is merely eligible; actual reclaim
  // is a separate later step and the default policy is RETAIN.
  releaseBlobReference(accountId: string, blobHash: string): BlobRecord | null;

  // --- Resumable upload sessions (Phase 7, transfer-layer) ---

  // Create an upload session for a whole blob being sent in parts.
  createUploadSession(
    accountId: string,
    uploadId: string,
    blobHash: string,
    declaredSize: number,
  ): void;

  // Fetch a session by id, scoped to the account, or null if unknown.
  getUploadSession(accountId: string, uploadId: string): UploadSessionRecord | null;

  // Record that a part was received (idempotent on (uploadId, partIndex): a
  // re-sent part updates its size and timestamp rather than duplicating).
  recordUploadPart(uploadId: string, partIndex: number, size: number): void;

  // List the acked parts of a session, ascending by index. Drives both the
  // resume point report and the reassembly order on finalize.
  listUploadParts(uploadId: string): UploadPartRecord[];

  // Delete a session and its part records (on finalize success or abort). The
  // staged part BYTES are removed separately via the BlobStore.
  deleteUploadSession(uploadId: string): void;

  // --- Blob reclaim / garbage collection (Phase 7 final step) ---

  // Find blobs eligible for reclaim, evaluating ALL THREE conditions from spec
  // section 8.3 as one query across every account (this is a global sweep):
  //   (a) zero references (ref_count == 0),
  //   (b) grace elapsed: last_reference_activity_at <= graceCutoff
  //       (graceCutoff = now - grace_period),
  //   (c) all NON-DEAD devices acked past the zero point: no device in the
  //       blob's account is both non-dead (last_active > deadCutoff, where
  //       deadCutoff = now - dead_device_period) AND behind the zero point
  //       (last_seen_seq < zero_ref_seq).
  // zero_ref_seq is on the same per-account seq line as devices.last_seen_seq
  // (both from nextSeq()/account_seq), so comparison (c) is meaningful. This is
  // a READ ONLY query: it deletes nothing. The caller (the reclaim sweep)
  // deletes the bytes then the row for each returned blob. Cutoffs are passed in
  // as ISO strings so all time logic lives in the sweep, not the store.
  listReclaimableBlobs(graceCutoff: string, deadCutoff: string): BlobRecord[];

  // Hard-delete a blob's metadata row. Returns true if a row was deleted, false
  // if it was already gone (idempotent: a repeated sweep does not error or
  // double-delete). The bytes are removed separately via the BlobStore. This and
  // the sweep are the ONLY places a blob is ever deleted.
  deleteBlob(accountId: string, blobHash: string): boolean;

  // Release underlying resources (database handle, etc.).
  close(): void;
}
