import type { Request } from "express";
import type { Store, AccountStore } from "./storage/types.js";
import type { BlobStore, BlobStat } from "./storage/blobstore.js";
import type { AuthMode } from "./config.js";
import { authenticatedCredential } from "./middleware/credential-auth.js";

// Thrown by the scope resolver when a request's account claim cannot be
// bound, and translated to a response by the single error-mapping middleware
// at the tail of buildApp. This class exists NOWHERE else: the middleware
// intercepts exactly these rejections and passes every other error through
// untouched.
//
// Statuses, decided for the whole workstream and uniform across all 18
// routes:
//   403 — the credential AUTHENTICATED but claims an account it is not bound
//         to. Distinct from 401 so later phases can add further distinct
//         terminal signals (revoked in 2.1, billing-lapsed in item 5) without
//         overloading one status.
//   401 — no authenticated credential reached the resolver (belt-and-
//         suspenders: the credential middleware already 401s this before any
//         handler runs).
export class ScopeError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

// The per-request account scope (Phase 1.3a).
//
// AccountScope is the ONLY object a request handler holds that can reach
// account data. It is the storage handle (AccountStore, from Store.forAccount)
// extended with the blob-byte operations that previously required the handler
// to pair a metadata check with a raw BlobStore call by adjacency. Folding the
// pair into one method means the check and the byte access cannot drift apart
// as handlers evolve: a handler that never sees the raw BlobStore cannot read,
// write, or discard bytes without the ownership predicate running first.
//
// Like AccountStore, this is a STATELESS parameter binder — it holds the bound
// account, the two backing stores, and nothing else. No cache, no transaction
// state, no per-request memory of any kind.
//
// The byte NAMESPACE stays global (content-addressed by ciphertext hash); that
// is the accepted design and this handle does not claim to change it. What the
// handle enforces is that THIS account only touches bytes for hashes it owns a
// metadata row for (reads) or sessions it owns (upload staging).
export interface AccountScope extends AccountStore {
  // --- Upload staging (bytes + bookkeeping, ownership-checked) ---

  // Stage one part of an upload this account owns: write the staged bytes,
  // then record the part row (same order the route always used). A uploadId
  // this account does not own throws — the route's own getUploadSession 404
  // makes that unreachable, so a throw here means a handler bug, and failing
  // loudly beats silently staging bytes into another account's session.
  stageUploadPart(uploadId: string, partIndex: number, bytes: Buffer): void;

  // Reassemble the acked parts of a session this account owns, in part-index
  // order, into the candidate whole blob the caller then hash-verifies.
  // Throws on a session this account does not own, like stageUploadPart.
  assembleUpload(uploadId: string): Buffer;

  // Discard a session this account owns: staged bytes first, then the session
  // row (parts cascade) — the same order every route path used. A session this
  // account does not own (or that no longer exists) is a no-op, preserving the
  // idempotency the finalize/mismatch paths rely on.
  discardUploadSession(uploadId: string): void;

  // --- Whole-blob bytes (the byte-read gate) ---

  // Store the finalized whole blob's bytes. The namespace is the global
  // content-addressed store: writing an already-present hash is a harmless
  // idempotent no-op (same hash, same bytes). The caller pairs this with
  // insertBlobIfAbsent for the account-scoped metadata row, as finalize does.
  putBlobBytes(blobHash: string, bytes: Buffer): void;

  // Byte-store stat, GATED on this account owning the blob's metadata row.
  // Returns null when this account has no such blob OR when the metadata row
  // exists but the bytes are gone (fail closed) — the same two 404s the
  // download route always produced, now inseparable from the check.
  statBlobBytes(blobHash: string): BlobStat | null;

  // Ranged byte read, GATED on this account owning the blob's metadata row.
  // The caller guarantees 0 <= start <= end < size (the route validates the
  // Range header against statBlobBytes first). Throws on a hash this account
  // does not own: unreachable from the route (statBlobBytes already gated the
  // request), so a throw means a handler bug, and failing loudly beats serving
  // another account's ciphertext.
  readBlobRange(blobHash: string, start: number, end: number): Buffer;
}

// How a handler obtains its AccountScope. The handler extracts the CLAIMED
// accountId exactly where it always has (body, query string, or path param —
// which is why this cannot be a single pre-body-parse middleware), then calls
// the resolver.
//
// Phase 1.3b: the resolver is where enforcement lives, and the ONLY place.
//   shared      — bind the claimed account, byte-for-byte the shared-token
//                 trust model. Untouched.
//   per-account — the operative account comes FROM THE CREDENTIAL the auth
//                 middleware verified; the claimed value is demoted to a
//                 cross-check. A mismatch throws ScopeError(403) before any
//                 data access. The comparison is BYTE-EXACT: no trimming,
//                 casing, or normalization — " house-1" and "house-1" are
//                 distinct live accounts today and must stay that way.
// A resolver that returns, returns a scope bound to an account the caller has
// proven; a handler that holds an AccountScope can no longer be holding the
// wrong account.
export type ScopeResolver = (req: Request, claimedAccountId: string) => AccountScope;

// Build one AccountScope: the storage handle plus the byte-gate methods, all
// bound to the same account. Plain object composition — no proxies, no state.
export function makeAccountScope(
  store: Store,
  blobStore: BlobStore,
  accountId: string,
): AccountScope {
  const data = store.forAccount(accountId);

  return {
    ...data,

    stageUploadPart(uploadId: string, partIndex: number, bytes: Buffer): void {
      if (data.getUploadSession(uploadId) === null) {
        throw new Error(`upload session ${uploadId} is not owned by account ${accountId}`);
      }
      // Bytes first, then the part row — the order the route always used. The
      // row insert re-checks ownership at the statement level (the SQL joins
      // the session on account_id), so this method is doubly scoped.
      blobStore.writePart(uploadId, partIndex, bytes);
      data.recordUploadPart(uploadId, partIndex, bytes.length);
    },

    assembleUpload(uploadId: string): Buffer {
      if (data.getUploadSession(uploadId) === null) {
        throw new Error(`upload session ${uploadId} is not owned by account ${accountId}`);
      }
      const parts = data.listUploadParts(uploadId);
      return blobStore.assemble(
        uploadId,
        parts.map((p) => p.partIndex),
      );
    },

    discardUploadSession(uploadId: string): void {
      // No-op on a session this account does not own: the byte discard below
      // is NOT account-scoped (staged bytes are keyed by uploadId alone), so
      // the ownership check is what stops one account discarding another's
      // in-flight upload. Idempotent by construction, like the paths using it.
      if (data.getUploadSession(uploadId) === null) {
        return;
      }
      blobStore.discardSession(uploadId);
      data.deleteUploadSession(uploadId);
    },

    putBlobBytes(blobHash: string, bytes: Buffer): void {
      blobStore.put(blobHash, bytes);
    },

    statBlobBytes(blobHash: string): BlobStat | null {
      if (data.getBlob(blobHash) === null) {
        return null;
      }
      return blobStore.stat(blobHash);
    },

    readBlobRange(blobHash: string, start: number, end: number): Buffer {
      if (data.getBlob(blobHash) === null) {
        throw new Error(`blob ${blobHash} is not owned by account ${accountId}`);
      }
      return blobStore.readRange(blobHash, start, end);
    },
  };
}

// Build the resolver buildApp hands to every router. The authMode parameter
// is required — a silently-defaulted mode would be a fail-open waiting for a
// forgotten argument; buildApp passes the loadConfig-resolved value.
export function makeScopeResolver(
  store: Store,
  blobStore: BlobStore,
  authMode: AuthMode,
): ScopeResolver {
  if (authMode === "shared") {
    // The shipped trust model, byte-for-byte: bind whatever account the
    // request names. deviceTokenAuth has already gated passage.
    return (_req: Request, claimedAccountId: string) =>
      makeAccountScope(store, blobStore, claimedAccountId);
  }

  // per-account: derive, compare, bind the DERIVED account.
  return (req: Request, claimedAccountId: string) => {
    const credential = authenticatedCredential(req);
    if (credential === undefined) {
      // Unreachable when the credential middleware is mounted (it 401s
      // first); if a future mount-order mistake ever exposes a scoped route
      // without it, fail closed as 401 rather than fall back to trusting the
      // claim.
      throw new ScopeError(401, "no authenticated credential");
    }
    if (credential.accountId !== claimedAccountId) {
      throw new ScopeError(403, "credential is not bound to this account");
    }
    // Bind the account the CREDENTIAL is bound to. Byte-equal to the claim at
    // this point, but the derivation is structural: the operative account
    // never comes from the request.
    return makeAccountScope(store, blobStore, credential.accountId);
  };
}
