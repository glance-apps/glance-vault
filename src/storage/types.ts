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
