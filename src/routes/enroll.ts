import { Router, json, type Request, type Response } from "express";
import type { CredentialIssuer } from "../storage/types.js";
import { timingSafeStringEqual } from "../middleware/auth.js";
import { mintCredential } from "../credentials.js";

// Enrollment: a device exchanges the admin-configured bootstrap secret for its
// own per-device credential bound to an account (Phase 1.2).
//
// Registered ONLY in per-account mode (buildApp registration-gates it), so a
// shared-mode server is byte-identical to one without this file. Mounted in
// the PUBLIC segment, before deviceTokenAuth but behind CORS and the per-IP
// rate limiter: the bootstrap secret IS this route's authentication. A fresh
// device holds only that secret — requiring the shared device token here would
// force per-account clients to carry it forever, the exact dependency this
// workstream removes.
//
// EXCHANGE-THEN-DISCARD: once the device holds its credential, it must not
// retain the bootstrap secret (a retained secret makes later revocation
// theater — the holder just re-enrolls). The server-side shape supports that:
// nothing after this exchange ever asks for the secret again, and enrollment
// is deliberately NON-IDEMPOTENT — every successful call mints a FRESH
// credential; the server never returns an existing one, so the secret is
// useless as a "recovery key" worth keeping. A device that loses its
// credential re-enrolls and gets a new one; the old row sits orphaned until
// revocation (2.1) gives credentials a lifecycle.
//
// This handler holds a CredentialIssuer — insert-credential and nothing else.
// It structurally cannot reach account data (no forAccount), the sweeps, or
// even credential reads. Issuance touches ONLY device_credentials: no devices
// row is read, written, or required (enrollment before first sync is the
// normal case), and no account seq is consumed, so sync ordering and
// tombstone-GC arithmetic cannot be perturbed by any enrollment activity.

// THE SWAPPABLE SEAM (the phase plan's step 1 of validate/mint/persist/
// respond): "does this presented proof entitle the caller to enroll into
// accountId?" Today the proof is the one configured bootstrap secret and the
// claimed accountId is not consulted. The Pro path replaces THIS FUNCTION with
// a purchased-license-key lookup — at which point it will also want to RETURN
// the account the key is bound to instead of trusting the claim, a one-
// signature change contained here. Mint, persist, and the response shape do
// not move.
export type EnrollmentValidator = (presentedSecret: string, accountId: string) => boolean;

export function bootstrapSecretValidator(configuredSecret: string): EnrollmentValidator {
  return (presentedSecret, _accountId) => timingSafeStringEqual(presentedSecret, configuredSecret);
}

export function enrollRouter(issuer: CredentialIssuer, validate: EnrollmentValidator): Router {
  const router = Router();

  // POST /enroll
  // Body: { enrollmentSecret, accountId, deviceId } — the secret rides in the
  // body, never the query string (query strings appear in proxy logs).
  // Success: 201 { credentialId, credential, accountId, deviceId, createdAt }.
  // The credential value appears in this response ONCE and is never
  // retrievable again (the server stores only its hash).
  router.post("/", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = req.body as {
      enrollmentSecret?: unknown;
      accountId?: unknown;
      deviceId?: unknown;
    };

    // Field-shape validation first (400), exactly like every other router:
    // non-empty strings, byte-exact — no trimming or normalization, matching
    // the account-id semantics everywhere else in the server.
    if (typeof body.enrollmentSecret !== "string" || body.enrollmentSecret.trim() === "") {
      res.status(400).json({ error: "enrollmentSecret is required" });
      return;
    }
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (typeof body.deviceId !== "string" || body.deviceId.trim() === "") {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }

    // Step 1: validate the enrollment proof (the swappable seam).
    if (!validate(body.enrollmentSecret, body.accountId)) {
      res.status(401).json({ error: "invalid enrollment secret" });
      return;
    }

    // Steps 2–4: mint fresh, persist the hash (superseding any still-active
    // predecessor for this byte-exact (accountId, deviceId) — Phase 2.1 turns
    // re-enrollment into rotation, so a lost device's old credential dies the
    // moment its replacement is born), return the value once.
    const minted = mintCredential();
    const record = issuer.issueCredential({
      credentialId: minted.credentialId,
      accountId: body.accountId,
      deviceId: body.deviceId,
      credentialHash: minted.credentialHash,
    });

    res.status(201).json({
      credentialId: record.credentialId,
      credential: minted.credential,
      accountId: record.accountId,
      deviceId: record.deviceId,
      createdAt: record.createdAt,
    });
  });

  return router;
}
