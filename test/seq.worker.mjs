import { register } from "tsx/esm/api";
import { parentPort, workerData } from "node:worker_threads";

// Worker for the concurrency test. Worker threads do not reliably inherit the
// tsx loader from the parent's execArgv, so this worker is plain JS that
// registers tsx itself and then dynamically imports the TypeScript store. It
// opens its own connection to the shared SQLite file and bumps the per-account
// counter many times, collecting every assigned seq. The main thread checks the
// union across all workers is a gap-free, duplicate-free run, which can only
// hold if bumps stay monotonic under concurrent writers.
register();

const { SqliteStore } = await import("../src/storage/sqlite.ts");

const { storagePath, accountId, iterations } = workerData;

const store = new SqliteStore(storagePath);
const assigned = [];
for (let i = 0; i < iterations; i++) {
  assigned.push(store.nextSeq(accountId));
}
store.close();

parentPort?.postMessage(assigned);
