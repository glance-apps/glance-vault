import { Router, json, type Request, type Response } from "express";
import type { Store, SyncRowInput, SyncRowRecord } from "../storage/types.js";

// The three apps that share this server. The app path param is validated against
// this set; anything else is rejected with 400.
const ALLOWED_APPS = new Set(["dayglance", "lastglance", "lifeglance"]);

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
export function syncRouter(store: Store): Router {
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
    const body = req.body as { accountId?: unknown; rows?: unknown };

    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (!Array.isArray(body.rows)) {
      res.status(400).json({ error: "rows must be an array" });
      return;
    }

    const rows: SyncRowInput[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      const raw = body.rows[i] as {
        entityId?: unknown;
        envelope?: unknown;
        deleted?: unknown;
        createdAt?: unknown;
        insertOnly?: unknown;
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
      rows.push({
        entityId: raw.entityId,
        envelope: Buffer.from(raw.envelope, "base64"),
        deleted: raw.deleted === true,
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : undefined,
        insertOnly: raw.insertOnly === true,
      });
    }

    const result = store.batchUpsert(app, body.accountId, rows);
    res.status(200).json(result);
  });

  // Report a device's sync cursor. Body: { accountId, deviceId, lastSeenSeq }.
  // The cursor moves forward only (MAX), so a stale report cannot rewind it. The
  // device cursor is account scoped, not per app (seq is assigned per account);
  // the :app segment is kept only for route consistency with the other sync
  // endpoints. Used later for coordinated tombstone GC.
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
    store.updateDeviceCursor(body.accountId, body.deviceId, body.lastSeenSeq);
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

    const result = store.listRows(app, accountId, since, limit);
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
    const row = store.getRow(req.params.app, accountId, req.params.entityId);
    if (row === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(serializeRow(row));
  });

  // Soft-delete a row: mark deleted, assign a new seq. Query: accountId.
  router.delete("/:app/:entityId", (req: Request, res: Response) => {
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const result = store.softDeleteRow(req.params.app, accountId, req.params.entityId);
    if (result === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.status(200).json(result);
  });

  return router;
}
