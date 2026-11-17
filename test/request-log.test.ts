import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestLog, redactPath } from "../src/middleware/request-log.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/storage/sqlite.js";

interface Harness {
  base: string;
  lines: string[];
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const lines: string[] = [];
  const app = express();
  app.use(requestLog((m) => lines.push(m)));
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get("/thing", (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.get("/sync/:app/:entityId", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    lines,
    close: () => server.close(),
  };
}

// The response's "finish" event can fire a beat after the client's fetch
// promise resolves, so poll briefly rather than asserting immediately.
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("logs one line per request with method, redacted route, and status (no query)", async () => {
  const h = await startServer();
  try {
    // The query string is stripped: an unknown route redacts every segment, and
    // ?since=5 never reaches the log line.
    const res = await fetch(`${h.base}/thing?since=5`);
    await res.text();
    assert.equal(res.status, 201);
    await waitFor(() => h.lines.length >= 1);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /^GET \/:seg 201 [\d.]+ms$/);
    assert.doesNotMatch(h.lines[0], /since=5/, "the query string is never logged");
  } finally {
    h.close();
  }
});

test("redacts the plaintext entityId and accountId out of the log line", async () => {
  const h = await startServer();
  try {
    // A single-row GET carries a plaintext entityId in the path and accountId in
    // the query; neither may appear in the log — only the route template does.
    const res = await fetch(`${h.base}/sync/dayglance/dailyNotes:2026-07-10?accountId=household-7`);
    await res.text();
    assert.equal(res.status, 200);
    await waitFor(() => h.lines.length >= 1);
    assert.equal(h.lines[0].replace(/ [\d.]+ms$/, ""), "GET /sync/:app/:entityId 200");
    assert.doesNotMatch(h.lines[0], /dailyNotes|2026-07-10|household-7|accountId/);
  } finally {
    h.close();
  }
});

test("redactPath collapses every user-identifying segment to a template", () => {
  // Sync literals kept; entityId redacted.
  assert.equal(redactPath("/sync/dayglance/batch"), "/sync/:app/batch");
  assert.equal(redactPath("/sync/dayglance/list"), "/sync/:app/list");
  assert.equal(redactPath("/sync/dayglance/device"), "/sync/:app/device");
  assert.equal(redactPath("/sync/dayglance/tasks:abc-123"), "/sync/:app/:entityId");
  assert.equal(redactPath("/sync/dayglance/singleton:deletedTaskIds"), "/sync/:app/:entityId");
  // Intents literals kept.
  assert.equal(redactPath("/intents/batch"), "/intents/batch");
  assert.equal(redactPath("/intents/list"), "/intents/list");
  // Salt account id redacted.
  assert.equal(redactPath("/salt/household-7"), "/salt/:accountId");
  // Blob hash and upload segments redacted; literals kept.
  const hash = "a".repeat(64);
  assert.equal(redactPath(`/blobs/${hash}`), "/blobs/:hash");
  assert.equal(redactPath(`/blobs/${hash}/ref-add`), "/blobs/:hash/ref-add");
  assert.equal(redactPath(`/blobs/${hash}/ref-release`), "/blobs/:hash/ref-release");
  assert.equal(redactPath("/blobs/uploads"), "/blobs/uploads");
  assert.equal(redactPath("/blobs/uploads/some-upload-id"), "/blobs/uploads/:uploadId");
  assert.equal(redactPath("/blobs/uploads/some-upload-id/parts/3"), "/blobs/uploads/:uploadId/parts/:index");
  assert.equal(redactPath("/blobs/uploads/some-upload-id/finalize"), "/blobs/uploads/:uploadId/finalize");
  // Unknown routes redact every segment (redactPath only ever sees req.path,
  // never a query string).
  assert.equal(redactPath("/thing"), "/:seg");
  assert.equal(redactPath("/a/b/c"), "/:seg/:seg/:seg");
  assert.equal(redactPath("/"), "/");
});

test("does not log health-check requests", async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/healthz`);
    await res.text();
    assert.equal(res.status, 200);
    // Give any stray finish handler a chance to fire, then assert nothing logged.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.lines.length, 0);
  } finally {
    h.close();
  }
});

test("redactPath names /enroll and /admin routes and redacts their ids", () => {
  assert.equal(redactPath("/enroll"), "/enroll");
  assert.equal(redactPath("/enroll/extra"), "/enroll/:seg");
  assert.equal(redactPath("/admin/accounts"), "/admin/accounts");
  assert.equal(redactPath("/admin/accounts/house-1"), "/admin/accounts/:accountId");
  assert.equal(redactPath("/admin/accounts/house-1/rotate-key"), "/admin/accounts/:accountId/rotate-key");
  assert.equal(redactPath("/admin/accounts/house-1/other"), "/admin/accounts/:accountId/:seg");
  assert.equal(redactPath("/admin/credentials"), "/admin/credentials");
  assert.equal(redactPath("/admin/credentials/cred-123/revoke"), "/admin/credentials/:credentialId/revoke");
  assert.equal(redactPath("/admin/credentials/cred-123"), "/admin/credentials/:credentialId");
  assert.equal(redactPath("/admin/usage"), "/admin/usage");
  assert.equal(redactPath("/admin/usage/house-1"), "/admin/usage/:seg");
  // Unknown admin sub-paths are redacted wholesale.
  assert.equal(redactPath("/admin/house-1"), "/admin/:seg");
  assert.equal(redactPath("/admin"), "/admin");
});

test("end to end: enrollment and admin traffic is logged without account or credential ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-request-log-"));
  const dbPath = join(dir, "test.db");
  const store = new SqliteStore(dbPath);
  store.migrate();
  const SECRET = "request-log-test-bootstrap-secret";
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let server: Server | undefined;
  try {
    const app = buildApp(
      {
        storagePath: dbPath,
        port: 0,
        deviceToken: "request-log-test-device-token",
        allowedOrigins: [],
        authMode: "per-account",
        enrollmentSecret: SECRET,
        enrollmentMode: "account-key",
        requestLog: true,
      },
      store,
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const admin = { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" };
    const post = (path: string, headers: Record<string, string>, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    const accountId = "tester-household-alpha";
    const deviceId = "tester-phone-bravo";
    const created = await post("/admin/accounts", admin, { accountId, label: "Tester A" });
    assert.equal(created.status, 201);
    const { accountKey } = (await created.json()) as { accountKey: string };

    const bad = await post("/enroll", { "Content-Type": "application/json" }, { accountKey: "wrong", deviceId });
    await bad.text();
    const good = await post("/enroll", { "Content-Type": "application/json" }, { accountKey, deviceId });
    assert.equal(good.status, 201);
    const { credentialId } = (await good.json()) as { credentialId: string };

    for (const path of ["/admin/accounts", "/admin/credentials", "/admin/usage"]) {
      const r = await fetch(`${base}${path}`, { headers: admin });
      await r.text();
    }
    await (await post(`/admin/credentials/${credentialId}/revoke`, admin, {})).text();
    await (await post(`/admin/accounts/${accountId}/rotate-key`, admin, {})).text();
    const del = await fetch(`${base}/admin/accounts/${accountId}`, {
      method: "DELETE",
      headers: admin,
      body: JSON.stringify({ confirm: accountId }),
    });
    assert.equal(del.status, 200);
    await del.text();
    await new Promise((r) => setTimeout(r, 50));

    const requests = lines.filter((l) => /^(GET|POST|DELETE) \//.test(l)).map((l) => l.replace(/ [\d.]+ms$/, ""));
    assert.deepEqual(requests, [
      "POST /admin/accounts 201",
      `POST /enroll ${bad.status}`,
      "POST /enroll 201",
      "GET /admin/accounts 200",
      "GET /admin/credentials 200",
      "GET /admin/usage 200",
      "POST /admin/credentials/:credentialId/revoke 200",
      "POST /admin/accounts/:accountId/rotate-key 200",
      "DELETE /admin/accounts/:accountId 200",
    ]);
    // No secret, key, or identifier from these requests reaches any log line.
    const all = lines.join("\n");
    for (const secretish of [accountId, deviceId, credentialId, accountKey, SECRET, "Tester A"]) {
      assert.ok(!all.includes(secretish), `log leaked ${secretish}`);
    }
  } finally {
    console.log = originalLog;
    server?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
