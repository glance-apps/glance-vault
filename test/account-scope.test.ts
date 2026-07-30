import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStore } from "../src/storage/sqlite.js";
import { DiskBlobStore } from "../src/storage/disk-blobstore.js";
import { makeAccountScope } from "../src/scope.js";

// Phase 1.3a: the account-bound handle. These tests pin the two structural
// properties the refactor adds, at the layer where they now live:
//
//   1. The upload-parts operations are scoped AT THE STATEMENT LEVEL — a
//      cross-account uploadId affects zero rows in SQL, not merely "the route
//      checked first".
//   2. The blob byte-read gate is atomic — the ownership check and the byte
//      access are one call, so bytes present in the global content-addressed
//      store are unreachable through a scope that does not own the metadata.

interface Harness {
  store: SqliteStore;
  blobStore: DiskBlobStore;
  cleanup: () => void;
}

function harness(prefix: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = new SqliteStore(join(dir, "test.db"));
  store.migrate();
  const blobStore = new DiskBlobStore(join(dir, "blobs"));
  return {
    store,
    blobStore,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const HASH_A = "a".repeat(64);

test("upload-part operations are account-enforced at the statement level", () => {
  const h = harness("glancevault-scope-parts-");
  try {
    const alice = h.store.forAccount("alice");
    const mallory = h.store.forAccount("mallory");

    alice.createUploadSession("upload-1", HASH_A, 1000);
    alice.recordUploadPart("upload-1", 0, 100);
    assert.equal(alice.listUploadParts("upload-1").length, 1, "owner records a part");

    // Cross-account record: the INSERT's session join matches nothing, so the
    // statement affects zero rows — no route check involved, pure SQL.
    mallory.recordUploadPart("upload-1", 1, 999);
    assert.equal(
      alice.listUploadParts("upload-1").length,
      1,
      "a cross-account recordUploadPart wrote nothing",
    );

    // Cross-account list: the join makes another account's session look
    // exactly like an unknown uploadId.
    assert.deepEqual(mallory.listUploadParts("upload-1"), [], "cross-account list is empty");

    // Cross-account delete: the DELETE's account predicate matches nothing.
    mallory.deleteUploadSession("upload-1");
    assert.notEqual(
      alice.getUploadSession("upload-1"),
      null,
      "a cross-account deleteUploadSession removed nothing",
    );

    // The owner's delete still works, and parts cascade.
    alice.deleteUploadSession("upload-1");
    assert.equal(alice.getUploadSession("upload-1"), null);
    assert.deepEqual(alice.listUploadParts("upload-1"), []);
  } finally {
    h.cleanup();
  }
});

test("the byte-read gate: bytes in the global store are unreachable without the metadata row", () => {
  const h = harness("glancevault-scope-gate-");
  try {
    const bytes = randomBytes(256);
    const hash = createHash("sha256").update(bytes).digest("hex");

    const alice = makeAccountScope(h.store, h.blobStore, "alice");
    const mallory = makeAccountScope(h.store, h.blobStore, "mallory");

    // Alice stores the blob: bytes into the global namespace, metadata row
    // scoped to her account (the same pair finalize writes).
    alice.putBlobBytes(hash, bytes);
    alice.insertBlobIfAbsent(hash, bytes.length);

    // The bytes ARE on disk, globally addressed — that is the accepted design.
    assert.ok(h.blobStore.exists(hash), "bytes exist in the global store");

    // But through a scope that owns no metadata row, stat is null and a read
    // throws: the check and the access are one call and cannot be separated.
    assert.equal(mallory.statBlobBytes(hash), null, "cross-account stat is gated to null");
    assert.throws(
      () => mallory.readBlobRange(hash, 0, bytes.length - 1),
      /not owned by account mallory/,
      "cross-account read throws instead of serving ciphertext",
    );

    // The owner reads normally.
    const stat = alice.statBlobBytes(hash);
    assert.ok(stat);
    assert.equal(stat.size, bytes.length);
    assert.deepEqual(alice.readBlobRange(hash, 0, bytes.length - 1), bytes);

    // Fail-closed half of the gate: metadata row exists but bytes are gone.
    h.blobStore.delete(hash);
    assert.equal(alice.statBlobBytes(hash), null, "row without bytes stats null (fail closed)");
  } finally {
    h.cleanup();
  }
});

test("upload staging through the scope is ownership-checked", () => {
  const h = harness("glancevault-scope-staging-");
  try {
    const alice = makeAccountScope(h.store, h.blobStore, "alice");
    const mallory = makeAccountScope(h.store, h.blobStore, "mallory");

    alice.createUploadSession("upload-2", HASH_A, 1000);
    alice.stageUploadPart("upload-2", 0, Buffer.from("part-zero"));

    // Staging into someone else's session throws (the route's 404 makes this
    // unreachable; the throw catches a future handler bug loudly).
    assert.throws(
      () => mallory.stageUploadPart("upload-2", 1, Buffer.from("injected")),
      /not owned by account mallory/,
    );

    // Discarding someone else's session is a no-op: the session row and the
    // staged bytes both survive.
    mallory.discardUploadSession("upload-2");
    assert.notEqual(alice.getUploadSession("upload-2"), null, "session row survived");
    assert.deepEqual(
      alice.assembleUpload("upload-2"),
      Buffer.from("part-zero"),
      "staged bytes survived",
    );

    // Assembling someone else's session throws rather than leaking bytes.
    assert.throws(() => mallory.assembleUpload("upload-2"), /not owned by account mallory/);

    // The owner's discard removes both, idempotently.
    alice.discardUploadSession("upload-2");
    assert.equal(alice.getUploadSession("upload-2"), null);
    alice.discardUploadSession("upload-2"); // second call: harmless no-op
  } finally {
    h.cleanup();
  }
});

test("the handle is a stateless binder: two handles for one account see the same data", () => {
  const h = harness("glancevault-scope-stateless-");
  try {
    const first = h.store.forAccount("acct");
    const second = h.store.forAccount("acct");

    const result = first.batchUpsert("dayglance", [
      { entityId: "e1", envelope: Buffer.from("v1"), deleted: false },
    ]);
    assert.equal(result.maxSeq, 1);
    // No per-handle state: a second handle picks up exactly where the seq is.
    assert.equal(second.latestSeq(), 1);
    assert.equal(second.nextSeq(), 2);
    assert.equal(first.latestSeq(), 2);
    assert.equal(first.accountId, "acct");
  } finally {
    h.cleanup();
  }
});
