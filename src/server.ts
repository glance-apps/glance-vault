import express, { type Express } from "express";
import { DEFAULT_MAX_BLOB_SIZE, defaultBlobStorePath, type Config } from "./config.js";
import type { Store } from "./storage/types.js";
import type { BlobStore } from "./storage/blobstore.js";
import { DiskBlobStore } from "./storage/disk-blobstore.js";
import { deviceTokenAuth } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { requestLog } from "./middleware/request-log.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { intentsRouter } from "./routes/intents.js";
import { saltRouter } from "./routes/salt.js";
import { blobsRouter } from "./routes/blobs.js";
import { eventsRouter } from "./routes/events.js";
import { InProcessAccountHub, type AccountHub, type Emit } from "./realtime/hub.js";

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
// hub is the in-process real-time push registry (Phase 9). Optional so tests can
// inject their own instance to observe connections; when omitted a fresh
// InProcessAccountHub is created. It is per-app (per process): one hub holds all
// of this container's live SSE connections. Multi-container fan-out is deferred
// (spec §13, §14.3) and would slot in behind the AccountHub interface here.
export function buildApp(
  config: Config,
  store: Store,
  blobStore?: BlobStore,
  hub: AccountHub = new InProcessAccountHub(),
): Express {
  const app = express();

  // Request logging runs first so it captures every request, including a CORS
  // preflight (answered by the cors middleware) and an auth rejection. Enabled
  // by loadConfig (default on); left off when config.requestLog is unset, which
  // keeps test output quiet since the test config literals omit it.
  if (config.requestLog) {
    app.use(requestLog());
  }

  app.use(cors(config.allowedOrigins));

  app.use(healthRouter(store));

  app.use(deviceTokenAuth(config.deviceToken));

  // The best-effort emission hook wired to the hub. Passed to the write routers
  // so they nudge connected clients after a commit. hub.publish is non-throwing
  // and non-blocking by contract, so a push failure can never affect a write.
  const emit: Emit = (accountId, nudge) => hub.publish(accountId, nudge);

  // Protected routes. Phase 1 adds the sync transport; the salt store is a
  // Phase 3 prerequisite; intents are the cross-app transport; Phase 7 adds the
  // content-addressed blob store; Phase 9 adds the SSE real-time push endpoint.
  app.use("/sync", syncRouter(store, emit));
  app.use("/intents", intentsRouter(store, emit));
  app.use("/salt", saltRouter(store));

  const blobs = blobStore ?? new DiskBlobStore(config.blobStorePath ?? defaultBlobStorePath(config.storagePath));
  const maxBlobSize = config.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;
  app.use("/blobs", blobsRouter(store, blobs, maxBlobSize));

  // Real-time push (nudge-only SSE), authenticated and account-scoped exactly
  // like the routes above. See routes/events.ts for the event shape and the
  // reverse-proxy flush requirement.
  app.use("/events", eventsRouter(store, hub));

  return app;
}
