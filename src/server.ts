import express, { type Express } from "express";
import { DEFAULT_MAX_BLOB_SIZE, defaultBlobStorePath, type Config } from "./config.js";
import type { Store } from "./storage/types.js";
import type { BlobStore } from "./storage/blobstore.js";
import { DiskBlobStore } from "./storage/disk-blobstore.js";
import { deviceTokenAuth } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { intentsRouter } from "./routes/intents.js";
import { saltRouter } from "./routes/salt.js";
import { blobsRouter } from "./routes/blobs.js";

// Build the Express app. Kept separate from the listen() call in index.ts so it
// can be constructed in tests without binding a port.
//
// CORS runs first so it applies to every route and can answer preflight OPTIONS
// before auth (preflight carries no Authorization header). /healthz is mounted
// before the auth middleware so it stays public. Everything after the auth
// middleware requires the device token.
// blobStore is optional: callers that pass one (index.ts, blob tests) control
// where the bytes live and the size cap. When omitted, a DiskBlobStore is
// constructed from the config so existing call sites (which never exercise the
// blob endpoints) keep working unchanged; the DiskBlobStore touches no disk
// until a blob is actually written.
export function buildApp(config: Config, store: Store, blobStore?: BlobStore): Express {
  const app = express();

  app.use(cors(config.allowedOrigins));

  app.use(healthRouter(store));

  app.use(deviceTokenAuth(config.deviceToken));

  // Protected routes. Phase 1 adds the sync transport; the salt store is a
  // Phase 3 prerequisite; intents are the cross-app transport; Phase 7 adds the
  // content-addressed blob store.
  app.use("/sync", syncRouter(store));
  app.use("/intents", intentsRouter(store));
  app.use("/salt", saltRouter(store));

  const blobs = blobStore ?? new DiskBlobStore(config.blobStorePath ?? defaultBlobStorePath(config.storagePath));
  const maxBlobSize = config.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
  app.use("/blobs", blobsRouter(store, blobs, maxBlobSize));

  return app;
}
