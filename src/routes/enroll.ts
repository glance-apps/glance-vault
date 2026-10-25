import { Router, json, type Request, type Response } from "express";
import type { AccountKeyResolver, CredentialIssuer } from "../storage/types.js";
import { timingSafeStringEqual } from "../middleware/auth.js";
import { mintCredential } from "../credentials.js";
import { hashAccountKey } from "../account-keys.js";

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
// respond): "does this presented proof entitle the caller to enroll, and into
// WHICH account?" The validator owns the proof fields of the body and returns
// the operative account, or the rejection. Mint, persist, and the response
// shape do not move between validators.
//
//   bootstrapSecretValidator  the self-host proof: the one configured secret,
//                             and the account is the one the caller claims.
//                             Right for one household; on a shared server it
//                             lets any secret holder enroll into any account.
//   accountKeyValidator       the hosted proof (GLANCEVAULT_ENROLLMENT_MODE=
//                             account-key): a per-account key, and the account
//                             is the one the SERVER has bound to that key. The
//                             caller's claim is never trusted; a mismatched
//                             one is rejected. The Pro license key drops in
//                             here unchanged.
export interface EnrollmentProof {
  enrollmentSecret?: unknown;
  accountKey?: unknown;
  accountId?: unknown;
}

export type EnrollmentDecision =
  | { ok: true; accountId: string }
  | { ok: false; status: 400 | 401 | 403; error: string };

export type EnrollmentValidator = (proof: EnrollmentProof) => EnrollmentDecision;

// Field-shape helper: non-empty strings, byte-exact — no trimming or
// normalization, matching the account-id semantics everywhere else.
function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function bootstrapSecretValidator(configuredSecret: string): EnrollmentValidator {
  return (proof) => {
    if (!isPresent(proof.enrollmentSecret)) {
      return { ok: false, status: 400, error: "enrollmentSecret is required" };
    }
    if (!isPresent(proof.accountId)) {
      return { ok: false, status: 400, error: "accountId is required" };
    }
    if (!timingSafeStringEqual(proof.enrollmentSecret, configuredSecret)) {
      return { ok: false, status: 401, error: "invalid enrollment secret" };
    }
    return { ok: true, accountId: proof.accountId };
  };
}

// The bootstrap secret is NOT accepted here, in either field: in this mode it
// is the operator's admin secret only, and accepting it at /enroll would
// reopen the any-account hole this validator exists to close. accountId is
// optional; a client that sends one learns at once if it pasted the wrong key.
export function accountKeyValidator(resolver: AccountKeyResolver): EnrollmentValidator {
  return (proof) => {
    if (!isPresent(proof.accountKey)) {
      return { ok: false, status: 400, error: "accountKey is required" };
    }
    // Unique-index point read on the hash; as with credential verification,
    // index timing reveals nothing actionable about other stored hashes.
    const account = resolver.getAccountByKeyHash(hashAccountKey(proof.accountKey));
    if (account === null) {
      return { ok: false, status: 401, error: "invalid account key" };
    }
    if (proof.accountId !== undefined && proof.accountId !== account.accountId) {
      return { ok: false, status: 403, error: "accountId does not match the account key" };
    }
    return { ok: true, accountId: account.accountId };
  };
}

export function enrollRouter(issuer: CredentialIssuer, validate: EnrollmentValidator): Router {
  const router = Router();

  // POST /enroll
  // Body: { enrollmentSecret, accountId, deviceId } (bootstrap mode) or
  // { accountKey, deviceId, accountId? } (account-key mode). The proof rides
  // in the body, never the query string (query strings appear in proxy logs).
  // Success: 201 { credentialId, credential, accountId, deviceId, createdAt }.
  // The credential value appears in this response ONCE and is never
  // retrievable again (the server stores only its hash). accountId in the
  // response is the operative account; in account-key mode it is how the
  // device learns which account to name on every later request.
  router.post("/", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as EnrollmentProof & { deviceId?: unknown };

    // Step 1: validate the enrollment proof (the swappable seam). Proof-field
    // shape errors (400) come from the validator, so each mode names its own
    // fields; deviceId is common to both and checked after.
    const decision = validate(body);
    if (!decision.ok) {
      res.status(decision.status).json({ error: decision.error });
      return;
    }
    if (!isPresent(body.deviceId)) {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }
    const accountId = decision.accountId;
    const deviceId = body.deviceId;

    // Steps 2–4: mint fresh, persist the hash (superseding any still-active
    // predecessor for this byte-exact (accountId, deviceId) — Phase 2.1 turns
    // re-enrollment into rotation, so a lost device's old credential dies the
    // moment its replacement is born), return the value once.
    const minted = mintCredential();
    const record = issuer.issueCredential({
      credentialId: minted.credentialId,
      accountId,
      deviceId,
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
