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
import { reapUploadSessions } from "../src/upload-reaper.js";

const TOKEN = "reaper-token";

interface Harness {
  base: string;
  store: SqliteStore;
  blobStore: DiskBlobStore;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-reaper-"));
  const path = join(dir, "test.db");
  const blobDir = join(dir, "blobs");
  const store = new SqliteStore(path);
  store.migrate();
  const blobStore = new DiskBlobStore(blobDir);
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [], blobStorePath: blobDir, maxBlobSize: 16 * 1024 * 1024 },
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
function rawHeaders(): Record<string, string> {
  return { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` };
}
function blobHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Open a session and stage one part, but never finalize — the abandoned-upload
// shape the reaper exists to clean up. Returns the uploadId.
async function startButAbandon(base: string, accountId: string): Promise<string> {
  const bytes = randomBytes(2048);
  const hash = blobHash(bytes);
  const init = await fetch(`${base}/blobs/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, blobHash: hash, size: bytes.length }),
  });
  const uploadId = ((await init.json()) as { uploadId: string }).uploadId;
  const url = new URL(`${base}/blobs/uploads/${uploadId}/parts/0`);
  url.searchParams.set("accountId", accountId);
  await fetch(url, { method: "PUT", headers: rawHeaders(), body: bytes.subarray(0, 1000) });
  return uploadId;
}

test("the reaper sweeps a stale session (row + staged bytes) but spares a fresh one", () => {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-reaper-unit-"));
  const path = join(dir, "test.db");
  const blobDir = join(dir, "blobs");
  try {
    const store = new SqliteStore(path);
    store.migrate();
    const blobStore = new DiskBlobStore(blobDir);

    // createUploadSession stamps created_at from the real clock, so we drive the
    // reaper's clock forward relative to when we create the sessions rather than
    // trying to backdate the row.
    store.forAccount("acct").createUploadSession("old-upload", "a".repeat(64), 1000);
    blobStore.writePart("old-upload", 0, randomBytes(500));

    // Reaper with a 1ms TTL, run "far in the future": the session is stale.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const result = reapUploadSessions(store, blobStore, 1, future, () => {});
    assert.equal(result.swept, 1, "the stale session was swept");
    assert.equal(store.forAccount("acct").getUploadSession("old-upload"), null, "session row is gone");
    assert.deepEqual(store.forAccount("acct").listUploadParts("old-upload"), [], "part records cascaded away");

    // A fresh session created now, swept with a long TTL, is spared.
    store.forAccount("acct").createUploadSession("fresh-upload", "b".repeat(64), 1000);
    const spared = reapUploadSessions(store, blobStore, 24 * 60 * 60 * 1000, new Date(), () => {});
    assert.equal(spared.swept, 0, "a session within the TTL is not swept");
    assert.notEqual(store.forAccount("acct").getUploadSession("fresh-upload"), null, "fresh session survives");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listStaleUploadSessions returns only sessions at/before the cutoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-reaper-list-"));
  const path = join(dir, "test.db");
  try {
    const store = new SqliteStore(path);
    store.migrate();
    store.forAccount("acct").createUploadSession("u1", "c".repeat(64), 10);
    // A cutoff far in the future catches it; one far in the past does not.
    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const pastCutoff = new Date(Date.now() - 60_000).toISOString();
    assert.equal(store.listStaleUploadSessions(futureCutoff).length, 1);
    assert.equal(store.listStaleUploadSessions(pastCutoff).length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an abandoned upload over HTTP is later reaped end to end", async () => {
  const h = await startServer();
  try {
    const uploadId = await startButAbandon(h.base, "acct-abandon");
    assert.notEqual(h.store.forAccount("acct-abandon").getUploadSession(uploadId), null, "session exists after abandon");

    // Sweep with a tiny TTL from a future clock: the session and its staged bytes go.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const result = reapUploadSessions(h.store, h.blobStore, 1, future, () => {});
    assert.equal(result.swept, 1);
    assert.equal(h.store.forAccount("acct-abandon").getUploadSession(uploadId), null, "reaped session is gone");
  } finally {
    h.close();
  }
});
