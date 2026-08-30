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
  // Client-supplied tombstone timestamp (epoch milliseconds), only meaningful on
  // a deleted row. Optional: omitted on non-deletes and on legacy clients. The
  // server persists it verbatim into sync_rows.deleted_at and never orders on it.
  deletedAt?: number;
}

// A stored row as returned to a client. envelope stays opaque bytes here; the
// HTTP layer is responsible for base64-encoding it on the way out.
export interface SyncRowRecord {
  entityId: string;
  envelope: Buffer;
  seq: number;
  deleted: boolean;
  serverMtime: string;
  // Client-supplied tombstone timestamp (epoch milliseconds), or null when the
  // row is live or was deleted by a legacy client that sent no timestamp. Clients
  // treat null as "delete wins"; a present value drives tombstone LWW.
  deletedAt: number | null;
}

export interface BatchResult {
  written: number;
  maxSeq: number;
}

export interface ListResult {
  rows: SyncRowRecord[];
  hasMore: boolean;
}

// The result of a soft-delete. seq is the tombstone's seq: freshly assigned
// when this call is what deleted the row, or the seq the existing tombstone
// already carries when the row was deleted before. alreadyDeleted distinguishes
// the two, and is the flag the HTTP layer uses to decide whether there is
// anything to nudge connected clients about -- a re-delete publishes nothing,
// so it must not emit.
export interface SoftDeleteResult {
  seq: number;
  alreadyDeleted: boolean;
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

// A per-device credential bound to one account. STORAGE ONLY at this phase:
// nothing constructs, reads, or validates one of these yet, and the Store
// interface below deliberately exposes no methods for them — the issuing phase
// adds those alongside the code that uses them.
//
// IDENTITY CONSTRAINT: accountId is the stable internal identity; a credential
// MAPS TO one and is never itself the account identity. credentialId is an
// opaque handle for the credential record, credentialHash is the verifier for
// the secret (the secret itself is never stored), and neither may be used
// anywhere as an account key.
export interface CredentialRecord {
  credentialId: string;
  accountId: string;
  deviceId: string;
  credentialHash: string;
  createdAt: string;
  // Revocation flag (Phase 2.1). null = active; an ISO timestamp = revoked at
  // that moment and the credential no longer authenticates. The store reports
  // this verbatim; the POLICY (reject with the byte-identical "invalid
  // credential" body) lives in the auth middleware, so the store stays a dumb
  // reader and a future response-policy change happens in one visible place.
  revokedAt: string | null;
}

// The storage interfaces, split along the account boundary (Phase 1.3a).
//
// AccountStore is the only surface through which account-scoped data can be
// read or written. It is obtained EXCLUSIVELY via Store.forAccount(accountId):
// every method is pre-bound to that one account, so "which account does this
// query touch" is decided at construction, once, rather than re-supplied (and
// re-trusted) on every call. Request handlers receive an AccountStore (via the
// scope resolver in server.ts) and never see the root Store, which makes an
// unscoped — or wrongly-scoped — data access inexpressible in a handler rather
// than merely not written. Today the resolver binds the account the client
// claims (shared-token trust model, unchanged); a later phase changes only
// WHERE the bound account comes from (the authenticated credential), not any of
// this shape.
//
// The handle is a STATELESS parameter binder and must stay one: it holds no
// cache, no cursor, and no transaction state, and every method body runs
// exactly the statement(s) it always ran — in particular, seq assignment stays
// inside the write transaction that stamps the row (see nextSeq).
export interface AccountStore {
  // The account every method below is bound to. Introspection only.
  readonly accountId: string;

  // Assign the next monotonic sequence number for this account. Strictly
  // increasing, with no duplicates. Intended to be called from inside a write
  // transaction so the assigned seq commits atomically with the row it stamps.
  nextSeq(): number;

  // Read the account's current latest seq WITHOUT advancing it, or 0 if the
  // account has never had a seq assigned. A pure read: unlike nextSeq it never
  // bumps the counter. Used by the SSE push endpoint to send a connecting client
  // the account's current position (the initial reconcile signal).
  latestSeq(): number;

  // Upsert a batch of sync rows for one app. Each row is assigned a freshly
  // bumped seq inside a single transaction, so seq assignment and the row write
  // commit atomically or not at all. On conflict the existing row's envelope,
  // seq, deleted, and server_mtime are replaced with the new values, so a
  // re-upserted row advances past its previous cursor position. A row marked
  // insertOnly is the exception: if its entity already exists it is skipped
  // entirely (not overwritten and not assigned a seq), so written counts only
  // the rows actually inserted or overwritten.
  batchUpsert(app: string, rows: SyncRowInput[]): BatchResult;

  // Incremental fetch: rows for this app with seq strictly greater than since,
  // ordered by seq ascending, capped at limit. hasMore reports whether more
  // rows remain past the returned page.
  listRows(app: string, since: number, limit: number): ListResult;

  // Fetch a single row by entity_id, or null if it does not exist.
  getRow(app: string, entityId: string): SyncRowRecord | null;

  // Soft-delete a row: mark deleted, assign a new seq, update server_mtime, and
  // record the client-supplied deletedAt (epoch ms; null when the client omits
  // it), all in one transaction. Returns the new seq, or null if the row does
  // not exist.
  //
  // Idempotent on an already-deleted row: the tombstone is left exactly as it
  // is (same seq, same server_mtime, same deleted_at -- a newer deletedAt on
  // the re-delete is ignored) and the result reports alreadyDeleted: true so
  // callers can skip the real-time nudge. Deleting a tombstone must never mint
  // a fresh seq; see SoftDeleteResult.
  softDeleteRow(app: string, entityId: string, deletedAt?: number | null): SoftDeleteResult | null;

  // Insert a batch of intent events. INSERT-ONLY: a re-sent event_id is a
  // harmless no-op, never an update, and consumes no seq. Each newly inserted
  // event is assigned a freshly bumped seq from the same per-account source as
  // sync. Returns the count actually inserted and the highest seq assigned.
  // Expired rows for this account are pruned lazily as part of the same write.
  insertIntents(events: IntentEventInput[]): IntentBatchResult;

  // Incremental intents fetch: events with seq strictly greater than since,
  // ordered by seq ascending, capped at limit. Only non-expired rows are
  // returned. Mirrors listRows, minus the app scope (intents are cross-app).
  listIntents(since: number, limit: number): IntentListResult;

  // Fetch the key-derivation salt, or null if none is stored yet. The salt is
  // an opaque base64 string the server never decodes.
  getSalt(): SaltRecord | null;

  // Store the salt if and only if none exists yet, then return whatever is
  // stored. First-write-wins: an existing salt is never overwritten, and the
  // returned value is always the stored one, not necessarily the supplied one.
  putSaltIfAbsent(salt: string): SaltRecord & { created: boolean };

  // Move a device's cursor forward. Upserts the (account, device) row, advancing
  // last_seen_seq to the MAX of the stored and supplied values so the cursor
  // never goes backward, and refreshing last_active. Used later for coordinated
  // tombstone GC.
  updateDeviceCursor(deviceId: string, lastSeenSeq: number): void;

  // --- Blob metadata + reference tracking ---

  // Fetch a blob's metadata row, or null if this account has no record of it.
  getBlob(blobHash: string): BlobRecord | null;

  // Insert the metadata row for a freshly stored blob, idempotently. If a row
  // already exists for this hash it is left untouched. On first insert the blob
  // starts at zero references with zeroRefSeq stamped from the per-account seq
  // source. created reports whether this call inserted the row.
  insertBlobIfAbsent(blobHash: string, size: number): { record: BlobRecord; created: boolean };

  // Report a reference ADD: increment refCount, clear zeroRefSeq, refresh
  // lastReferenceActivityAt. Returns the updated row, or null if the blob is
  // not stored for this account. NO deletion happens here.
  addBlobReference(blobHash: string): BlobRecord | null;

  // Report a reference RELEASE: decrement refCount (clamped at zero) and
  // refresh lastReferenceActivityAt. A true 1 -> 0 transition stamps zeroRefSeq
  // with a fresh per-account seq. Returns the updated row, or null if the blob
  // is not stored for this account. NO deletion happens here.
  releaseBlobReference(blobHash: string): BlobRecord | null;

  // --- Resumable upload sessions (transfer-layer) ---

  // Create an upload session, owned by this account, for a whole blob being
  // sent in parts.
  createUploadSession(uploadId: string, blobHash: string, declaredSize: number): void;

  // Fetch a session by id IF this account owns it, or null. This is the
  // ownership check every subsequent upload step's 404 rides on.
  getUploadSession(uploadId: string): UploadSessionRecord | null;

  // Record that a part was received (idempotent on (uploadId, partIndex)).
  // ACCOUNT-ENFORCED AT THE STATEMENT LEVEL: the insert joins
  // blob_upload_sessions on this account, so a part can never be recorded
  // against a session this account does not own — the statement simply affects
  // zero rows. The route's session lookup makes that unreachable; the join
  // makes it impossible.
  recordUploadPart(uploadId: string, partIndex: number, size: number): void;

  // List the acked parts of a session this account owns, ascending by index.
  // Statement-level scoped like recordUploadPart: another account's session
  // yields an empty list, indistinguishable from an unknown uploadId.
  listUploadParts(uploadId: string): UploadPartRecord[];

  // Delete a session this account owns, and its part records (cascade). The
  // staged part BYTES are removed separately via the BlobStore. Scoped at the
  // statement level: another account's session is untouched (zero rows).
  deleteUploadSession(uploadId: string): void;
}

// The credential-issuance surface (Phase 1.2) — the ONLY storage object the
// enrollment route receives. Deliberately narrow: the root Store extends this,
// but the enrollment router's parameter is typed as CredentialIssuer, so
// inside that handler forAccount, the sweeps, and lifecycle are not
// expressible — the same compile-time discipline the scoped routers live
// under, applied to the one route that legitimately predates an account
// scope. Credential rows are AUTH METADATA (a mapping to an account_id),
// not account data: inserting one exposes no sync row, salt, intent, blob,
// or cursor.
export interface CredentialIssuer {
  // Persist a freshly minted credential, SUPERSEDING its predecessors
  // (Phase 2.1): inside one transaction, stamp revoked_at on any still-active
  // credential for the same byte-exact (accountId, deviceId), then insert the
  // fresh row. Re-enrollment is thereby rotation, not accumulation — without
  // this, every re-enroll leaves a LIVE KEY behind forever (the pre-2.1
  // orphan leak). The comparison is byte-exact: no trimming or normalization,
  // matching account/device semantics everywhere else. Stamps created_at
  // itself, like every other store-side timestamp. The credentialHash is the
  // verifier (see src/credentials.ts); the secret value itself is never
  // stored. Consumes NO account seq: issuance cannot perturb sync ordering or
  // tombstone-GC arithmetic. Returns the new record plus how many
  // predecessors this issuance revoked.
  issueCredential(input: {
    credentialId: string;
    accountId: string;
    deviceId: string;
    credentialHash: string;
  }): CredentialRecord & { superseded: number };
}

// The credential-administration surface (Phase 2.1) — the ONLY storage object
// the admin router receives. Same narrow-interface discipline as
// CredentialIssuer: the root Store extends this, but the admin router's
// parameter is typed CredentialAdmin, so inside that handler forAccount, the
// sweeps, issuance, and lifecycle are not expressible. Credential rows are
// auth metadata, not account data — the same argument that placed
// CredentialIssuer on the root store.
export interface CredentialAdmin {
  // Every credential row, active and revoked, ordered deterministically
  // (created_at, then credential_id). Includes rows orphaned by pre-2.1
  // re-enrollments — those are LIVE KEYS until explicitly revoked, and this
  // listing is how an operator finds them. The route serializes an explicit
  // field allowlist; credential_hash is returned here but MUST never leave
  // the route layer.
  listCredentials(): CredentialRecord[];

  // Stamp revoked_at on a credential, idempotently: an already-revoked row
  // keeps its ORIGINAL timestamp (the WHERE clause requires revoked_at IS
  // NULL, so a re-revoke changes zero rows). Returns the row as stored plus
  // whether this call did the revoking, or null for an unknown credentialId.
  // Writes exactly one cell of one row and touches no other table — never
  // the devices cursor row (see the route for why that is deliberate).
  revokeCredential(credentialId: string): { record: CredentialRecord; revokedNow: boolean } | null;
}

// One account's usage snapshot (Phase 3.1) — DERIVED, CURRENT-STATE aggregates.
// Nothing here is a lifetime/throughput figure: pruned intents and reclaimed
// blobs are unrecoverable history, and a counter starting at zero would be
// worse than none (someone would mistake it for history). Everything below is
// fully knowable for pre-existing data precisely because it is current state.
//
// What counts toward stored bytes (ratified in the 3.1 design):
//   - TOMBSTONES ARE CHARGED: a soft delete keeps its envelope, and those
//     bytes cannot be freed while any device cursor sits below the tombstone's
//     seq (the GC invariant), so treating them as free would let enforcement
//     build a quota an account physically cannot get back under. The
//     live/tombstone split is reported so the share is visible.
//   - RECLAIMABLE-BUT-UNRECLAIMED BLOBS ARE CHARGED: row and bytes exist, and
//     under the default RETAIN policy may exist forever. (Fairness under
//     enforcement is a 3.2 consideration, flagged there, not solved here.)
//   - A blob referenced by many entities is charged ONCE (content-addressed,
//     stored once per account; ref_count multiplies nothing).
//   - Staged upload bytes are reported SEPARATELY, never folded into stored:
//     they are reaper-bounded transfer scratch, and folding them in would make
//     the headline jitter with every upload.
//   - storedBytes.intents is the PHYSICAL bytes of rows currently present
//     (including expired-but-not-yet-pruned); intents.current is the LOGICAL
//     non-expired count. Physical for bytes, logical for volume.
//
// ATTRIBUTION, NOT VOLUME: blob bytes come from blobs.size (the per-account
// metadata), never from stat-ing the global byte store. If this number ever
// disagrees with du on the volume, the cause is a transient orphan from a
// crash between reclaim's byte-delete and row-delete (or reaper scratch) —
// written down here before it happens.
export interface AccountUsage {
  accountId: string;
  storedBytes: {
    // sync_rows envelope bytes per app (the split that distinguishes a
    // lifeGLANCE archive household from a dayGLANCE task user), plus their sum.
    envelopesByApp: Record<string, number>;
    envelopes: number;
    intents: number;
    blobs: number;
    total: number;
  };
  counts: {
    rows: number;
    liveRows: number;
    tombstones: number;
    blobs: number;
  };
  intents: {
    // Current non-expired events. CURRENT STATE, NOT THROUGHPUT.
    current: number;
  };
  uploads: {
    sessions: number; // = concurrent uploads (sessions are reaped when stale)
    stagedBytes: number;
  };
}

// The usage-reporting surface (Phase 3.1) — read-only, derived, aggregate-only.
// Same narrow-interface discipline as CredentialIssuer/CredentialAdmin: the
// admin route holds this and cannot reach forAccount, credentials, or the
// sweeps. Usage numbers are AGGREGATES ABOUT account data, not account data:
// no envelope byte, entity id, blob hash, or plaintext-adjacent value crosses
// this surface.
//
// Derived on read, deliberately: maintained counters would need delta
// accounting inside batchUpsert, softDeleteRow, intent insert, both prune
// paths, blob insert, and reclaim — new read-modify-write patterns adjacent to
// the four seq landmines. Derivation adds ZERO statements to any write
// transaction and cannot drift. If Phase 3.2's numbers show the one
// scan-shaped component (envelope bytes) needs a maintained counter for
// write-path enforcement, it lands BEHIND THIS INTERFACE, seeded by one
// derivation pass — a swap, not a rework.
export interface UsageReporter {
  // Usage snapshot for one account (byte-exact accountId, like everything).
  usageForAccount(accountId: string): AccountUsage;

  // Snapshots for every account that has any footprint in the data tables
  // (sync rows, intents, blobs, upload sessions, salts, devices, seq), in
  // deterministic accountId order. An account whose only trace is a
  // credential row has no data footprint and is visible via the credential
  // listing instead.
  listUsage(): AccountUsage[];
}

// Targeted, SELECT-only reads for quota admission (Phase 3.2). Same
// aggregate-only argument as UsageReporter: no envelope byte, entity id, or
// hash crosses this surface, and nothing here opens a transaction or touches
// a write path. Every method is an indexed aggregate — the envelope-bytes
// scan is deliberately NOT reachable from enforcement.
export interface QuotaReader {
  // The storage-admission footprint: stored blob bytes plus the in-flight
  // RESERVATION (sum of live sessions' declared sizes) and the live session
  // count. Declared sizes are honest upper bounds: the part path has always
  // rejected parts exceeding a session's declared total mid-upload, so actual
  // assembled size never exceeds declared.
  blobFootprint(accountId: string): { blobBytes: number; sessionCount: number; declaredBytes: number };

  // Total sync rows for an account (index-only count; tombstones included,
  // consistent with 3.1's charging).
  syncRowCount(accountId: string): number;

  // How many of these entityIds already exist for (app, account) — the
  // net-new probe for the row cap, so updates to existing entities are never
  // blocked by it. Read-only point lookups, outside any transaction; the
  // benign TOCTOU this implies is documented at the call site.
  countExistingEntities(app: string, accountId: string, entityIds: string[]): number;

  // Current non-expired intent count (the same logical measure 3.1 reports).
  intentCount(accountId: string): number;

  // How many of these eventIds are already stored for the account — the
  // net-new probe for the intent cap, mirroring countExistingEntities.
  // insertIntents is insert-only (a re-sent eventId writes nothing), so a
  // retried batch must not be counted against the cap: without this probe, a
  // client whose batch filled the cap and whose response was lost would get
  // 429 on the retry for events that are already durably delivered.
  // Deliberately matches the write path's own dedup probe (existence
  // regardless of expiry), so gate and write agree on what a re-send is.
  countExistingIntentEvents(accountId: string, eventIds: string[]): number;
}

// Thin storage interface — the ROOT store. Request handlers never see this
// type: they receive an AccountStore from the scope resolver, and this root
// interface deliberately cannot read or write account data at all except by
// constructing an AccountStore via forAccount (the one named, greppable
// gateway). What remains here is lifecycle plus the legitimately-global
// operations: boot-time migration, the health report, and the sweeps (blob
// reclaim, upload reaper, intent pruning) that operate across all accounts on
// server-derived rows rather than caller-supplied scope.
//
// SQLite is the only implementation; a Postgres implementation can be added
// later by satisfying this same contract without touching any handler code.
export interface Store extends CredentialIssuer, CredentialAdmin, UsageReporter, QuotaReader {
  // Apply any pending migrations. Safe to call on every boot; a no-op once the
  // database is already at the current schema version.
  migrate(): void;

  // The schema version the storage is currently at. Reported by /healthz.
  schemaVersion(): number;

  // Run fn inside a single write transaction. If fn throws, the transaction is
  // rolled back. Returns whatever fn returns.
  transaction<T>(fn: () => T): T;

  // Construct the account-bound data handle — the ONLY way to reach
  // account-scoped data from this interface. Cheap and stateless: it binds the
  // accountId parameter and nothing else, so constructing one per request is
  // the intended usage.
  forAccount(accountId: string): AccountStore;

  // Hard-delete expired intent events across ALL accounts (expires_at <= now).
  // Returns the number of rows deleted. The per-account lazy prune runs inside
  // insertIntents; this global form exists for an occasional sweep.
  pruneExpiredIntents(): number;

  // List upload sessions created at or before the cutoff (an ISO timestamp),
  // for the stale-session reaper. Returns the uploadId and accountId of each so
  // the caller can discard the staged bytes (BlobStore) and delete the row.
  // READ ONLY: deletes nothing itself.
  listStaleUploadSessions(cutoff: string): { uploadId: string; accountId: string }[];

  // Sweep-side session delete (upload reaper): removes a session row (parts
  // cascade) for a session identified by the reaper's own listing, not by a
  // caller-supplied scope. Handlers use AccountStore.deleteUploadSession.
  deleteUploadSession(uploadId: string): void;

  // Find blobs eligible for reclaim, evaluating ALL THREE conditions from spec
  // section 8.3 as one query across every account (this is a global sweep):
  //   (a) zero references (ref_count == 0),
  //   (b) grace elapsed: last_reference_activity_at <= graceCutoff,
  //   (c) all NON-DEAD devices acked past the zero point: no device in the
  //       blob's account is both non-dead (last_active > deadCutoff) AND behind
  //       the zero point (last_seen_seq < zero_ref_seq).
  // zero_ref_seq is on the same per-account seq line as devices.last_seen_seq,
  // so comparison (c) is meaningful. READ ONLY: it deletes nothing. Cutoffs are
  // passed in as ISO strings so all time logic lives in the sweep.
  listReclaimableBlobs(graceCutoff: string, deadCutoff: string): BlobRecord[];

  // Sweep-side hard-delete of a blob's metadata row (blob reclaim). Returns
  // true if a row was deleted, false if already gone (idempotent). The
  // accountId comes from the reclaim listing's own rows, never from a caller-
  // supplied request scope. The bytes are removed separately via the BlobStore.
  deleteBlob(accountId: string, blobHash: string): boolean;

  // Look up a credential row by its credential_id, or null. Auth metadata
  // read (Phase 2.1): powers the SSE heartbeat revalidation — the events
  // route holds only a narrow (credentialId) => active? closure built from
  // this in buildApp — and the admin revoke's read-back.
  getCredentialById(credentialId: string): CredentialRecord | null;

  // Look up a credential row by its stored verifier hash, or null. The read
  // half of the construction src/credentials.ts owns: the enforcement phase
  // verifies a presented credential as
  // getCredentialByHash(hashCredential(presented)). Lives on the root Store
  // (NOT on CredentialIssuer — the enrollment route cannot read credentials,
  // only insert; and NOT on AccountStore — verification happens in order to
  // CONSTRUCT an account scope, so it cannot require one).
  getCredentialByHash(credentialHash: string): CredentialRecord | null;

  // Release underlying resources (database handle, etc.).
  close(): void;
}
