import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_AUTH_MODE } from "../src/config.js";

// loadConfig reads an optional JSON config file whose path comes from
// GLANCEVAULT_CONFIG. These tests pass an explicit env object, and the repo has
// no ./config.json, so only the env values below are in play.
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { GLANCEVAULT_DEVICE_TOKEN: "test-token", ...extra };
}

test("auth mode defaults to shared", () => {
  assert.equal(loadConfig(env()).authMode, "shared");
  assert.equal(DEFAULT_AUTH_MODE, "shared");
});

test("auth mode accepts both modes, trimmed and case-insensitive", () => {
  // per-account requires an enrollment secret since Phase 1.2, so those
  // variants carry one; shared needs none.
  const withSecret = { GLANCEVAULT_ENROLLMENT_SECRET: "boot" };
  assert.equal(loadConfig(env({ GLANCEVAULT_AUTH_MODE: "shared" })).authMode, "shared");
  assert.equal(
    loadConfig(env({ GLANCEVAULT_AUTH_MODE: "per-account", ...withSecret })).authMode,
    "per-account",
  );
  assert.equal(
    loadConfig(env({ GLANCEVAULT_AUTH_MODE: "  Per-Account ", ...withSecret })).authMode,
    "per-account",
  );
});

test("an unrecognized auth mode is fatal, not silently coerced", () => {
  // Deliberately unlike the on/off flags, which treat anything unrecognized as
  // their default. A typo here must not quietly leave the server in shared mode
  // once per-account means something.
  for (const bad of ["per_account", "peraccount", "off", "true", "SHARE"]) {
    assert.throws(
      () => loadConfig(env({ GLANCEVAULT_AUTH_MODE: bad })),
      /Invalid GLANCEVAULT_AUTH_MODE/,
      `rejected ${bad}`,
    );
  }
});

test("an empty auth mode is treated as unset", () => {
  // The compose file passes optional settings through as ${VAR:-}, so an empty
  // value must select the default rather than refuse to boot.
  assert.equal(loadConfig(env({ GLANCEVAULT_AUTH_MODE: "" })).authMode, "shared");
  assert.equal(loadConfig(env({ GLANCEVAULT_AUTH_MODE: "   " })).authMode, "shared");
});

test("auth mode does not disturb the rest of the config", () => {
  // Both variants carry the enrollment secret (required in per-account mode
  // since Phase 1.2) so authMode remains the only differing field.
  const secret = { GLANCEVAULT_ENROLLMENT_SECRET: "boot" };
  const shared = loadConfig(env({ GLANCEVAULT_AUTH_MODE: "shared", ...secret }));
  const perAccount = loadConfig(env({ GLANCEVAULT_AUTH_MODE: "per-account", ...secret }));
  assert.deepEqual(
    { ...shared, authMode: null },
    { ...perAccount, authMode: null },
    "the flag is the only field it changes",
  );
});
