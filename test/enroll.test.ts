import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { mintCredential, hashCredential, CREDENTIAL_PREFIX } from "../src/credentials.js";
import { timingSafeStringEqual } from "../src/middleware/auth.js";

const TOKEN = "enroll-test-device-token";
const SECRET = "enroll-test-bootstrap-secret";

interface Harness {
  base: string;
  store: SqliteStore;
  dbPath: string;
  close: () => void;
}

async function startServer(authMode?: "shared" | "per-account"): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-enroll-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);
  store.migrate();
  const app = buildApp(
    {
      storagePath: dbPath,
      port: 0,
      deviceToken: TOKEN,
      allowedOrigins: [],
      authMode,
      enrollmentSecret: authMode === "per-account" ? SECRET : undefined,
    },
    store,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    dbPath,
    close: () => {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function enroll(
  base: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> | string }> {
  const res = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    body: ct.includes("application/json") ? (JSON.parse(text) as Record<string, unknown>) : text,
  };
}

// --- The credential construction (src/credentials.ts owns both sides) ---

test("mintCredential produces gvc_-prefixed 256-bit values whose stored hash round-trips", () => {
  const a = mintCredential();
  const b = mintCredential();
  assert.match(a.credential, new RegExp(`^${CREDENTIAL_PREFIX}[0-9a-f]{64}$`));
  assert.notEqual(a.credential, b.credential, "every mint is fresh");
  assert.notEqual(a.credentialId, b.credentialId);
  assert.equal(a.credentialHash, hashCredential(a.credential), "hash covers the full value");
  assert.equal(
    a.credentialHash,
    createHash("sha256").update(a.credential, "utf8").digest("hex"),
    "the construction is plain SHA-256 hex over the full string",
  );
});

test("timingSafeStringEqual: equal, unequal, and length-mismatched inputs", () => {
  assert.equal(timingSafeStringEqual("secret-a", "secret-a"), true);
  assert.equal(timingSafeStringEqual("secret-a", "secret-b"), false);
  // The length guard is a correctness precondition (timingSafeEqual throws on
  // unequal lengths), not an optimization.
  assert.equal(timingSafeStringEqual("short", "much-longer-value"), false);
  assert.equal(timingSafeStringEqual("", ""), true);
});

// --- The exchange, in per-account mode ---

test("two devices enrolling to one account receive distinct credentials (household model)", async () => {
  const h = await startServer("per-account");
  try {
    const a = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "phone" });
    const b = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "tablet" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const ra = a.body as Record<string, string>;
    const rb = b.body as Record<string, string>;
    assert.notEqual(ra.credential, rb.credential, "distinct secrets");
    assert.notEqual(ra.credentialId, rb.credentialId, "distinct rows");
    assert.equal(ra.accountId, "house-1");
    assert.equal(rb.accountId, "house-1");

    // Rows are correctly shaped: hash stored (never the value), bound to the
    // right account and device.
    const db = new Database(h.dbPath, { readonly: true });
    const rows = db
      .prepare(`SELECT * FROM device_credentials ORDER BY device_id`)
      .all() as Record<string, string>[];
    db.close();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.account_id, r.device_id, r.credential_hash]),
      [
        ["house-1", "phone", hashCredential(ra.credential)],
        ["house-1", "tablet", hashCredential(rb.credential)],
      ],
      "stored hashes are the SHA-256 of the returned values; the values themselves are not stored",
    );
  } finally {
    h.close();
  }
});

test("devices enrolling to different accounts are bound to their respective accounts", async () => {
  const h = await startServer("per-account");
  try {
    const a = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "phone" });
    const b = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-2", deviceId: "phone" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);

    // The verify path the enforcement phase will use: hash the presented value,
    // point-read the unique index, land on the right account.
    const foundA = h.store.getCredentialByHash(
      hashCredential((a.body as Record<string, string>).credential),
    );
    const foundB = h.store.getCredentialByHash(
      hashCredential((b.body as Record<string, string>).credential),
    );
    assert.equal(foundA?.accountId, "house-1");
    assert.equal(foundB?.accountId, "house-2");
    assert.equal(h.store.getCredentialByHash(hashCredential("gvc_" + "0".repeat(64))), null);
  } finally {
    h.close();
  }
});

test("enrollment succeeds with zero devices rows and writes none (no sync prerequisite)", async () => {
  const h = await startServer("per-account");
  try {
    const res = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "brand-new" });
    assert.equal(res.status, 201);
    const db = new Database(h.dbPath, { readonly: true });
    const devices = (db.prepare(`SELECT COUNT(*) AS n FROM devices`).get() as { n: number }).n;
    const seqRows = (db.prepare(`SELECT COUNT(*) AS n FROM account_seq`).get() as { n: number }).n;
    db.close();
    assert.equal(devices, 0, "no devices row was required or created");
    assert.equal(seqRows, 0, "no account seq was consumed by issuance");
  } finally {
    h.close();
  }
});

test("enrollment is non-idempotent: the same device re-enrolling mints a fresh credential", async () => {
  const h = await startServer("per-account");
  try {
    const first = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "phone" });
    const second = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "house-1", deviceId: "phone" });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(
      (first.body as Record<string, string>).credential,
      (second.body as Record<string, string>).credential,
      "re-enrollment never returns an existing credential (the secret is not a recovery key)",
    );
    const db = new Database(h.dbPath, { readonly: true });
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM device_credentials`).get() as { n: number }).n;
    db.close();
    assert.equal(n, 2, "the earlier row remains (orphaned until 2.1 revocation)");
  } finally {
    h.close();
  }
});

test("wrong, absent, and malformed enrollment secrets are rejected", async () => {
  const h = await startServer("per-account");
  try {
    const wrong = await enroll(h.base, { enrollmentSecret: "not-the-secret", accountId: "a", deviceId: "d" });
    assert.equal(wrong.status, 401);
    const absent = await enroll(h.base, { accountId: "a", deviceId: "d" });
    assert.equal(absent.status, 400);
    const emptyish = await enroll(h.base, { enrollmentSecret: "   ", accountId: "a", deviceId: "d" });
    assert.equal(emptyish.status, 400);
    const noAccount = await enroll(h.base, { enrollmentSecret: SECRET, deviceId: "d" });
    assert.equal(noAccount.status, 400);
    const noDevice = await enroll(h.base, { enrollmentSecret: SECRET, accountId: "a" });
    assert.equal(noDevice.status, 400);

    const db = new Database(h.dbPath, { readonly: true });
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM device_credentials`).get() as { n: number }).n;
    db.close();
    assert.equal(n, 0, "no rejected attempt persisted anything");
  } finally {
    h.close();
  }
});

// --- Shared-mode inertness: the endpoint is ABSENT, not present-and-refusing ---

test("shared mode does not register /enroll: token-less probe gets the auth 401, tokened probe gets the default 404", async () => {
  const h = await startServer(); // authMode omitted -> shared
  try {
    const noToken = await fetch(`${h.base}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: SECRET, accountId: "a", deviceId: "d" }),
    });
    assert.equal(noToken.status, 401, "deviceTokenAuth still owns the path");
    assert.deepEqual(await noToken.json(), { error: "missing or malformed Authorization header" });

    const withToken = await fetch(`${h.base}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ enrollmentSecret: SECRET, accountId: "a", deviceId: "d" }),
    });
    assert.equal(withToken.status, 404, "falls through to Express's default 404, as today");
    assert.match(withToken.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    h.close();
  }
});

// --- Config: fatal without a secret in per-account mode ---

test("per-account mode without an enrollment secret is fatal at startup", () => {
  const env = { GLANCEVAULT_DEVICE_TOKEN: "t", GLANCEVAULT_AUTH_MODE: "per-account" };
  assert.throws(() => loadConfig(env), /requires an enrollment secret/);
  assert.throws(
    () => loadConfig({ ...env, GLANCEVAULT_ENROLLMENT_SECRET: "   " }),
    /requires an enrollment secret/,
    "whitespace-only counts as unset (the compose passthrough pattern)",
  );
  const ok = loadConfig({ ...env, GLANCEVAULT_ENROLLMENT_SECRET: "boot-secret" });
  assert.equal(ok.enrollmentSecret, "boot-secret");
  const shared = loadConfig({ GLANCEVAULT_DEVICE_TOKEN: "t" });
  assert.equal(shared.enrollmentSecret, undefined, "shared mode needs no secret");
});
