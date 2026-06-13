import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Store } from "./types.js";
import { runMigrations, currentVersion } from "./migrations.js";

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

  close(): void {
    this.db.close();
  }
}
