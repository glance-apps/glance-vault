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
import { InProcessAccountHub } from "../src/realtime/hub.js";
import { reclaimSweep } from "../src/reclaim.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";

// Phase 3.1: usage accounting, record only. Derived current-state aggregates
// exposed at GET /admin/usage. Ground truth in these tests is computed from
// the payloads the TEST sent (client-side byte lengths), never from the code
// path being verified.

const TOKEN = "usage-device-token";
const SECRET = "usage-bootstrap-secret";

interface Harness {
  base: string;
  store: SqliteStore;
  hub: InProcessAccountHub;
  blobStore: DiskBlobStore;
  close: () => void;
}

async function startPerAccount(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-usage-"));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const hub = new InProcessAccountHub();
  const blobStore = new DiskBlobStore(join(dir, "blobs"));
  const app = buildApp(
    {
      storagePath: join(dir, "test.db"),
      port: 0,
      deviceToken: TOKEN,
      allowedOrigins: [],
      authMode: "per-account",
      enrollmentSecret: SECRET,
    },
    store,
    blobStore,
    hub,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    hub,
    blobStore,
    close: () => {
      (server as Server & { closeAllConnections(): void }).closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function enroll(base: string, accountId: string, deviceId: string): Promise<string> {
  const res = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentSecret: SECRET, accountId, deviceId }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { credential: string }).credential;
}

async function getUsage(base: string): Promise<{ accounts: any[]; totals: any }> {
  const res = await fetch(`${base}/admin/usage`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.equal(res.status, 200);
  return (await res.json()) as { accounts: any[]; totals: any };
}

function account(usage: { accounts: any[] }, id: string) {
  const a = usage.accounts.find((x) => x.accountId === id);
  assert.ok(a, `account ${id} present in usage`);
  return a;
}

test("measured numbers match independently computed ground truth, including the awkward cases", async () => {
  const h = await startPerAccount();
  try {
    const cred = await enroll(h.base, "house-1", "phone");
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${cred}` };

    // Ground truth ledger, computed client-side from what we send.
    let expectDay = 0;
    let expectLife = 0;

    // Two dayglance rows with known byte sizes.
    const e1 = randomBytes(137); // exact envelope bytes
    const e2 = randomBytes(261);
    expectDay += e1.length + e2.length;
    await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        accountId: "house-1",
        rows: [
          { entityId: "a", envelope: e1.toString("base64"), deleted: false },
          { entityId: "b", envelope: e2.toString("base64"), deleted: false },
        ],
      }),
    });
    // Overwrite row "a" with a DIFFERENT size: usage must reflect the
    // replacement, not the sum of versions (current state, not history).
    const e1b = randomBytes(64);
    expectDay += e1b.length - e1.length;
    await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        accountId: "house-1",
        rows: [{ entityId: "a", envelope: e1b.toString("base64"), deleted: false }],
      }),
    });
    // AWKWARD CASE: soft delete keeps the envelope -> tombstone still charged.
    await fetch(`${h.base}/sync/dayglance/b?accountId=house-1&deletedAt=1767225600000`, {
      method: "DELETE",
      headers: H,
    });
    // A lifeglance row, for the per-app split.
    const e3 = randomBytes(512);
    expectLife += e3.length;
    await fetch(`${h.base}/sync/lifeglance/batch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        accountId: "house-1",
        rows: [{ entityId: "m", envelope: e3.toString("base64"), deleted: false }],
      }),
    });

    // One intent with known bytes.
    const iv = randomBytes(99);
    await fetch(`${h.base}/intents/batch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        accountId: "house-1",
        events: [{ eventId: "i1", envelope: iv.toString("base64"), expiresAt: "2031-01-01T00:00:00.000Z" }],
      }),
    });

    // One finalized blob with known bytes, then AWKWARD CASE: referenced by
    // more than one entity (two ref-adds) — charged once.
    const blob = randomBytes(2048);
    const hash = createHash("sha256").update(blob).digest("hex");
    const up = (await (
      await fetch(`${h.base}/blobs/uploads`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ accountId: "house-1", blobHash: hash, size: blob.length }),
      })
    ).json()) as { uploadId: string };
    await fetch(`${h.base}/blobs/uploads/${up.uploadId}/parts/0?accountId=house-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${cred}` },
      body: new Uint8Array(blob),
    });
    await fetch(`${h.base}/blobs/uploads/${up.uploadId}/finalize`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ accountId: "house-1" }),
    });
    await fetch(`${h.base}/blobs/${hash}/ref-add`, { method: "POST", headers: H, body: JSON.stringify({ accountId: "house-1" }) });
    await fetch(`${h.base}/blobs/${hash}/ref-add`, { method: "POST", headers: H, body: JSON.stringify({ accountId: "house-1" }) });

    // AWKWARD CASE: an abandoned upload session with staged bytes — reported
    // separately, never folded into stored.
    const staged = randomBytes(333);
    const orphan = (await (
      await fetch(`${h.base}/blobs/uploads`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          accountId: "house-1",
          blobHash: createHash("sha256").update(staged).digest("hex"),
          size: staged.length,
        }),
      })
    ).json()) as { uploadId: string };
    await fetch(`${h.base}/blobs/uploads/${orphan.uploadId}/parts/0?accountId=house-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${cred}` },
      body: new Uint8Array(staged),
    });
    // (never finalized)

    const u = account(await getUsage(h.base), "house-1");

    assert.equal(u.storedBytes.envelopesByApp.dayglance, expectDay, "dayglance envelope bytes (incl. tombstone)");
    assert.equal(u.storedBytes.envelopesByApp.lifeglance, expectLife, "lifeglance envelope bytes");
    assert.equal(u.storedBytes.envelopes, expectDay + expectLife);
    assert.equal(u.storedBytes.intents, iv.length, "intent envelope bytes");
    assert.equal(u.storedBytes.blobs, blob.length, "blob charged ONCE despite two references");
    assert.equal(u.storedBytes.total, expectDay + expectLife + iv.length + blob.length);
    assert.deepEqual(u.counts, { rows: 3, liveRows: 2, tombstones: 1, blobs: 1 });
    assert.deepEqual(u.intents, { current: 1 });
    assert.deepEqual(
      u.uploads,
      { sessions: 1, stagedBytes: staged.length },
      "abandoned session reported separately from stored",
    );
  } finally {
    h.close();
  }
});

test("a reclaimable-but-unreclaimed blob stays charged; reclaim removes the charge", async () => {
  const h = await startPerAccount();
  try {
    const bytes = randomBytes(1024);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const scope = h.store.forAccount("house-r");
    h.blobStore.put(hash, bytes);
    scope.insertBlobIfAbsent(hash, bytes.length); // zero refs from creation -> reclaimable
    let u = h.store.usageForAccount("house-r");
    assert.equal(u.storedBytes.blobs, bytes.length, "reclaimable-but-unreclaimed blob is CHARGED (physical truth)");

    // After an actual reclaim (grace elapsed, no devices), the charge goes.
    const far = new Date(Date.now() + 365 * 24 * 3600 * 1000);
    reclaimSweep(
      h.store,
      h.blobStore,
      { reclaim: true, gracePeriodMs: 1000, deadDevicePeriodMs: 1000 },
      far,
      () => {},
    );
    u = h.store.usageForAccount("house-r");
    assert.equal(u.storedBytes.blobs, 0, "reclaimed blob no longer charged");
    assert.equal(u.counts.blobs, 0);
  } finally {
    h.close();
  }
});

test("expired-but-unpruned intents: physical bytes charged, logical current excludes them", async () => {
  const h = await startPerAccount();
  try {
    const cred = await enroll(h.base, "house-i", "phone");
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${cred}` };
    const iv = randomBytes(80);
    await fetch(`${h.base}/intents/batch`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({
        accountId: "house-i",
        events: [{ eventId: "soon", envelope: iv.toString("base64"), expiresAt: new Date(Date.now() + 80).toISOString() }],
      }),
    });
    await new Promise((r) => setTimeout(r, 150)); // let it expire; no write, so no lazy prune
    const u = account(await getUsage(h.base), "house-i");
    assert.equal(u.storedBytes.intents, iv.length, "physical bytes of the expired-but-unpruned row still counted");
    assert.equal(u.intents.current, 0, "logical current excludes expired");
  } finally {
    h.close();
  }
});

test("SSE connections are reported per account, and byte-exact account ids stay distinct", async () => {
  const h = await startPerAccount();
  try {
    const plain = await enroll(h.base, "house-1", "phone");
    const spaced = await enroll(h.base, " house-1", "phone");

    const ac = new AbortController();
    const res = await fetch(`${h.base}/events?accountId=house-1`, {
      headers: { Authorization: `Bearer ${plain}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value } = await reader.read();
      text += Buffer.from(value!).toString("utf8");
    }

    // Write one row under the whitespace-distinct sibling account.
    await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${spaced}` },
      body: JSON.stringify({
        accountId: " house-1",
        rows: [{ entityId: "x", envelope: randomBytes(10).toString("base64"), deleted: false }],
      }),
    });

    const usage = await getUsage(h.base);
    assert.equal(account(usage, "house-1").sse.connections, 1, "live SSE connection attributed");
    assert.equal(account(usage, " house-1").sse.connections, 0);
    assert.ok(
      account(usage, " house-1").storedBytes.envelopes > 0,
      '" house-1" reported as its own byte-exact account',
    );
    assert.equal(usage.totals.sseConnections, 1);
    ac.abort();
  } finally {
    h.close();
  }
});

test("the usage surface is admin-guarded and absent in shared mode", async () => {
  const h = await startPerAccount();
  try {
    const wrong = await fetch(`${h.base}/admin/usage`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);
    const absent = await fetch(`${h.base}/admin/usage`);
    assert.equal(absent.status, 401);
  } finally {
    h.close();
  }

  // Shared mode: not registered at all — deviceTokenAuth 401 / default 404.
  const dir = mkdtempSync(join(tmpdir(), "glancevault-usage-shared-"));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const app = buildApp(
    { storagePath: join(dir, "test.db"), port: 0, deviceToken: TOKEN, allowedOrigins: [] },
    store,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/usage`)).status, 401);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/admin/usage`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
      404,
    );
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hub.connectionCounts enumerates accounts deterministically", () => {
  const hub = new InProcessAccountHub();
  const sub = (id: number) => ({ id, deliver: () => {}, close: () => {} });
  hub.subscribe("b-acct", sub(1));
  hub.subscribe("a-acct", sub(2));
  hub.subscribe("a-acct", sub(3));
  assert.deepEqual(hub.connectionCounts(), [
    { accountId: "a-acct", connections: 2 },
    { accountId: "b-acct", connections: 1 },
  ]);
});
