import { createHash, randomBytes, randomUUID } from "node:crypto";

// The per-account enrollment key construction (GLANCEVAULT_ENROLLMENT_MODE=
// account-key). Same shape and reasoning as src/credentials.ts: a key is
// "gvk_" + 64 lowercase hex chars (32 random bytes), stored only as its plain
// SHA-256. It is server-generated with 256 bits of entropy, so a password KDF
// buys nothing, and a deterministic hash keeps the lookup a unique-index read.
//
// The key is what a person pastes into an app once per device. The device
// exchanges it at /enroll for its own per-device credential and discards it;
// the key then sits with the account holder (and, for Pro, in the purchase
// email) as the way to enroll the next device.
//
// The "gvk_" prefix (versus "gvc_" for credentials) lets a support exchange,
// a log line, or a leaked-secret scanner tell the two apart at a glance.

export const ACCOUNT_KEY_PREFIX = "gvk_";

// Server-generated account ids. Not secret, and deliberately unrelated to the
// key, so rotating a key can never change the account it maps to.
export const ACCOUNT_ID_PREFIX = "acct_";

export interface MintedAccountKey {
  // The key, handed to the operator EXACTLY ONCE (create or rotate response).
  accountKey: string;
  // SHA-256 hex of the key — what accounts.key_hash stores.
  keyHash: string;
}

export function hashAccountKey(accountKey: string): string {
  return createHash("sha256").update(accountKey, "utf8").digest("hex");
}

export function mintAccountKey(): MintedAccountKey {
  const accountKey = ACCOUNT_KEY_PREFIX + randomBytes(32).toString("hex");
  return { accountKey, keyHash: hashAccountKey(accountKey) };
}

export function newAccountId(): string {
  return ACCOUNT_ID_PREFIX + randomUUID();
}
