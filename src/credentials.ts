import { createHash, randomBytes, randomUUID } from "node:crypto";

// The per-device credential construction (Phase 1.2). This module owns BOTH
// sides of the hash choice — minting and verifying — so the construction is
// encapsulated in exactly one place: the enrollment route mints through it,
// and the later enforcement phase verifies through it, with neither ever
// knowing how the hash is built.
//
// Construction: the credential VALUE is "gvc_" + 64 lowercase hex chars (32
// random bytes); the stored VERIFIER is the plain SHA-256 (hex) of that full
// string. Deliberately NOT a password KDF (bcrypt/argon2), for three reasons
// that were weighed, not defaulted:
//   1. KDFs protect low-entropy human secrets. This value carries 256 bits of
//      server-generated entropy; SHA-256 preimage resistance is already the
//      wall, and no salt is needed because there is no low-entropy input to
//      precompute against.
//   2. Enforcement verifies a credential on EVERY request; a per-request KDF
//      is a self-inflicted DoS lever.
//   3. The idx_credentials_hash UNIQUE index gives O(1) lookup only because
//      the hash is deterministic; per-row salting would force a scan-and-
//      compare over every credential.
// The "gvc_" prefix is for leaked-secret scanners and log triage; it carries
// no semantics and the hash covers it along with the rest of the string.

export const CREDENTIAL_PREFIX = "gvc_";

export interface MintedCredential {
  // Opaque server-generated identifier for the credential ROW. Not secret,
  // not the account identity — the internal handle later phases use to refer
  // to one credential (e.g. revocation).
  credentialId: string;
  // The secret value handed to the device EXACTLY ONCE in the enrollment
  // response. Never stored; the server keeps only the hash.
  credential: string;
  // SHA-256 hex of the credential value — what device_credentials stores.
  credentialHash: string;
}

// Hash a presented credential value to its stored verifier form. Verification
// (a later phase) is: getCredentialByHash(hashCredential(presented)) — a plain
// unique-index lookup. No constant-time ceremony is needed around that lookup:
// an attacker cannot steer SHA-256 preimages, so index-timing reveals nothing
// actionable about other stored hashes.
export function hashCredential(credentialValue: string): string {
  return createHash("sha256").update(credentialValue, "utf8").digest("hex");
}

// Mint a fresh credential. Every call produces a new value: enrollment is
// deliberately NON-idempotent (a re-enrollment mints fresh rather than
// returning an existing credential), so the bootstrap secret never doubles as
// a recovery key worth retaining on the device.
export function mintCredential(): MintedCredential {
  const credential = CREDENTIAL_PREFIX + randomBytes(32).toString("hex");
  return {
    credentialId: randomUUID(),
    credential,
    credentialHash: hashCredential(credential),
  };
}
