import { Router, json, type Request, type Response } from "express";
import type { SyncRowInput, SyncRowRecord } from "../storage/types.js";
import type { Emit } from "../realtime/hub.js";
import type { ScopeResolver } from "../scope.js";
import type { QuotaGate } from "../quotas.js";

// The app namespaces that share this server: the three GLANCE apps plus
// `dayglance-bridge`, dayGLANCE's Obsidian bridge plugin, which syncs its
// pairing meta, intent and observation rows under its own namespace. The app
// path param is validated against this set; anything else is rejected with 400.
const ALLOWED_APPS = new Set(["dayglance", "dayglance-bridge", "lastglance", "lifeglance"]);

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// Serialize a stored row for the wire. The envelope is opaque bytes; it leaves
// the server base64-encoded. The server never inspects it.
function serializeRow(row: SyncRowRecord) {
  return {
    entityId: row.entityId,
    envelope: row.envelope.toString("base64"),
    seq: row.seq,
    deleted: row.deleted,
    serverMtime: row.serverMtime,
    // Client-supplied tombstone timestamp for tombstone LWW; null on live rows
    // and on tombstones written by a client that predates deletedAt.
    deletedAt: row.deletedAt,
  };
}

// Pull accountId from the query string, requiring a non-empty string.
function queryAccountId(req: Request): string | null {
  const value = req.query.accountId;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

// Phase 1 sync transport. Four endpoints, all already behind device-token auth
// (mounted after the auth middleware in server.ts). No crypto, no envelope
// parsing, no intents, no media: just opaque rows in and out with server
// assigned seq ordering.
// The router receives a ScopeResolver, not a store (Phase 1.3a): each handler
// extracts the claimed accountId exactly as before, resolves it to an
// account-bound AccountScope, and has no other object through which account
// data is reachable. In shared mode the resolver binds the claimed account
// unchanged, so behavior is byte-identical.
// emit is the best-effort real-time push hook (Phase 9). After a write that
// advances the account seq commits, we call emit(accountId, { seq }) so any
// connected SSE client for that account is nudged to drain. emit is guaranteed
// non-throwing and non-blocking (it fans out to in-memory connections and drops
// dead ones); it is called AFTER the store write returns (durably committed) so
// a nudged client that drains immediately sees the new rows. Push is an
// optimization only: it never gates or fails the write.
// gate (Phase 3.2): optional row-count cap at the batch path only. NET-NEW
// entities only — updates to existing entities are never blocked. The
// soft-delete and device-cursor routes below NEVER consult the gate
// (recovery and tombstone-GC safety), and neither does anything else here.
export function syncRouter(resolve: ScopeResolver, emit: Emit, gate?: QuotaGate): Router {
  const router = Router();

  // Validate the app path param once for every route that carries it.
  router.param("app", (_req, res, next, app) => {
    if (!ALLOWED_APPS.has(app)) {
      res.status(400).json({ error: "unknown app", allowed: [...ALLOWED_APPS] });
      return;
    }
    next();
  });

  // Upsert a batch of rows. Body: { accountId, rows: [{ entityId, envelope,
  // deleted?, createdAt?, insertOnly? }] }. envelope is base64-encoded bytes on
  // the wire and stored as an opaque BLOB. createdAt is advisory and currently
  // ignored. insertOnly requests first-write-wins for that row (used for the key
  // verifier). entityId is an opaque, client-chosen string: any non-empty value
  // is accepted, including reserved ids like "__glance_keycheck"; the server
  // never parses or format-checks it.
  router.post("/:app/batch", json({ limit: "16mb" }), (req: Request, res: Response) => {
    const app = req.params.app;
    const body = req.body as { accountId?: unknown; rows?: unknown; notify?: unknown };

    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (!Array.isArray(body.rows)) {
      res.status(400).json({ error: "rows must be an array" });
      return;
    }
    if (body.notify !== undefined && typeof body.notify !== "boolean") {
      res.status(400).json({ error: "notify must be a boolean" });
      return;
    }
    // Default ON: a write nudges unless it explicitly opts out. This preserves
    // every real content nudge (a client that never sends the flag behaves
    // exactly as before) while letting a bookkeeping write silence itself.
    const notify = body.notify !== false;

    const rows: SyncRowInput[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      const raw = body.rows[i] as {
        entityId?: unknown;
        envelope?: unknown;
        deleted?: unknown;
        createdAt?: unknown;
        insertOnly?: unknown;
        deletedAt?: unknown;
      };
      if (typeof raw.entityId !== "string" || raw.entityId.trim() === "") {
        res.status(400).json({ error: `rows[${i}].entityId is required` });
        return;
      }
      if (typeof raw.envelope !== "string") {
        res.status(400).json({ error: `rows[${i}].envelope must be a base64 string` });
        return;
      }
      if (raw.deleted !== undefined && typeof raw.deleted !== "boolean") {
        res.status(400).json({ error: `rows[${i}].deleted must be a boolean` });
        return;
      }
      if (raw.insertOnly !== undefined && typeof raw.insertOnly !== "boolean") {
        res.status(400).json({ error: `rows[${i}].insertOnly must be a boolean` });
        return;
      }
      if (
        raw.deletedAt !== undefined &&
        (typeof raw.deletedAt !== "number" || !Number.isInteger(raw.deletedAt) || raw.deletedAt < 0)
      ) {
        res.status(400).json({ error: `rows[${i}].deletedAt must be a non-negative integer` });
        return;
      }
      rows.push({
        entityId: raw.entityId,
        envelope: Buffer.from(raw.envelope, "base64"),
        deleted: raw.deleted === true,
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
        insertOnly: raw.insertOnly === true,
        deletedAt: typeof raw.deletedAt === "number" ? raw.deletedAt : undefined,
      });
    }

    const scoped = resolve(req, body.accountId);

    // Row cap (Phase 3.2), before the write, outside any transaction. The
    // net-new probe is read-only point lookups, so two devices racing can
    // land a few rows over the cap (benign TOCTOU, documented): a soft cap
    // that never over-blocks beats a serialized one that bottlenecks writes.
    if (gate) {
      const rejected = gate.admitSyncBatch(scoped.accountId, app, rows.map((r) => r.entityId));
      if (rejected) {
        res.status(rejected.status).json(rejected.body);
        return;
      }
    }

    const result = scoped.batchUpsert(app, rows);
    // Real-time nudge (Phase 9), emitted ONLY for content writes. Two gates:
    //   - notify: a client marks a per-cycle BOOKKEEPING write (device-state /
    //     cursor / high-water-mark persisted as a sync row) with `notify: false`.
    //     Such a write still commits and still advances the seq — it just does
    //     not wake every other device. This is what breaks the SSE self-nudge
    //     loop: a content-free housekeeping cycle no longer nudges, so it cannot
    //     provoke a nudge -> drain -> housekeep -> nudge cascade. A genuine
    //     content write (notify omitted or true) still nudges instantly.
    //   - maxSeq > 0: nothing was actually written (every row was an insert-only
    //     no-op), so there is nothing to drain.
    // The WRITE is never gated — only the nudge is. Post-commit, best-effort:
    // emit never throws and never blocks the response.
    if (notify && result.maxSeq > 0) {
      // Keyed by the scope's DERIVED account, not the request's claimed
      // string (Phase 1.3b): byte-equal after a successful resolve, but the
      // binding is structural rather than by adjacency. Tagged with the app
      // namespace that was written (see Nudge.app) so a consumer can tell its
      // own app's rows from another's; the seq is shared across apps.
      emit(scoped.accountId, { seq: result.maxSeq, app });
    }
    res.status(200).json(result);
  });

  // Report a device's sync cursor. Body: { accountId, deviceId, lastSeenSeq }.
  // The cursor moves forward only (MAX), so a stale report cannot rewind it. The
  // device cursor is account scoped, not per app (seq is assigned per account);
  // the :app segment is kept only for route consistency with the other sync
  // endpoints. Used later for coordinated tombstone GC.
  //
  // BOOKKEEPING PATH — NEVER emits a real-time nudge. This is the per-cycle
  // device-state / last-seen / high-water-mark write every device makes even
  // when no content changed. It does not advance the account seq
  // (updateDeviceCursor never calls nextSeq) and it must never publish a nudge:
  // nudging here would wake every connected device, each of which drains and
  // re-reports its cursor, which would nudge again — the SSE self-nudge loop.
  // There is deliberately no emit() call in this handler; keep it that way.
  router.post("/:app/device", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = req.body as { accountId?: unknown; deviceId?: unknown; lastSeenSeq?: unknown };
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (typeof body.deviceId !== "string" || body.deviceId.trim() === "") {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }
    if (
      typeof body.lastSeenSeq !== "number" ||
      !Number.isInteger(body.lastSeenSeq) ||
      body.lastSeenSeq < 0
    ) {
      res.status(400).json({ error: "lastSeenSeq must be a non-negative integer" });
      return;
    }
    resolve(req, body.accountId).updateDeviceCursor(body.deviceId, body.lastSeenSeq);
    res.status(200).json({ updated: true });
  });

  // Incremental fetch. Query: accountId, since (seq cursor, default 0), limit
  // (default 500, max 1000). Returns rows with seq > since, ascending.
  router.get("/:app/list", (req: Request, res: Response) => {
    const app = req.params.app;
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }

    let since = 0;
    if (req.query.since !== undefined) {
      since = Number(req.query.since);
      if (!Number.isInteger(since) || since < 0) {
        res.status(400).json({ error: "since must be a non-negative integer" });
        return;
      }
    }

    let limit = DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      if (limit > MAX_LIMIT) {
        limit = MAX_LIMIT;
      }
    }

    const result = resolve(req, accountId).listRows(app, since, limit);
    res.status(200).json({
      rows: result.rows.map(serializeRow),
      hasMore: result.hasMore,
    });
  });

  // Fetch a single row by entityId. Query: accountId. Returns 200 with the
  // serialized row when it exists, or 404 when it does not (never 400 for a
  // missing row — the key-verifier client relies on 404 meaning "new account").
  // entityId is opaque; reserved ids like "__glance_keycheck" are fetched like
  // any other.
  router.get("/:app/:entityId", (req: Request, res: Response) => {
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const row = resolve(req, accountId).getRow(req.params.app, req.params.entityId);
    if (row === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(serializeRow(row));
  });

  // Soft-delete a row: mark deleted, assign a new seq. Query: accountId, and an
  // optional deletedAt (epoch ms) the client v1.6.0 sends so the tombstone can
  // drive last-writer-wins. Absent/invalid deletedAt is stored as null, which
  // clients read as delete-wins (legacy semantics).
  // Deleting an already-deleted row is idempotent: the store returns the
  // existing tombstone's seq without assigning a new one, so the response is
  // unchanged for the client and nothing is emitted (see the emit guard below).
  router.delete("/:app/:entityId", (req: Request, res: Response) => {
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    let deletedAt: number | null = null;
    if (req.query.deletedAt !== undefined) {
      const parsed = Number(req.query.deletedAt);
      if (!Number.isInteger(parsed) || parsed < 0) {
        res.status(400).json({ error: "deletedAt must be a non-negative integer" });
        return;
      }
      deletedAt = parsed;
    }
    const scoped = resolve(req, accountId);
    const result = scoped.softDeleteRow(req.params.app, req.params.entityId, deletedAt);
    if (result === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    // A soft-delete that actually tombstoned the row advances the account seq
    // (a new tombstone seq), so nudge connected clients to drain. Post-commit,
    // best-effort. Keyed by the scope's derived account (Phase 1.3b), not the
    // claimed string.
    // A re-delete of an already-deleted row assigned no seq and changed
    // nothing, so there is nothing to drain: emitting there would nudge every
    // connected client into a fetch that returns no new rows, and a client that
    // re-deletes what it drains would keep the loop alive by itself.
    if (!result.alreadyDeleted) {
      // Tagged with the app namespace of the tombstoned row (see Nudge.app).
      emit(scoped.accountId, { seq: result.seq, app: req.params.app });
    }
    res.status(200).json({ seq: result.seq });
  });

  return router;
}
