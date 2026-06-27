import { loadConfig } from "./config.js";
import { SqliteStore } from "./storage/sqlite.js";
import { DiskBlobStore } from "./storage/disk-blobstore.js";
import { buildApp } from "./server.js";
import { reclaimSweep } from "./reclaim.js";
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
        `(schema v${store.schemaVersion()}, storage ${config.storagePath}, ` +
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

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down.`);
    if (reclaimTimer) {
      clearInterval(reclaimTimer);
    }
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
