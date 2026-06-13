import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { Store } from "./storage/types.js";
import { deviceTokenAuth } from "./middleware/auth.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { saltRouter } from "./routes/salt.js";

// Build the Express app. Kept separate from the listen() call in index.ts so it
// can be constructed in tests without binding a port.
//
// /healthz is mounted before the auth middleware so it stays public. Everything
// after the auth middleware requires the device token. There are no protected
// routes yet in Phase 0; the middleware is in place so sync, intents, and media
// endpoints land already guarded in later phases.
export function buildApp(config: Config, store: Store): Express {
  const app = express();

  app.use(healthRouter(store));

  app.use(deviceTokenAuth(config.deviceToken));

  // Protected routes. Phase 1 adds the sync transport; the salt store is a
  // Phase 3 prerequisite. Intents and media land in later phases.
  app.use("/sync", syncRouter(store));
  app.use("/salt", saltRouter(store));

  return app;
}
