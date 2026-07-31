import { Router, type Request, type Response } from "express";
import type { AccountHub, Nudge, Subscriber } from "../realtime/hub.js";
import type { ScopeResolver } from "../scope.js";
import { authenticatedCredential } from "../middleware/credential-auth.js";

// Real-time push endpoint (Phase 9, spec §14). A single authenticated,
// account-scoped SSE stream. It is mounted after the device-token auth
// middleware (server.ts), so every connection is behind the same Bearer auth as
// the sync/intents routes, and it is scoped to the account named in the
// accountId query param exactly like `/sync/:app/list` and `/intents/list`. A
// token for account A subscribes only to account A's nudges; the hub is keyed by
// that accountId, so A never receives B's nudges.
//
// NUDGE-ONLY: the stream carries only a signal (the account's latest seq), never
// payloads/plaintext/row content. The client compares the seq to its cursor and,
// if behind, runs its existing authenticated sync + intent drain. Polling stays
// the backstop; this is purely an optimization (spec §14.3).
//
// Event shape on the wire (SSE `event:`/`data:` frames):
//   event: ready     — sent once, immediately on connect.
//                      data: {"seq": <account's current latest seq>}
//                      Lets a just-connected client reconcile without waiting
//                      for the next write.
//   event: activity  — sent on every write that advances the account seq: the
//                      sync batch-upsert path, the sync soft-delete path, and
//                      the intents insert path. Sync and intents share ONE
//                      per-account seq source, so a single "activity" nudge
//                      covers both; the client drains sync and intents together.
//                      data: {"seq": <account's latest seq after the write>}
//   : heartbeat      — an SSE comment line (ignored by EventSource) sent
//                      periodically to keep the connection alive through idle
//                      proxy/load-balancer timeouts.
//
// REVERSE-PROXY FLUSH REQUIREMENT: this response must NOT be buffered. Nudges are
// written incrementally and must reach the client immediately, so a reverse
// proxy in front of the server has to disable response buffering for this route
// — Caddy: `reverse_proxy` with `flush_interval -1`; nginx: `proxy_buffering
// off` (also signalled via the `X-Accel-Buffering: no` response header below).
// Without it, nudges are batched and the real-time property is lost.

const DEFAULT_HEARTBEAT_MS = 20_000;

// Pull accountId from the query string, requiring a non-empty string. Same
// helper shape as the sync and intents routers.
function queryAccountId(req: Request): string | null {
  const value = req.query.accountId;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

// Format one SSE frame: a named event with a single JSON data line, terminated
// by the blank line the SSE wire format requires.
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface EventsOptions {
  // Heartbeat interval in ms. Kept configurable so tests can observe a heartbeat
  // quickly; defaults to a proxy-friendly ~20s in production.
  heartbeatMs?: number;
  // Revalidation hook (Phase 2.1): "is this credential still active?" —
  // checked on every heartbeat tick, so a revocation written OUTSIDE this
  // process (host-side sqlite3 against the mounted volume, a future hosted
  // panel) still terminates the stream within one heartbeat interval. The
  // in-process admin revoke evicts immediately via the hub; this is the
  // backstop that makes revocation airtight regardless of trigger. buildApp
  // supplies it in per-account mode (one indexed point read per connection
  // per tick — at the 1024-connection global cap and the 20s default, a worst
  // case of ~51 reads/second); absent in shared mode, where connections carry
  // no credential and heartbeat behavior is byte-identical to before.
  isCredentialActive?: (credentialId: string) => boolean;
}

export function eventsRouter(resolve: ScopeResolver, hub: AccountHub, opts: EventsOptions = {}): Router {
  const router = Router();
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let nextId = 1;

  router.get("/", (req: Request, res: Response) => {
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    // Resolve the scope once, at connect: this is the lifetime dimension SSE
    // adds — the account bound here is the account this stream serves until it
    // closes. resolve() is pure construction, so placing it here (before the
    // cap check) changes no observable ordering.
    const scoped = resolve(req, accountId);
    // The ONE string both hub calls key on (Phase 1.3b): the scope's derived
    // account. subscribe and the cleanup closure's unsubscribe share this
    // binding by construction — if they ever keyed on different strings, a
    // subscriber would leak in the hub permanently.
    const boundAccount = scoped.accountId;
    // The credential this stream authenticated with (Phase 2.1): present in
    // per-account mode, undefined in shared mode. Captured once at connect —
    // the same lifetime binding as boundAccount.
    const credentialId = authenticatedCredential(req)?.credentialId;

    const sub: Subscriber = {
      id: nextId++,
      credentialId,
      deliver(nudge: Nudge) {
        // A dead/closed socket makes this throw (or the response is already
        // ended); let it propagate so the hub evicts this subscriber. Write
        // backpressure (write() returning false) is not death and is ignored.
        if (res.writableEnded) {
          throw new Error("SSE response already ended");
        }
        res.write(frame("activity", nudge));
      },
      close() {
        // Server-initiated termination (hub.disconnectCredential). The hub
        // has already unsubscribed this record; ending the response fires the
        // res 'close' event, whose cleanup() is idempotent and stops the
        // heartbeat. Safe on an already-ended response.
        res.end();
      },
    };

    // Enforce the per-account connection cap BEFORE any header is written, so an
    // over-cap client gets a clean 429 rather than a half-open stream.
    if (!hub.subscribe(boundAccount, sub)) {
      res.status(429).json({ error: "too many connections for account" });
      return;
    }

    // SSE headers, flushed immediately (no buffering — see the file-level
    // reverse-proxy note). Everything below runs synchronously through the first
    // res.write, so no publish can interleave before the headers are on the wire.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Initial reconcile event: the account's current latest seq. A client can
    // compare this to its cursor and drain immediately, without waiting for the
    // next write to fire an activity nudge.
    res.write(frame("ready", { seq: scoped.latestSeq() }));

    // Teardown on disconnect/close/error: stop the heartbeat and remove the
    // subscription so a dead connection never leaks in the hub. Idempotent.
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearInterval(heartbeat);
      hub.unsubscribe(boundAccount, sub);
    };

    // Periodic heartbeat comment to keep the connection alive through idle
    // proxy/LB timeouts. unref so a pending heartbeat never keeps the process
    // alive on shutdown. A write failure here means the socket is gone: clean up.
    const heartbeat = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      // Revalidate before keeping the stream alive (Phase 2.1): a credential
      // revoked since connect — by any path, including a database write this
      // process never saw — ends the stream here instead of being heartbeated
      // indefinitely. The disconnected client reconnects, connect returns 401
      // invalid credential, and the shipped client's halt fires: revocation
      // reaches live streams with no client change.
      if (credentialId !== undefined && opts.isCredentialActive !== undefined) {
        let active = true;
        try {
          active = opts.isCredentialActive(credentialId);
        } catch {
          // A transient storage error must not kill a healthy stream; the
          // next tick re-checks.
        }
        if (!active) {
          cleanup();
          res.end();
          return;
        }
      }
      try {
        res.write(": heartbeat\n\n");
      } catch {
        cleanup();
      }
    }, heartbeatMs);
    heartbeat.unref();

    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  return router;
}
