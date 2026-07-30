import { Router, json, type Request, type Response } from "express";
import type { ScopeResolver } from "../scope.js";

// Phase 3 prerequisite: the key-derivation salt as server state. One salt per
// account, fetched by any new device so it can derive the same root key from the
// passphrase. The salt is not secret and is opaque to the server: it is stored
// and returned as a base64 string and never decoded. The server stores no
// passphrase, no derived key, and performs no key derivation. These endpoints
// sit behind device-token auth (mounted after the auth middleware in server.ts).
// The account scope arrives as a PATH PARAM here (the third transport, next to
// sync/intents/blobs bodies and query strings); it is resolved to an
// account-bound handle exactly like every other router (Phase 1.3a).
export function saltRouter(resolve: ScopeResolver): Router {
  const router = Router();

  // Require a non-empty accountId on every route that carries it.
  router.param("accountId", (_req, res, next, accountId) => {
    if (typeof accountId !== "string" || accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    next();
  });

  // Return the salt for this account, or 404 if none is stored yet.
  router.get("/:accountId", (req: Request, res: Response) => {
    const record = resolve(req, req.params.accountId).getSalt();
    if (record === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(record);
  });

  // Store the salt for this account if none exists, then return the stored salt.
  // First-write-wins: if a salt already exists it is returned unchanged and the
  // supplied value is ignored. created is true only when this call stored a new
  // salt.
  router.put("/:accountId", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = req.body as { salt?: unknown };
    if (typeof body.salt !== "string" || body.salt.trim() === "") {
      res.status(400).json({ error: "salt must be a non-empty base64 string" });
      return;
    }
    const result = resolve(req, req.params.accountId).putSaltIfAbsent(body.salt);
    res.status(200).json(result);
  });

  return router;
}
