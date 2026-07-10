import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { SqliteStore } from "../src/storage/sqlite.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";
import { buildApp } from "../src/server.js";

const TOKEN = "hammer-token";

// A live server backed by a real SQLite file and a real on-disk blob store,
// mirroring the sync/intents harnesses. Every test gets its own store and blob
// directory, so they are independent, and exercises the full HTTP path
// including auth and routing. maxBlobSize is configurable per harness so the
// over-size test can use a small cap. The store is exposed so a couple of tests
// can assert storage-level state (reference counts, the zero point) directly.
interface Harness {
  base: string;
  store: SqliteStore;
  maxBlobSize: number;
  close: () => void;
}

async function startServer(maxBlobSize = 16 * 1024 * 1024): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "glancevault-blobs-"));
  const path = join(dir, "test.db");
  const blobDir = join(dir, "blobs");
  const store = new SqliteStore(path);
  store.migrate();
  const blobStore = new DiskBlobStore(blobDir);
  const app = buildApp(
    { storagePath: path, port: 0, deviceToken: TOKEN, allowedOrigins: [], blobStorePath: blobDir, maxBlobSize },
    store,
    blobStore,
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    maxBlobSize,
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

function rawHeaders(): Record<string, string> {
  return { "Content-Type": "application/octet-stream", Authorization: `Bearer ${TOKEN}` };
}

// The content address: lowercase hex sha256 of the (opaque) ciphertext bytes,
// exactly the function the server recomputes on finalize.
function blobHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Synthetic, opaque "ciphertext": random bytes the server stores and returns
// untouched. The server never decrypts these.
function garbageBlob(bytes = 4096): Buffer {
  return randomBytes(bytes);
}

interface InitiateResult {
  status: number;
  body: { uploadId?: string; blobHash?: string; exists?: boolean; received?: unknown[]; error?: string };
}

async function initiate(base: string, accountId: string, hash: string, size: number): Promise<InitiateResult> {
  const res = await fetch(`${base}/blobs/uploads`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId, blobHash: hash, size }),
  });
  return { status: res.status, body: (await res.json()) as InitiateResult["body"] };
}

async function sendPart(
  base: string,
  accountId: string,
  uploadId: string,
  index: number,
  bytes: Buffer,
): Promise<{ status: number; body: { received: { index: number; size: number }[]; receivedBytes: number } }> {
  const url = new URL(`${base}/blobs/uploads/${uploadId}/parts/${index}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { method: "PUT", headers: rawHeaders(), body: bytes });
  return {
    status: res.status,
    body: (await res.json()) as { received: { index: number; size: number }[]; receivedBytes: number },
  };
}

async function status(
  base: string,
  accountId: string,
  uploadId: string,
): Promise<{ status: number; body: { received: { index: number; size: number }[]; receivedBytes: number; declaredSize: number } }> {
  const url = new URL(`${base}/blobs/uploads/${uploadId}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { headers: authHeaders() });
  return {
    status: res.status,
    body: (await res.json()) as {
      received: { index: number; size: number }[];
      receivedBytes: number;
      declaredSize: number;
    },
  };
}

async function finalize(
  base: string,
  accountId: string,
  uploadId: string,
): Promise<{ status: number; body: { blobHash?: string; size?: number; stored?: boolean; deduped?: boolean; error?: string } }> {
  const res = await fetch(`${base}/blobs/uploads/${uploadId}/finalize`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ accountId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Upload a whole blob in equal-sized parts, the common path. Returns the hash.
async function uploadInParts(
  base: string,
  accountId: string,
  bytes: Buffer,
  partSize: number,
): Promise<string> {
  const hash = blobHash(bytes);
  const init = await initiate(base, accountId, hash, bytes.length);
  assert.equal(init.status, 201, "fresh upload session created");
  const uploadId = init.body.uploadId as string;
  let index = 0;
  for (let off = 0; off < bytes.length; off += partSize) {
    await sendPart(base, accountId, uploadId, index, bytes.subarray(off, off + partSize));
    index += 1;
  }
  const fin = await finalize(base, accountId, uploadId);
  assert.equal(fin.status, 200, "finalize succeeded");
  assert.equal(fin.body.stored, true);
  return hash;
}

async function headExists(base: string, accountId: string, hash: string): Promise<number> {
  const url = new URL(`${base}/blobs/${hash}`);
  url.searchParams.set("accountId", accountId);
  const res = await fetch(url, { method: "HEAD", headers: authHeaders() });
  return res.status;
}

// 1. EXISTENCE CHECK: a HEAD on an unknown hash is 404; after upload it is 200
// and reports the size. This is what lets a client skip uploading a blob the
// server already has.
test("existence check reports 404 before upload and 200 after", async () => {
  const h = await startServer();
  try {
    const account = "acct-exists";
    const bytes = garbageBlob(1234);
    const hash = blobHash(bytes);

    assert.equal(await headExists(h.base, account, hash), 404, "unknown blob is absent");

    await uploadInParts(h.base, account, bytes, 512);

    assert.equal(await headExists(h.base, account, hash), 200, "stored blob is present");

    // The size is reported in a header; the body stays empty (cheap check).
    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", account);
    const res = await fetch(url, { method: "HEAD", headers: authHeaders() });
    assert.equal(res.headers.get("x-blob-size"), String(bytes.length));
    assert.equal(await res.text(), "", "HEAD carries no body");
  } finally {
    h.close();
  }
});

// 2. IDEMPOTENT UPLOAD: once a hash is stored, re-initiating an upload of the
// same hash is a no-op that reports exists:true (the client uploads nothing).
// This is the content-addressing idempotency, analogous to an intents event_id.
test("re-uploading a known hash is an idempotent no-op", async () => {
  const h = await startServer();
  try {
    const account = "acct-idem";
    const bytes = garbageBlob(8000);
    const hash = await uploadInParts(h.base, account, bytes, 3000);

    // Initiate again: the server already has it, so it tells the client to skip.
    const again = await initiate(h.base, account, hash, bytes.length);
    assert.equal(again.status, 200);
    assert.equal(again.body.exists, true, "server already has the blob");
    assert.equal(again.body.uploadId, undefined, "no new session is created for a known hash");

    // The bytes are unchanged and there is exactly one metadata row.
    const rec = h.store.getBlob(account, hash);
    assert.ok(rec, "the metadata row exists");
    assert.equal(rec.size, bytes.length);

    // A full download returns the exact bytes that were uploaded.
    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", account);
    const dl = await fetch(url, { headers: authHeaders() });
    const got = Buffer.from(await dl.arrayBuffer());
    assert.deepEqual(got, bytes, "downloaded bytes are byte-identical to the upload");
  } finally {
    h.close();
  }
});

// 3. RESUMABLE UPLOAD: send some parts, "interrupt" (stop sending), query the
// resume point, then resume from the last acked part and finalize. Finalize
// verifies the reassembled bytes hash to the declared blobHash.
test("an interrupted upload resumes from the acked point and finalizes", async () => {
  const h = await startServer();
  try {
    const account = "acct-resume";
    const partSize = 1000;
    const bytes = garbageBlob(partSize * 5 + 137); // 6 parts, last one short
    const hash = blobHash(bytes);

    const init = await initiate(h.base, account, hash, bytes.length);
    assert.equal(init.status, 201);
    const uploadId = init.body.uploadId as string;

    // Send the first 3 parts, then "lose the connection".
    for (let i = 0; i < 3; i++) {
      const ack = await sendPart(h.base, account, uploadId, i, bytes.subarray(i * partSize, (i + 1) * partSize));
      assert.equal(ack.status, 200);
    }

    // Resume point: the server reports exactly the 3 acked parts and their bytes.
    const resume = await status(h.base, account, uploadId);
    assert.equal(resume.status, 200);
    assert.deepEqual(
      resume.body.received.map((p) => p.index),
      [0, 1, 2],
      "the three acked parts are reported as the resume point",
    );
    assert.equal(resume.body.receivedBytes, 3 * partSize, "acked byte count is correct");

    // A premature finalize now would fail the hash check (incomplete bytes); the
    // client instead resumes from part 3 onward.
    let index = 3;
    for (let off = 3 * partSize; off < bytes.length; off += partSize) {
      const ack = await sendPart(h.base, account, uploadId, index, bytes.subarray(off, off + partSize));
      assert.equal(ack.status, 200);
      index += 1;
    }

    const fin = await finalize(h.base, account, uploadId);
    assert.equal(fin.status, 200, "finalize verifies the reassembled hash and stores the blob");
    assert.equal(fin.body.blobHash, hash);
    assert.equal(fin.body.size, bytes.length);

    // The whole blob round-trips byte-identically.
    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", account);
    const dl = await fetch(url, { headers: authHeaders() });
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes, "reassembled blob matches the original");
  } finally {
    h.close();
  }
});

// 3b. Resending an already-acked part is idempotent: the acked set and byte
// count do not grow, so a retry after an uncertain ack is harmless.
test("resending an acked part does not duplicate it", async () => {
  const h = await startServer();
  try {
    const account = "acct-resend-part";
    const partSize = 500;
    const bytes = garbageBlob(partSize * 3);
    const hash = blobHash(bytes);
    const init = await initiate(h.base, account, hash, bytes.length);
    const uploadId = init.body.uploadId as string;

    await sendPart(h.base, account, uploadId, 0, bytes.subarray(0, partSize));
    await sendPart(h.base, account, uploadId, 1, bytes.subarray(partSize, 2 * partSize));
    // Re-send part 0 (a retry): no duplicate, byte count unchanged.
    const resend = await sendPart(h.base, account, uploadId, 0, bytes.subarray(0, partSize));
    assert.deepEqual(resend.body.received.map((p) => p.index), [0, 1]);
    assert.equal(resend.body.receivedBytes, 2 * partSize, "a re-sent part does not inflate the total");

    await sendPart(h.base, account, uploadId, 2, bytes.subarray(2 * partSize));
    const fin = await finalize(h.base, account, uploadId);
    assert.equal(fin.status, 200);
  } finally {
    h.close();
  }
});

// 4. HASH MISMATCH ON FINALIZE is rejected: if the reassembled ciphertext does
// not hash to the declared blobHash, finalize fails and nothing is stored. The
// address must match the bytes.
test("finalize rejects when the reassembled bytes do not match the declared hash", async () => {
  const h = await startServer();
  try {
    const account = "acct-mismatch";
    const declared = garbageBlob(2048);
    const tampered = garbageBlob(2048); // different bytes, different hash
    const declaredHashValue = blobHash(declared);

    const init = await initiate(h.base, account, declaredHashValue, tampered.length);
    assert.equal(init.status, 201);
    const uploadId = init.body.uploadId as string;

    // Upload the WRONG bytes under the declared hash.
    await sendPart(h.base, account, uploadId, 0, tampered);

    const fin = await finalize(h.base, account, uploadId);
    assert.equal(fin.status, 400, "a hash mismatch is rejected");
    assert.match(fin.body.error ?? "", /hash mismatch/i);

    // Nothing was stored under the declared hash.
    assert.equal(await headExists(h.base, account, declaredHashValue), 404, "the blob was not stored");
    assert.equal(h.store.getBlob(account, declaredHashValue), null, "no metadata row was created");
  } finally {
    h.close();
  }
});

// 5. OVER-SIZE is rejected server-side: declaring a size above the operator cap
// is rejected at initiate, before any bytes move. The client also checks, but
// the server is the real guarantee.
test("an over-size blob is rejected server-side at initiate", async () => {
  const cap = 4096;
  const h = await startServer(cap);
  try {
    const account = "acct-oversize";
    const bytes = garbageBlob(cap + 1);
    const hash = blobHash(bytes);

    const init = await initiate(h.base, account, hash, bytes.length);
    assert.equal(init.status, 413, "over-cap declared size is rejected");
    assert.equal(await headExists(h.base, account, hash), 404, "nothing was stored");

    // A blob at exactly the cap is accepted.
    const ok = garbageBlob(cap);
    const okHash = await uploadInParts(h.base, account, ok, cap);
    assert.equal(await headExists(h.base, account, okHash), 200, "a blob at the cap is accepted");
  } finally {
    h.close();
  }
});

// 5b. The part-size accounting is also a server-side guard: parts that would
// exceed the declared total are rejected mid-upload.
test("parts exceeding the declared size are rejected", async () => {
  const h = await startServer();
  try {
    const account = "acct-partsize";
    const bytes = garbageBlob(1000);
    const hash = blobHash(bytes);
    const init = await initiate(h.base, account, hash, bytes.length);
    const uploadId = init.body.uploadId as string;

    // First part fills the declared size; a second non-empty part overflows it.
    await sendPart(h.base, account, uploadId, 0, bytes);
    const overflow = await sendPart(h.base, account, uploadId, 1, garbageBlob(1));
    assert.equal(overflow.status, 400, "parts beyond the declared total are rejected");
  } finally {
    h.close();
  }
});

// 6. RANGE DOWNLOAD returns the correct byte range. A full GET is 200 with all
// bytes; a Range request is 206 with the exact slice and a correct Content-Range.
test("range download returns the correct byte range", async () => {
  const h = await startServer();
  try {
    const account = "acct-range";
    const bytes = garbageBlob(10_000);
    const hash = await uploadInParts(h.base, account, bytes, 4096);

    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", account);

    // Full download: 200, Accept-Ranges advertised, all bytes.
    const full = await fetch(url, { headers: authHeaders() });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    // A middle range [1000, 1999]: 206 with exactly those 1000 bytes.
    const mid = await fetch(url, { headers: { ...authHeaders(), Range: "bytes=1000-1999" } });
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get("content-range"), `bytes 1000-1999/${bytes.length}`);
    assert.equal(mid.headers.get("content-length"), "1000");
    assert.deepEqual(Buffer.from(await mid.arrayBuffer()), bytes.subarray(1000, 2000), "the exact slice");

    // Open-ended range [9000, EOF].
    const tail = await fetch(url, { headers: { ...authHeaders(), Range: "bytes=9000-" } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(9000), "to end of blob");

    // Suffix range: the last 500 bytes.
    const suffix = await fetch(url, { headers: { ...authHeaders(), Range: "bytes=-500" } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 500));

    // Unsatisfiable range: 416 with a Content-Range reporting the size.
    const bad = await fetch(url, { headers: { ...authHeaders(), Range: `bytes=${bytes.length}-${bytes.length + 10}` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), `bytes */${bytes.length}`);
  } finally {
    h.close();
  }
});

// 7. REFERENCE ADD/RELEASE maintains the count and records the zero point. Add
// raises the count and clears the zero cursor; release lowers it; the 1 -> 0
// release stamps zeroRefSeq (the cursor reclaim later checks against device
// acks). NO deletion happens — the blob is retained at zero.
test("reference add/release maintains the count and records the zero point", async () => {
  const h = await startServer();
  try {
    const account = "acct-refs";
    const bytes = garbageBlob(2048);
    const hash = await uploadInParts(h.base, account, bytes, 1024);

    // A freshly uploaded blob is at zero references with a zero point already
    // stamped (it is at zero from creation until something references it).
    const fresh = h.store.getBlob(account, hash);
    assert.ok(fresh);
    assert.equal(fresh.refCount, 0, "starts at zero references");
    assert.notEqual(fresh.zeroRefSeq, null, "a zero point is recorded at creation");

    // Add two references: count climbs, zero point cleared (no longer at zero).
    const add1 = await fetch(`${h.base}/blobs/${hash}/ref-add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    assert.equal(add1.status, 200);
    assert.equal(((await add1.json()) as { refCount: number }).refCount, 1);

    const add2 = await fetch(`${h.base}/blobs/${hash}/ref-add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    const add2Body = (await add2.json()) as { refCount: number; zeroRefSeq: number | null };
    assert.equal(add2Body.refCount, 2);
    assert.equal(add2Body.zeroRefSeq, null, "zero point cleared while references are held");

    // Release one: count drops to 1, still no zero point.
    const rel1 = await fetch(`${h.base}/blobs/${hash}/ref-release`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    const rel1Body = (await rel1.json()) as { refCount: number; zeroRefSeq: number | null };
    assert.equal(rel1Body.refCount, 1);
    assert.equal(rel1Body.zeroRefSeq, null, "still referenced, so no zero point");

    // Release the last one: count hits zero and a fresh zero point is stamped.
    const rel2 = await fetch(`${h.base}/blobs/${hash}/ref-release`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    const rel2Body = (await rel2.json()) as { refCount: number; zeroRefSeq: number | null };
    assert.equal(rel2Body.refCount, 0, "back to zero references");
    assert.notEqual(rel2Body.zeroRefSeq, null, "the 1 -> 0 release records the zero point");

    // NO deletion: the blob is retained at zero references (default policy).
    assert.equal(await headExists(h.base, account, hash), 200, "blob retained at zero references");

    // An extra release at zero is a harmless no-op (clamped, never negative).
    const rel3 = await fetch(`${h.base}/blobs/${hash}/ref-release`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    assert.equal(((await rel3.json()) as { refCount: number }).refCount, 0, "release clamps at zero");
  } finally {
    h.close();
  }
});

// 7b. Reference reporting requires the blob to exist (blobs-before-reference):
// adding a reference to an unknown blob is a 404, never an implicit create.
test("referencing an unknown blob is rejected", async () => {
  const h = await startServer();
  try {
    const account = "acct-noblob";
    const hash = blobHash(garbageBlob(10));
    const res = await fetch(`${h.base}/blobs/${hash}/ref-add`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ accountId: account }),
    });
    assert.equal(res.status, 404, "cannot reference a blob the server does not have");
  } finally {
    h.close();
  }
});

// 8. ACCOUNT ISOLATION: a blob uploaded under one account is not visible to
// another (existence and download are account scoped, like sync and intents).
test("blobs are isolated between accounts", async () => {
  const h = await startServer();
  try {
    const bytes = garbageBlob(3000);
    const hash = await uploadInParts(h.base, "acct-a", bytes, 1500);

    assert.equal(await headExists(h.base, "acct-a", hash), 200, "owner sees its blob");
    assert.equal(await headExists(h.base, "acct-b", hash), 404, "another account does not");

    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", "acct-b");
    const dl = await fetch(url, { headers: authHeaders() });
    assert.equal(dl.status, 404, "another account cannot download it");
  } finally {
    h.close();
  }
});

// 8b. CROSS-ACCOUNT CLAIM ORACLE IS CLOSED: dedup is keyed per-account, so a
// caller who merely knows a hash another account uploaded cannot obtain a
// metadata row (and thus download rights) without actually possessing the bytes.
// The initiate short-circuit and the finalize short-circuit both key on this
// account's metadata, not on global byte existence.
test("a second account cannot claim a blob by hash without possessing the bytes", async () => {
  const h = await startServer();
  try {
    const bytes = garbageBlob(3000);
    const hash = await uploadInParts(h.base, "acct-a", bytes, 1500);

    // acct-b knows the hash but does not have the bytes. Initiate must NOT report
    // exists:true (that would let it skip upload and claim the blob); it opens a
    // real upload session instead.
    const init = await initiate(h.base, "acct-b", hash, bytes.length);
    assert.equal(init.status, 201, "a non-owner gets a fresh session, not a dedup hit");
    assert.notEqual(init.body.exists, true, "initiate does not leak another account's blob");
    assert.equal(await headExists(h.base, "acct-b", hash), 404, "still no metadata row for acct-b");

    // Finalizing WITHOUT uploading the bytes cannot succeed: the reassembled
    // (empty) bytes do not hash to the declared address, so it is rejected rather
    // than deduped against acct-a's on-disk bytes.
    const fin = await finalize(h.base, "acct-b", init.body.uploadId as string);
    assert.equal(fin.status, 400, "no possession, no claim");
    assert.equal(await headExists(h.base, "acct-b", hash), 404, "acct-b never gained access");

    // The legitimate same-account dedup still works: acct-a re-initiating the
    // hash it truly owns is the idempotent no-op.
    const again = await initiate(h.base, "acct-a", hash, bytes.length);
    assert.equal(again.body.exists, true, "the owner still gets the dedup fast path");
  } finally {
    h.close();
  }
});

// 9. AUTH: the blob endpoints sit behind device-token auth, like every other
// protected route. A request without the token is rejected before any work.
test("blob endpoints require the device token", async () => {
  const h = await startServer();
  try {
    const hash = blobHash(garbageBlob(10));
    const url = new URL(`${h.base}/blobs/${hash}`);
    url.searchParams.set("accountId", "acct-auth");
    const res = await fetch(url, { method: "HEAD" });
    assert.equal(res.status, 401, "no token, no access");
  } finally {
    h.close();
  }
});
