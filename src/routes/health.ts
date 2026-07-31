import { Router } from "express";
import type { Store } from "../storage/types.js";
import type { AuthMode } from "../config.js";
import { SERVER_VERSION } from "../version.js";

// GET /healthz. No auth required (mounted before every auth middleware in both
// modes). Returns a small JSON body reporting liveness, the server version, the
// storage schema version, and the auth mode. Useful for container health
// checks, for confirming a fresh volume migrated on boot, and — the reason
// authMode is here (Phase 1.4a) — for a client to discover which auth model a
// server runs before enrollment, rather than by failing at something.
//
// authMode mirrors the config values exactly ("shared" | "per-account"), so an
// operator reading /healthz and one reading their compose file see the same
// strings. It is appended LAST so the pre-existing fields keep their exact
// serialized positions (res.json preserves insertion order); the only change
// to the body versus before is this one added trailing key. Advertising the
// mode leaks nothing: an unauthenticated caller can already tell the mode apart
// by probing POST /enroll (404 in shared, a real response in per-account), so
// this only makes explicit what is already trivially discoverable — and the
// field is the mode string ONLY, never whether an enrollment secret is set,
// credential counts, or any other auth state.
export function healthRouter(store: Store, authMode: AuthMode): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: SERVER_VERSION,
      schemaVersion: store.schemaVersion(),
      authMode,
    });
  });

  return router;
}
