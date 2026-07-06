import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { requestLog } from "../src/middleware/request-log.js";

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

test("logs one line per request with method, path (incl. query), and status", async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/thing?since=5`);
    await res.text();
    assert.equal(res.status, 201);
    await waitFor(() => h.lines.length >= 1);
    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /^GET \/thing\?since=5 201 [\d.]+ms$/);
  } finally {
    h.close();
  }
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
