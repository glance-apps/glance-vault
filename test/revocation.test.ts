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
import { InProcessAccountHub, type Nudge, type Subscriber } from "../src/realtime/hub.js";

// Phase 2.1: revocation. A nullable revoked_at flag checked in the auth
// middleware (byte-identical "invalid credential" body), admin list/revoke
// endpoints guarded by the bootstrap secret, supersede-on-re-enroll, and SSE
// termination via both the in-process hub path and heartbeat revalidation.

const TOKEN = "revocation-device-token";
const SECRET = "revocation-bootstrap-secret";

interface Harness {
  base: string;
  store: SqliteStore;
  hub: InProcessAccountHub;
  dbPath: string;
  close: () => void;
}

async function startPerAccount(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-revoke-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);
  store.migrate();
  const hub = new InProcessAccountHub();
  const app = buildApp(
    {
      storagePath: dbPath,
      port: 0,
      deviceToken: TOKEN,
      allowedOrigins: [],
      authMode: "per-account",
      enrollmentSecret: SECRET,
    },
    store,
    undefined,
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
    dbPath,
    close: () => {
      (server as Server & { closeAllConnections(): void }).closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function enroll(
  base: string,
  accountId: string,
  deviceId: string,
): Promise<{ credential: string; credentialId: string }> {
  const res = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollmentSecret: SECRET, accountId, deviceId }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { credential: string; credentialId: string };
}

async function listWith(base: string, credential: string, accountId = "house-1") {
  const res = await fetch(`${base}/sync/dayglance/list?accountId=${encodeURIComponent(accountId)}&since=0`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  return { status: res.status, body: await res.json() };
}

async function adminRevoke(base: string, credentialId: string, secret = SECRET) {
  const res = await fetch(`${base}/admin/credentials/${credentialId}/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a revoked credential is rejected on the next request with the byte-identical body", async () => {
  const h = await startPerAccount();
  try {
    const a = await enroll(h.base, "house-1", "phone");
    assert.equal((await listWith(h.base, a.credential)).status, 200, "works before revocation");

    const rev = await adminRevoke(h.base, a.credentialId);
    assert.equal(rev.status, 200);
    assert.equal(rev.body.revokedNow, true);

    const after = await listWith(h.base, a.credential);
    assert.equal(after.status, 401);
    assert.deepEqual(after.body, { error: "invalid credential" }, "EXACT body the shipped halt matches");
  } finally {
    h.close();
  }
});

test("revocation writes exactly one cell; re-revoke is a no-op keeping the original timestamp", async () => {
  const h = await startPerAccount();
  try {
    const a = await enroll(h.base, "house-1", "phone");
    const b = await enroll(h.base, "house-1", "tablet");

    const db = new Database(h.dbPath, { readonly: true });
    const snapshot = () =>
      db.prepare("SELECT * FROM device_credentials ORDER BY credential_id").all() as Record<
        string,
        unknown
      >[];
    const before = snapshot();

    const rev = await adminRevoke(h.base, a.credentialId);
    assert.equal(rev.status, 200);
    const after = snapshot();

    // Exactly one row differs, and within it exactly one column.
    let changedCells = 0;
    for (let i = 0; i < before.length; i++) {
      for (const key of Object.keys(before[i])) {
        if (before[i][key] !== after[i][key]) {
          changedCells++;
          assert.equal(key, "revoked_at", "the only changed column is revoked_at");
          assert.equal(before[i].credential_id, a.credentialId, "on the revoked row only");
        }
      }
    }
    assert.equal(changedCells, 1, "exactly one cell changed in device_credentials");

    // Re-revoke: no-op, original timestamp survives.
    const again = await adminRevoke(h.base, a.credentialId);
    assert.equal(again.status, 200);
    assert.equal(again.body.revokedNow, false);
    assert.deepEqual(snapshot(), after, "re-revoke changed nothing");

    // The sibling still works.
    assert.equal((await listWith(h.base, b.credential)).status, 200);
    db.close();
  } finally {
    h.close();
  }
});

test("supersede: re-enrolling the same byte-exact (accountId, deviceId) revokes the predecessor", async () => {
  const h = await startPerAccount();
  try {
    const first = await enroll(h.base, "house-1", "phone");
    assert.equal((await listWith(h.base, first.credential)).status, 200);

    const second = await enroll(h.base, "house-1", "phone");
    assert.equal((await listWith(h.base, second.credential)).status, 200, "successor works");
    const old = await listWith(h.base, first.credential);
    assert.equal(old.status, 401, "predecessor died when its replacement was born");
    assert.deepEqual(old.body, { error: "invalid credential" });

    // Byte-exact: a whitespace-distinct deviceId does NOT supersede.
    const spaced = await enroll(h.base, "house-1", " phone");
    assert.equal((await listWith(h.base, second.credential)).status, 200, '"phone" unaffected by " phone"');
    // Nor does the same deviceId under a different account.
    await enroll(h.base, "house-2", "phone");
    assert.equal((await listWith(h.base, second.credential)).status, 200);
    assert.equal((await listWith(h.base, spaced.credential)).status, 200);
  } finally {
    h.close();
  }
});

test("admin listing shows every row, never a hash; unknown revoke 404s; wrong/absent secret 401s", async () => {
  const h = await startPerAccount();
  try {
    const a = await enroll(h.base, "house-1", "phone");
    await enroll(h.base, "house-1", "phone"); // supersedes a -> one revoked, one active
    await enroll(h.base, "house-2", "camera");

    const res = await fetch(`${h.base}/admin/credentials`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert.equal(res.status, 200);
    const { credentials } = (await res.json()) as { credentials: Record<string, unknown>[] };
    assert.equal(credentials.length, 3, "active AND revoked rows are listed");
    assert.equal(credentials.filter((c) => c.revokedAt !== null).length, 1);
    for (const c of credentials) {
      assert.deepEqual(
        Object.keys(c).sort(),
        ["accountId", "createdAt", "credentialId", "deviceId", "revokedAt"],
        "explicit allowlist: the verifier hash never leaves the route layer",
      );
    }

    assert.equal((await adminRevoke(h.base, "no-such-credential")).status, 404);
    assert.equal((await adminRevoke(h.base, a.credentialId, "wrong-secret")).status, 401);
    const absent = await fetch(`${h.base}/admin/credentials`);
    assert.equal(absent.status, 401);
  } finally {
    h.close();
  }
});

test("shared mode does not register /admin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-revoke-shared-"));
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
    const noToken = await fetch(`http://127.0.0.1:${port}/admin/credentials`);
    assert.equal(noToken.status, 401, "deviceTokenAuth still owns the path");
    const withToken = await fetch(`http://127.0.0.1:${port}/admin/credentials`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(withToken.status, 404, "falls through to Express's default 404, as today");
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hub.disconnectCredential closes exactly the matching subscribers", () => {
  const hub = new InProcessAccountHub();
  const closed: number[] = [];
  const make = (id: number, credentialId?: string): Subscriber => ({
    id,
    credentialId,
    deliver: (_n: Nudge) => {},
    close: () => closed.push(id),
  });
  hub.subscribe("acct-1", make(1, "cred-a"));
  hub.subscribe("acct-1", make(2, "cred-b"));
  hub.subscribe("acct-2", make(3, "cred-a")); // same credential, other account key
  hub.subscribe("acct-2", make(4)); // shared-mode subscriber, no identity

  assert.equal(hub.disconnectCredential("cred-a"), 2, "both cred-a connections closed");
  assert.deepEqual(closed.sort(), [1, 3]);
  assert.equal(hub.totalConnections(), 2, "cred-b and the identity-less subscriber remain");
  assert.equal(hub.disconnectCredential("cred-a"), 0, "idempotent: nothing left to close");
});

test("SSE: in-process revocation via the admin endpoint terminates the live stream", async () => {
  const h = await startPerAccount();
  try {
    const a = await enroll(h.base, "house-1", "phone");
    const ac = new AbortController();
    const res = await fetch(`${h.base}/events?accountId=house-1`, {
      headers: { Authorization: `Bearer ${a.credential}` },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Consume the ready frame.
    let text = "";
    while (!text.includes("\n\n")) {
      const { value } = await reader.read();
      text += Buffer.from(value!).toString("utf8");
    }
    assert.equal(h.hub.connectionCount("house-1"), 1);

    const rev = await adminRevoke(h.base, a.credentialId);
    assert.equal(rev.status, 200);

    // The stream ends server-side: the reader drains to done without abort.
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      const chunk = await reader.read();
      done = chunk.done;
    }
    assert.equal(done, true, "server closed the stream");
    assert.equal(h.hub.connectionCount("house-1"), 0, "subscriber removed from the hub");

    // The reconnect completes the chain the shipped client rides: 401, exact body.
    const reconnect = await fetch(`${h.base}/events?accountId=house-1`, {
      headers: { Authorization: `Bearer ${a.credential}` },
    });
    assert.equal(reconnect.status, 401);
    assert.deepEqual(await reconnect.json(), { error: "invalid credential" });
  } finally {
    h.close();
  }
});

test("SSE: an out-of-band revocation (direct DB write) is caught by heartbeat revalidation", async () => {
  // buildApp with the production wiring but nothing telling the hub — the
  // revocation happens via a SEPARATE database connection, exactly like a
  // host-side sqlite3 against the mounted volume. Uses a per-account server
  // whose events heartbeat is the default 20s? Too slow for a test — so this
  // harness rebuilds the app with a short heartbeat via the events options
  // that buildApp itself wires. buildApp offers no heartbeat knob (correctly),
  // so we approximate the out-of-process property faithfully at the next
  // layer down: the same isCredentialActive closure buildApp constructs, with
  // eventsRouter's injectable heartbeatMs. The harness-level 20s real-server
  // proof lives in the phase verification script.
  const { default: express } = await import("express");
  const { eventsRouter } = await import("../src/routes/events.js");
  const { makeScopeResolver } = await import("../src/scope.js");
  const { credentialAuth } = await import("../src/middleware/credential-auth.js");
  const { DiskBlobStore } = await import("../src/storage/disk-blobstore.js");

  const dir = mkdtempSync(join(tmpdir(), "glancevault-revoke-hb-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);
  store.migrate();
  const hub = new InProcessAccountHub();
  const issued = store.issueCredential({
    credentialId: "hb-cred",
    accountId: "house-1",
    deviceId: "phone",
    credentialHash: (await import("../src/credentials.js")).hashCredential("gvc_" + "1".repeat(64)),
  });
  assert.equal(issued.superseded, 0);

  const app = express();
  app.use(credentialAuth(store));
  const resolve = makeScopeResolver(store, new DiskBlobStore(join(dir, "blobs")), "per-account");
  app.use(
    "/events",
    eventsRouter(resolve, hub, {
      heartbeatMs: 60,
      isCredentialActive: (id) => {
        const rec = store.getCredentialById(id);
        return rec !== null && rec.revokedAt === null;
      },
    }),
  );
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events?accountId=house-1`, {
      headers: { Authorization: `Bearer ${"gvc_" + "1".repeat(64)}` },
    });
    assert.equal(res.status, 200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value } = await reader.read();
      text += Buffer.from(value!).toString("utf8");
    }
    assert.equal(hub.connectionCount("house-1"), 1);

    // Revoke via a SEPARATE connection to the same file — the server process's
    // store object is not involved in the write, and the hub is never told.
    const outOfBand = new Database(dbPath);
    outOfBand
      .prepare("UPDATE device_credentials SET revoked_at = ? WHERE credential_id = ?")
      .run(new Date().toISOString(), "hb-cred");
    outOfBand.close();

    // The next heartbeat tick revalidates and ends the stream.
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      const chunk = await reader.read();
      done = chunk.done;
    }
    assert.equal(done, true, "heartbeat revalidation closed the stream");
    assert.equal(hub.connectionCount("house-1"), 0, "cleanup removed the subscriber");
  } finally {
    (server as Server & { closeAllConnections(): void }).closeAllConnections();
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejected requests from a revoked credential mutate nothing", async () => {
  const h = await startPerAccount();
  try {
    const a = await enroll(h.base, "house-1", "phone");
    // Establish data with the credential while it is active.
    await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.credential}` },
      body: JSON.stringify({
        accountId: "house-1",
        rows: [{ entityId: "e1", envelope: Buffer.from("v").toString("base64"), deleted: false }],
      }),
    });
    await adminRevoke(h.base, a.credentialId);

    const db = new Database(h.dbPath, { readonly: true });
    const fingerprint = () =>
      JSON.stringify(
        ["sync_rows", "intent_events", "devices", "account_seq", "account_salts", "device_credentials"].map(
          (t) => db.prepare(`SELECT * FROM ${t}`).all(),
        ),
      );
    const before = fingerprint();

    // Attempted write, delete, cursor poke, and intent with the revoked credential.
    const attempts = [
      ["POST", "/sync/dayglance/batch", { accountId: "house-1", rows: [{ entityId: "e1", envelope: "eA==", deleted: false }] }],
      ["DELETE", "/sync/dayglance/e1?accountId=house-1", undefined],
      ["POST", "/sync/dayglance/device", { accountId: "house-1", deviceId: "phone", lastSeenSeq: 99 }],
      ["POST", "/intents/batch", { accountId: "house-1", events: [{ eventId: "x", envelope: "eA==", expiresAt: "2031-01-01T00:00:00.000Z" }] }],
    ] as const;
    for (const [method, path, body] of attempts) {
      const res = await fetch(`${h.base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.credential}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(res.status, 401);
    }

    assert.equal(fingerprint(), before, "no table changed under rejected revoked-credential requests");
    db.close();
  } finally {
    h.close();
  }
});
