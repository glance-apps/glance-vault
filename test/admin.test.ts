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

const DEVICE_TOKEN = "device-token";
const ADMIN_TOKEN = "admin-token";

interface Harness {
  base: string;
  close: () => void;
}

// Start a server WITH an admin token configured, so the /admin routes are
// mounted. (A separate test starts one without an admin token to confirm the
// routes stay absent.)
async function startServer(adminToken?: string): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-admin-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: DEVICE_TOKEN, allowedOrigins: [], adminToken },
    store,
  );
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

function deviceHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEVICE_TOKEN}` };
}

function adminHeaders(token = ADMIN_TOKEN): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function envelope(bytes = 48): string {
  return randomBytes(bytes).toString("base64");
}

async function seedAccount(base: string, accountId: string): Promise<void> {
  // A salt, some rows, a tombstone, and a device cursor: data in every table the
  // purge is meant to clear.
  await fetch(`${base}/salt/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: deviceHeaders(),
    body: JSON.stringify({ salt: randomBytes(16).toString("base64") }),
  });
  await fetch(`${base}/sync/dayglance/batch`, {
    method: "POST",
    headers: deviceHeaders(),
    body: JSON.stringify({
      accountId,
      rows: [
        { entityId: "a", envelope: envelope() },
        { entityId: "b", envelope: envelope() },
      ],
    }),
  });
  await fetch(`${base}/sync/lastglance/batch`, {
    method: "POST",
    headers: deviceHeaders(),
    body: JSON.stringify({ accountId, rows: [{ entityId: "c", envelope: envelope() }] }),
  });
  await fetch(`${base}/sync/dayglance/a?accountId=${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: deviceHeaders(),
  });
  await fetch(`${base}/sync/dayglance/device`, {
    method: "POST",
    headers: deviceHeaders(),
    body: JSON.stringify({ accountId, deviceId: "dev-1", lastSeenSeq: 1 }),
  });
}

async function purge(base: string, accountId: string, token = ADMIN_TOKEN) {
  const res = await fetch(`${base}/admin/account/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: adminHeaders(token),
  });
  return { status: res.status, body: await res.json() };
}

// 1. Purge removes an account's rows AND its salt, across all apps, leaving the
// account in a clean-slate state: salt GET is 404 and every app list is empty.
test("purge wipes an account's rows and salt", async () => {
  const h = await startServer(ADMIN_TOKEN);
  try {
    const account = "acct-purge";
    await seedAccount(h.base, account);

    // Precondition: data is present.
    const saltBefore = await fetch(`${h.base}/salt/${account}`, { headers: deviceHeaders() });
    assert.equal(saltBefore.status, 200, "salt exists before purge");

    const res = await purge(h.base, account);
    assert.equal(res.status, 200);
    assert.equal(res.body.purged, true);
    assert.equal(res.body.deleted.salt, 1, "the salt was deleted");
    assert.equal(res.body.deleted.syncRows, 3, "all 3 sync rows (both apps) were deleted");
    assert.equal(res.body.deleted.devices, 1, "the device cursor was deleted");
    assert.ok(res.body.deleted.accountSeq >= 1, "the seq counter was deleted");

    // Postcondition: clean slate.
    const saltAfter = await fetch(`${h.base}/salt/${account}`, { headers: deviceHeaders() });
    assert.equal(saltAfter.status, 404, "salt is gone after purge");

    for (const app of ["dayglance", "lastglance"]) {
      const list = await fetch(`${h.base}/sync/${app}/list?accountId=${account}&since=0`, {
        headers: deviceHeaders(),
      });
      const body = (await list.json()) as { rows: unknown[] };
      assert.equal(body.rows.length, 0, `${app} has no rows after purge`);
    }

    // A fresh salt can be registered (and is "created"), so a re-enable starts clean.
    const reput = await fetch(`${h.base}/salt/${account}`, {
      method: "PUT",
      headers: deviceHeaders(),
      body: JSON.stringify({ salt: randomBytes(16).toString("base64") }),
    });
    const reputBody = (await reput.json()) as { created: boolean };
    assert.equal(reputBody.created, true, "a new salt is established after purge");
  } finally {
    h.close();
  }
});

// 2. Purge is scoped to one account: a second account's data is untouched.
test("purge does not touch other accounts", async () => {
  const h = await startServer(ADMIN_TOKEN);
  try {
    await seedAccount(h.base, "victim");
    await seedAccount(h.base, "bystander");

    await purge(h.base, "victim");

    const salt = await fetch(`${h.base}/salt/bystander`, { headers: deviceHeaders() });
    assert.equal(salt.status, 200, "bystander salt survives");
    const list = await fetch(`${h.base}/sync/dayglance/list?accountId=bystander&since=0`, {
      headers: deviceHeaders(),
    });
    const body = (await list.json()) as { rows: unknown[] };
    assert.equal(body.rows.length, 2, "bystander rows survive");
  } finally {
    h.close();
  }
});

// 3. Purging an account with no data is a 200 with all-zero counts (idempotent).
test("purging an unknown account is a no-op 200 with zero counts", async () => {
  const h = await startServer(ADMIN_TOKEN);
  try {
    const res = await purge(h.base, "never-existed");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.deleted, {
      syncRows: 0,
      intentEvents: 0,
      devices: 0,
      accountSeq: 0,
      salt: 0,
    });
  } finally {
    h.close();
  }
});

// 4. The admin route requires the admin token, not the device token: a wrong or
// device token is rejected, and the rejection does not purge anything.
test("admin purge rejects a missing, wrong, or device token", async () => {
  const h = await startServer(ADMIN_TOKEN);
  try {
    const account = "acct-auth";
    await seedAccount(h.base, account);

    // No Authorization header.
    const none = await fetch(`${h.base}/admin/account/${account}`, { method: "DELETE" });
    assert.equal(none.status, 401, "missing token is 401");

    // The device token is not the admin token.
    const wrong = await purge(h.base, account, DEVICE_TOKEN);
    assert.equal(wrong.status, 401, "device token cannot purge");

    // The account is intact after the rejected attempts.
    const salt = await fetch(`${h.base}/salt/${account}`, { headers: deviceHeaders() });
    assert.equal(salt.status, 200, "nothing was purged by the rejected calls");
  } finally {
    h.close();
  }
});

// 5. When no admin token is configured, the admin routes are not mounted at all,
// so the destructive endpoint is unreachable even with the device token.
test("admin routes are absent when no admin token is configured", async () => {
  const h = await startServer(undefined);
  try {
    const account = "acct-noadmin";
    await seedAccount(h.base, account);

    // No admin auth middleware is mounted, so the request falls through to the
    // device-token auth and then 404s (route does not exist) rather than purging.
    const res = await fetch(`${h.base}/admin/account/${account}`, {
      method: "DELETE",
      headers: deviceHeaders(),
    });
    assert.equal(res.status, 404, "admin route is not mounted without an admin token");

    const salt = await fetch(`${h.base}/salt/${account}`, { headers: deviceHeaders() });
    assert.equal(salt.status, 200, "the account is untouched");
  } finally {
    h.close();
  }
});
