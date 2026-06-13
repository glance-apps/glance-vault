import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

const TOKEN = "device-token";

interface Harness {
  base: string;
  path: string;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-device-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp({ storagePath: path, port: 0, deviceToken: TOKEN }, store);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    path,
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

async function postDevice(
  base: string,
  app: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/sync/${app}/device`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Read a device row straight from the SQLite file to verify what was stored.
function readDevice(path: string, accountId: string, deviceId: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT last_seen_seq, last_active FROM devices WHERE account_id = ? AND device_id = ?`,
      )
      .get(accountId, deviceId) as { last_seen_seq: number; last_active: string } | undefined;
  } finally {
    db.close();
  }
}

test("POST device upserts the cursor and advances forward only", async () => {
  const h = await startServer();
  try {
    // First report creates the row.
    const first = await postDevice(h.base, "dayglance", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: 10,
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { updated: true });
    assert.equal(readDevice(h.path, "house-1", "phone")?.last_seen_seq, 10);

    // A higher cursor moves it forward.
    const higher = await postDevice(h.base, "dayglance", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: 25,
    });
    assert.equal(higher.status, 200);
    assert.equal(readDevice(h.path, "house-1", "phone")?.last_seen_seq, 25);

    // A lower cursor must NOT move it backward (MAX wins).
    const lower = await postDevice(h.base, "dayglance", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: 5,
    });
    assert.equal(lower.status, 200);
    assert.deepEqual(lower.json, { updated: true });
    assert.equal(
      readDevice(h.path, "house-1", "phone")?.last_seen_seq,
      25,
      "a stale report did not rewind the cursor",
    );

    // Equal cursor is a harmless no-op on the value.
    await postDevice(h.base, "dayglance", { accountId: "house-1", deviceId: "phone", lastSeenSeq: 25 });
    assert.equal(readDevice(h.path, "house-1", "phone")?.last_seen_seq, 25);
  } finally {
    h.close();
  }
});

test("device cursors are isolated per device within an account", async () => {
  const h = await startServer();
  try {
    await postDevice(h.base, "dayglance", { accountId: "house-1", deviceId: "phone", lastSeenSeq: 30 });
    await postDevice(h.base, "dayglance", { accountId: "house-1", deviceId: "laptop", lastSeenSeq: 7 });
    assert.equal(readDevice(h.path, "house-1", "phone")?.last_seen_seq, 30);
    assert.equal(readDevice(h.path, "house-1", "laptop")?.last_seen_seq, 7);
  } finally {
    h.close();
  }
});

test("POST device rejects bad input and unknown apps", async () => {
  const h = await startServer();
  try {
    const noAccount = await postDevice(h.base, "dayglance", { deviceId: "phone", lastSeenSeq: 1 });
    assert.equal(noAccount.status, 400);

    const noDevice = await postDevice(h.base, "dayglance", { accountId: "house-1", lastSeenSeq: 1 });
    assert.equal(noDevice.status, 400);

    const badSeq = await postDevice(h.base, "dayglance", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: -1,
    });
    assert.equal(badSeq.status, 400);

    const nonInt = await postDevice(h.base, "dayglance", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: 1.5,
    });
    assert.equal(nonInt.status, 400);

    const badApp = await postDevice(h.base, "bogus", {
      accountId: "house-1",
      deviceId: "phone",
      lastSeenSeq: 1,
    });
    assert.equal(badApp.status, 400);
  } finally {
    h.close();
  }
});
