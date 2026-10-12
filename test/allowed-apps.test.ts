import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig, DEFAULT_ALLOWED_APPS } from "../src/config.js";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

// loadConfig reads an optional JSON config file whose path comes from
// GLANCEVAULT_CONFIG. These tests pass an explicit env object, and the repo has
// no ./config.json, so only the env values below are in play.
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GLANCEVAULT_DEVICE_TOKEN: "test-token", ...extra };
}

test("allowed apps default to every current GLANCE app", () => {
  assert.deepEqual(loadConfig(env()).allowedApps, [...DEFAULT_ALLOWED_APPS]);
  for (const app of ["dayglance", "dayglance-bridge", "lastglance", "lastglance-people", "lifeglance"]) {
    assert.ok(DEFAULT_ALLOWED_APPS.includes(app), `${app} is in the default`);
  }
});

test("a blank GLANCEVAULT_ALLOWED_APPS (compose passthrough) falls back to the default", () => {
  assert.deepEqual(loadConfig(env({ GLANCEVAULT_ALLOWED_APPS: "  " })).allowedApps, [
    ...DEFAULT_ALLOWED_APPS,
  ]);
});

test("GLANCEVAULT_ALLOWED_APPS replaces the default, trimmed and de-duplicated", () => {
  assert.deepEqual(
    loadConfig(env({ GLANCEVAULT_ALLOWED_APPS: " lastglance, newglance ,,lastglance" })).allowedApps,
    ["lastglance", "newglance"],
  );
});

test("a malformed app name is fatal at startup", () => {
  for (const bad of ["LastGlance", "last glance", "-lead", "a/b", "x".repeat(65)]) {
    assert.throws(
      () => loadConfig(env({ GLANCEVAULT_ALLOWED_APPS: `lastglance,${bad}` })),
      /Invalid app name in GLANCEVAULT_ALLOWED_APPS/,
      `rejected ${bad}`,
    );
  }
});

test("a list of only separators is fatal, not an empty allowlist", () => {
  assert.throws(
    () => loadConfig(env({ GLANCEVAULT_ALLOWED_APPS: ", ," })),
    /GLANCEVAULT_ALLOWED_APPS is empty/,
  );
});

const TOKEN = "apps-token";

async function withServer(
  allowedApps: string[] | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-apps-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [], allowedApps },
    store,
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listStatus(base: string, app: string): Promise<number> {
  const res = await fetch(`${base}/sync/${app}/list?accountId=acct`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  await res.arrayBuffer();
  return res.status;
}

test("lastglance-people syncs on a server with no app config", async () => {
  await withServer(undefined, async (base) => {
    assert.equal(await listStatus(base, "lastglance-people"), 200);
    assert.equal(await listStatus(base, "lastglance"), 200);
    assert.equal(await listStatus(base, "bogus"), 400);
  });
});

test("a configured app list is what the sync routes enforce", async () => {
  await withServer(["newglance"], async (base) => {
    assert.equal(await listStatus(base, "newglance"), 200, "configured app accepted");
    assert.equal(await listStatus(base, "lastglance"), 400, "default app no longer accepted");
    const res = await fetch(`${base}/sync/lastglance/list?accountId=acct`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.deepEqual(await res.json(), { error: "unknown app", allowed: ["newglance"] });
  });
});
