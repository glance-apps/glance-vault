import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";
import { InProcessAccountHub } from "../src/realtime/hub.js";

// Phase 1.3b: per-account enforcement. The operative account comes from the
// authenticated per-device credential; a claimed accountId that does not
// byte-exactly match is 403; an absent/malformed/unrecognized credential is
// 401. Shared mode is untouched (every other test file exercises it).

const TOKEN = "enforcement-device-token";
const SECRET = "enforcement-bootstrap-secret";

interface Harness {
  base: string;
  store: SqliteStore;
  hub: InProcessAccountHub;
  close: () => void;
}

async function startPerAccount(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-enforce-"));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const hub = new InProcessAccountHub();
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

async function call(
  base: string,
  credential: string | null,
  method: string,
  path: string,
  json?: unknown,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (credential !== null) headers.Authorization = `Bearer ${credential}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

test("the operative account is derived from the credential; mismatched claims get 403 on all three transports", async () => {
  const h = await startPerAccount();
  try {
    const credA = await enroll(h.base, "house-a", "phone");

    // Legitimate use works: write and read back under the bound account.
    const write = await call(h.base, credA, "POST", "/sync/dayglance/batch", {
      accountId: "house-a",
      rows: [{ entityId: "e1", envelope: Buffer.from("v1").toString("base64"), deleted: false }],
    });
    assert.equal(write.status, 200);

    // Body transport.
    const bodyMismatch = await call(h.base, credA, "POST", "/sync/dayglance/batch", {
      accountId: "house-b",
      rows: [{ entityId: "e1", envelope: Buffer.from("x").toString("base64"), deleted: false }],
    });
    assert.equal(bodyMismatch.status, 403);
    assert.deepEqual(bodyMismatch.body, { error: "credential is not bound to this account" });

    // Query transport.
    const queryMismatch = await call(h.base, credA, "GET", "/sync/dayglance/list?accountId=house-b&since=0");
    assert.equal(queryMismatch.status, 403);

    // Path-param transport (salt) — and salt SQUATTING specifically: a PUT to
    // an account nobody owns is rejected, not first-write-won.
    const saltSquat = await call(h.base, credA, "PUT", "/salt/unowned-account", {
      salt: Buffer.from("evil").toString("base64"),
    });
    assert.equal(saltSquat.status, 403);
    assert.equal(h.store.forAccount("unowned-account").getSalt(), null, "no salt row was created");
  } finally {
    h.close();
  }
});

test("401 for absent, malformed, and unrecognized credentials — distinct from the 403 mismatch", async () => {
  const h = await startPerAccount();
  try {
    await enroll(h.base, "house-a", "phone");

    const absent = await call(h.base, null, "GET", "/sync/dayglance/list?accountId=house-a&since=0");
    assert.equal(absent.status, 401);
    assert.deepEqual(absent.body, { error: "missing or malformed Authorization header" });

    const res = await fetch(`${h.base}/sync/dayglance/list?accountId=house-a&since=0`, {
      headers: { Authorization: "NotBearer stuff" },
    });
    assert.equal(res.status, 401);

    const unknown = await call(
      h.base,
      "gvc_" + "0".repeat(64),
      "GET",
      "/sync/dayglance/list?accountId=house-a&since=0",
    );
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, { error: "invalid credential" });

    // The shared device token authenticates NOTHING in per-account mode.
    const sharedToken = await call(h.base, TOKEN, "GET", "/sync/dayglance/list?accountId=house-a&since=0");
    assert.equal(sharedToken.status, 401);
    assert.deepEqual(sharedToken.body, { error: "invalid credential" });
  } finally {
    h.close();
  }
});

test("byte-exact comparison: whitespace-distinct accounts stay distinct", async () => {
  const h = await startPerAccount();
  try {
    const credPlain = await enroll(h.base, "house-1", "phone");
    const credSpaced = await enroll(h.base, " house-1", "phone");

    const wrongWay = await call(
      h.base,
      credPlain,
      "GET",
      `/sync/dayglance/list?accountId=${encodeURIComponent(" house-1")}&since=0`,
    );
    assert.equal(wrongWay.status, 403, '"house-1" credential cannot act on " house-1"');

    const otherWay = await call(h.base, credSpaced, "GET", "/sync/dayglance/list?accountId=house-1&since=0");
    assert.equal(otherWay.status, 403, '" house-1" credential cannot act on "house-1"');

    const rightWay = await call(
      h.base,
      credSpaced,
      "GET",
      `/sync/dayglance/list?accountId=${encodeURIComponent(" house-1")}&since=0`,
    );
    assert.equal(rightWay.status, 200, "each credential works on its own byte-exact account");
  } finally {
    h.close();
  }
});

test("SSE: a cross-account subscription is rejected with 403 BEFORE hub.subscribe", async () => {
  const h = await startPerAccount();
  try {
    const credA = await enroll(h.base, "house-a", "phone");

    const res = await fetch(`${h.base}/events?accountId=house-b`, {
      headers: { Authorization: `Bearer ${credA}` },
    });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/, "a JSON rejection, not a stream");
    assert.deepEqual(await res.json(), { error: "credential is not bound to this account" });
    assert.equal(h.hub.connectionCount("house-b"), 0, "the hub never saw the subscription");
    assert.equal(h.hub.totalConnections(), 0);

    // The legitimate subscription still works, keyed by the derived account.
    const ac = new AbortController();
    const ok = await fetch(`${h.base}/events?accountId=house-a`, {
      headers: { Authorization: `Bearer ${credA}` },
      signal: ac.signal,
    });
    assert.equal(ok.status, 200);
    const reader = (ok.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value!).toString("utf8");
    }
    assert.match(text, /event: ready/);
    assert.equal(h.hub.connectionCount("house-a"), 1, "subscribed under the derived account");
    ac.abort();
  } finally {
    h.close();
  }
});

test("rejected cross-account writes mutate nothing", async () => {
  const h = await startPerAccount();
  try {
    const credA = await enroll(h.base, "house-a", "phone");
    const credB = await enroll(h.base, "house-b", "phone");

    // Account B establishes real data with its own credential.
    await call(h.base, credB, "POST", "/sync/dayglance/batch", {
      accountId: "house-b",
      rows: [{ entityId: "victim", envelope: Buffer.from("original").toString("base64"), deleted: false }],
    });
    await call(h.base, credB, "PUT", "/salt/house-b", { salt: Buffer.from("b-salt").toString("base64") });
    const scopeB = h.store.forAccount("house-b");
    const rowBefore = scopeB.getRow("dayglance", "victim");
    const saltBefore = scopeB.getSalt();
    const seqBefore = scopeB.latestSeq();

    // A's credential attempts overwrite, delete, cursor poke, and intent
    // injection against B. All 403.
    const attempts = [
      await call(h.base, credA, "POST", "/sync/dayglance/batch", {
        accountId: "house-b",
        rows: [{ entityId: "victim", envelope: Buffer.from("overwritten").toString("base64"), deleted: false }],
      }),
      await call(h.base, credA, "DELETE", "/sync/dayglance/victim?accountId=house-b"),
      await call(h.base, credA, "POST", "/sync/dayglance/device", {
        accountId: "house-b",
        deviceId: "phone",
        lastSeenSeq: 999,
      }),
      await call(h.base, credA, "POST", "/intents/batch", {
        accountId: "house-b",
        events: [
          {
            eventId: "inject",
            envelope: Buffer.from("x").toString("base64"),
            expiresAt: "2031-01-01T00:00:00.000Z",
          },
        ],
      }),
      await call(h.base, credA, "PUT", "/salt/house-b", { salt: Buffer.from("evil").toString("base64") }),
    ];
    for (const a of attempts) {
      assert.equal(a.status, 403);
    }

    assert.deepEqual(scopeB.getRow("dayglance", "victim"), rowBefore, "row untouched");
    assert.deepEqual(scopeB.getSalt(), saltBefore, "salt untouched");
    assert.equal(scopeB.latestSeq(), seqBefore, "no seq consumed by rejected writes");
    assert.equal(scopeB.listIntents(0, 10).rows.length, 0, "no intent injected");
    assert.equal(
      (h.store.forAccount("house-b").listRows("dayglance", 0, 10).rows[0] as { deleted: boolean }).deleted,
      false,
      "no tombstone created",
    );
  } finally {
    h.close();
  }
});
