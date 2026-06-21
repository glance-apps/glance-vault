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

  // Release underlying resources (database handle, etc.).
  close(): void;
}
