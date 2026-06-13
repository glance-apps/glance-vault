// Thin storage interface. Request handlers depend only on this interface, never
// on a concrete database. SQLite is the only implementation in Phase 0; a
// Postgres implementation can be added later by satisfying this same contract
// without touching any handler code.
//
// The interface stays deliberately small for Phase 0. Sync, intents, and media
// data methods are NOT defined here yet; they arrive with their respective
// phases. What every backend must provide from day one is migration on boot,
// a per-account monotonic sequence source, a way to run work in a transaction,
// and clean shutdown.
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

  // Release underlying resources (database handle, etc.).
  close(): void;
}
