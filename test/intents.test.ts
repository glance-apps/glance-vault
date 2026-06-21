import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { buildApp } from "../src/server.js";

const TOKEN = "hammer-token";

// A live server backed by a real SQLite file on disk, mirroring the sync hammer
// harness. Every test gets its own store, so they are independent, and exercises
// the full HTTP path including auth and routing. The store is exposed so the
// prune test can call the storage method directly (intents has no prune
// endpoint; prune runs lazily on write and as a callable sweep).
interface Harness {
  base: string;
  store: SqliteStore;
  close: () => void;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-intents-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore(path);
  store.migrate();
  const app = buildApp({ storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [] }, store);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    close: () => {
      server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function authHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

interface WireIntent {
  eventId: string;
  envelope: string;
  seq: number;
  expiresAt: string;
  serverMtime: string;
}

// A TTL timestamp some minutes from now (positive) or in the past (negative),
// as a canonical ISO string.
function ttl(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60_000).toISOString();
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

async function listIntents(
  base: string,
  accountId: string,
  since: number,
  limit?: number,
): Promise<{ status: number; body: { rows: WireIntent[]; hasMore: boolean } }> {
  const url = new URL(`${base}/intents/list`);
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("since", String(since));
  if (limit !== undefined) {
    url.searchParams.set("limit", String(limit));
  }
  const res = await fetch(url, { headers: authHeaders() });
  return { status: res.status, body: (await res.json()) as { rows: WireIntent[]; hasMore: boolean } };
}

// A synthetic, opaque envelope: random bytes, base64-encoded, not real
// ciphertext. The server must store and return these bytes untouched.
function garbageEnvelope(bytes = 64): string {
  return randomBytes(bytes).toString("base64");
}

// 1. WRITE insert-only idempotency: re-sending the same event_id is a harmless
// no-op. It creates no duplicate row, does not overwrite, and consumes no seq
// (written and maxSeq do not grow on the re-send), mirroring the sync
// insertOnly key-verifier test.
test("re-sending an intent event_id is an insert-only no-op", async () => {
  const h = await startServer();
  try {
    const account = "acct-idem";
    const K = 4;
    const original = Array.from({ length: K }, (_u, i) => ({
      eventId: `ev${i}`,
      envelope: garbageEnvelope(),
      expiresAt: ttl(60),
    }));

    const first = await postIntents(h.base, account, original);
    assert.equal(first.status, 200);
    assert.equal(first.body.written, K, "all K new events were inserted");
    assert.equal(first.body.maxSeq, K, "a K-event insert advances the seq by exactly K");

    // Re-send the same event_ids, even with different envelope bytes: insert-only
    // means the stored rows are untouched and no seq is consumed.
    const resend = original.map((e) => ({ ...e, envelope: garbageEnvelope() }));
    const second = await postIntents(h.base, account, resend);
    assert.equal(second.status, 200);
    assert.equal(second.body.written, 0, "re-sent event_ids are skipped, not re-inserted");
    assert.equal(second.body.maxSeq, 0, "no seq is consumed by a re-sent event_id");

    // No duplicates, and the original envelopes survive unchanged (no update).
    const listed = await listIntents(h.base, account, 0);
    assert.equal(listed.body.rows.length, K, "no duplicate rows were created");
    const byId = new Map(listed.body.rows.map((r) => [r.eventId, r]));
    for (const sent of original) {
      assert.equal(byId.get(sent.eventId)?.envelope, sent.envelope, "stored bytes are unchanged");
    }
  } finally {
    h.close();
  }
});

// 1b. Envelope losslessness: the exact bytes a client uploads come back
// byte-for-byte from list. The server treats the envelope as an opaque BLOB.
test("intent envelope round-trips byte-identically through write then list", async () => {
  const h = await startServer();
  try {
    const account = "acct-envelope";
    const raws = [randomBytes(1), randomBytes(2), randomBytes(100), randomBytes(257), Buffer.alloc(0)];
    const events = raws.map((raw, i) => ({
      eventId: `env${i}`,
      envelope: raw.toString("base64"),
      expiresAt: ttl(60),
    }));

    const written = await postIntents(h.base, account, events);
    assert.equal(written.body.written, events.length);

    const listed = await listIntents(h.base, account, 0);
    const byId = new Map(listed.body.rows.map((r) => [r.eventId, r]));
    for (let i = 0; i < events.length; i++) {
      const returned = byId.get(`env${i}`);
      assert.ok(returned, `row env${i} came back`);
      assert.deepEqual(
        Buffer.from(returned.envelope, "base64"),
        raws[i],
        `env${i} decodes to the exact bytes that were uploaded`,
      );
    }
  } finally {
    h.close();
  }
});

// 2. LIST-SINCE-CURSOR: returns only events with seq > since, in seq order, and
// reports hasMore by over-fetching, exactly like the sync list endpoint.
test("intents list returns only newer events in seq order with hasMore paging", async () => {
  const h = await startServer();
  try {
    const account = "acct-list";

    // First write of N events: from cursor 0, all N come back, in ascending seq.
    const N = 3;
    const firstEvents = Array.from({ length: N }, (_u, i) => ({
      eventId: `n${i}`,
      envelope: garbageEnvelope(),
      expiresAt: ttl(60),
    }));
    const firstWrite = await postIntents(h.base, account, firstEvents);
    const cursor = firstWrite.body.maxSeq;

    const page1 = await listIntents(h.base, account, 0);
    assert.equal(page1.body.rows.length, N, "all N events returned from cursor 0");
    assert.equal(page1.body.hasMore, false, "no more rows beyond the full set");
    for (let i = 1; i < page1.body.rows.length; i++) {
      assert.ok(page1.body.rows[i].seq > page1.body.rows[i - 1].seq, "rows are in ascending seq order");
    }

    // Write M more; listing from the prior cursor returns exactly the M newer.
    const M = 2;
    const moreEvents = Array.from({ length: M }, (_u, i) => ({
      eventId: `m${i}`,
      envelope: garbageEnvelope(),
      expiresAt: ttl(60),
    }));
    await postIntents(h.base, account, moreEvents);

    const page2 = await listIntents(h.base, account, cursor);
    assert.equal(page2.body.rows.length, M, "exactly the M newer events returned past the cursor");
    for (const r of page2.body.rows) {
      assert.ok(r.seq > cursor, "every returned event is strictly past the cursor");
    }

    // Paging: N + M = 5 total. A limit-2 page from 0 has more behind it.
    const p = await listIntents(h.base, account, 0, 2);
    assert.equal(p.body.rows.length, 2);
    assert.equal(p.body.hasMore, true, "a full page with rows behind it reports hasMore");

    const c2 = p.body.rows[p.body.rows.length - 1].seq;
    const p2 = await listIntents(h.base, account, c2, 2);
    assert.equal(p2.body.rows.length, 2);
    assert.equal(p2.body.hasMore, true);

    const c3 = p2.body.rows[p2.body.rows.length - 1].seq;
    const p3 = await listIntents(h.base, account, c3, 2);
    assert.equal(p3.body.rows.length, 1, "the last partial page");
    assert.equal(p3.body.hasMore, false, "no rows remain past the last page");
  } finally {
    h.close();
  }
});

// 2b. Account isolation: events written under one account never surface in a
// list for another. (Intents are account scoped only; there is no app scope,
// since intents are the cross-app channel.)
test("intents are isolated between accounts", async () => {
  const h = await startServer();
  try {
    await postIntents(h.base, "acct-a", [
      { eventId: "a1", envelope: garbageEnvelope(), expiresAt: ttl(60) },
      { eventId: "a2", envelope: garbageEnvelope(), expiresAt: ttl(60) },
    ]);
    await postIntents(h.base, "acct-b", [
      { eventId: "b1", envelope: garbageEnvelope(), expiresAt: ttl(60) },
    ]);

    const a = await listIntents(h.base, "acct-a", 0);
    assert.equal(a.body.rows.length, 2, "account A has exactly its own events");
    const b = await listIntents(h.base, "acct-b", 0);
    assert.equal(b.body.rows.length, 1, "account B has only its own event");
  } finally {
    h.close();
  }
});

// Resolve after roughly ms milliseconds. Used to let a short TTL lapse so the
// prune path can be observed deleting a row that was live when written.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3a. Lazy prune on write: an event written already past its TTL is accepted but
// pruned in the same write transaction, so it never persists and never lists.
// (Prune runs lazily on every write; intents are disposable, so a slightly late
// prune is harmless. There is no prune HTTP endpoint.)
test("an already-expired event is lazily pruned on write and never lists", async () => {
  const h = await startServer();
  try {
    const account = "acct-prune-lazy";
    await postIntents(h.base, account, [
      { eventId: "expired", envelope: garbageEnvelope(), expiresAt: ttl(-60) },
      { eventId: "live", envelope: garbageEnvelope(), expiresAt: ttl(60) },
    ]);

    const listed = await listIntents(h.base, account, 0);
    assert.deepEqual(
      listed.body.rows.map((r) => r.eventId),
      ["live"],
      "the already-expired event was pruned on write; only the live event remains",
    );

    // It is gone from storage, not merely filtered: a global sweep finds nothing
    // left to delete.
    assert.equal(h.store.pruneExpiredIntents(), 0, "nothing expired remains to prune");
  } finally {
    h.close();
  }
});

// 3b. TTL PRUNE removes rows that expire after they were written. A short-TTL
// event is live at write time (so it survives the on-write prune), then lapses;
// once expired it is excluded from list (the expires_at > now filter) and
// pruneExpiredIntents hard-deletes it from storage while leaving a live event
// untouched.
test("prune deletes expired intent rows and leaves live ones", async () => {
  const h = await startServer();
  try {
    const account = "acct-prune";

    // "soon" is live now (+600ms) so it survives the on-write prune; "live" has a
    // long TTL and must survive throughout.
    await postIntents(h.base, account, [
      { eventId: "soon", envelope: garbageEnvelope(), expiresAt: new Date(Date.now() + 600).toISOString() },
      { eventId: "live", envelope: garbageEnvelope(), expiresAt: ttl(60) },
    ]);

    // Both are present immediately after the write.
    const before = await listIntents(h.base, account, 0);
    assert.deepEqual(
      before.body.rows.map((r) => r.eventId).sort(),
      ["live", "soon"],
      "both events list while soon is still live",
    );

    // Let "soon" lapse, then list excludes it server-side before any prune runs.
    await sleep(900);
    const afterExpiry = await listIntents(h.base, account, 0);
    assert.deepEqual(
      afterExpiry.body.rows.map((r) => r.eventId),
      ["live"],
      "the expired event is filtered out of list",
    );

    // The prune sweep hard-deletes exactly the expired row.
    assert.equal(h.store.pruneExpiredIntents(), 1, "exactly the one expired row was pruned");

    // The live event survives, and a repeat prune is a no-op.
    const after = await listIntents(h.base, account, 0);
    assert.deepEqual(after.body.rows.map((r) => r.eventId), ["live"], "the live event survives the prune");
    assert.equal(h.store.pruneExpiredIntents(), 0, "a repeat prune deletes nothing");
  } finally {
    h.close();
  }
});
