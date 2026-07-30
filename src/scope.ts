import type { Request } from "express";
import type { Store, AccountStore } from "./storage/types.js";
import type { BlobStore, BlobStat } from "./storage/blobstore.js";

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
// the resolver. In this phase the resolver simply binds the claimed account in
// BOTH auth modes — byte-for-byte the shared-token trust model. A later phase
// changes only what happens inside the resolver (derive the account from the
// authenticated credential on req, reject a mismatch); the handler-facing
// shape, including the req parameter that phase will need, is fixed here so
// that phase touches one function instead of eighteen handlers.
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

// Build the resolver buildApp hands to every router. Identical in shared and
// per-account mode in this phase: bind the claimed account. The req parameter
// is deliberately part of the signature now, unused, so the enforcement phase
// changes this one function body and nothing else.
export function makeScopeResolver(store: Store, blobStore: BlobStore): ScopeResolver {
  return (_req: Request, claimedAccountId: string) =>
    makeAccountScope(store, blobStore, claimedAccountId);
}
