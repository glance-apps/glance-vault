// A row as accepted from a client for upsert. The server treats envelope as
// opaque bytes. createdAt is the client clock, advisory only; the server has no
// column for it and currently ignores it (there is nothing to parse and nothing
// to merge on at this phase).
export interface SyncRowInput {
  entityId: string;
  envelope: Buffer;
  deleted: boolean;
  createdAt?: number;
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
  // so a re-upserted row advances past its previous cursor position.
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

  // Release underlying resources (database handle, etc.).
  close(): void;
}
