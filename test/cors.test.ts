import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

const TOKEN = "cors-token";

interface Harness {
  base: string;
  close: () => void;
}

async function startServer(allowedOrigins: string[]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-cors-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp({ storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins }, store);
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

test("preflight from an allowed origin gets 204 with CORS headers and no auth", async () => {
  const origin = "https://app.example.com";
  const h = await startServer([origin, "https://other.example.com"]);
  try {
    // Preflight carries no Authorization header on purpose.
    const res = await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    assert.equal(res.status, 204, "preflight is answered before auth");
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    assert.ok(methods.includes("POST") && methods.includes("OPTIONS"));
    const allowHeaders = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.ok(allowHeaders.includes("authorization"), "Authorization is an allowed header");
  } finally {
    h.close();
  }
});

test("actual request from an allowed origin carries the allow-origin header", async () => {
  const origin = "https://app.example.com";
  const h = await startServer([origin]);
  try {
    const res = await fetch(`${h.base}/healthz`, { headers: { Origin: origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("vary"), "Origin");
  } finally {
    h.close();
  }
});

test("a disallowed origin gets no CORS headers", async () => {
  const h = await startServer(["https://app.example.com"]);
  try {
    const res = await fetch(`${h.base}/healthz`, { headers: { Origin: "https://evil.example.com" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);

    const pre = await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(pre.status, 204, "preflight still ends, but without allow headers");
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
  } finally {
    h.close();
  }
});

test("wildcard allows any origin", async () => {
  const h = await startServer(["*"]);
  try {
    const res = await fetch(`${h.base}/healthz`, { headers: { Origin: "https://anything.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    h.close();
  }
});

test("no allowed origins means no CORS headers", async () => {
  const h = await startServer([]);
  try {
    const res = await fetch(`${h.base}/healthz`, { headers: { Origin: "https://app.example.com" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally {
    h.close();
  }
});
