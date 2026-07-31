import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { DEFAULT_MAX_BLOB_SIZE, defaultBlobStorePath, type Config } from "./config.js";
import type { Store } from "./storage/types.js";
import type { BlobStore } from "./storage/blobstore.js";
import { DiskBlobStore } from "./storage/disk-blobstore.js";
import { deviceTokenAuth } from "./middleware/auth.js";
import { makeScopeResolver, ScopeError } from "./scope.js";
import { credentialAuth } from "./middleware/credential-auth.js";
import { enrollRouter, bootstrapSecretValidator } from "./routes/enroll.js";
import { cors } from "./middleware/cors.js";
import { requestLog } from "./middleware/request-log.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { intentsRouter } from "./routes/intents.js";
import { saltRouter } from "./routes/salt.js";
import { blobsRouter } from "./routes/blobs.js";
import { eventsRouter } from "./routes/events.js";
import {
  InProcessAccountHub,
  DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT,
  type AccountHub,
  type Emit,
} from "./realtime/hub.js";
import { DEFAULT_MAX_SSE_CONNECTIONS } from "./config.js";

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
  hub?: AccountHub,
): Express {
  const app = express();

  // Trust the reverse proxy so req.ip reflects the real client (via
  // X-Forwarded-For), which per-IP rate limiting depends on. Default "loopback"
  // trusts a proxy on localhost, matching the compose setup. When omitted from a
  // test config literal, fall back to the same default rather than leaving
  // Express's default (which would attribute every request to the proxy).
  app.set("trust proxy", config.trustProxy ?? "loopback");

  // The real-time push registry. When a caller does not inject one (index.ts,
  // most tests), build the in-process hub with the configured global connection
  // ceiling so a single process cannot accumulate unbounded SSE connections
  // across accounts.
  const accountHub =
    hub ??
    new InProcessAccountHub(
      DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT,
      config.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS,
    );

  // Request logging runs first so it captures every request, including a CORS
  // preflight (answered by the cors middleware) and an auth rejection. Enabled
  // by loadConfig (default on); left off when config.requestLog is unset, which
  // keeps test output quiet since the test config literals omit it.
  if (config.requestLog) {
    app.use(requestLog());
  }

  app.use(cors(config.allowedOrigins));

  // Per-IP rate limiting runs after CORS (so a preflight OPTIONS, answered by the
  // cors middleware, is never counted) and before auth (so a token-guessing
  // flood is throttled before it reaches the constant-time compare). Off only
  // when explicitly disabled; test config literals omit the flag, so it stays off
  // in tests unless a test opts in.
  if (config.rateLimit) {
    app.use(
      rateLimit({
        windowMs: config.rateLimitWindowMs ?? 60_000,
        max: config.rateLimitMax ?? 600,
      }),
    );
  }

  app.use(healthRouter(store, config.authMode ?? "shared"));

  // Enrollment (Phase 1.2): REGISTERED ONLY IN PER-ACCOUNT MODE, so a
  // shared-mode server is byte-identical to one where this route does not
  // exist (unknown-path probes keep today's exact 401/404 behavior). This is
  // deliberately a registration-level mode branch — the one kind allowed; no
  // request handler branches on mode. Mounted in the public segment (behind
  // CORS and the rate limiter, before deviceTokenAuth) because the bootstrap
  // secret is the route's own authentication, and the router receives ONLY
  // the narrow CredentialIssuer surface — it structurally cannot reach
  // account data, credential reads, or the sweeps. loadConfig guarantees
  // enrollmentSecret is set whenever authMode is "per-account".
  if (config.authMode === "per-account") {
    app.use("/enroll", enrollRouter(store, bootstrapSecretValidator(config.enrollmentSecret!)));
  }

  // Request auth (Phase 1.3b): a registration-level mode branch, like the
  // /enroll gate above — no handler branches on mode. Shared mode mounts the
  // shared-token middleware exactly as always. Per-account mode mounts the
  // credential middleware IN ITS PLACE: the Bearer token is the per-device
  // credential, 401s (absent/malformed/unrecognized) happen at the same
  // pipeline position they always have, and the shared device token
  // authenticates nothing — honoring it would let any holder keep acting on
  // any account, the vulnerability enforcement closes.
  if (config.authMode === "per-account") {
    app.use(credentialAuth(store));
  } else {
    app.use(deviceTokenAuth(config.deviceToken));
  }

  // The best-effort emission hook wired to the hub. Passed to the write routers
  // so they nudge connected clients after a commit. hub.publish is non-throwing
  // and non-blocking by contract, so a push failure can never affect a write.
  const emit: Emit = (accountId, nudge) => accountHub.publish(accountId, nudge);

  const blobs = blobStore ?? new DiskBlobStore(config.blobStorePath ?? defaultBlobStorePath(config.storagePath));
  const maxBlobSize = config.maxBlobSize ?? DEFAULT_MAX_BLOB_SIZE;

  // The scope resolver (Phase 1.3a): the ONLY path from a request to account
  // data. Routers receive this instead of the store, so a handler physically
  // has no object through which an unscoped (or wrongly-scoped) access could be
  // written. In this phase the resolver binds the claimed accountId in both
  // auth modes — behavior is byte-identical to before the split; a later phase
  // changes only what happens inside makeScopeResolver. The root store stays in
  // this function for /healthz (schemaVersion) and is handed to the sweeps by
  // index.ts; after the interface split it cannot read account data itself
  // except via forAccount.
  const resolveScope = makeScopeResolver(store, blobs, config.authMode ?? "shared");

  // Protected routes. Phase 1 adds the sync transport; the salt store is a
  // Phase 3 prerequisite; intents are the cross-app transport; Phase 7 adds the
  // content-addressed blob store; Phase 9 adds the SSE real-time push endpoint.
  app.use("/sync", syncRouter(resolveScope, emit));
  app.use("/intents", intentsRouter(resolveScope, emit));
  app.use("/salt", saltRouter(resolveScope));

  app.use("/blobs", blobsRouter(resolveScope, maxBlobSize));

  // Real-time push (nudge-only SSE), authenticated and account-scoped exactly
  // like the routes above. See routes/events.ts for the event shape and the
  // reverse-proxy flush requirement.
  app.use("/events", eventsRouter(resolveScope, accountHub));

  // The scope-rejection mapper (Phase 1.3b), mounted after every router. It
  // intercepts EXACTLY the resolver's ScopeError throws — the class exists
  // nowhere else — and translates them to the uniform 401/403 JSON. Every
  // other error takes next(err) to Express's default handler, exactly as if
  // this middleware did not exist; existing error responses (all written
  // directly to res by handlers) never enter the error path at all. The
  // eslint-style unused `next` parameter is required: Express dispatches by
  // arity, and a 4-arg signature is what marks an error middleware.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ScopeError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  });

  return app;
}
