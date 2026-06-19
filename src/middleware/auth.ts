import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Bearer-token auth for Phase 0. A protected request must present the configured
// secret as a Bearer token in the Authorization header. Anything missing,
// malformed, or wrong is rejected with 401. There is no user model and no token
// registry: one configured token is the whole policy for this phase.
//
// invalidMessage lets callers distinguish a wrong device token from a wrong
// admin token without changing the (deliberately constant-time) comparison.
function bearerTokenAuth(validToken: string, invalidMessage: string) {
  const expected = Buffer.from(validToken, "utf8");

  return function (req: Request, res: Response, next: NextFunction): void {
    const header = req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }

    const presented = Buffer.from(header.slice("Bearer ".length), "utf8");
    // Length-guarded constant-time compare so token length is not leaked and a
    // valid token is not distinguished from an invalid one by response timing.
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      res.status(401).json({ error: invalidMessage });
      return;
    }

    next();
  };
}

// The single shared device secret that authenticates every sync/salt request.
export function deviceTokenAuth(validToken: string) {
  return bearerTokenAuth(validToken, "invalid device token");
}

// A separate secret authorizing destructive admin/maintenance operations (e.g.
// purging an account). Kept distinct from the device token so handing a device
// the sync secret never grants it the power to wipe an account.
export function adminTokenAuth(adminToken: string) {
  return bearerTokenAuth(adminToken, "invalid admin token");
}
