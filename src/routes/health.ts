import { Router } from "express";
import type { Store } from "../storage/types.js";
import { SERVER_VERSION } from "../version.js";

// GET /healthz. No auth required. Returns a small JSON body reporting liveness,
// the server version, and the storage schema version. Useful for container
// health checks and for confirming a fresh volume migrated on boot.
export function healthRouter(store: Store): Router {
  const router = Router();

  router.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: SERVER_VERSION,
      schemaVersion: store.schemaVersion(),
    });
  });

  return router;
}
