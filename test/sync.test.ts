import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

const TOKEN = "hammer-token";

// A live server backed by a real SQLite file on disk. Every test gets its own,
// so they are independent. The hammer suite drives the actual HTTP endpoints,
// not mocks, so it exercises the full request path including auth and routing.
interface Harness {
  base: string;
  store: SqliteStore;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-sync-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp({ storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [] }, store);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: () => {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

interface WireRow {
  entityId: string;
  envelope: string;
  seq: number;
  deleted: boolean;
  serverMtime: string;
}

async function postBatch(
  base: string,
  app: string,
  accountId: string,
  rows: Array<{ entityId: string; envelope: string; deleted?: boolean; insertOnly?: boolean }>,
): Promise<{ status: number; body: { written: number; maxSeq: number } }> {
  const res = await fetch(`${base}/sync/${app}/batch`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, rows }),
  });
  return { status: res.status, body: (await res.json()) as { written: number; maxSeq: number } };
}

async function getRow(
  base: string,
  app: string,
  accountId: string,
  entityId: string,
): Promise<{ status: number; body: WireRow | { error: string } }> {
  const url = new URL(`${base}/sync/${app}/${encodeURIComponent(entityId)}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { headers: authHeaders() });
  return { status: res.status, body: (await res.json()) as WireRow | { error: string } };
}

async function listRows(
  base: string,
  app: string,
  accountId: string,
  since: number,
  limit?: number,
): Promise<{ status: number; body: { rows: WireRow[]; hasMore: boolean } }> {
  const url = new URL(`${base}/sync/${app}/list`);
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("since", String(since));
  if (limit !== undefined) {
    url.searchParams.set("limit", String(limit));
  }
  const res = await fetch(url, { headers: authHeaders() });
  return { status: res.status, body: (await res.json()) as { rows: WireRow[]; hasMore: boolean } };
}

// A synthetic, opaque envelope: random bytes, base64-encoded, not real
// ciphertext. The server must store and return these bytes untouched.
function garbageEnvelope(bytes = 64): string {
  return randomBytes(bytes).toString("base64");
}

// 1. Seq monotonicity under concurrent batch writes.
test("seq stays monotonic under concurrent batch writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-sync-conc-"));
  const path = join(dir, "test.db");
  try {
    // Migrate up front so workers only write.
    const store = new SqliteStore(path);
    store.migrate();
    store.close();

    const WORKERS = 8;
    const BATCHES = 10;
    const ROWS_PER_BATCH = 25;
    const ACCOUNT = "acct-conc";
    const APP = "dayglance";
    const workerPath = fileURLToPath(new URL("./sync.worker.mjs", import.meta.url));

    await Promise.all(
      Array.from({ length: WORKERS }, (_unused, workerId) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(workerPath, {
            workerData: {
              storagePath: path,
              accountId: ACCOUNT,
              app: APP,
              workerId,
              batches: BATCHES,
              rowsPerBatch: ROWS_PER_BATCH,
              envelopeBytes: 48,
            },
          });
          worker.once("message", () => resolve());
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`worker exited with code ${code}`));
          });
        }),
      ),
    );

    // Read every row back and collect its seq. Every entity id was unique, so no
    // upserts collided and the full set of seqs must be exactly 1..total.
    const reader = new SqliteStore(path);
    const total = WORKERS * BATCHES * ROWS_PER_BATCH;
    const seqs: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = reader.listRows(APP, ACCOUNT, cursor, 1000);
      for (const row of page.rows) {
        seqs.push(row.seq);
      }
      if (!page.hasMore) break;
      cursor = page.rows[page.rows.length - 1].seq;
    }
    reader.close();

    assert.equal(seqs.length, total, "every written row was read back");
    const unique = new Set(seqs);
    assert.equal(unique.size, total, "no two rows share a seq");
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      assert.equal(sorted[i], i + 1, "assigned seqs form a gap-free run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2. Idempotency: re-sending the same batch creates no duplicate rows, keeps the
// stored content identical, and advances the seq by exactly one write's worth
// (one seq per row), never more.
test("re-sending a batch is idempotent in content and bounded in seq", async () => {
  const h = await startServer();
  try {
    const K = 5;
    const account = "acct-idem";
    const rows = Array.from({ length: K }, (_u, i) => ({
      entityId: `e${i}`,
      envelope: garbageEnvelope(),
    }));

    const first = await postBatch(h.base, "dayglance", account, rows);
    assert.equal(first.status, 200);
    assert.equal(first.body.written, K);
    assert.equal(first.body.maxSeq, K, "a single K-row write advances the seq by exactly K");

    const second = await postBatch(h.base, "dayglance", account, rows);
    assert.equal(second.status, 200);
    assert.equal(second.body.written, K);
    assert.equal(second.body.maxSeq, 2 * K, "the re-send advances by exactly one more write, not more");

    const listed = await listRows(h.base, "dayglance", account, 0);
    assert.equal(listed.body.rows.length, K, "no duplicate rows were created");
    const byId = new Map(listed.body.rows.map((r) => [r.entityId, r]));
    for (const sent of rows) {
      assert.equal(byId.get(sent.entityId)?.envelope, sent.envelope, "stored bytes are unchanged");
    }
  } finally {
    h.close();
  }
});

// 3. ON CONFLICT correctness: re-upserting an existing entity with a new envelope
// advances its seq, so the row reappears in a list since the cursor it was at.
test("upsert with a new envelope advances seq past the prior cursor", async () => {
  const h = await startServer();
  try {
    const account = "acct-conflict";
    const envA = garbageEnvelope();
    const envB = garbageEnvelope();

    const first = await postBatch(h.base, "dayglance", account, [{ entityId: "e1", envelope: envA }]);
    const cursor = first.body.maxSeq;

    // Nothing newer than the cursor yet.
    const empty = await listRows(h.base, "dayglance", account, cursor);
    assert.equal(empty.body.rows.length, 0, "no rows past the cursor before the re-upsert");

    const second = await postBatch(h.base, "dayglance", account, [{ entityId: "e1", envelope: envB }]);
    assert.ok(second.body.maxSeq > cursor, "the re-upsert was assigned a higher seq");

    const after = await listRows(h.base, "dayglance", account, cursor);
    assert.equal(after.body.rows.length, 1, "the re-upserted row appears past the old cursor");
    assert.equal(after.body.rows[0].entityId, "e1");
    assert.equal(after.body.rows[0].envelope, envB, "the new envelope is returned");
    assert.ok(after.body.rows[0].seq > cursor);
  } finally {
    h.close();
  }
});

// 4. Incremental fetch correctness, including hasMore. hasMore reflects whether
// rows remain beyond the returned page (computed by over-fetching limit + 1),
// not merely whether the page is full.
test("incremental fetch returns only rows past the cursor and reports hasMore", async () => {
  const h = await startServer();
  try {
    const account = "acct-incr";

    // Write N rows, fetch from 0, expect all N.
    const N = 3;
    const firstRows = Array.from({ length: N }, (_u, i) => ({
      entityId: `n${i}`,
      envelope: garbageEnvelope(),
    }));
    const firstWrite = await postBatch(h.base, "dayglance", account, firstRows);
    const cursor = firstWrite.body.maxSeq;

    const page1 = await listRows(h.base, "dayglance", account, 0);
    assert.equal(page1.body.rows.length, N, "all N rows returned from cursor 0");
    assert.equal(page1.body.hasMore, false, "no more rows beyond the full set");

    // Write M more, fetch from the prior cursor, expect exactly M.
    const M = 2;
    const moreRows = Array.from({ length: M }, (_u, i) => ({
      entityId: `m${i}`,
      envelope: garbageEnvelope(),
    }));
    await postBatch(h.base, "dayglance", account, moreRows);

    const page2 = await listRows(h.base, "dayglance", account, cursor);
    assert.equal(page2.body.rows.length, M, "exactly the M newer rows returned");

    // Paging: N + M = 5 rows total. A limit-2 page from 0 has more behind it.
    const p = await listRows(h.base, "dayglance", account, 0, 2);
    assert.equal(p.body.rows.length, 2);
    assert.equal(p.body.hasMore, true, "a full page with rows behind it reports hasMore");

    const c2 = p.body.rows[p.body.rows.length - 1].seq;
    const p2 = await listRows(h.base, "dayglance", account, c2, 2);
    assert.equal(p2.body.rows.length, 2);
    assert.equal(p2.body.hasMore, true);

    const c3 = p2.body.rows[p2.body.rows.length - 1].seq;
    const p3 = await listRows(h.base, "dayglance", account, c3, 2);
    assert.equal(p3.body.rows.length, 1, "the last partial page");
    assert.equal(p3.body.hasMore, false, "no rows remain past the last page");
  } finally {
    h.close();
  }
});

// 5. Soft-delete: the row comes back in a list as deleted with an advanced seq,
// and the single-row GET reflects the deletion too.
test("soft-delete marks the row deleted and advances its seq", async () => {
  const h = await startServer();
  try {
    const account = "acct-del";
    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: "e1", envelope: garbageEnvelope() },
    ]);
    const seqBefore = write.body.maxSeq;

    const res = await fetch(
      `${h.base}/sync/dayglance/e1?accountId=${account}`,
      { method: "DELETE", headers: authHeaders() },
    );
    assert.equal(res.status, 200);
    const delBody = (await res.json()) as { seq: number };
    assert.ok(delBody.seq > seqBefore, "delete assigned a higher seq");

    const listed = await listRows(h.base, "dayglance", account, 0);
    assert.equal(listed.body.rows.length, 1);
    assert.equal(listed.body.rows[0].deleted, true, "tombstone shows deleted true");
    assert.equal(listed.body.rows[0].seq, delBody.seq, "list reflects the advanced seq");

    // The tombstone also appears past the pre-delete cursor.
    const sinceBefore = await listRows(h.base, "dayglance", account, seqBefore);
    assert.equal(sinceBefore.body.rows.length, 1);
    assert.equal(sinceBefore.body.rows[0].deleted, true);

    const getRes = await fetch(
      `${h.base}/sync/dayglance/e1?accountId=${account}`,
      { headers: authHeaders() },
    );
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as WireRow;
    assert.equal(getBody.deleted, true, "single-row GET reflects deleted true");
    assert.equal(getBody.seq, delBody.seq);

    // Deleting a row the server never saw is a 404.
    const missing = await fetch(
      `${h.base}/sync/dayglance/nope?accountId=${account}`,
      { method: "DELETE", headers: authHeaders() },
    );
    assert.equal(missing.status, 404);
  } finally {
    h.close();
  }
});

// 5b. Envelope losslessness: the exact ciphertext bytes a client uploads via
// batch come back byte-for-byte from list. The client stores base64(IV||GCM) and
// the server treats it as an opaque BLOB, so any re-encoding/padding/truncation
// here would corrupt every pulled row. Uses raw random bytes (not valid GCM) to
// prove the path is byte-transparent, independent of any envelope structure.
test("envelope round-trips byte-identically through batch then list", async () => {
  const h = await startServer();
  try {
    const account = "acct-envelope";

    // A spread of payload sizes, including ones whose length is not a multiple
    // of 3 so base64 padding ("=") is exercised, and a zero-length envelope.
    const raws = [
      randomBytes(1),
      randomBytes(2),
      randomBytes(12 + 16), // a plausible IV(12) || 16-byte GCM tag, no plaintext
      randomBytes(100),
      randomBytes(257),
      Buffer.alloc(0),
    ];
    const rows = raws.map((raw, i) => ({ entityId: `env${i}`, envelope: raw.toString("base64") }));

    const written = await postBatch(h.base, "dayglance", account, rows);
    assert.equal(written.status, 200);
    assert.equal(written.body.written, rows.length);

    const listed = await listRows(h.base, "dayglance", account, 0);
    assert.equal(listed.body.rows.length, rows.length);
    const byId = new Map(listed.body.rows.map((r) => [r.entityId, r]));

    for (let i = 0; i < rows.length; i++) {
      const returned = byId.get(`env${i}`);
      assert.ok(returned, `row env${i} came back`);
      assert.equal(returned.envelope, rows[i].envelope, `env${i} base64 string is unchanged`);
      assert.deepEqual(
        Buffer.from(returned.envelope, "base64"),
        raws[i],
        `env${i} decodes to the exact bytes that were uploaded`,
      );
    }
  } finally {
    h.close();
  }
});

// 6. Cross-app isolation: rows written under one app never surface in a list for
// another app on the same account.
test("apps are isolated within an account", async () => {
  const h = await startServer();
  try {
    const account = "acct-apps";

    await postBatch(h.base, "dayglance", account, [
      { entityId: "d1", envelope: garbageEnvelope() },
      { entityId: "d2", envelope: garbageEnvelope() },
    ]);

    const lastEmpty = await listRows(h.base, "lastglance", account, 0);
    assert.equal(lastEmpty.body.rows.length, 0, "dayglance rows do not leak into lastglance");

    await postBatch(h.base, "lastglance", account, [
      { entityId: "l1", envelope: garbageEnvelope() },
    ]);

    const dayRows = await listRows(h.base, "dayglance", account, 0);
    assert.equal(dayRows.body.rows.length, 2, "dayglance still has exactly its own rows");
    const lastRows = await listRows(h.base, "lastglance", account, 0);
    assert.equal(lastRows.body.rows.length, 1, "lastglance has only its own row");

    // And an unknown app is rejected.
    const bad = await fetch(`${h.base}/sync/bogus/list?accountId=${account}`, {
      headers: authHeaders(),
    });
    assert.equal(bad.status, 400, "unknown app is rejected");
  } finally {
    h.close();
  }
});

// 7. Key-verifier (sync >= 1.5.0): the client reads a reserved row
// "__glance_keycheck" once per session to validate the passphrase before
// syncing. A missing verifier MUST be 404 (the client treats 404 as "new
// account" and then writes the verifier), never 400 -- reserved "__glance_*"
// ids are opaque, client-chosen strings and must not be format-rejected.
const KEYCHECK = "__glance_keycheck";

test("GET of a non-existent key-verifier row returns 404, not 400", async () => {
  const h = await startServer();
  try {
    const got = await getRow(h.base, "dayglance", "acct-keycheck-new", KEYCHECK);
    assert.equal(got.status, 404, "a new account's verifier read is 404, never 400");
  } finally {
    h.close();
  }
});

test("the key-verifier writes via batch and then reads back and lists", async () => {
  const h = await startServer();
  try {
    const account = "acct-keycheck-write";
    const envelope = garbageEnvelope();

    // The client writes the verifier via batch with insertOnly.
    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: KEYCHECK, envelope, insertOnly: true },
    ]);
    assert.equal(write.status, 200, "the reserved id is accepted on batch, not 400");
    assert.equal(write.body.written, 1);

    // The single-row GET now returns 200 with the verifier.
    const got = await getRow(h.base, "dayglance", account, KEYCHECK);
    assert.equal(got.status, 200);
    const row = got.body as WireRow;
    assert.equal(row.entityId, KEYCHECK);
    assert.equal(row.envelope, envelope, "the stored verifier envelope is returned intact");
    assert.equal(row.deleted, false);
    assert.ok(typeof row.seq === "number");

    // It is stored and returned like any other row, so it also appears in list.
    const listed = await listRows(h.base, "dayglance", account, 0);
    const found = listed.body.rows.find((r) => r.entityId === KEYCHECK);
    assert.ok(found, "the verifier appears in list like any other row");
    assert.equal(found?.envelope, envelope);
  } finally {
    h.close();
  }
});

test("a second insertOnly write of the key-verifier does not overwrite it", async () => {
  const h = await startServer();
  try {
    const account = "acct-keycheck-firstwins";
    const original = garbageEnvelope();
    const other = garbageEnvelope();
    assert.notEqual(original, other);

    const first = await postBatch(h.base, "dayglance", account, [
      { entityId: KEYCHECK, envelope: original, insertOnly: true },
    ]);
    assert.equal(first.body.written, 1);
    const seqAfterFirst = first.body.maxSeq;

    // A racing/second device tries to write a different verifier with insertOnly.
    const second = await postBatch(h.base, "dayglance", account, [
      { entityId: KEYCHECK, envelope: other, insertOnly: true },
    ]);
    assert.equal(second.status, 200);
    assert.equal(second.body.written, 0, "the existing verifier was skipped, not overwritten");
    assert.equal(second.body.maxSeq, 0, "no new seq was consumed by the skipped insert-only row");

    // The stored verifier is still the first writer's, unchanged.
    const got = await getRow(h.base, "dayglance", account, KEYCHECK);
    const row = got.body as WireRow;
    assert.equal(row.envelope, original, "first-write-wins: the original verifier survives");
    assert.equal(row.seq, seqAfterFirst, "the verifier's seq did not advance");
  } finally {
    h.close();
  }
});
