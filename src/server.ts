import express, { type Express } from "express";
import type { Config } from "./config.js";
import type { Store } from "./storage/types.js";
import { deviceTokenAuth, adminTokenAuth } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { saltRouter } from "./routes/salt.js";
import { adminRouter } from "./routes/admin.js";

// Build the Express app. Kept separate from the listen() call in index.ts so it
// can be constructed in tests without binding a port.
//
// CORS runs first so it applies to every route and can answer preflight OPTIONS
// before auth (preflight carries no Authorization header). /healthz is mounted
// before the auth middleware so it stays public. Everything after the auth
// middleware requires the device token.
export function buildApp(config: Config, store: Store): Express {
  const app = express();

  app.use(cors(config.allowedOrigins));

  app.use(healthRouter(store));

  // Admin/maintenance routes are mounted only when an admin token is configured,
  // and gated by that separate token rather than the shared device token. They
  // sit before the device-token middleware so a maintenance caller authenticates
  // with the admin token alone. Off by default: no admin token, no destructive
  // endpoints exposed.
  if (config.adminToken) {
    app.use("/admin", adminTokenAuth(config.adminToken), adminRouter(store));
  }

  app.use(deviceTokenAuth(config.deviceToken));

  // Protected routes. Phase 1 adds the sync transport; the salt store is a
  // Phase 3 prerequisite. Intents and media land in later phases.
  app.use("/sync", syncRouter(store));
  app.use("/salt", saltRouter(store));

  return app;
}
