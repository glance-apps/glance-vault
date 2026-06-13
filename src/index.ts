import { loadConfig } from "./config.js";
import { SqliteStore } from "./storage/sqlite.js";
import { buildApp } from "./server.js";
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

  const app = buildApp(config, store);
  const server = app.listen(config.port, () => {
    console.log(
      `GLANCEvault ${SERVER_VERSION} listening on port ${config.port} ` +
        `(schema v${store.schemaVersion()}, storage ${config.storagePath})`,
    );
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down.`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
