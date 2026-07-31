import { Router, type Request, type Response } from "express";
import type { CredentialAdmin } from "../storage/types.js";
import { timingSafeStringEqual } from "../middleware/auth.js";

// Credential administration (Phase 2.1): how an operator actually revokes.
//
// Registered ONLY in per-account mode, exactly like /enroll, and mounted in
// the same public segment (behind CORS and the per-IP rate limiter, before
// the credential middleware): this surface authenticates itself. There is no
// admin UI in this server; these two endpoints are the whole mechanism, and
// they are curl-able — which beats docker exec into a runtime image that
// (correctly) carries no sqlite3 binary. A CLI, if ever wanted, is sugar over
// these endpoints, never over the database: an out-of-process database write
// bypasses the hub eviction and leans entirely on the SSE heartbeat backstop.
//
// TRUST ARGUMENT for guarding this with the enrollment bootstrap secret: that
// secret already grants enrollment into ANY account — full data access —
// so listing and revoking credentials grants strictly less. No new trust
// level is created by reusing it.
//
// The router receives only the CredentialAdmin surface (list + revoke): the
// same narrow-interface discipline as CredentialIssuer. forAccount, issuance,
// the sweeps, and lifecycle are not expressible here.

// THE HOSTED SEAM, same shape as the enrollment validator: "does this
// presented secret authorize credential administration?" A hosted deployment
// swaps THIS FUNCTION's construction (operator auth instead of the bootstrap
// secret) in buildApp; the endpoints, the response shapes, and the store
// surface do not move.
export type AdminGuard = (presentedSecret: string) => boolean;

export function bootstrapAdminGuard(configuredSecret: string): AdminGuard {
  return (presentedSecret) => timingSafeStringEqual(presentedSecret, configuredSecret);
}

// Serialize one credential row for the listing/revoke responses. EXPLICIT
// ALLOWLIST: credentialId, accountId, deviceId, createdAt, revokedAt. The
// credential_hash never leaves this layer — a listing that returned verifier
// hashes would hand out offline-crackable material for every device at once.
function serializeCredential(record: {
  credentialId: string;
  accountId: string;
  deviceId: string;
  createdAt: string;
  revokedAt: string | null;
}) {
  return {
    credentialId: record.credentialId,
    accountId: record.accountId,
    deviceId: record.deviceId,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

export function adminRouter(
  admin: CredentialAdmin,
  authorize: AdminGuard,
  // Called after a revocation is durably stamped, with the revoked
  // credentialId. buildApp wires this to hub.disconnectCredential so live SSE
  // streams for the credential terminate immediately (the in-process path;
  // the heartbeat revalidation covers every other path).
  onRevoked: (credentialId: string) => void,
): Router {
  const router = Router();

  // Bearer auth with the bootstrap secret, same header shape as everything
  // else. Same rejection bodies as the credential middleware for the same
  // conditions: header problems are header problems in both places.
  router.use((req: Request, res: Response, next) => {
    const header = req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }
    if (!authorize(header.slice("Bearer ".length))) {
      res.status(401).json({ error: "invalid enrollment secret" });
      return;
    }
    next();
  });

  // GET /admin/credentials — every credential, active and revoked, in
  // deterministic order. Revoked-but-lingering rows and the pre-2.1 orphans
  // (live keys until revoked!) are exactly what this listing exists to
  // surface; multiple rows per (account, device) are plainly visible.
  router.get("/credentials", (_req: Request, res: Response) => {
    res.status(200).json({ credentials: admin.listCredentials().map(serializeCredential) });
  });

  // POST /admin/credentials/:credentialId/revoke — stamp revoked_at,
  // idempotently (a re-revoke keeps the original timestamp and reports
  // revokedNow: false), then notify the hub. 404 for an unknown id.
  router.post("/credentials/:credentialId/revoke", (req: Request, res: Response) => {
    const result = admin.revokeCredential(req.params.credentialId);
    if (result === null) {
      res.status(404).json({ error: "unknown credential" });
      return;
    }
    if (result.revokedNow) {
      // Terminate any live SSE streams this credential holds, AFTER the flag
      // is durably stamped: eviction is a consequence of revocation, never a
      // substitute for it.
      onRevoked(result.record.credentialId);
    }
    res.status(200).json({
      ...serializeCredential(result.record),
      revokedNow: result.revokedNow,
    });
  });

  return router;
}
