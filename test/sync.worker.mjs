import { register } from "tsx/esm/api";
import { parentPort, workerData } from "node:worker_threads";
import { randomBytes } from "node:crypto";

// Worker for the concurrent-batch-writes test. Like the Phase 0 seq worker, it
// registers tsx itself (worker threads do not reliably inherit the parent's
// loader) and opens its own connection to the shared SQLite file. Each worker
// writes several batches of rows with entity ids namespaced by worker id, so no
// two workers ever conflict and every row persists with its own distinct seq.
// The main thread then checks the union of all assigned seqs is a gap-free,
// duplicate-free run, which can only hold if batch writes stay monotonic under
// concurrent writers.
register();

const { SqliteStore } = await import("../src/storage/sqlite.ts");

const { storagePath, accountId, app, workerId, batches, rowsPerBatch, envelopeBytes } =
  workerData;

const store = new SqliteStore(storagePath);
for (let b = 0; b < batches; b++) {
  const rows = [];
  for (let i = 0; i < rowsPerBatch; i++) {
    rows.push({
      entityId: `w${workerId}-b${b}-e${i}`,
      envelope: randomBytes(envelopeBytes),
      deleted: false,
    });
  }
  store.forAccount(accountId).batchUpsert(app, rows);
}
store.close();

parentPort?.postMessage({ workerId, written: batches * rowsPerBatch });
