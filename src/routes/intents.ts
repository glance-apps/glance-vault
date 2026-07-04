import { Router, json, type Request, type Response } from "express";
import type { Store, IntentEventInput, IntentEventRecord } from "../storage/types.js";
import type { Emit } from "../realtime/hub.js";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

// Serialize a stored intent event for the wire. The envelope is opaque bytes; it
// leaves the server base64-encoded, exactly like a sync row. The server never
// inspects it.
function serializeIntent(row: IntentEventRecord) {
  return {
    eventId: row.eventId,
    envelope: row.envelope.toString("base64"),
    seq: row.seq,
    expiresAt: row.expiresAt,
    serverMtime: row.serverMtime,
  };
}

// Pull accountId from the query string, requiring a non-empty string. Same
// helper shape as the sync router.
function queryAccountId(req: Request): string | null {
  const value = req.query.accountId;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

// Normalize a client-supplied TTL timestamp to a canonical ISO-8601 UTC string,
// or null if it is not a parseable timestamp. Accepts an ISO string or an epoch
// number. This is the one timestamp the server reads (it is routing metadata, a
// TTL, not the opaque envelope); normalizing it makes expires_at compare
// correctly against the server clock (which also writes canonical ISO) for both
// list filtering and pruning. The envelope itself is never parsed.
function normalizeExpiresAt(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

// Phase 6 intents transport. Cross-device, cross-app messages delivered as
// encrypted, insert-only, TTL-expiring rows. Mounted after the auth middleware
// in server.ts, so every route is behind device-token auth and account scoped,
// exactly like sync. The server never decrypts the envelope, assigns a
// monotonic seq per account (the same source sync uses), and never tracks a
// per-client receive cursor: the client owns its receive cursor and lists since
// a value it supplies. Intents carry no app path param: they are the cross-app
// channel between the apps, so they are account scoped only.
// emit is the best-effort real-time push hook (Phase 9), same contract as the
// sync router: after a landed intent advances the account seq, nudge connected
// SSE clients for that account to drain. Intents share the SAME per-account seq
// source as sync, so this is the same "activity" nudge — a nudged client drains
// both sync and intents. Post-commit, non-throwing, non-blocking; never gates
// the write.
export function intentsRouter(store: Store, emit: Emit): Router {
  const router = Router();

  // Insert a batch of intent events. Body: { accountId, events: [{ eventId,
  // envelope, expiresAt }] }. envelope is base64-encoded bytes on the wire and
  // stored as an opaque BLOB. expiresAt is the client-supplied TTL (ISO string
  // or epoch number). INSERT-ONLY: a re-sent eventId is a harmless no-op, never
  // an update. Returns { written, maxSeq } like the sync batch endpoint, where
  // maxSeq is the highest seq assigned in this batch (0 when nothing new was
  // inserted).
  router.post("/batch", json({ limit: "16mb" }), (req: Request, res: Response) => {
    const body = req.body as { accountId?: unknown; events?: unknown };

    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: "events must be an array" });
      return;
    }

    const events: IntentEventInput[] = [];
    for (let i = 0; i < body.events.length; i++) {
      const raw = body.events[i] as {
        eventId?: unknown;
        envelope?: unknown;
        expiresAt?: unknown;
      };
      if (typeof raw.eventId !== "string" || raw.eventId.trim() === "") {
        res.status(400).json({ error: `events[${i}].eventId is required` });
        return;
      }
      if (typeof raw.envelope !== "string") {
        res.status(400).json({ error: `events[${i}].envelope must be a base64 string` });
        return;
      }
      const expiresAt = normalizeExpiresAt(raw.expiresAt);
      if (expiresAt === null) {
        res.status(400).json({ error: `events[${i}].expiresAt must be a valid timestamp` });
        return;
      }
      events.push({
        eventId: raw.eventId,
        envelope: Buffer.from(raw.envelope, "base64"),
        expiresAt,
      });
    }

    const result = store.insertIntents(body.accountId, events);
    // Nudge connected clients only when a new intent actually landed (maxSeq is
    // 0 when every event was an insert-only re-send). Post-commit, best-effort.
    if (result.maxSeq > 0) {
      emit(body.accountId, { seq: result.maxSeq });
    }
    res.status(200).json(result);
  });

  // Incremental fetch. Query: accountId, since (seq cursor, default 0), limit
  // (default 500, max 1000). Returns events with seq > since, ascending. Only
  // non-expired events are returned. Same shape as the sync list endpoint.
  router.get("/list", (req: Request, res: Response) => {
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

    const result = store.listIntents(accountId, since, limit);
    res.status(200).json({
      rows: result.rows.map(serializeIntent),
      hasMore: result.hasMore,
    });
  });

  return router;
}
