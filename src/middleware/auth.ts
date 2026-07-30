import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Length-guarded constant-time equality for secrets. timingSafeEqual requires
// equal-length inputs, so the length check is a CORRECTNESS precondition, not
// an optimization — do not remove it as redundant. Comparing lengths first
// leaks only the length mismatch, never byte positions, which is the same
// property the device-token middleware has always had. Shared by the
// device-token middleware and the enrollment route (Phase 1.2) so the
// security-sensitive primitive exists exactly once.
export function timingSafeStringEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Device-token auth for Phase 0. Every protected request must present the single
// shared secret as a Bearer token in the Authorization header. Anything missing,
// malformed, or wrong is rejected with 401. There is no user model and no token
// registry: one configured token is the whole policy for this phase. Sets
// NOTHING on the request object: passing auth grants passage, not identity.
export function deviceTokenAuth(validToken: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const header = req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }

    if (!timingSafeStringEqual(header.slice("Bearer ".length), validToken)) {
      res.status(401).json({ error: "invalid device token" });
      return;
    }

    next();
  };
}
