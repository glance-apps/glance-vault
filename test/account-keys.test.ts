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
import { loadConfig, type EnrollmentMode } from "../src/config.js";
import { ACCOUNT_KEY_PREFIX, hashAccountKey } from "../src/account-keys.js";

// Enrollment-key mode: a per-account key, minted by the operator, decides the
// account a device enrolls into. The adversarial cases are the point: on a
// shared server, a tester holding key A must never read, write, delete,
// enroll into, or sign out anything in account B.

const TOKEN = "account-keys-test-device-token";
const SECRET = "account-keys-test-bootstrap-secret";

interface Harness {
  base: string;
  dbPath: string;
  close: () => void;
}

async function startServer(opts: {
  enrollmentMode?: EnrollmentMode;
  maxAccounts?: number;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-account-keys-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);
  store.migrate();
  const app = buildApp(
    {
      storagePath: dbPath,
      port: 0,
      deviceToken: TOKEN,
      allowedOrigins: [],
      authMode: "per-account",
      enrollmentSecret: SECRET,
      enrollmentMode: opts.enrollmentMode ?? "account-key",
      maxAccounts: opts.maxAccounts,
    },
    store,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    dbPath,
    close: () => {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Json = Record<string, unknown>;

async function call(
  base: string,
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = JSON.parse(text) as Json;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

async function createAccount(base: string, body: Json = {}) {
  return call(base, "POST", "/admin/accounts", { bearer: SECRET, body });
}

async function enroll(base: string, body: Json) {
  return call(base, "POST", "/enroll", { body });
}

// Create an account and enroll one device into it; returns what a device holds.
async function provision(base: string, deviceId: string, label?: string) {
  const created = await createAccount(base, label !== undefined ? { label } : {});
  assert.equal(created.status, 201);
  const accountKey = created.body.accountKey as string;
  const enrolled = await enroll(base, { accountKey, deviceId });
  assert.equal(enrolled.status, 201);
  return {
    accountId: created.body.accountId as string,
    accountKey,
    credential: enrolled.body.credential as string,
    credentialId: enrolled.body.credentialId as string,
  };
}

const ENVELOPE = Buffer.from("opaque-ciphertext").toString("base64");

async function writeRow(base: string, credential: string, accountId: string, entityId: string) {
  return call(base, "POST", "/sync/dayglance/batch", {
    bearer: credential,
    body: { accountId, rows: [{ entityId, envelope: ENVELOPE }] },
  });
}

async function listRows(base: string, credential: string, accountId: string) {
  return call(base, "GET", `/sync/dayglance/list?accountId=${encodeURIComponent(accountId)}&since=0`, {
    bearer: credential,
  });
}

function countRows(dbPath: string, sql: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// --- Admin: create, list, keys shown once ---

test("creating accounts mints distinct keys and server-generated ids; the key is shown once", async () => {
  const h = await startServer();
  try {
    const a = await createAccount(h.base, { label: "Daniel" });
    const b = await createAccount(h.base);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.match(a.body.accountKey as string, new RegExp(`^${ACCOUNT_KEY_PREFIX}[0-9a-f]{64}$`));
    assert.notEqual(a.body.accountKey, b.body.accountKey);
    assert.match(a.body.accountId as string, /^acct_[0-9a-f-]{36}$/);
    assert.notEqual(a.body.accountId, b.body.accountId);
    assert.equal(a.body.label, "Daniel");
    assert.equal(b.body.label, null);

    const list = await call(h.base, "GET", "/admin/accounts", { bearer: SECRET });
    assert.equal(list.status, 200);
    const accounts = list.body.accounts as Json[];
    assert.deepEqual(
      accounts.map((x) => Object.keys(x).sort()),
      [
        ["accountId", "createdAt", "keyRotatedAt", "label"],
        ["accountId", "createdAt", "keyRotatedAt", "label"],
      ],
      "the listing never carries a key or a key hash",
    );
    assert.equal(list.body.maxAccounts, null);

    // Only the hash is stored.
    const db = new Database(h.dbPath, { readonly: true });
    const stored = db.prepare(`SELECT key_hash FROM accounts WHERE account_id = ?`).get(a.body.accountId) as {
      key_hash: string;
    };
    db.close();
    assert.equal(stored.key_hash, hashAccountKey(a.body.accountKey as string));
  } finally {
    h.close();
  }
});

test("an operator-supplied accountId adopts that id; a duplicate is refused", async () => {
  const h = await startServer();
  try {
    const first = await createAccount(h.base, { accountId: "house-1" });
    assert.equal(first.status, 201);
    assert.equal(first.body.accountId, "house-1");
    const dup = await createAccount(h.base, { accountId: "house-1" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "account already exists");
    for (const bad of ["", "   ", 7, "x".repeat(129)]) {
      const r = await createAccount(h.base, { accountId: bad });
      assert.equal(r.status, 400, `accountId ${JSON.stringify(bad)} is rejected`);
    }
    const badLabel = await createAccount(h.base, { label: 5 });
    assert.equal(badLabel.status, 400);
  } finally {
    h.close();
  }
});

test("the account cap refuses creation past GLANCEVAULT_MAX_ACCOUNTS", async () => {
  const h = await startServer({ maxAccounts: 2 });
  try {
    assert.equal((await createAccount(h.base)).status, 201);
    assert.equal((await createAccount(h.base)).status, 201);
    const third = await createAccount(h.base);
    assert.equal(third.status, 409);
    assert.deepEqual(third.body, { error: "account limit reached", maxAccounts: 2 });
    const list = await call(h.base, "GET", "/admin/accounts", { bearer: SECRET });
    assert.equal((list.body.accounts as Json[]).length, 2);
    assert.equal(list.body.maxAccounts, 2);
  } finally {
    h.close();
  }
});

test("the cap holds under concurrent creates", async () => {
  const h = await startServer({ maxAccounts: 3 });
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => createAccount(h.base)));
    assert.equal(results.filter((r) => r.status === 201).length, 3);
    assert.equal(results.filter((r) => r.status === 409).length, 7);
    assert.equal(countRows(h.dbPath, `SELECT COUNT(*) AS n FROM accounts`), 3);
  } finally {
    h.close();
  }
});

test("account admin needs the bootstrap secret; an account key or credential does not authorize it", async () => {
  const h = await startServer();
  try {
    const a = await provision(h.base, "phone");
    for (const bearer of [undefined, "wrong", a.accountKey, a.credential]) {
      const create = await call(h.base, "POST", "/admin/accounts", { bearer, body: {} });
      assert.equal(create.status, 401, `create refused for ${bearer}`);
      const list = await call(h.base, "GET", "/admin/accounts", { bearer });
      assert.equal(list.status, 401, `list refused for ${bearer}`);
      const rotate = await call(h.base, "POST", `/admin/accounts/${a.accountId}/rotate-key`, { bearer, body: {} });
      assert.equal(rotate.status, 401, `rotate refused for ${bearer}`);
    }
    assert.equal(countRows(h.dbPath, `SELECT COUNT(*) AS n FROM accounts`), 1);
  } finally {
    h.close();
  }
});

// --- Enrollment: the key decides the account ---

test("a device enrolls with the key alone and learns its account from the response", async () => {
  const h = await startServer();
  try {
    const created = await createAccount(h.base);
    const r = await enroll(h.base, { accountKey: created.body.accountKey, deviceId: "phone" });
    assert.equal(r.status, 201);
    assert.equal(r.body.accountId, created.body.accountId);
    assert.equal(r.body.deviceId, "phone");

    // The credential works for that account.
    const w = await writeRow(h.base, r.body.credential as string, r.body.accountId as string, "task-1");
    assert.equal(w.status, 200);

    // Sending the right accountId alongside the key is accepted too.
    const withId = await enroll(h.base, {
      accountKey: created.body.accountKey,
      accountId: created.body.accountId,
      deviceId: "tablet",
    });
    assert.equal(withId.status, 201);
  } finally {
    h.close();
  }
});

test("key A cannot enroll into account B, and nothing is persisted", async () => {
  const h = await startServer();
  try {
    const a = await createAccount(h.base);
    const b = await createAccount(h.base);
    const r = await enroll(h.base, { accountKey: a.body.accountKey, accountId: b.body.accountId, deviceId: "d" });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: "accountId does not match the account key" });
    assert.equal(countRows(h.dbPath, `SELECT COUNT(*) AS n FROM device_credentials`), 0);
  } finally {
    h.close();
  }
});

test("the bootstrap secret no longer enrolls, in either field, and claimed accounts are ignored without a key", async () => {
  const h = await startServer();
  try {
    await createAccount(h.base, { accountId: "house-1" });
    const asSecret = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "d" });
    assert.equal(asSecret.status, 400);
    assert.deepEqual(asSecret.body, { error: "accountKey is required" });
    const asKey = await enroll(h.base, { accountKey: SECRET, accountId: "house-1", deviceId: "d" });
    assert.equal(asKey.status, 401);
    assert.deepEqual(asKey.body, { error: "invalid account key" });
    const unknown = await enroll(h.base, { accountKey: `${ACCOUNT_KEY_PREFIX}${"0".repeat(64)}`, deviceId: "d" });
    assert.equal(unknown.status, 401);
    const noDevice = await enroll(h.base, { accountKey: (await createAccount(h.base)).body.accountKey });
    assert.equal(noDevice.status, 400);
    assert.deepEqual(noDevice.body, { error: "deviceId is required" });
    assert.equal(countRows(h.dbPath, `SELECT COUNT(*) AS n FROM device_credentials`), 0);
  } finally {
    h.close();
  }
});

test("adversarial: a tester holding account A cannot read, write, delete, or sign out account B", async () => {
  const h = await startServer();
  try {
    const a = await provision(h.base, "shared-device-name", "tester A");
    const b = await provision(h.base, "shared-device-name", "Daniel");
    assert.equal((await writeRow(h.base, b.credential, b.accountId, "b-secret")).status, 200);

    // A's credential naming B is refused on read, write, row GET and delete.
    assert.equal((await listRows(h.base, a.credential, b.accountId)).status, 403);
    assert.equal((await writeRow(h.base, a.credential, b.accountId, "x")).status, 403);
    const get = await call(h.base, "GET", `/sync/dayglance/b-secret?accountId=${b.accountId}`, { bearer: a.credential });
    assert.equal(get.status, 403);
    const del = await call(h.base, "DELETE", `/sync/dayglance/b-secret?accountId=${b.accountId}`, {
      bearer: a.credential,
    });
    assert.equal(del.status, 403);

    // Re-enrolling with A's key under B's device id lands in A, so it cannot
    // supersede (sign out) B's device.
    const reenroll = await enroll(h.base, { accountKey: a.accountKey, deviceId: "shared-device-name" });
    assert.equal(reenroll.status, 201);
    assert.equal(reenroll.body.accountId, a.accountId);
    const bList = await listRows(h.base, b.credential, b.accountId);
    assert.equal(bList.status, 200, "B's device is still signed in");
    assert.deepEqual(
      (bList.body.rows as Json[]).map((r) => r.entityId),
      ["b-secret"],
      "B's data is intact",
    );
  } finally {
    h.close();
  }
});

// --- Rotation ---

test("rotating a key retires the old key, keeps the account and its data, and keeps devices unless asked", async () => {
  const h = await startServer();
  try {
    const a = await provision(h.base, "phone");
    assert.equal((await writeRow(h.base, a.credential, a.accountId, "task-1")).status, 200);

    const rotated = await call(h.base, "POST", `/admin/accounts/${a.accountId}/rotate-key`, {
      bearer: SECRET,
      body: {},
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.accountId, a.accountId);
    assert.equal(rotated.body.revokedCredentials, 0);
    assert.equal(typeof rotated.body.keyRotatedAt, "string");
    const newKey = rotated.body.accountKey as string;
    assert.notEqual(newKey, a.accountKey);

    assert.equal((await enroll(h.base, { accountKey: a.accountKey, deviceId: "laptop" })).status, 401);
    const fresh = await enroll(h.base, { accountKey: newKey, deviceId: "laptop" });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.accountId, a.accountId, "the new key resumes the same account");

    const list = await listRows(h.base, fresh.body.credential as string, a.accountId);
    assert.deepEqual((list.body.rows as Json[]).map((r) => r.entityId), ["task-1"]);
    assert.equal((await listRows(h.base, a.credential, a.accountId)).status, 200, "the phone stays signed in");
  } finally {
    h.close();
  }
});

test("rotating with revokeDevices signs out every device of that account only", async () => {
  const h = await startServer();
  try {
    const a = await provision(h.base, "phone");
    const a2 = await enroll(h.base, { accountKey: a.accountKey, deviceId: "tablet" });
    const b = await provision(h.base, "phone");

    const rotated = await call(h.base, "POST", `/admin/accounts/${a.accountId}/rotate-key`, {
      bearer: SECRET,
      body: { revokeDevices: true },
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.revokedCredentials, 2);

    assert.equal((await listRows(h.base, a.credential, a.accountId)).status, 401);
    assert.equal((await listRows(h.base, a2.body.credential as string, a.accountId)).status, 401);
    assert.equal((await listRows(h.base, b.credential, b.accountId)).status, 200, "account B is untouched");

    const back = await enroll(h.base, { accountKey: rotated.body.accountKey, deviceId: "phone" });
    assert.equal(back.status, 201);
    assert.equal((await listRows(h.base, back.body.credential as string, a.accountId)).status, 200);
  } finally {
    h.close();
  }
});

test("rotating an unknown account is a 404; a non-boolean revokeDevices is a 400", async () => {
  const h = await startServer();
  try {
    const missing = await call(h.base, "POST", "/admin/accounts/nope/rotate-key", { bearer: SECRET, body: {} });
    assert.equal(missing.status, 404);
    const a = await provision(h.base, "phone");
    const bad = await call(h.base, "POST", `/admin/accounts/${a.accountId}/rotate-key`, {
      bearer: SECRET,
      body: { revokeDevices: "yes" },
    });
    assert.equal(bad.status, 400);
  } finally {
    h.close();
  }
});

// --- Bootstrap mode is unchanged ---

test("bootstrap mode does not register /admin/accounts and still enrolls with the secret", async () => {
  const h = await startServer({ enrollmentMode: "bootstrap" });
  try {
    const create = await call(h.base, "POST", "/admin/accounts", { bearer: SECRET, body: {} });
    assert.notEqual(create.status, 201);
    assert.equal(countRows(h.dbPath, `SELECT COUNT(*) AS n FROM accounts`), 0);
    const r = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "d" });
    assert.equal(r.status, 201);
    assert.equal(r.body.accountId, "house-1");
  } finally {
    h.close();
  }
});

// --- Config ---

test("config: enrollment mode defaults, parsing, and the per-account requirement", () => {
  const base = { GLANCEVAULT_DEVICE_TOKEN: "t", GLANCEVAULT_AUTH_MODE: "per-account", GLANCEVAULT_ENROLLMENT_SECRET: "s" };
  assert.equal(loadConfig(base).enrollmentMode, "bootstrap");
  assert.equal(loadConfig({ ...base, GLANCEVAULT_ENROLLMENT_MODE: " Account-Key " }).enrollmentMode, "account-key");
  assert.equal(loadConfig({ ...base, GLANCEVAULT_ENROLLMENT_MODE: "  " }).enrollmentMode, "bootstrap");
  assert.throws(() => loadConfig({ ...base, GLANCEVAULT_ENROLLMENT_MODE: "account-keys" }), /Invalid GLANCEVAULT_ENROLLMENT_MODE/);
  assert.throws(
    () => loadConfig({ GLANCEVAULT_DEVICE_TOKEN: "t", GLANCEVAULT_ENROLLMENT_MODE: "account-key" }),
    /requires GLANCEVAULT_AUTH_MODE=per-account/,
  );
  assert.equal(loadConfig(base).maxAccounts, undefined);
  assert.equal(loadConfig({ ...base, GLANCEVAULT_MAX_ACCOUNTS: "10" }).maxAccounts, 10);
  assert.throws(() => loadConfig({ ...base, GLANCEVAULT_MAX_ACCOUNTS: "0" }), /Invalid GLANCEVAULT_MAX_ACCOUNTS/);
});
