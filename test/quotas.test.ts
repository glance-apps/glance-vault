import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";
import { makeQuotaGate } from "../src/quotas.js";
import type { Config } from "../src/config.js";

// Phase 3.2: per-account quota enforcement. The contract under test:
//   - storage gates BLOB-attributable bytes (stored + in-flight declared
//     reservations) at initiate, 413; finalize re-checks (belt-and-suspenders
//     for a limit lowered mid-upload).
//   - rows gates NET-NEW sync entities only, 413.
//   - intents gates current non-expired volume, 429, self-healing via TTL.
//   - concurrent uploads gate session count, 429.
//   - the rejection body is EXACTLY
//     { error: "quota exceeded", quota, limit, used, requested } — the shape
//     Phase 3.3 renders. The SSE per-account 429 keeps its legacy body as the
//     documented exception.
//   - the never-gated list: reads, updates to existing entities, soft-delete,
//     device cursors, salt, ref ops, dedup re-upload, cancel, enroll.
//   - a rejection mutates nothing (checks run before writes, outside every
//     transaction).
// Ground truth is computed from what the TEST sent, or read straight off the
// store — never from the gate being verified.

const TOKEN = "quota-device-token";
const SECRET = "quota-bootstrap-secret";

interface Harness {
  base: string;
  store: SqliteStore;
  blobStore: DiskBlobStore;
  close: () => void;
}

// Shared-mode server by default (quotas are config-driven and mode-blind, and
// shared mode keeps the auth header trivial); pass authMode/enrollmentSecret
// for the per-account test. Quota values go in as Config fields (bytes/counts,
// post-unit-conversion — loadConfig's MB multiplier is covered separately).
async function start(overrides: Partial<Config> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-quota-"));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const blobStore = new DiskBlobStore(join(dir, "blobs"));
  const app = buildApp(
    {
      storagePath: join(dir, "test.db"),
      port: 0,
      deviceToken: TOKEN,
      allowedOrigins: [],
      ...overrides,
    },
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
      (server as Server & { closeAllConnections(): void }).closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const H = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

function hashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function initiate(base: string, accountId: string, blobHash: string, size: number) {
  return fetch(`${base}/blobs/uploads`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ accountId, blobHash, size }),
  });
}

// Full happy-path upload: initiate, one part, finalize. Asserts every step so a
// quota that misfires on a path that should be open fails loudly here.
async function uploadBlob(base: string, accountId: string, bytes: Buffer): Promise<string> {
  const hash = hashOf(bytes);
  const init = await initiate(base, accountId, hash, bytes.length);
  assert.equal(init.status, 201, `initiate admitted (${await init.clone().text()})`);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const part = await fetch(`${base}/blobs/uploads/${uploadId}/parts/0?accountId=${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(bytes),
  });
  assert.equal(part.status, 200);
  const fin = await fetch(`${base}/blobs/uploads/${uploadId}/finalize`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ accountId }),
  });
  assert.equal(fin.status, 200, `finalize admitted (${await fin.clone().text()})`);
  return hash;
}

async function syncBatch(base: string, accountId: string, entityIds: string[], envelopeBytes = 32) {
  return fetch(`${base}/sync/dayglance/batch`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      accountId,
      rows: entityIds.map((entityId) => ({
        entityId,
        envelope: randomBytes(envelopeBytes).toString("base64"),
        deleted: false,
      })),
    }),
  });
}

async function sendIntents(base: string, accountId: string, eventIds: string[], expiresAt: string) {
  return fetch(`${base}/intents/batch`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      accountId,
      events: eventIds.map((eventId) => ({
        eventId,
        envelope: randomBytes(24).toString("base64"),
        expiresAt,
      })),
    }),
  });
}

test("storage quota: 413 at initiate with the exact 3.3 body, and the rejection mutates nothing", async () => {
  const h = await start({ quotaStorageBytes: 500 });
  try {
    await uploadBlob(h.base, "house-q", randomBytes(300));

    const before = h.store.usageForAccount("house-q");
    const res = await initiate(h.base, "house-q", hashOf(randomBytes(8)), 300);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), {
      error: "quota exceeded",
      quota: "storage",
      limit: 500,
      used: 300,
      requested: 300,
    });

    // Nothing moved: no session row, no reservation, no staged bytes, and the
    // account's usage report is unchanged.
    assert.deepEqual(h.store.blobFootprint("house-q"), {
      blobBytes: 300,
      sessionCount: 0,
      declaredBytes: 0,
    });
    assert.deepEqual(h.store.usageForAccount("house-q"), before);

    // An exact fit is admitted: the check is strictly `>`, so used + requested
    // == limit passes (300 + 200 = 500).
    assert.equal((await initiate(h.base, "house-q", hashOf(randomBytes(8)), 200)).status, 201);
  } finally {
    h.close();
  }
});

test("reservations hold: sequential initiates count in-flight declared bytes; cancel releases", async () => {
  const h = await start({ quotaStorageBytes: 1000 });
  try {
    const a = await initiate(h.base, "house-r", hashOf(randomBytes(8)), 400);
    assert.equal(a.status, 201);
    const b = await initiate(h.base, "house-r", hashOf(randomBytes(8)), 400);
    assert.equal(b.status, 201);
    const { uploadId: bId } = (await b.json()) as { uploadId: string };

    // Zero bytes stored, yet a third 400 is over: reservations are real.
    const c1 = await initiate(h.base, "house-r", hashOf(randomBytes(8)), 400);
    assert.equal(c1.status, 413);
    assert.deepEqual(await c1.json(), {
      error: "quota exceeded",
      quota: "storage",
      limit: 1000,
      used: 800,
      requested: 400,
    });

    // Cancelling one session releases exactly its reservation.
    const cancel = await fetch(`${h.base}/blobs/uploads/${bId}?accountId=house-r`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { uploadId: bId, cancelled: true });
    assert.equal((await initiate(h.base, "house-r", hashOf(randomBytes(8)), 400)).status, 201);
  } finally {
    h.close();
  }
});

test("reservations hold under CONCURRENT initiates: exactly the admissible count wins", async () => {
  const h = await start({ quotaStorageBytes: 1000 });
  try {
    // Five parallel initiates of 400 bytes each against a 1000-byte limit:
    // exactly two fit (800), the other three must see the reservations and be
    // rejected. check-then-create is synchronous per event-loop turn, so no
    // interleaving can admit a third.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => initiate(h.base, "house-c", hashOf(randomBytes(8)), 400)),
    );
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 413, 413, 413]);
    assert.deepEqual(h.store.blobFootprint("house-c"), {
      blobBytes: 0,
      sessionCount: 2,
      declaredBytes: 800,
    });
  } finally {
    h.close();
  }
});

test("cancel discards staged bytes with the session; a repeat cancel is 404", async () => {
  const h = await start({ quotaStorageBytes: 10_000 });
  try {
    const bytes = randomBytes(600);
    const init = await initiate(h.base, "house-x", hashOf(bytes), bytes.length);
    assert.equal(init.status, 201);
    const { uploadId } = (await init.json()) as { uploadId: string };
    await fetch(`${h.base}/blobs/uploads/${uploadId}/parts/0?accountId=house-x`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array(bytes),
    });
    assert.deepEqual(h.store.usageForAccount("house-x").uploads, {
      sessions: 1,
      stagedBytes: 600,
    });

    const del = await fetch(`${h.base}/blobs/uploads/${uploadId}?accountId=house-x`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(del.status, 200);
    assert.deepEqual(h.store.usageForAccount("house-x").uploads, { sessions: 0, stagedBytes: 0 });

    // Gone means gone: cancel and status both 404 now, like any unknown id.
    const again = await fetch(`${h.base}/blobs/uploads/${uploadId}?accountId=house-x`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(again.status, 404);
  } finally {
    h.close();
  }
});

test("concurrent-uploads cap: 429 with the quota body; cancel reopens a slot", async () => {
  const h = await start({ quotaUploads: 2 });
  try {
    assert.equal((await initiate(h.base, "house-u", hashOf(randomBytes(8)), 100)).status, 201);
    const second = await initiate(h.base, "house-u", hashOf(randomBytes(8)), 100);
    assert.equal(second.status, 201);
    const { uploadId } = (await second.json()) as { uploadId: string };

    const third = await initiate(h.base, "house-u", hashOf(randomBytes(8)), 100);
    assert.equal(third.status, 429);
    assert.deepEqual(await third.json(), {
      error: "quota exceeded",
      quota: "concurrent-uploads",
      limit: 2,
      used: 2,
      requested: 1,
    });

    await fetch(`${h.base}/blobs/uploads/${uploadId}?accountId=house-u`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal((await initiate(h.base, "house-u", hashOf(randomBytes(8)), 100)).status, 201);
  } finally {
    h.close();
  }
});

test("row cap gates only NET-NEW entities; updates at the cap and soft-deletes stay open", async () => {
  const h = await start({ quotaRows: 3 });
  try {
    assert.equal((await syncBatch(h.base, "house-rows", ["a", "b", "c"])).status, 200);

    // At the cap, updating existing entities is never blocked — the sync
    // client's constant re-upserts keep working.
    assert.equal((await syncBatch(h.base, "house-rows", ["a", "b"])).status, 200);

    // One net-new entity over the cap: rejected, and the mixed batch is
    // rejected WHOLE (the existing entity "c" is not updated piecemeal).
    const cBefore = (await (
      await fetch(`${h.base}/sync/dayglance/c?accountId=house-rows`, { headers: H })
    ).json()) as { seq: number };
    const over = await syncBatch(h.base, "house-rows", ["c", "d"]);
    assert.equal(over.status, 413);
    assert.deepEqual(await over.json(), {
      error: "quota exceeded",
      quota: "rows",
      limit: 3,
      used: 3,
      requested: 1,
    });
    assert.equal(
      (await fetch(`${h.base}/sync/dayglance/d?accountId=house-rows`, { headers: H })).status,
      404,
      "rejected batch wrote nothing",
    );
    const cAfter = (await (
      await fetch(`${h.base}/sync/dayglance/c?accountId=house-rows`, { headers: H })
    ).json()) as { seq: number };
    assert.equal(cAfter.seq, cBefore.seq, "rejected batch did not touch the existing row either");

    // Soft-delete is NEVER gated (recovery + tombstone-GC safety) — and the
    // tombstone still occupies a row (envelope kept), so the cap stays hit:
    // row-count recovery is tombstone GC or an operator raise, by design.
    assert.equal(
      (await fetch(`${h.base}/sync/dayglance/a?accountId=house-rows`, { method: "DELETE", headers: H })).status,
      200,
    );
    assert.equal((await syncBatch(h.base, "house-rows", ["d"])).status, 413);
  } finally {
    h.close();
  }
});

test("intent cap: 429 with the quota body, and it self-heals as TTLs expire", async () => {
  const h = await start({ quotaIntents: 2 });
  try {
    const far = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await sendIntents(h.base, "house-i", ["i1", "i2"], far)).status, 200);
    const over = await sendIntents(h.base, "house-i", ["i3"], far);
    assert.equal(over.status, 429);
    assert.deepEqual(await over.json(), {
      error: "quota exceeded",
      quota: "intents",
      limit: 2,
      used: 2,
      requested: 1,
    });

    // Self-recovery: the count is CURRENT non-expired volume, so once TTLs
    // pass the account is admitted again with no operator action.
    const soon = new Date(Date.now() + 80).toISOString();
    assert.equal((await sendIntents(h.base, "house-t", ["t1", "t2"], soon)).status, 200);
    assert.equal((await sendIntents(h.base, "house-t", ["t3"], soon)).status, 429);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await sendIntents(h.base, "house-t", ["t4"], far)).status, 200);
  } finally {
    h.close();
  }
});

test("an over-quota account keeps every exit: the never-gated list, end to end", async () => {
  // Limits set BELOW what the account already holds — the "already over on
  // upgrade day" shape. Seeded through the store directly, since the point is
  // to start beyond the line.
  const h = await start({ quotaStorageBytes: 100, quotaRows: 1, quotaIntents: 1, quotaUploads: 1 });
  try {
    const scope = h.store.forAccount("house-over");
    scope.batchUpsert("dayglance", [
      { entityId: "a", envelope: randomBytes(40), deleted: false },
      { entityId: "b", envelope: randomBytes(40), deleted: false },
    ]);
    const blob = randomBytes(200); // 200 stored > 100 limit
    const hash = hashOf(blob);
    h.blobStore.put(hash, blob);
    scope.insertBlobIfAbsent(hash, blob.length);

    // Reads: list, single row, blob download.
    assert.equal((await fetch(`${h.base}/sync/dayglance/list?accountId=house-over`, { headers: H })).status, 200);
    assert.equal((await fetch(`${h.base}/sync/dayglance/a?accountId=house-over`, { headers: H })).status, 200);
    assert.equal((await fetch(`${h.base}/blobs/${hash}?accountId=house-over`, { headers: H })).status, 200);

    // Updating an EXISTING entity while over the row cap: open.
    assert.equal((await syncBatch(h.base, "house-over", ["a"])).status, 200);
    // A new entity: gated (this is the cap doing its one job).
    assert.equal((await syncBatch(h.base, "house-over", ["z"])).status, 413);

    // Soft-delete and device cursor: open (recovery and GC safety).
    assert.equal(
      (await fetch(`${h.base}/sync/dayglance/b?accountId=house-over`, { method: "DELETE", headers: H })).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${h.base}/sync/dayglance/device`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({ accountId: "house-over", deviceId: "phone", lastSeenSeq: 1 }),
        })
      ).status,
      200,
    );

    // Ref ops: open (releasing references is how reclaim ever helps).
    assert.equal(
      (
        await fetch(`${h.base}/blobs/${hash}/ref-release`, {
          method: "POST",
          headers: H,
          body: JSON.stringify({ accountId: "house-over" }),
        })
      ).status,
      200,
    );

    // Dedup re-initiate of an ALREADY-OWNED hash: zero new bytes, always
    // admitted — the client self-heal path survives being over quota.
    const dedup = await initiate(h.base, "house-over", hash, blob.length);
    assert.equal(dedup.status, 200);
    assert.deepEqual(await dedup.json(), { exists: true, blobHash: hash });

    // A NEW hash is gated — over quota means no new media, nothing else.
    assert.equal((await initiate(h.base, "house-over", hashOf(randomBytes(8)), 10)).status, 413);

    // Salt: open in both directions.
    const salt = randomBytes(16).toString("base64");
    assert.equal(
      (
        await fetch(`${h.base}/salt/house-over`, {
          method: "PUT",
          headers: H,
          body: JSON.stringify({ salt }),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${h.base}/salt/house-over`, { headers: H })).status, 200);

    // Cancel: open — it RELEASES reservation, so gating it would be a trap.
    scope.createUploadSession("stuck-upload", hashOf(randomBytes(8)), 50);
    assert.equal(
      (
        await fetch(`${h.base}/blobs/uploads/stuck-upload?accountId=house-over`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
      200,
    );

    // And the quotas are PER-account: a sibling account on the same server is
    // entirely unaffected by house-over's state.
    assert.equal((await syncBatch(h.base, "house-else", ["fresh"])).status, 200);
  } finally {
    h.close();
  }
});

test("finalize re-checks: a limit lowered mid-upload rejects and cleans up like a hash mismatch", async () => {
  // Two apps over the SAME store and blob dir simulate an operator restart
  // with a lower limit between initiate and finalize — the only way the
  // belt-and-suspenders check can trip (admission math covers everything else).
  const dir = mkdtempSync(join(tmpdir(), "glancevault-quota-refin-"));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const blobStore = new DiskBlobStore(join(dir, "blobs"));
  const baseConfig = { storagePath: join(dir, "test.db"), port: 0, deviceToken: TOKEN, allowedOrigins: [] };
  const highApp = buildApp({ ...baseConfig, quotaStorageBytes: 10_000 }, store, blobStore);
  const lowApp = buildApp({ ...baseConfig, quotaStorageBytes: 500 }, store, blobStore);
  const highServer: Server = await new Promise((resolve) => {
    const s = highApp.listen(0, () => resolve(s));
  });
  const lowServer: Server = await new Promise((resolve) => {
    const s = lowApp.listen(0, () => resolve(s));
  });
  const high = `http://127.0.0.1:${(highServer.address() as AddressInfo).port}`;
  const low = `http://127.0.0.1:${(lowServer.address() as AddressInfo).port}`;
  try {
    const bytes = randomBytes(600);
    const hash = hashOf(bytes);
    const init = await initiate(high, "house-f", hash, bytes.length);
    assert.equal(init.status, 201, "admitted under the original limit");
    const { uploadId } = (await init.json()) as { uploadId: string };
    await fetch(`${high}/blobs/uploads/${uploadId}/parts/0?accountId=house-f`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` },
      body: new Uint8Array(bytes),
    });

    // "Restart with a lower limit": finalize lands on the low-limit instance.
    const fin = await fetch(`${low}/blobs/uploads/${uploadId}/finalize`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ accountId: "house-f" }),
    });
    assert.equal(fin.status, 413);
    assert.deepEqual(await fin.json(), {
      error: "quota exceeded",
      quota: "storage",
      limit: 500,
      used: 0,
      requested: 600,
    });

    // Cleanup matches the hash-mismatch path: session gone, staged bytes gone,
    // no blob row, no bytes.
    assert.deepEqual(store.blobFootprint("house-f"), { blobBytes: 0, sessionCount: 0, declaredBytes: 0 });
    assert.deepEqual(store.usageForAccount("house-f").uploads, { sessions: 0, stagedBytes: 0 });
    assert.equal(
      (await fetch(`${high}/blobs/uploads/${uploadId}?accountId=house-f`, { headers: H })).status,
      404,
    );
    assert.equal(
      (await fetch(`${high}/blobs/${hash}?accountId=house-f`, { method: "HEAD", headers: H })).status,
      404,
    );
  } finally {
    for (const s of [highServer, lowServer]) {
      (s as Server & { closeAllConnections(): void }).closeAllConnections();
      s.close();
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SSE per-account cap is configurable, and its legacy 429 body stays byte-identical", async () => {
  const h = await start({ maxSseConnectionsPerAccount: 1 });
  try {
    const ac = new AbortController();
    const first = await fetch(`${h.base}/events?accountId=house-s`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    assert.equal(first.status, 200);
    const reader = (first.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value } = await reader.read();
      text += Buffer.from(value!).toString("utf8");
    }

    // Second connection for the SAME account: 429 with the PRE-EXISTING body,
    // not the quota shape — shipped clients match on this exact text, the one
    // documented exception to the uniform rejection body.
    const second = await fetch(`${h.base}/events?accountId=house-s`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(second.status, 429);
    assert.equal(await second.text(), JSON.stringify({ error: "too many connections for account" }));

    // The cap is per-ACCOUNT: a different account still connects.
    const ac2 = new AbortController();
    const other = await fetch(`${h.base}/events?accountId=house-other`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: ac2.signal,
    });
    assert.equal(other.status, 200);
    ac2.abort();
    ac.abort();
  } finally {
    h.close();
  }
});

test("per-account mode: enrollment is never gated, and quotas bind to the credential's account", async () => {
  const h = await start({
    authMode: "per-account",
    enrollmentSecret: SECRET,
    quotaRows: 1,
  });
  try {
    const enroll = async (deviceId: string) => {
      const res = await fetch(`${h.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrollmentSecret: SECRET, accountId: "house-p", deviceId }),
      });
      assert.equal(res.status, 201);
      return ((await res.json()) as { credential: string }).credential;
    };
    const cred = await enroll("phone");
    const HC = { "Content-Type": "application/json", Authorization: `Bearer ${cred}` };

    const fill = await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: HC,
      body: JSON.stringify({
        accountId: "house-p",
        rows: [{ entityId: "only", envelope: randomBytes(16).toString("base64"), deleted: false }],
      }),
    });
    assert.equal(fill.status, 200);

    // Over the row cap now — but enrolling ANOTHER device into this account
    // still works: identity/recovery paths are never quota-gated.
    await enroll("laptop");

    // And the gate fires on the DERIVED account like every other check.
    const over = await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: HC,
      body: JSON.stringify({
        accountId: "house-p",
        rows: [{ entityId: "extra", envelope: randomBytes(16).toString("base64"), deleted: false }],
      }),
    });
    assert.equal(over.status, 413);
  } finally {
    h.close();
  }
});

test("intent cap counts only NET-NEW event ids: an idempotent retry is never rejected", async () => {
  const h = await start({ quotaIntents: 2 });
  try {
    const far = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await sendIntents(h.base, "house-re", ["r1", "r2"], far)).status, 200);

    // The retry trap the gate must not spring: the batch filled the cap, the
    // response was lost, the client re-sends. The write is a no-op (insert-
    // only dedup on eventId), so the gate must admit it.
    const retry = await sendIntents(h.base, "house-re", ["r1", "r2"], far);
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { written: number }).written, 0, "re-send wrote nothing");

    // A mixed batch is gated on its new ids only: r1 is stored, r3 is new and
    // over the cap — rejected, with `requested` counting just the new one.
    const mixed = await sendIntents(h.base, "house-re", ["r1", "r3"], far);
    assert.equal(mixed.status, 429);
    assert.deepEqual(await mixed.json(), {
      error: "quota exceeded",
      quota: "intents",
      limit: 2,
      used: 2,
      requested: 1,
    });

    // Duplicate ids WITHIN a batch count once (one row lands): at 1 of 2 used,
    // ["d1","d1"] is one net-new event and fits.
    assert.equal((await sendIntents(h.base, "house-dup", ["d0"], far)).status, 200);
    assert.equal((await sendIntents(h.base, "house-dup", ["d1", "d1"], far)).status, 200);
  } finally {
    h.close();
  }
});

test("oversized batches: the IN() probes chunk instead of hitting SQLite's variable limit", async () => {
  const h = await start({ quotaRows: 10 });
  try {
    // Unit level: 40k ids is past the 32766-variable ceiling that used to
    // throw "too many SQL variables". Seed a couple among them to prove the
    // chunked count still counts correctly.
    h.store.forAccount("house-big").batchUpsert("dayglance", [
      { entityId: "n7", envelope: randomBytes(8), deleted: false },
      { entityId: "n39999", envelope: randomBytes(8), deleted: false },
    ]);
    const ids = Array.from({ length: 40_000 }, (_, i) => `n${i}`);
    assert.equal(h.store.countExistingEntities("dayglance", "house-big", ids), 2);
    assert.equal(h.store.countExistingIntentEvents("house-big", ids), 0);

    // End to end: a 40k-row batch against the row cap gets a clean 413 (the
    // verdict it deserves), not a 500 from an oversized IN().
    const res = await syncBatch(h.base, "house-big", ids, 8);
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), {
      error: "quota exceeded",
      quota: "rows",
      limit: 10,
      used: 2,
      requested: 39_998,
    });
  } finally {
    h.close();
  }
});

test("no quota configured: makeQuotaGate returns undefined (default-off is structural)", async () => {
  const h = await start(); // no quota keys at all
  try {
    assert.equal(makeQuotaGate(h.store, {}), undefined);
    assert.notEqual(makeQuotaGate(h.store, { rows: 1 }), undefined);

    // And the running unconfigured server admits everything the gated ones
    // above rejected: no residual checks.
    assert.equal((await syncBatch(h.base, "house-free", ["a", "b", "c", "d", "e"])).status, 200);
    assert.equal((await initiate(h.base, "house-free", hashOf(randomBytes(8)), 10_000_000)).status, 201);
  } finally {
    h.close();
  }
});
