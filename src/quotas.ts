import type { QuotaReader } from "./storage/types.js";

// Per-account quota enforcement (Phase 3.2).
//
// DESIGN, as ratified: storage is enforced against BLOB-ATTRIBUTABLE bytes
// (stored blobs + in-flight declared reservations) at the blob path ONLY.
// Envelope bytes are measured and reported by /admin/usage but deliberately
// unenforced — that one move keeps every check an indexed aggregate, makes
// mid-upload failure the natural admission model (the declared size IS a
// reservation), and dissolves the over-quota recovery trap: sync writes,
// soft-deletes, cursor reports, salt, and ref-release are NEVER gated, so an
// over-quota account keeps working minus new media. The optional row cap is
// the coarse backstop if envelope abuse ever materializes.
//
// Every check runs in route code BEFORE any store write, outside every
// transaction, on SELECT-only indexed aggregates — a rejection mutates
// nothing structurally, not carefully, and the four seq landmines are
// untouched by construction.
//
// DEFAULTS: no quota configured -> makeQuotaGate returns undefined -> the
// routers hold no gate and skip nothing-at-all. Zero behavior change for an
// unconfigured server is structural.
//
// RESERVATION ATOMICITY: check-then-create at blob initiate runs
// synchronously within one event-loop turn (better-sqlite3 is synchronous),
// so parallel initiates serialize at the JS level and the reservation math
// holds exactly in a single process. Under multiple replicas that atomicity
// is per-replica — racing initiates across replicas get the same benign
// TOCTOU the row cap documents. The SSE cap remains per-process (hub state).

export interface QuotaPolicy {
  storageBytes?: number;
  rows?: number;
  intents?: number;
  uploads?: number;
}

// A rejection, ready for the route to send. The shape Phase 3.3 relies on:
// status says what kind (413 storage-shaped, 429 volume/concurrency-shaped),
// `quota` says which limit, and the three numbers render "X of Y used".
// Distinct from every existing error body.
export interface QuotaVerdict {
  status: 413 | 429;
  body: {
    error: "quota exceeded";
    quota: "storage" | "rows" | "intents" | "concurrent-uploads";
    limit: number;
    used: number;
    requested: number;
  };
}

export interface QuotaGate {
  // Blob upload admission, at initiate, before a session row exists. Checked
  // in a deterministic order: the concurrent-uploads cap first (cheaper),
  // then storage against stored + reserved + this declared size. The route
  // runs its dedup check BEFORE this gate, so re-uploading an already-owned
  // hash (zero new bytes, the client self-heal path) always succeeds even
  // over quota.
  admitUpload(accountId: string, declaredSize: number): QuotaVerdict | null;

  // Finalize belt-and-suspenders: only trips when the operator lowered the
  // limit between initiate and finalize (admission math otherwise guarantees
  // stored + reserved never exceeds the limit, and actual <= declared). The
  // route discards the staged bytes and session on rejection.
  admitFinalize(accountId: string, assembledSize: number): QuotaVerdict | null;

  // Row cap at the sync batch path: NET-NEW entities only, so updates to
  // existing entities are never blocked and the sync client's constant
  // re-upserts keep working at the cap. The soft-delete and device-cursor
  // routes never consult this (recovery and GC safety).
  admitSyncBatch(accountId: string, app: string, entityIds: string[]): QuotaVerdict | null;

  // Intent volume cap (current non-expired count). 429: flood-shaped, and it
  // self-heals as TTLs expire — the one genuinely self-recovering dimension.
  // NET-NEW events only, same dedup-before-quota rule as the other gates:
  // insertIntents is insert-only, so a re-sent eventId writes nothing and
  // must not be counted — a client retrying a batch whose response was lost
  // is re-announcing delivered events, not adding volume.
  admitIntents(accountId: string, eventIds: string[]): QuotaVerdict | null;
}

// Build the gate, or undefined when nothing is configured — the undefined is
// what makes default-off structural rather than a per-request flag check.
export function makeQuotaGate(reader: QuotaReader, policy: QuotaPolicy): QuotaGate | undefined {
  const { storageBytes, rows, intents, uploads } = policy;
  if (storageBytes === undefined && rows === undefined && intents === undefined && uploads === undefined) {
    return undefined;
  }

  const verdict = (
    status: 413 | 429,
    quota: QuotaVerdict["body"]["quota"],
    limit: number,
    used: number,
    requested: number,
  ): QuotaVerdict => ({ status, body: { error: "quota exceeded", quota, limit, used, requested } });

  return {
    admitUpload(accountId, declaredSize) {
      if (uploads !== undefined || storageBytes !== undefined) {
        const fp = reader.blobFootprint(accountId);
        if (uploads !== undefined && fp.sessionCount >= uploads) {
          return verdict(429, "concurrent-uploads", uploads, fp.sessionCount, 1);
        }
        if (storageBytes !== undefined) {
          const used = fp.blobBytes + fp.declaredBytes;
          if (used + declaredSize > storageBytes) {
            return verdict(413, "storage", storageBytes, used, declaredSize);
          }
        }
      }
      return null;
    },

    admitFinalize(accountId, assembledSize) {
      if (storageBytes !== undefined) {
        const fp = reader.blobFootprint(accountId);
        if (fp.blobBytes + assembledSize > storageBytes) {
          return verdict(413, "storage", storageBytes, fp.blobBytes, assembledSize);
        }
      }
      return null;
    },

    admitSyncBatch(accountId, app, entityIds) {
      if (rows !== undefined && entityIds.length > 0) {
        const current = reader.syncRowCount(accountId);
        // Fast path: even if every row were new, we'd fit.
        if (current + entityIds.length <= rows) {
          return null;
        }
        // existing counts rows keyed by these ids, so it can never exceed the
        // distinct id count: netNew is >= 0 by construction.
        const distinct = new Set(entityIds).size;
        const netNew = distinct - reader.countExistingEntities(app, accountId, entityIds);
        if (netNew > 0 && current + netNew > rows) {
          return verdict(413, "rows", rows, current, netNew);
        }
      }
      return null;
    },

    admitIntents(accountId, eventIds) {
      if (intents !== undefined && eventIds.length > 0) {
        const current = reader.intentCount(accountId);
        // Fast path mirrors the row cap: even all-new, we'd fit.
        if (current + eventIds.length <= intents) {
          return null;
        }
        const distinct = new Set(eventIds).size;
        const netNew = distinct - reader.countExistingIntentEvents(accountId, eventIds);
        if (netNew > 0 && current + netNew > intents) {
          return verdict(429, "intents", intents, current, netNew);
        }
      }
      return null;
    },
  };
}
