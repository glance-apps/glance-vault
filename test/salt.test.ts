import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

const TOKEN = "salt-token";

interface Harness {
  base: string;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-salt-"));
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

interface SaltBody {
  accountId: string;
  salt: string;
  createdAt: string;
  created?: boolean;
}

async function putSalt(base: string, accountId: string, salt: string) {
  const res = await fetch(`${base}/salt/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ salt }),
  });
  return { status: res.status, body: (await res.json()) as SaltBody };
}

async function getSalt(base: string, accountId: string) {
  const res = await fetch(`${base}/salt/${encodeURIComponent(accountId)}`, {
    headers: authHeaders(),
  });
  return { status: res.status, body: (await res.json()) as SaltBody };
}

function saltValue(): string {
  return randomBytes(16).toString("base64");
}

// 1. PUT with no existing salt stores and returns it with created: true.
test("PUT stores a new salt and reports created true", async () => {
  const h = await startServer();
  try {
    const salt = saltValue();
    const res = await putSalt(h.base, "acct-1", salt);
    assert.equal(res.status, 200);
    assert.equal(res.body.created, true);
    assert.equal(res.body.salt, salt, "the stored salt is the supplied one");
    assert.equal(res.body.accountId, "acct-1");
    assert.ok(res.body.createdAt, "createdAt is set");
  } finally {
    h.close();
  }
});

// 2. A second PUT with a different value returns the original, created: false.
test("PUT never overwrites: a second value returns the original", async () => {
  const h = await startServer();
  try {
    const original = saltValue();
    const other = saltValue();
    assert.notEqual(original, other);

    const first = await putSalt(h.base, "acct-2", original);
    assert.equal(first.body.created, true);

    const second = await putSalt(h.base, "acct-2", other);
    assert.equal(second.status, 200);
    assert.equal(second.body.created, false, "no new salt was stored");
    assert.equal(second.body.salt, original, "the original salt is returned unchanged");
    assert.equal(second.body.createdAt, first.body.createdAt, "createdAt is unchanged");
  } finally {
    h.close();
  }
});

// 3. Concurrent PUTs for the same account all return the same salt, with exactly
// one of them reporting created: true. This is the first-write-wins invariant.
test("concurrent PUTs converge on a single salt", async () => {
  const h = await startServer();
  try {
    const RACERS = 12;
    const candidates = Array.from({ length: RACERS }, () => saltValue());
    // All distinct so a winner is unambiguous.
    assert.equal(new Set(candidates).size, RACERS);

    const results = await Promise.all(
      candidates.map((salt) => putSalt(h.base, "acct-race", salt)),
    );

    const returnedSalts = new Set(results.map((r) => r.body.salt));
    assert.equal(returnedSalts.size, 1, "every racer saw the same stored salt");

    const createdCount = results.filter((r) => r.body.created === true).length;
    assert.equal(createdCount, 1, "exactly one racer stored the salt");

    const winner = [...returnedSalts][0];
    assert.ok(candidates.includes(winner), "the winning salt is one of the candidates");

    const after = await getSalt(h.base, "acct-race");
    assert.equal(after.body.salt, winner, "GET agrees with the racers");
  } finally {
    h.close();
  }
});

// 4. GET returns the stored salt after a PUT.
test("GET returns the stored salt", async () => {
  const h = await startServer();
  try {
    const salt = saltValue();
    const put = await putSalt(h.base, "acct-4", salt);

    const got = await getSalt(h.base, "acct-4");
    assert.equal(got.status, 200);
    assert.equal(got.body.salt, salt);
    assert.equal(got.body.accountId, "acct-4");
    assert.equal(got.body.createdAt, put.body.createdAt);
  } finally {
    h.close();
  }
});

// 4b. The salt survives PUT -> GET as the exact same 16 bytes, with the base64
// string itself unchanged. This is the cross-device key-derivation contract: a
// second device must derive the same root key, which it can only do if these
// bytes match the first device's byte-for-byte. Guards against any re-encoding,
// padding, or whitespace drift in the salt path.
test("PUT-then-GET round-trips the salt to identical bytes", async () => {
  const h = await startServer();
  try {
    const raw = randomBytes(16);
    const salt = raw.toString("base64");

    const put = await putSalt(h.base, "acct-bytes", salt);
    assert.equal(put.body.salt, salt, "PUT echoes the exact base64 string");
    assert.deepEqual(Buffer.from(put.body.salt, "base64"), raw, "PUT salt decodes to the same 16 bytes");

    const got = await getSalt(h.base, "acct-bytes");
    assert.equal(got.body.salt, salt, "GET returns the exact base64 string, no re-encoding");
    assert.deepEqual(Buffer.from(got.body.salt, "base64"), raw, "GET salt decodes to the same 16 bytes");
    assert.equal(Buffer.from(got.body.salt, "base64").length, 16, "salt is exactly 16 bytes");
  } finally {
    h.close();
  }
});

// 4c. A second PUT with a different salt is ignored and returns the original
// salt's exact bytes. If a racing device's salt were echoed back instead, the
// two devices would derive different root keys -> guaranteed decryption failure.
test("a second PUT with a different salt returns the original bytes", async () => {
  const h = await startServer();
  try {
    const originalRaw = randomBytes(16);
    const original = originalRaw.toString("base64");
    const otherRaw = randomBytes(16);
    const other = otherRaw.toString("base64");
    assert.notEqual(original, other);

    const first = await putSalt(h.base, "acct-second", original);
    assert.equal(first.body.created, true);

    const second = await putSalt(h.base, "acct-second", other);
    assert.equal(second.body.created, false, "the second PUT stored nothing");
    assert.equal(second.body.salt, original, "the second PUT echoes the stored salt, not its own");
    assert.deepEqual(
      Buffer.from(second.body.salt, "base64"),
      originalRaw,
      "the echoed salt is the original's exact bytes",
    );
    assert.notDeepEqual(
      Buffer.from(second.body.salt, "base64"),
      otherRaw,
      "the second device's own salt was not stored or returned",
    );
  } finally {
    h.close();
  }
});

// 5. GET on an unknown account returns 404.
test("GET on an unknown account is 404", async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/salt/never-seen`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  } finally {
    h.close();
  }
});
