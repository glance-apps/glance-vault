import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";
import { SCHEMA_VERSION, SERVER_VERSION } from "../src/version.js";

// Phase 1.4a: /healthz advertises the auth mode so a client can discover it
// before enrolling. The endpoint is public in both modes; the body gains one
// trailing "authMode" key mirroring the config values.

interface Harness {
  base: string;
  close: () => void;
}

async function startServer(authMode?: "shared" | "per-account"): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-healthz-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp(
    {
      storagePath: path,
      port: 0,
      deviceToken: "healthz-token",
      allowedOrigins: [],
      authMode,
      enrollmentSecret: authMode === "per-account" ? "boot-secret" : undefined,
    },
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

test("/healthz reports authMode 'shared' by default, unauthenticated, with the exact body shape", async () => {
  const h = await startServer(); // authMode omitted -> shared default
  try {
    // No Authorization header: the endpoint is public.
    const res = await fetch(`${h.base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      status: "ok",
      version: SERVER_VERSION,
      schemaVersion: SCHEMA_VERSION,
      authMode: "shared",
    });
    // authMode is appended LAST, after schemaVersion.
    assert.deepEqual(Object.keys(body as object), ["status", "version", "schemaVersion", "authMode"]);
  } finally {
    h.close();
  }
});

test("/healthz reports authMode 'per-account', unauthenticated", async () => {
  const h = await startServer("per-account");
  try {
    const res = await fetch(`${h.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      version: SERVER_VERSION,
      schemaVersion: SCHEMA_VERSION,
      authMode: "per-account",
    });
  } finally {
    h.close();
  }
});

test("authMode is the only field that differs between the two modes", async () => {
  const shared = await startServer();
  const perAccount = await startServer("per-account");
  try {
    const a = (await (await fetch(`${shared.base}/healthz`)).json()) as Record<string, unknown>;
    const b = (await (await fetch(`${perAccount.base}/healthz`)).json()) as Record<string, unknown>;
    assert.equal(a.authMode, "shared");
    assert.equal(b.authMode, "per-account");
    assert.deepEqual({ ...a, authMode: null }, { ...b, authMode: null });
  } finally {
    shared.close();
    perAccount.close();
  }
});
