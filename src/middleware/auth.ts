import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Device-token auth for Phase 0. Every protected request must present the single
// shared secret as a Bearer token in the Authorization header. Anything missing,
// malformed, or wrong is rejected with 401. There is no user model and no token
// registry: one configured token is the whole policy for this phase.
export function deviceTokenAuth(validToken: string) {
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
      res.status(401).json({ error: "invalid device token" });
      return;
    }

    next();
  };
}
