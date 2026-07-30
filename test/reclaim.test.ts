import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";
import { buildApp } from "../src/server.js";
import { reclaimSweep, type ReclaimPolicy } from "../src/reclaim.js";

const TOKEN = "hammer-token";
const DAY = 24 * 60 * 60 * 1000;

// A live server backed by a real SQLite file and on-disk blob store, mirroring
// the blobs harness, but also exposing the blobStore so reclaim can be driven
// and asserted at the storage level. reclaimSweep is called directly with an
// injected `now`, exactly as the intents prune tests call the store method
// directly (reclaim has no request-hot-path endpoint; it is a periodic sweep).
interface Harness {
  base: string;
  store: SqliteStore;
  blobStore: DiskBlobStore;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-reclaim-"));
  const path = join(dir, "test.db");
  const blobDir = join(dir, "blobs");
  const store = new SqliteStore(path);
  store.migrate();
  const blobStore = new DiskBlobStore(blobDir);
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [], blobStorePath: blobDir },
    store,
    blobStore,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    blobStore,
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

function blobHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function garbageBlob(bytes = 1024): Buffer {
  return randomBytes(bytes);
}

// Upload one whole blob as a single part and finalize it. Returns the hash.
async function uploadBlob(base: string, accountId: string, bytes: Buffer): Promise<string> {
  const hash = blobHash(bytes);
  const init = await fetch(`${base}/blobs/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, blobHash: hash, size: bytes.length }),
  });
  const initBody = (await init.json()) as { uploadId?: string; exists?: boolean };
  if (initBody.exists) {
    return hash; // already stored (idempotent)
  }
  const uploadId = initBody.uploadId as string;
  const url = new URL(`${base}/blobs/uploads/${uploadId}/parts/0`);
  url.searchParams.set("accountId", accountId);
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` },
    body: bytes,
  });
  const fin = await fetch(`${base}/blobs/uploads/${uploadId}/finalize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId }),
  });
  assert.equal(fin.status, 200, "upload finalized");
  return hash;
}

async function refAdd(base: string, accountId: string, hash: string): Promise<number> {
  const res = await fetch(`${base}/blobs/${hash}/ref-add`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { refCount: number }).refCount;
}

async function refRelease(base: string, accountId: string, hash: string): Promise<number> {
  const res = await fetch(`${base}/blobs/${hash}/ref-release`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { refCount: number }).refCount;
}

async function headExists(base: string, accountId: string, hash: string): Promise<number> {
  const url = new URL(`${base}/blobs/${hash}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { method: "HEAD", headers: authHeaders() });
  return res.status;
}

// Standard policy: reclaim ON, 30-day grace, 90-day dead threshold.
function onPolicy(overrides: Partial<ReclaimPolicy> = {}): ReclaimPolicy {
  return { reclaim: true, gracePeriodMs: 30 * DAY, deadDevicePeriodMs: 90 * DAY, ...overrides };
}

const QUIET = (): void => {}; // silence reclaim's per-blob log in tests

// SAFETY 1. With reclaim OFF (the default RETAIN policy), the sweep deletes
// NOTHING regardless of references or age. This is the whole safety net for a
// self-hoster who never opts in.
test("reclaim off (retain default) deletes nothing", async () => {
  const h = await startServer();
  try {
    const account = "acct-retain";
    const bytes = garbageBlob();
    const hash = await uploadBlob(h.base, account, bytes);
    // At zero references from creation; even far in the future...
    const far = new Date(Date.now() + 1000 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, { reclaim: false, gracePeriodMs: 0, deadDevicePeriodMs: 0 }, far, QUIET);

    assert.equal(result.enabled, false, "the sweep reports it did not run");
    assert.deepEqual(result.reclaimed, [], "nothing was reclaimed");
    assert.equal(await headExists(h.base, account, hash), 200, "the blob is retained");
    assert.ok(h.store.forAccount(account).getBlob(hash), "the row is retained");
    assert.ok(h.blobStore.exists(hash), "the bytes are retained");
  } finally {
    h.close();
  }
});

// SAFETY 2. A blob with any live reference is never deleted (condition a).
test("a blob with references is never reclaimed", async () => {
  const h = await startServer();
  try {
    const account = "acct-ref";
    const hash = await uploadBlob(h.base, account, garbageBlob());
    assert.equal(await refAdd(h.base, account, hash), 1);

    // Reclaim on, generous time so only the reference itself protects it.
    const far = new Date(Date.now() + 1000 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy({ gracePeriodMs: 0 }), far, QUIET);
    assert.deepEqual(result.reclaimed, [], "a referenced blob is not eligible");
    assert.equal(await headExists(h.base, account, hash), 200);
  } finally {
    h.close();
  }
});

// SAFETY 3. A blob still within the grace window is never deleted (condition b),
// even at zero references with no devices to block it.
test("a blob within the grace window is never reclaimed", async () => {
  const h = await startServer();
  try {
    const account = "acct-grace";
    const hash = await uploadBlob(h.base, account, garbageBlob());
    // Zero refs from creation; last activity ~ now. One day later is well inside
    // a 30-day grace window.
    const soon = new Date(Date.now() + 1 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy(), soon, QUIET);
    assert.deepEqual(result.reclaimed, [], "grace has not elapsed, so not eligible");
    assert.equal(await headExists(h.base, account, hash), 200);
  } finally {
    h.close();
  }
});

// SAFETY 4. A non-dead device that has NOT acked past the blob's zero point
// blocks deletion (condition c) — it might hold a reference the server has not
// seen — even though grace has elapsed.
test("an unacked non-dead device blocks reclaim", async () => {
  const h = await startServer();
  try {
    const account = "acct-unacked";
    const hash = await uploadBlob(h.base, account, garbageBlob());
    const rec = h.store.forAccount(account).getBlob(hash);
    assert.ok(rec?.zeroRefSeq != null);

    // A device that is behind the zero point (last_seen_seq 0 < zero_ref_seq).
    h.store.forAccount(account).updateDeviceCursor("dev-behind", 0);

    // 40 days on: grace (30d) elapsed, but the device is non-dead (< 90d) and
    // behind the zero point, so it blocks.
    const later = new Date(Date.now() + 40 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);
    assert.deepEqual(result.reclaimed, [], "a non-dead unacked device blocks deletion");
    assert.equal(await headExists(h.base, account, hash), 200);
  } finally {
    h.close();
  }
});

// SAFETY 5. A device past the DEAD threshold is excluded from condition c, so a
// blob it has not acked can still be reclaimed (you cannot wait forever for a
// vanished device).
test("a dead device is excluded so reclaim can proceed", async () => {
  const h = await startServer();
  try {
    const account = "acct-dead";
    const hash = await uploadBlob(h.base, account, garbageBlob());

    // Same behind-the-zero-point device as the previous test...
    h.store.forAccount(account).updateDeviceCursor("dev-behind", 0);

    // ...but now 100 days on: the device (last active ~ real now) is past the
    // 90-day dead threshold, so it is excluded; grace (30d) has elapsed; zero
    // references. All three conditions hold → reclaimed.
    const later = new Date(Date.now() + 100 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);
    assert.equal(result.reclaimed.length, 1, "the dead device does not block reclaim");
    assert.equal(result.reclaimed[0].blobHash, hash);
    assert.equal(await headExists(h.base, account, hash), 404, "bytes + row deleted");
    assert.equal(h.store.forAccount(account).getBlob(hash), null);
    assert.equal(h.blobStore.exists(hash), false);
  } finally {
    h.close();
  }
});

// SAFETY 6. A blob that goes 0 -> 1 -> ... must NOT be reclaimed: re-referencing
// before reclaim restores ref_count > 0 and clears the (now stale) zero point.
test("a blob re-referenced after hitting zero is not reclaimed", async () => {
  const h = await startServer();
  try {
    const account = "acct-revive";
    const hash = await uploadBlob(h.base, account, garbageBlob());
    assert.equal(await refAdd(h.base, account, hash), 1); // 0 -> 1
    assert.equal(await refRelease(h.base, account, hash), 0); // 1 -> 0, zero point stamped
    const atZero = h.store.forAccount(account).getBlob(hash);
    assert.notEqual(atZero?.zeroRefSeq, null, "zero point recorded at zero");

    assert.equal(await refAdd(h.base, account, hash), 1); // 0 -> 1 again
    const revived = h.store.forAccount(account).getBlob(hash);
    assert.equal(revived?.refCount, 1);
    assert.equal(revived?.zeroRefSeq, null, "zero point cleared on re-reference");

    // Even far in the future with grace elapsed, ref_count > 0 keeps it.
    const far = new Date(Date.now() + 1000 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy({ gracePeriodMs: 0 }), far, QUIET);
    assert.deepEqual(result.reclaimed, [], "a revived blob is not reclaimed");
    assert.equal(await headExists(h.base, account, hash), 200);
  } finally {
    h.close();
  }
});

// CORE. When all three conditions hold (zero refs, grace elapsed, every non-dead
// device acked past the zero point) the blob IS deleted — both the bytes and the
// row. Also: repeated sweeps are idempotent, and a reclaimed hash can be
// re-uploaded afterward (self-heal), proving reclaim leaves no rejecting state.
test("an eligible blob is reclaimed (bytes + row), idempotently, and can be re-uploaded", async () => {
  const h = await startServer();
  try {
    const account = "acct-eligible";
    const bytes = garbageBlob(2048);
    const hash = await uploadBlob(h.base, account, bytes);
    const rec = h.store.forAccount(account).getBlob(hash);
    assert.ok(rec?.zeroRefSeq != null);

    // A device that HAS acked past the zero point (last_seen_seq >= zero_ref_seq):
    // condition c is satisfied even though the device is alive.
    h.store.forAccount(account).updateDeviceCursor("dev-acked", rec.zeroRefSeq);

    // 40 days on: grace elapsed, device non-dead but acked, zero references.
    const later = new Date(Date.now() + 40 * DAY);
    const result = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);

    assert.equal(result.enabled, true);
    assert.equal(result.reclaimed.length, 1, "the eligible blob was reclaimed");
    assert.equal(result.reclaimed[0].blobHash, hash);
    assert.equal(result.reclaimed[0].size, bytes.length);
    assert.equal(h.store.forAccount(account).getBlob(hash), null, "the row is gone");
    assert.equal(h.blobStore.exists(hash), false, "the bytes are gone");
    assert.equal(await headExists(h.base, account, hash), 404);

    // Idempotent: a second immediate sweep finds nothing and does not error.
    const again = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);
    assert.deepEqual(again.reclaimed, [], "nothing left to reclaim on the second sweep");

    // Self-heal: a device that still holds the original re-uploads it. Because
    // reclaim left no tombstone, the re-upload of the same hash is accepted and
    // lands at the same address.
    const rehash = await uploadBlob(h.base, account, bytes);
    assert.equal(rehash, hash, "re-upload lands at the same content address");
    assert.equal(await headExists(h.base, account, hash), 200, "the blob is back");
    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", account);
    const dl = await fetch(url, { headers: authHeaders() });
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, "re-uploaded bytes round-trip");
  } finally {
    h.close();
  }
});

// SAFETY (multi-account / multi-device). The zero-point comparison is per
// account: an acked device in one account never satisfies condition c for a
// blob in another, and a single still-behind device blocks even when others are
// acked.
test("reclaim eligibility is evaluated per account and across all devices", async () => {
  const h = await startServer();
  try {
    // Account A: two devices, one acked past the zero point, one still behind.
    const account = "acct-multi";
    const hash = await uploadBlob(h.base, account, garbageBlob());
    const rec = h.store.forAccount(account).getBlob(hash);
    assert.ok(rec?.zeroRefSeq != null);
    h.store.forAccount(account).updateDeviceCursor("dev-acked", rec.zeroRefSeq);
    h.store.forAccount(account).updateDeviceCursor("dev-behind", 0);

    const later = new Date(Date.now() + 40 * DAY);
    let result = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);
    assert.deepEqual(result.reclaimed, [], "one behind non-dead device blocks the whole blob");
    assert.equal(await headExists(h.base, account, hash), 200);

    // Once the lagging device catches up, the blob becomes eligible.
    h.store.forAccount(account).updateDeviceCursor("dev-behind", rec.zeroRefSeq);
    result = reclaimSweep(h.store, h.blobStore, onPolicy(), later, QUIET);
    assert.equal(result.reclaimed.length, 1, "all devices acked → eligible");
    assert.equal(h.store.forAccount(account).getBlob(hash), null);
  } finally {
    h.close();
  }
});
