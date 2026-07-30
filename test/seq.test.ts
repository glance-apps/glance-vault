import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/storage/sqlite.js";

function freshDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-seq-"));
  return { dir, path: join(dir, "test.db") };
}

test("nextSeq is strictly monotonic in a single writer", () => {
  const { dir, path } = freshDbPath();
  try {
    const store = new SqliteStore(path);
    store.migrate();

    let previous = 0;
    for (let i = 0; i < 1000; i++) {
      const seq = store.forAccount("acct-a").nextSeq();
      assert.equal(seq, previous + 1, "seq should increase by exactly one");
      previous = seq;
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextSeq is per-account, independent counters", () => {
  const { dir, path } = freshDbPath();
  try {
    const store = new SqliteStore(path);
    store.migrate();

    assert.equal(store.forAccount("acct-a").nextSeq(), 1);
    assert.equal(store.forAccount("acct-b").nextSeq(), 1);
    assert.equal(store.forAccount("acct-a").nextSeq(), 2);
    assert.equal(store.forAccount("acct-b").nextSeq(), 2);
    assert.equal(store.forAccount("acct-a").nextSeq(), 3);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent bumps stay monotonic with no duplicates or gaps", async () => {
  const { dir, path } = freshDbPath();
  try {
    // Migrate up front so workers only ever bump the counter.
    const store = new SqliteStore(path);
    store.migrate();
    store.close();

    const WORKERS = 8;
    const ITERATIONS = 500;
    const workerUrl = new URL("./seq.worker.mjs", import.meta.url);
    const workerPath = fileURLToPath(workerUrl);

    const runs = await Promise.all(
      Array.from({ length: WORKERS }, () =>
        new Promise<number[]>((resolve, reject) => {
          const worker = new Worker(workerPath, {
            workerData: {
              storagePath: path,
              accountId: "acct-shared",
              iterations: ITERATIONS,
            },
          });
          worker.once("message", (msg: number[]) => resolve(msg));
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`worker exited with code ${code}`));
          });
        }),
      ),
    );

    const all = runs.flat();
    const total = WORKERS * ITERATIONS;
    assert.equal(all.length, total, "every bump returned a value");

    // Each worker observed its own values strictly increasing.
    for (const run of runs) {
      for (let i = 1; i < run.length; i++) {
        assert.ok(run[i] > run[i - 1], "each worker sees strictly increasing seqs");
      }
    }

    // The union across all workers is exactly 1..total: no duplicates, no gaps.
    const unique = new Set(all);
    assert.equal(unique.size, total, "no two writers got the same seq");
    const sorted = [...all].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      assert.equal(sorted[i], i + 1, "the assigned seqs form a gap-free run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
