import { Router, type Request, type Response } from "express";
import type { Store } from "../storage/types.js";

// Admin/maintenance endpoints. These are destructive and are mounted only when a
// separate admin token is configured (see server.ts), behind that admin token
// rather than the shared device token. The intended use is clean-slate testing
// and operator maintenance, e.g. purging an account whose rows accumulated under
// stale client keys across many builds.
export function adminRouter(store: Store): Router {
  const router = Router();

  // Require a non-empty accountId on every route that carries it.
  router.param("accountId", (_req, res, next, accountId) => {
    if (typeof accountId !== "string" || accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    next();
  });

  // Purge ALL data for one account: every app's sync rows, intent events, device
  // cursors, the per-account seq counter, and the key-derivation salt. This is
  // the clean-slate reset: after it, the account has no salt (so the next device
  // PUT establishes a fresh one) and no rows (so no leftover ciphertext encrypted
  // under an old key can wedge a pull). Irreversible. Returns the per-table
  // delete counts; purging an account with no data returns all zeros (still 200).
  router.delete("/account/:accountId", (req: Request, res: Response) => {
    const deleted = store.purgeAccount(req.params.accountId);
    res.status(200).json({ purged: true, accountId: req.params.accountId, deleted });
  });

  return router;
}
