import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { requestLog, redactPath } from "../src/middleware/request-log.js";

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
