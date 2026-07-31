import type { Request, Response, NextFunction } from "express";
import type { Store, CredentialRecord } from "../storage/types.js";
import { hashCredential } from "../credentials.js";

// Per-device credential auth (Phase 1.3b). In per-account mode this middleware
// REPLACES deviceTokenAuth at registration time (a registration-level mode
// branch in buildApp, the kind ratified in 1.2), occupying the same pipeline
// position so 401s happen exactly where they always have: before any body
// parsing, before any handler. An unauthenticated caller therefore cannot
// probe the field-validation surface, in either mode.
//
// The credential IS the Bearer token — the wire shape the clients already
// speak; 1.4 changes only what string they send. The shared device token
// authenticates NOTHING in per-account mode: honoring it would let any holder
// keep acting on any account, which is the vulnerability this phase closes.
//
// Statuses (decided for the workstream): 401 for absent, malformed, or
// unrecognized credentials — all three here. 403 (an authenticated credential
// claiming an account it is not bound to) is the scope resolver's, not this
// middleware's: binding is per-claimed-account and the claim arrives by body,
// query, or path, which only the handler can extract.
//
// Verification is the composition Phase 1.2 sealed: hash the presented value
// (src/credentials.ts owns the construction) and point-read the unique
// verifier index. The narrow parameter type mirrors the CredentialIssuer
// discipline: this middleware can look up credentials and reach nothing else.
export type CredentialVerifier = Pick<Store, "getCredentialByHash">;

// The authenticated credential for a request, handed from this middleware to
// the scope resolver. A WeakMap keyed by the request object: no monkey-patched
// Express types, no `any`, entries garbage-collected with the request.
const authenticated = new WeakMap<Request, CredentialRecord>();

// Read the authenticated credential for a request, or undefined when the
// request did not pass this middleware (shared mode, or a bug). Consumed by
// makeScopeResolver's per-account branch.
export function authenticatedCredential(req: Request): CredentialRecord | undefined {
  return authenticated.get(req);
}

export function credentialAuth(verifier: CredentialVerifier) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const header = req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      // Same body as deviceTokenAuth's equivalent rejection: the failure is
      // about the header shape, identical in both modes.
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }

    // Unknown credential: 401 with wording DISTINCT from shared mode's
    // "invalid device token" — both conditions are 401, so the body is the
    // only signal a client has to distinguish "re-enroll needed" from "server
    // misconfigured". No timing ceremony is needed around this lookup: the
    // presented value is hashed first, and an attacker cannot steer SHA-256
    // preimages, so index timing reveals nothing actionable (see
    // src/credentials.ts).
    const record = verifier.getCredentialByHash(hashCredential(header.slice("Bearer ".length)));
    if (record === null) {
      res.status(401).json({ error: "invalid credential" });
      return;
    }

    // Revoked (Phase 2.1): rejected with the BYTE-IDENTICAL body the
    // unrecognized case uses, deliberately. The shipped 1.4b client halts only
    // on this exact body, the remedy for both conditions is the same
    // (re-enroll), and distinct wording would leave every pre-2.2 client
    // retrying forever against revoked credentials. The revoked-vs-unknown
    // distinction goes to the server log instead: credentialId and deviceId
    // are opaque; the accountId is stripped, matching the request-log
    // redaction posture.
    if (record.revokedAt !== null) {
      console.warn(
        `auth: revoked credential presented (credentialId=${record.credentialId}, ` +
          `deviceId=${record.deviceId}, revokedAt=${record.revokedAt})`,
      );
      res.status(401).json({ error: "invalid credential" });
      return;
    }

    // Like deviceTokenAuth, set nothing on the request object itself; the
    // authenticated identity travels in the WeakMap to the scope resolver.
    authenticated.set(req, record);
    next();
  };
}
