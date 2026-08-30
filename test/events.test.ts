import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";
import { eventsRouter } from "../src/routes/events.js";
import { makeScopeResolver } from "../src/scope.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";
import { deviceTokenAuth } from "../src/middleware/auth.js";
import { InProcessAccountHub, type Nudge, type Subscriber } from "../src/realtime/hub.js";

const TOKEN = "hammer-token";

// A live server with a real SQLite file and a real InProcessAccountHub, driving
// the actual HTTP + SSE path (no mocks). The hub is exposed so tests can assert
// on live connection counts (leak / cleanup checks). heartbeatMs is threaded
// through a dedicated events-only app so a heartbeat can be observed quickly;
// the full buildApp wiring (used by every other test here) keeps the production
// ~20s default.
interface Harness {
  base: string;
  store: SqliteStore;
  hub: InProcessAccountHub;
  close: () => void;
}

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

// Full production app (buildApp), so the sync/intents emission hooks are
// exercised exactly as they run in production.
async function startServer(hub = new InProcessAccountHub()): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-events-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [] },
    store,
    undefined,
    hub,
  );
  const server = await listen(app);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    hub,
    close: () => {
      // Force-destroy any still-open SSE sockets so the test process can exit;
      // server.close() alone waits on persistent connections and would hang the
      // runner under concurrent execution.
      server.closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// A minimal app mounting only auth + the events router, so a short heartbeat
// interval can be injected for the heartbeat test.
async function startEventsOnly(heartbeatMs: number): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-events-hb-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const hub = new InProcessAccountHub();
  const app = express();
  app.use(deviceTokenAuth(TOKEN));
  // The events router takes the scope resolver, like every router post-1.3a.
  // The DiskBlobStore is inert here (events never touch bytes) and touches no
  // disk until a blob is written.
  // Mode is a required parameter (a missing mode fails CLOSED, not open);
  // this harness exercises the shared path.
  const resolve = makeScopeResolver(store, new DiskBlobStore(join(dir, "blobs")), "shared");
  app.use("/events", eventsRouter(resolve, hub, { heartbeatMs }));
  const server = await listen(app);
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    store,
    hub,
    close: () => {
      server.closeAllConnections();
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

function garbageEnvelope(bytes = 64): string {
  return randomBytes(bytes).toString("base64");
}

async function postBatch(
  base: string,
  app: string,
  accountId: string,
  rows: Array<{ entityId: string; envelope: string; deleted?: boolean; insertOnly?: boolean }>,
  notify?: boolean,
): Promise<{ status: number; body: { written: number; maxSeq: number } }> {
  const payload: Record<string, unknown> = { accountId, rows };
  if (notify !== undefined) {
    payload.notify = notify;
  }
  const res = await fetch(`${base}/sync/${app}/batch`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as { written: number; maxSeq: number } };
}

// The per-cycle device-state / cursor / high-water-mark report: the bookkeeping
// write a client makes every sync cycle even when no content changed.
async function postDevice(
  base: string,
  app: string,
  accountId: string,
  deviceId: string,
  lastSeenSeq: number,
): Promise<{ status: number; body: { updated: boolean } }> {
  const res = await fetch(`${base}/sync/${app}/device`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, deviceId, lastSeenSeq }),
  });
  return { status: res.status, body: (await res.json()) as { updated: boolean } };
}

async function deleteRow(
  base: string,
  app: string,
  accountId: string,
  entityId: string,
): Promise<{ status: number; body: { seq: number } | { error: string } }> {
  const url = new URL(`${base}/sync/${app}/${encodeURIComponent(entityId)}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { method: "DELETE", headers: authHeaders() });
  return { status: res.status, body: (await res.json()) as { seq: number } | { error: string } };
}

async function postIntents(
  base: string,
  accountId: string,
  events: Array<{ eventId: string; envelope: string; expiresAt: string }>,
): Promise<{ status: number; body: { written: number; maxSeq: number } }> {
  const res = await fetch(`${base}/intents/batch`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, events }),
  });
  return { status: res.status, body: (await res.json()) as { written: number; maxSeq: number } };
}

function ttl(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
}

// --- A minimal SSE client that parses the event stream over fetch. ---

interface SseFrame {
  event?: string;
  data?: string;
  comment?: string;
}

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
    } else if (line.startsWith("event:")) {
      frame.event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      frame.data = (frame.data ?? "") + line.slice("data:".length).trim();
    }
  }
  return frame;
}

class SseClient {
  status = 0;
  contentType: string | null = null;
  private controller = new AbortController();
  private queue: SseFrame[] = [];
  private waiters: Array<(f: SseFrame) => void> = [];
  private buffer = "";

  static async connect(base: string, accountId: string | null, token = TOKEN): Promise<SseClient> {
    const c = new SseClient();
    const url = new URL(`${base}/events`);
    if (accountId !== null) {
      url.searchParams.set("accountId", accountId);
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: c.controller.signal,
    });
    c.status = res.status;
    c.contentType = res.headers.get("content-type");
    if (res.status === 200 && res.body) {
      void c.pump(res.body as ReadableStream<Uint8Array>);
    } else {
      // Drain a non-stream (error) body so the socket can close.
      await res.text().catch(() => undefined);
    }
    return c;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
          const raw = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          this.emit(parseFrame(raw));
        }
      }
    } catch {
      // Aborted/closed; nothing more to read.
    }
  }

  private emit(frame: SseFrame): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(frame);
    } else {
      this.queue.push(frame);
    }
  }

  // Resolve with the next frame of any kind, or reject on timeout.
  next(timeoutMs = 2000): Promise<SseFrame> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for SSE frame"));
      }, timeoutMs);
      const waiter = (f: SseFrame): void => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push(waiter);
    });
  }

  // Wait for the next frame carrying the named event, skipping comments
  // (heartbeats). Rejects on timeout.
  async nextEvent(name: string, timeoutMs = 2000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for event "${name}"`);
      }
      const frame = await this.next(remaining);
      if (frame.event === name) {
        return frame;
      }
    }
  }

  // Wait for the next heartbeat comment frame, skipping any data frames.
  async nextComment(timeoutMs = 2000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for heartbeat comment");
      }
      const frame = await this.next(remaining);
      if (frame.comment !== undefined) {
        return frame;
      }
    }
  }

  close(): void {
    this.controller.abort();
  }
}

// Poll a predicate until it holds or the timeout elapses.
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ======================================================================
// Hub unit tests (the in-process account-scoped pub/sub, in isolation).
// ======================================================================

function fakeSubscriber(id: number, received: Nudge[]): Subscriber {
  return { id, deliver: (n) => received.push(n), close: () => {} };
}

test("hub delivers a nudge to every connection for the account", () => {
  const hub = new InProcessAccountHub();
  const a1: Nudge[] = [];
  const a2: Nudge[] = [];
  hub.subscribe("acct", fakeSubscriber(1, a1));
  hub.subscribe("acct", fakeSubscriber(2, a2));
  assert.equal(hub.connectionCount("acct"), 2);

  hub.publish("acct", { seq: 7 });
  assert.deepEqual(a1, [{ seq: 7 }]);
  assert.deepEqual(a2, [{ seq: 7 }]);
});

test("hub isolates accounts: a publish reaches only its own account", () => {
  const hub = new InProcessAccountHub();
  const a: Nudge[] = [];
  const b: Nudge[] = [];
  hub.subscribe("acct-a", fakeSubscriber(1, a));
  hub.subscribe("acct-b", fakeSubscriber(2, b));

  hub.publish("acct-a", { seq: 3 });
  assert.deepEqual(a, [{ seq: 3 }]);
  assert.deepEqual(b, [], "account B received nothing from account A's publish");
});

test("hub unsubscribe cleans up and does not leak empty account keys", () => {
  const hub = new InProcessAccountHub();
  const sub = fakeSubscriber(1, []);
  hub.subscribe("acct", sub);
  assert.equal(hub.totalConnections(), 1);
  hub.unsubscribe("acct", sub);
  assert.equal(hub.connectionCount("acct"), 0);
  assert.equal(hub.totalConnections(), 0, "the empty account set was dropped");
  // Unsubscribing again is a harmless no-op.
  hub.unsubscribe("acct", sub);
  assert.equal(hub.totalConnections(), 0);
});

test("hub publish is best-effort: a throwing connection is dropped, others still get it", () => {
  const hub = new InProcessAccountHub();
  const good: Nudge[] = [];
  const bad: Subscriber = {
    id: 1,
    deliver() {
      throw new Error("dead socket");
    },
    close: () => {},
  };
  hub.subscribe("acct", bad);
  hub.subscribe("acct", fakeSubscriber(2, good));

  // publish must not throw even though one subscriber throws...
  assert.doesNotThrow(() => hub.publish("acct", { seq: 9 }));
  // ...the healthy connection still received the nudge...
  assert.deepEqual(good, [{ seq: 9 }]);
  // ...and the throwing connection was evicted (no leak of a dead connection).
  assert.equal(hub.connectionCount("acct"), 1);
});

test("hub enforces a per-account connection cap", () => {
  const hub = new InProcessAccountHub(2);
  assert.equal(hub.subscribe("acct", fakeSubscriber(1, [])), true);
  assert.equal(hub.subscribe("acct", fakeSubscriber(2, [])), true);
  assert.equal(hub.subscribe("acct", fakeSubscriber(3, [])), false, "third is rejected at the cap");
  assert.equal(hub.connectionCount("acct"), 2);
});

test("hub enforces a global connection cap across accounts", () => {
  // High per-account cap, low GLOBAL cap: the ceiling must bind even when each
  // account is well under its own limit and connections spread across accounts
  // (the vector a shared token opens by varying accountId).
  const hub = new InProcessAccountHub(100, 3);
  const subA = fakeSubscriber(1, []);
  assert.equal(hub.subscribe("a", subA), true);
  assert.equal(hub.subscribe("b", fakeSubscriber(2, [])), true);
  assert.equal(hub.subscribe("c", fakeSubscriber(3, [])), true);
  assert.equal(hub.totalConnections(), 3);
  // Fourth connection, a brand-new account, is refused at the global ceiling.
  assert.equal(hub.subscribe("d", fakeSubscriber(4, [])), false, "global cap refuses the 4th");
  assert.equal(hub.totalConnections(), 3);
  assert.equal(hub.connectionCount("d"), 0, "no empty set leaked for the refused account");

  // Freeing a slot lets a new connection back in, and the counter tracks it.
  hub.unsubscribe("a", subA);
  assert.equal(hub.totalConnections(), 2);
  assert.equal(hub.subscribe("d", fakeSubscriber(5, [])), true, "a freed slot admits a new connection");
  assert.equal(hub.totalConnections(), 3);
});

// ======================================================================
// SSE endpoint integration tests (auth, headers, initial seq, nudges,
// isolation, heartbeat, clean disconnect) over real HTTP.
// ======================================================================

test("SSE endpoint requires the device token like every other route", async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/events?accountId=acct`, {
      headers: { Accept: "text/event-stream" },
    });
    assert.equal(res.status, 401, "no Bearer token is rejected");
    await res.text();
  } finally {
    h.close();
  }
});

test("SSE endpoint requires accountId", async () => {
  const h = await startServer();
  try {
    const c = await SseClient.connect(h.base, null);
    assert.equal(c.status, 400, "a missing accountId is a 400");
    c.close();
  } finally {
    h.close();
  }
});

test("SSE connect sets stream headers and sends an initial ready event with the current latest seq", async () => {
  const h = await startServer();
  try {
    const account = "acct-ready";
    // Advance the account seq to a known value first (3 rows -> seq 3).
    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: "e1", envelope: garbageEnvelope() },
      { entityId: "e2", envelope: garbageEnvelope() },
      { entityId: "e3", envelope: garbageEnvelope() },
    ]);
    assert.equal(write.body.maxSeq, 3);

    const c = await SseClient.connect(h.base, account);
    assert.equal(c.status, 200);
    assert.match(c.contentType ?? "", /text\/event-stream/, "SSE content type is set");

    const ready = await c.nextEvent("ready");
    assert.deepEqual(JSON.parse(ready.data!), { seq: 3 }, "initial event carries the current latest seq");
    c.close();
  } finally {
    h.close();
  }
});

test("a fresh account's initial ready seq is 0", async () => {
  const h = await startServer();
  try {
    const c = await SseClient.connect(h.base, "brand-new-account");
    const ready = await c.nextEvent("ready");
    assert.deepEqual(JSON.parse(ready.data!), { seq: 0 });
    c.close();
  } finally {
    h.close();
  }
});

test("a subscribed connection is nudged when the account seq advances via a sync write", async () => {
  const h = await startServer();
  try {
    const account = "acct-syncnudge";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: "task-1", envelope: garbageEnvelope() },
      { entityId: "task-2", envelope: garbageEnvelope() },
    ]);
    assert.equal(write.body.maxSeq, 2);

    const nudge = await c.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudge.data!), { seq: 2 }, "the nudge carries the account's latest seq");
    c.close();
  } finally {
    h.close();
  }
});

test("a subscribed connection is nudged when a sync soft-delete advances the seq", async () => {
  const h = await startServer();
  try {
    const account = "acct-delnudge";
    // Seed a row (seq 1) before connecting so the delete is the observed nudge.
    await postBatch(h.base, "dayglance", account, [{ entityId: "gone", envelope: garbageEnvelope() }]);

    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    const del = await deleteRow(h.base, "dayglance", account, "gone");
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { seq: 2 });

    const nudge = await c.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudge.data!), { seq: 2 });
    c.close();
  } finally {
    h.close();
  }
});

test("a re-delete of an already-deleted row fires no nudge and does not advance the seq", async () => {
  const h = await startServer();
  try {
    const account = "acct-redelete-silent";
    await postBatch(h.base, "dayglance", account, [{ entityId: "gone", envelope: garbageEnvelope() }]);

    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // The real delete nudges once, as always.
    const del = await deleteRow(h.base, "dayglance", account, "gone");
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { seq: 2 });
    assert.deepEqual(JSON.parse((await c.nextEvent("activity")).data!), { seq: 2 });

    // Re-deleting the tombstone publishes nothing, so it must not nudge. A
    // nudge here is the seq-churn loop: every connected client is woken to
    // drain nothing, and a client that re-deletes what it drains keeps the
    // cycle running on its own.
    const again = await deleteRow(h.base, "dayglance", account, "gone");
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { seq: 2 }, "the re-delete reports the existing tombstone seq");
    assert.equal(h.store.forAccount(account).latestSeq(), 2, "the re-delete did not advance the seq");
    await assert.rejects(c.nextEvent("activity", 300), /timed out/, "a re-delete fires no nudge");
    c.close();
  } finally {
    h.close();
  }
});

test("an unchanged batch re-delete fires no nudge", async () => {
  const h = await startServer();
  try {
    const account = "acct-batch-redelete-silent";
    await postBatch(h.base, "dayglance", account, [{ entityId: "gone", envelope: garbageEnvelope() }]);

    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // Tombstoning the live row is a content write: it nudges.
    const tomb = garbageEnvelope();
    const first = await postBatch(h.base, "dayglance", account, [
      { entityId: "gone", envelope: tomb, deleted: true },
    ]);
    assert.equal(first.body.maxSeq, 2);
    assert.deepEqual(JSON.parse((await c.nextEvent("activity")).data!), { seq: 2 });

    // Re-sending the identical tombstone writes nothing, so maxSeq is 0 and the
    // route's existing `maxSeq > 0` gate already suppresses the nudge. This is
    // the batch-path half of the seq-churn loop.
    const again = await postBatch(h.base, "dayglance", account, [
      { entityId: "gone", envelope: tomb, deleted: true },
    ]);
    assert.deepEqual(again.body, { written: 0, maxSeq: 0 });
    assert.equal(h.store.forAccount(account).latestSeq(), 2, "the re-delete did not advance the seq");
    await assert.rejects(c.nextEvent("activity", 300), /timed out/, "an unchanged re-delete fires no nudge");
    c.close();
  } finally {
    h.close();
  }
});

test("a subscribed connection is nudged when an intent lands", async () => {
  const h = await startServer();
  try {
    const account = "acct-intentnudge";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    const write = await postIntents(h.base, account, [
      { eventId: "ev1", envelope: garbageEnvelope(), expiresAt: ttl(60) },
    ]);
    assert.equal(write.body.maxSeq, 1);

    const nudge = await c.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudge.data!), { seq: 1 }, "intents nudge shares the account seq line");
    c.close();
  } finally {
    h.close();
  }
});

test("the nudge is signal-only: it carries the seq and no payload/plaintext", async () => {
  const h = await startServer();
  try {
    const account = "acct-nopayload";
    const secret = randomBytes(48).toString("base64");
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    await postBatch(h.base, "lastglance", account, [{ entityId: "row", envelope: secret }]);

    const nudge = await c.nextEvent("activity");
    const parsed = JSON.parse(nudge.data!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), ["seq"], "the only field is seq");
    assert.equal(typeof parsed.seq, "number");
    // The opaque envelope bytes never appear anywhere in the frame.
    assert.ok(!nudge.data!.includes(secret), "no row content leaks into the nudge");
  } finally {
    h.close();
  }
});

test("account isolation: a connection for account A never receives account B's nudges", async () => {
  const h = await startServer();
  try {
    const a = await SseClient.connect(h.base, "acct-A");
    const b = await SseClient.connect(h.base, "acct-B");
    await a.nextEvent("ready");
    await b.nextEvent("ready");

    // Write only to account B.
    const write = await postBatch(h.base, "dayglance", "acct-B", [
      { entityId: "b-row", envelope: garbageEnvelope() },
    ]);
    assert.equal(write.body.maxSeq, 1);

    // B receives its nudge...
    const nudgeB = await b.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudgeB.data!), { seq: 1 });
    // ...and A receives NOTHING for it (times out with no activity frame).
    await assert.rejects(a.nextEvent("activity", 300), /timed out/, "account A got no cross-account nudge");

    a.close();
    b.close();
  } finally {
    h.close();
  }
});

test("a write still succeeds when a subscribed connection has gone dead", async () => {
  const h = await startServer();
  try {
    const account = "acct-deadconn";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");
    assert.equal(h.hub.connectionCount(account), 1);

    // Kill the connection abruptly, then immediately write. Whether or not the
    // server has processed the socket close yet, the publish must never fail the
    // write: a dead delivery is dropped, not propagated.
    c.close();
    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: "still-writes", envelope: garbageEnvelope() },
    ]);
    assert.equal(write.status, 200, "the write succeeded despite the dead connection");
    assert.equal(write.body.maxSeq, 1);

    // The dead connection is reaped, not leaked.
    await waitFor(() => h.hub.connectionCount(account) === 0);
  } finally {
    h.close();
  }
});

test("disconnect unregisters the connection cleanly (no leak)", async () => {
  const h = await startServer();
  try {
    const account = "acct-leak";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");
    assert.equal(h.hub.connectionCount(account), 1, "the connection is registered");
    assert.equal(h.hub.totalConnections(), 1);

    c.close();
    await waitFor(() => h.hub.connectionCount(account) === 0);
    assert.equal(h.hub.totalConnections(), 0, "the registry is empty after disconnect");
  } finally {
    h.close();
  }
});

test("the connection receives periodic heartbeat comments", async () => {
  const h = await startEventsOnly(60);
  try {
    const c = await SseClient.connect(h.base, "acct-hb");
    await c.nextEvent("ready");
    // With a 60ms interval, a couple of heartbeat comments arrive well within
    // the wait window.
    const first = await c.nextComment(1000);
    assert.equal(first.comment, "heartbeat");
    const second = await c.nextComment(1000);
    assert.equal(second.comment, "heartbeat");
    c.close();
  } finally {
    h.close();
  }
});

// ======================================================================
// Self-nudge loop fix: only CONTENT writes nudge; bookkeeping writes do
// not. (Account isolation and best-effort emission are unchanged and stay
// covered by the tests above.)
// ======================================================================

test("a device-cursor (bookkeeping) write emits no nudge and does not advance the seq", async () => {
  const h = await startServer();
  try {
    const account = "acct-cursor-silent";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // The per-cycle device-state / last-seen / HWM report. It must not nudge.
    const rep = await postDevice(h.base, "dayglance", account, "phone", 5);
    assert.equal(rep.status, 200);
    assert.deepEqual(rep.body, { updated: true });

    // It also does not touch the account seq (bookkeeping never calls nextSeq).
    assert.equal(h.store.forAccount(account).latestSeq(), 0, "the cursor report did not advance the seq");
    // And no activity nudge is delivered within the window.
    await assert.rejects(c.nextEvent("activity", 300), /timed out/, "a cursor report fires no nudge");
    c.close();
  } finally {
    h.close();
  }
});

test("a content-free sync cycle produces no nudge (no self-loop)", async () => {
  const h = await startServer();
  try {
    const account = "acct-noloop";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // Simulate several housekeeping-only cycles: each cycle the client only
    // re-reports its cursor (no content changed). None of these may nudge, or the
    // nudge would trigger the next cycle -> the self-nudge loop this fix removes.
    for (let i = 1; i <= 3; i++) {
      await postDevice(h.base, "dayglance", account, "phone", i);
    }
    await assert.rejects(
      c.nextEvent("activity", 400),
      /timed out/,
      "a content-free cycle never nudges",
    );
    c.close();
  } finally {
    h.close();
  }
});

test("a bookkeeping batch write (notify:false) commits and advances seq but fires no nudge", async () => {
  const h = await startServer();
  try {
    const account = "acct-notify-false";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // A device-state row persisted through the content batch endpoint, marked as
    // bookkeeping with notify:false. The WRITE must still happen (row stored, seq
    // advanced) — only the nudge is suppressed.
    const write = await postBatch(
      h.base,
      "dayglance",
      account,
      [{ entityId: "__device_state__", envelope: garbageEnvelope() }],
      false,
    );
    assert.equal(write.status, 200);
    assert.equal(write.body.written, 1, "the bookkeeping row was still written");
    assert.equal(write.body.maxSeq, 1, "and it still advanced the account seq");
    assert.equal(h.store.forAccount(account).latestSeq(), 1, "the seq really advanced (write not gated)");

    // No nudge for the suppressed write...
    await assert.rejects(
      c.nextEvent("activity", 300),
      /timed out/,
      "notify:false suppresses the nudge",
    );

    // ...but suppression is per-write, not sticky: the very next real content
    // write (notify omitted) nudges instantly with the new latest seq.
    const real = await postBatch(h.base, "dayglance", account, [
      { entityId: "task-1", envelope: garbageEnvelope() },
    ]);
    assert.equal(real.body.maxSeq, 2);
    const nudge = await c.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudge.data!), { seq: 2 }, "the following content write still nudges");
    c.close();
  } finally {
    h.close();
  }
});

test("a normal content batch (notify omitted) still nudges instantly", async () => {
  const h = await startServer();
  try {
    const account = "acct-content-nudges";
    const c = await SseClient.connect(h.base, account);
    await c.nextEvent("ready");

    // No notify flag at all -> default ON -> nudge. This is the preserve-real-
    // nudges property: existing clients that never send the flag are unaffected.
    const write = await postBatch(h.base, "dayglance", account, [
      { entityId: "task-a", envelope: garbageEnvelope() },
      { entityId: "task-b", envelope: garbageEnvelope() },
    ]);
    assert.equal(write.body.maxSeq, 2);
    const nudge = await c.nextEvent("activity");
    assert.deepEqual(JSON.parse(nudge.data!), { seq: 2 });
    c.close();
  } finally {
    h.close();
  }
});

test("notify must be a boolean when present", async () => {
  const h = await startServer();
  try {
    const res = await fetch(`${h.base}/sync/dayglance/batch`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: "acct-x", rows: [], notify: "false" }),
    });
    assert.equal(res.status, 400, "a non-boolean notify is rejected");
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /notify must be a boolean/);
  } finally {
    h.close();
  }
});
