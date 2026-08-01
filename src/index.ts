import { loadConfig } from "./config.js";
import { SqliteStore } from "./storage/sqlite.js";
import { DiskBlobStore } from "./storage/disk-blobstore.js";
import { buildApp } from "./server.js";
import { reclaimSweep } from "./reclaim.js";
import { reapUploadSessions } from "./upload-reaper.js";
import { SERVER_VERSION, SCHEMA_VERSION } from "./version.js";
import { TARGET_SCHEMA_VERSION } from "./storage/migrations.js";

// Entry point. Load config, open storage, run migrations on boot (so a fresh,
// empty volume comes up working), then start listening.
function main(): void {
  const config = loadConfig();

  // Guard against the version constant drifting from the actual migration set.
  if (SCHEMA_VERSION !== TARGET_SCHEMA_VERSION) {
    throw new Error(
      `SCHEMA_VERSION (${SCHEMA_VERSION}) does not match the migration set (${TARGET_SCHEMA_VERSION}).`,
    );
  }

  // Selecting "per-account" today buys nothing: the credential store exists but
  // no issuance, derivation, or rejection is wired up, so requests are still
  // scoped exactly as in "shared" mode. Say so loudly rather than let an operator
  // believe they have turned on an enforcement that is not built yet.
  if (config.authMode === "per-account") {
    // Enforcement is live (Phase 1.3b): every scoped request must present a
    // per-device credential, and the operative account is derived from it. The
    // shared device token is still REQUIRED BY CONFIG but authenticates
    // nothing in this mode — say so, or the operator's first signal is a
    // fleet of 401s.
    console.log(
      "auth: per-account enforcement is active. Requests authenticate with " +
        "per-device credentials (enroll at POST /enroll); a client-supplied " +
        "accountId that does not match the credential is rejected with 403.",
    );
    console.warn(
      "auth: GLANCEVAULT_DEVICE_TOKEN is configured but the shared device " +
        "token authenticates NOTHING in per-account mode. Clients presenting " +
        "it will receive 401 invalid credential; devices must enroll for " +
        "per-device credentials instead.",
    );
    // Footgun, not a broken state: an enrollment secret equal to the shared
    // device token collapses the two trust levels (any token holder could
    // enroll durable per-device credentials). Warn, don't refuse — an
    // operator may have done this deliberately while testing.
    if (config.enrollmentSecret === config.deviceToken) {
      console.warn(
        "auth: GLANCEVAULT_ENROLLMENT_SECRET equals GLANCEVAULT_DEVICE_TOKEN. " +
          "Use a distinct secret so holding the shared device token does not " +
          "also grant the ability to enroll new device credentials.",
      );
    }
  }

  // Quotas configured in shared mode gate the CLAIMED account, which any
  // client can rename: advisory, not enforcement. Warn, don't refuse — same
  // treatment as the shared-token and equal-secrets warnings.
  const anyQuota =
    config.quotaStorageBytes !== undefined ||
    config.quotaRows !== undefined ||
    config.quotaIntents !== undefined ||
    config.quotaUploads !== undefined;
  if (anyQuota && config.authMode !== "per-account") {
    console.warn(
      "quotas: per-account quotas are configured but GLANCEVAULT_AUTH_MODE is " +
        "shared. Quotas gate the accountId the client CLAIMS, and a client can " +
        "evade them by renaming its claimed account — they are advisory without " +
        "per-account identity. Enable per-account mode for real enforcement.",
    );
  }

  const store = new SqliteStore(config.storagePath);
  store.migrate();

  // The blob store (opaque ciphertext bytes) lives on disk now, behind the
  // BlobStore interface so an object-storage backend can slot in later with no
  // endpoint change.
  const blobStore = new DiskBlobStore(config.blobStorePath!);

  const app = buildApp(config, store, blobStore);
  const server = app.listen(config.port, () => {
    console.log(
      `GLANCEvault ${SERVER_VERSION} listening on port ${config.port} ` +
        `(auth ${config.authMode}, schema v${store.schemaVersion()}, ` +
        `storage ${config.storagePath}, ` +
        `blobs ${config.blobStorePath}, maxBlob ${config.maxBlobSize}B, ` +
        `reclaim ${config.blobReclaim ? "on" : "off (retain)"})`,
    );
  });

  // Periodic blob reclaim sweep. DEFAULT RETAIN: the timer is armed ONLY when the
  // operator has opted in (config.blobReclaim). When off, no sweep ever runs and
  // nothing is deleted. The sweep is heavier than the lazy intents prune, so it
  // runs on a schedule off the request hot path. unref() so a pending timer never
  // keeps the process alive on shutdown.
  let reclaimTimer: ReturnType<typeof setInterval> | undefined;
  if (config.blobReclaim) {
    const policy = {
      reclaim: true,
      gracePeriodMs: config.blobGracePeriodMs!,
      deadDevicePeriodMs: config.blobDeadDevicePeriodMs!,
    };
    reclaimTimer = setInterval(() => {
      try {
        reclaimSweep(store, blobStore, policy);
      } catch (err) {
        console.error(`reclaim: sweep failed: ${String(err)}`);
      }
    }, config.blobReclaimIntervalMs!);
    reclaimTimer.unref();
    console.log(
      `reclaim: enabled (grace ${config.blobGracePeriodMs}ms, ` +
        `dead-device ${config.blobDeadDevicePeriodMs}ms, ` +
        `interval ${config.blobReclaimIntervalMs}ms)`,
    );
  }

  // Stale-upload-session reaper. ALWAYS ON (it only ever removes abandoned
  // transfer-layer scratch — a never-finalized session and its staged part bytes
  // — never a finalized blob or a synced row), so it needs no operator opt-in.
  // unref() so a pending sweep never keeps the process alive on shutdown.
  const uploadReaperTimer = setInterval(() => {
    try {
      reapUploadSessions(store, blobStore, config.uploadSessionTtlMs!);
    } catch (err) {
      console.error(`upload-reaper: sweep failed: ${String(err)}`);
    }
  }, config.uploadSessionSweepIntervalMs!);
  uploadReaperTimer.unref();

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down.`);
    if (reclaimTimer) {
      clearInterval(reclaimTimer);
    }
    clearInterval(uploadReaperTimer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
