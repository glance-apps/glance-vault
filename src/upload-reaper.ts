import type { Store } from "./storage/types.js";
import type { BlobStore } from "./storage/blobstore.js";

// Stale resumable-upload reaper (Phase 7 transfer-layer hygiene).
//
// A resumable upload that is never finalized (client crash, abandoned transfer,
// interrupted network) leaves behind a blob_upload_sessions row plus its staged
// part BYTES under the blob store's .uploads subtree. Nothing else ever removes
// them: finalize and the hash-mismatch path clean up their own session, but an
// upload that simply stops does not. Without a reaper these accumulate
// indefinitely — wasted disk and, under a shared token, a cheap way to fill it.
//
// This is SAFE in a way blob reclaim is not: it only ever deletes transfer-layer
// scratch (a session and its staged parts), never a finalized blob or any synced
// row. So unlike reclaim it is ALWAYS ON, no operator opt-in. A session younger
// than the TTL is left alone so a slow-but-live upload is never yanked out from
// under a client mid-transfer.
//
// Ordering mirrors reclaim: discard the staged BYTES first, then delete the
// session ROW (its parts cascade). Both steps are idempotent, so a crash between
// them is recoverable — the next sweep re-discards leftover bytes, and a
// half-deleted session is simply gone.

export interface UploadReaperResult {
  swept: number;
}

// Run one reaper sweep. `now` is injectable so callers and tests control the
// clock; production passes the real current time. Sessions with created_at at or
// before (now - ttlMs) are removed.
export function reapUploadSessions(
  store: Store,
  blobStore: BlobStore,
  ttlMs: number,
  now: Date = new Date(),
  log: (message: string) => void = (m) => console.log(m),
): UploadReaperResult {
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();
  const stale = store.listStaleUploadSessions(cutoff);

  let swept = 0;
  for (const session of stale) {
    // Bytes first, then the row (parts cascade). Both idempotent.
    blobStore.discardSession(session.uploadId);
    store.deleteUploadSession(session.uploadId);
    swept += 1;
  }

  if (swept > 0) {
    log(`upload-reaper: swept ${swept} stale upload session(s) (created <= ${cutoff})`);
  }
  return { swept };
}
