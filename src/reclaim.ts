import type { Store } from "./storage/types.js";
import type { BlobStore } from "./storage/blobstore.js";

// Blob reclaim (garbage collection) — Phase 7 final step. This is the dangerous
// part: a wrong reclaim permanently deletes irreplaceable media, so it is
// conservative by default (OFF — RETAIN) and, when on, gated by all three
// conditions from spec section 8.3. Deletion happens ONLY here.
//
// The sweep is periodic/explicit, never on a request hot path. It evaluates the
// three conditions as one query (Store.listReclaimableBlobs), then for each
// eligible blob deletes the BYTES (BlobStore.delete) and then the ROW
// (Store.deleteBlob), logging each reclaim with the hash and the reason it was
// eligible.
//
// Self-heal (NOT built here, a client concern): a device that still holds a
// reclaimed blob re-uploads it on next sync; content-addressing makes that
// upload idempotent and it lands at the same address. Reclaim deliberately
// leaves NO tombstone or rejecting state behind — deleteBlob removes the row
// outright — so a re-upload of a previously-reclaimed hash is accepted exactly
// like a first upload (initiate → finalize → insertBlobIfAbsent inserts a fresh
// row). Confirmed: reclaim adds no state that would reject a re-upload.

export interface ReclaimPolicy {
  // Master switch. DEFAULT RETAIN: when false, the sweep deletes NOTHING,
  // regardless of references or age. The tracking just sits there.
  reclaim: boolean;
  // Condition 2: a blob is eligible only once it has been at zero references,
  // untouched, for at least this long.
  gracePeriodMs: number;
  // Condition 3: a device idle longer than this is treated as DEAD and excluded
  // from the "all devices acked past the zero point" check.
  deadDevicePeriodMs: number;
}

export interface ReclaimedBlob {
  accountId: string;
  blobHash: string;
  size: number;
  zeroRefSeq: number | null;
  lastReferenceActivityAt: string;
}

export interface ReclaimResult {
  // False when reclaim is off (RETAIN); true when the sweep actually ran.
  enabled: boolean;
  // The blobs deleted this sweep (bytes + row).
  reclaimed: ReclaimedBlob[];
}

// Run one reclaim sweep. `now` is injectable so callers (and tests) control the
// clock; production passes the real current time. A no-op that returns
// { enabled: false } when reclaim is off — the safe default path deletes
// nothing.
//
// Idempotent and safe to run repeatedly: it only ever deletes blobs that
// currently satisfy all three conditions, and both deletes are idempotent, so a
// second immediate sweep finds nothing left and does nothing.
export function reclaimSweep(
  store: Store,
  blobStore: BlobStore,
  policy: ReclaimPolicy,
  now: Date = new Date(),
  log: (message: string) => void = (m) => console.log(m),
): ReclaimResult {
  // RETAIN (default): never delete anything. This guard is the whole safety net
  // for a self-hoster who never opts in.
  if (!policy.reclaim) {
    return { enabled: false, reclaimed: [] };
  }

  const nowMs = now.getTime();
  const graceCutoff = new Date(nowMs - policy.gracePeriodMs).toISOString();
  const deadCutoff = new Date(nowMs - policy.deadDevicePeriodMs).toISOString();

  const eligible = store.listReclaimableBlobs(graceCutoff, deadCutoff);

  const reclaimed: ReclaimedBlob[] = [];
  for (const blob of eligible) {
    // Bytes first, then the row (spec ordering). Both deletes are idempotent, so
    // a crash between them is recoverable: an orphaned byte file is reclaimed on
    // the next sweep's delete (or harmlessly overwritten by a re-upload), and a
    // row whose bytes are already gone fails closed (download 404) until a
    // re-upload heals it.
    blobStore.delete(blob.blobHash);
    store.deleteBlob(blob.accountId, blob.blobHash);
    reclaimed.push({
      accountId: blob.accountId,
      blobHash: blob.blobHash,
      size: blob.size,
      zeroRefSeq: blob.zeroRefSeq,
      lastReferenceActivityAt: blob.lastReferenceActivityAt,
    });
    log(
      `reclaim: deleted blob ${blob.blobHash} (account=${blob.accountId}, ` +
        `size=${blob.size}, zero_ref_seq=${blob.zeroRefSeq}, ` +
        `last_reference_activity_at=${blob.lastReferenceActivityAt}): ` +
        `zero references, grace elapsed (since <= ${graceCutoff}), ` +
        `all non-dead devices acked past the zero point (dead cutoff ${deadCutoff})`,
    );
  }

  if (reclaimed.length > 0) {
    log(`reclaim: sweep complete, ${reclaimed.length} blob(s) reclaimed`);
  }
  return { enabled: true, reclaimed };
}
