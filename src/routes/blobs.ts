import { Router, json, raw, type Request, type Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../storage/types.js";
import type { BlobStore } from "../storage/blobstore.js";

// A blob hash is the lowercase hex SHA-256 of the ciphertext: 64 hex chars. The
// server recomputes this exact function over the reassembled bytes on finalize
// to verify the content address matches the bytes. Validating the shape on the
// way in also guards the disk path (no separators can appear in a 64-hex
// string). The bytes themselves stay opaque ciphertext; only the address is
// hashed, and only to verify integrity.
const HASH_RE = /^[0-9a-f]{64}$/;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Pull accountId from the query string, requiring a non-empty string. Same
// helper shape as the sync and intents routers.
function queryAccountId(req: Request): string | null {
  const value = req.query.accountId;
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value;
}

// Parse an HTTP Range header against a known total size. Supports a single byte
// range in the three standard forms: "bytes=start-end", "bytes=start-" (to
// EOF), and "bytes=-suffix" (last suffix bytes). Returns the resolved inclusive
// [start, end], or "unsatisfiable" for a syntactically valid but out-of-range
// request (→ 416), or null when the header is absent/malformed (→ treat as a
// full download). Multi-range requests are not supported; only the first range
// is honored, which is all a video player needs to stream and seek.
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) {
    return null;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) {
    return null;
  }
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === "" && endRaw === "") {
    return null;
  }

  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(endRaw);
    if (suffix <= 0) {
      return "unsatisfiable";
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }

  if (start > end || start >= size) {
    return "unsatisfiable";
  }
  if (end >= size) {
    end = size - 1;
  }
  return { start, end };
}

// Phase 7 content-addressed blob store transport. Mounted after the auth
// middleware in server.ts, so every route is behind device-token auth and
// account scoped, exactly like sync and intents. The server stores opaque
// encrypted bytes addressed by the client-supplied ciphertext hash; it never
// decrypts, inspects, or transforms them. This step builds existence check,
// resumable upload, range download, and reference TRACKING (add/release). It
// does NOT build reclaim/deletion: at zero references a blob is merely marked
// eligible (zeroRefSeq stamped), and the default policy is RETAIN.
//
// maxBlobSize is the operator-configured server-side cap. The client also
// checks before uploading, but this is the real guarantee.
export function blobsRouter(store: Store, blobStore: BlobStore, maxBlobSize: number): Router {
  const router = Router();

  // Raw body for upload parts: any content-type, capped at the max blob size
  // (a single part can never legitimately exceed the whole-blob cap). body-parser
  // answers an over-cap part with 413 on its own, a second server-side guard
  // beneath the explicit size accounting below.
  const rawPart = raw({ type: () => true, limit: maxBlobSize });

  // --- Resumable upload: initiate ---------------------------------------------
  // POST /blobs/uploads  body: { accountId, blobHash, size }
  // Begins an upload session for one whole blob sent in parts. Enforces the size
  // cap up front (reject over-limit before any bytes move). Idempotent on the
  // content address: if the server already has the blob, returns { exists: true }
  // so the client skips the upload entirely (dedup saves bandwidth; a retried
  // upload of a known hash is a no-op).
  router.post("/uploads", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = req.body as { accountId?: unknown; blobHash?: unknown; size?: unknown };
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (typeof body.blobHash !== "string" || !HASH_RE.test(body.blobHash)) {
      res.status(400).json({ error: "blobHash must be a 64-character hex sha256" });
      return;
    }
    if (typeof body.size !== "number" || !Number.isInteger(body.size) || body.size < 0) {
      res.status(400).json({ error: "size must be a non-negative integer" });
      return;
    }
    if (body.size > maxBlobSize) {
      res.status(413).json({ error: "blob exceeds maximum size", maxBlobSize });
      return;
    }

    // Already stored: idempotent no-op, the client uploads nothing. Ensure this
    // account has a metadata row for it (a re-uploader of an existing blob still
    // expects to reference it).
    if (blobStore.exists(body.blobHash)) {
      const stat = blobStore.stat(body.blobHash);
      store.insertBlobIfAbsent(body.accountId, body.blobHash, stat ? stat.size : body.size);
      res.status(200).json({ exists: true, blobHash: body.blobHash });
      return;
    }

    const uploadId = randomUUID();
    store.createUploadSession(body.accountId, uploadId, body.blobHash, body.size);
    res.status(201).json({ uploadId, blobHash: body.blobHash, received: [] });
  });

  // --- Resumable upload: status / resume point --------------------------------
  // GET /blobs/uploads/:uploadId?accountId=
  // Reports which parts the server has acked, so a client resumes from the last
  // acked part after an interruption.
  router.get("/uploads/:uploadId", (req: Request, res: Response) => {
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const session = store.getUploadSession(accountId, req.params.uploadId);
    if (session === null) {
      res.status(404).json({ error: "unknown upload session" });
      return;
    }
    const parts = store.listUploadParts(session.uploadId);
    const receivedBytes = parts.reduce((sum, p) => sum + p.size, 0);
    res.status(200).json({
      uploadId: session.uploadId,
      blobHash: session.blobHash,
      declaredSize: session.declaredSize,
      received: parts.map((p) => ({ index: p.partIndex, size: p.size })),
      receivedBytes,
    });
  });

  // --- Resumable upload: send a part ------------------------------------------
  // PUT /blobs/uploads/:uploadId/parts/:index?accountId=   body: raw bytes
  // Stores one part and acks it. Re-sending the same index is safe (it
  // overwrites), which is what makes resume idempotent. Enforces that the acked
  // parts never exceed the declared total (a second size guard beneath the
  // body-parser cap).
  router.put(
    "/uploads/:uploadId/parts/:index",
    rawPart,
    (req: Request, res: Response) => {
      const accountId = queryAccountId(req);
      if (accountId === null) {
        res.status(400).json({ error: "accountId is required" });
        return;
      }
      const session = store.getUploadSession(accountId, req.params.uploadId);
      if (session === null) {
        res.status(404).json({ error: "unknown upload session" });
        return;
      }
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        res.status(400).json({ error: "part index must be a non-negative integer" });
        return;
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      // Running total: replace this index's prior size (a re-send), add the new
      // part. Reject if the parts would exceed the declared total.
      const parts = store.listUploadParts(session.uploadId);
      const priorForIndex = parts.find((p) => p.partIndex === index)?.size ?? 0;
      const total = parts.reduce((sum, p) => sum + p.size, 0) - priorForIndex + bytes.length;
      if (total > session.declaredSize) {
        res.status(400).json({ error: "parts exceed declared blob size" });
        return;
      }

      blobStore.writePart(session.uploadId, index, bytes);
      store.recordUploadPart(session.uploadId, index, bytes.length);

      const acked = store.listUploadParts(session.uploadId);
      res.status(200).json({
        received: acked.map((p) => ({ index: p.partIndex, size: p.size })),
        receivedBytes: acked.reduce((sum, p) => sum + p.size, 0),
      });
    },
  );

  // --- Resumable upload: finalize ---------------------------------------------
  // POST /blobs/uploads/:uploadId/finalize  body: { accountId }
  // Reassembles the acked parts into the single whole blob, VERIFIES the
  // reassembled ciphertext hashes to the declared blobHash, and REJECTS on
  // mismatch (the address must match the bytes). On success stores the whole
  // blob and inserts the metadata row. Idempotent: a re-finalize of an already-
  // stored hash is a harmless no-op.
  router.post(
    "/uploads/:uploadId/finalize",
    json({ limit: "16kb" }),
    (req: Request, res: Response) => {
      const body = req.body as { accountId?: unknown };
      if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
        res.status(400).json({ error: "accountId is required" });
        return;
      }
      const accountId = body.accountId;
      const session = store.getUploadSession(accountId, req.params.uploadId);
      if (session === null) {
        res.status(404).json({ error: "unknown upload session" });
        return;
      }

      // Already stored (a prior finalize, or another upload of the same content):
      // no-op, do not duplicate, do not error. Clean up this session.
      if (blobStore.exists(session.blobHash)) {
        const stat = blobStore.stat(session.blobHash);
        const size = stat ? stat.size : session.declaredSize;
        store.insertBlobIfAbsent(accountId, session.blobHash, size);
        blobStore.discardSession(session.uploadId);
        store.deleteUploadSession(session.uploadId);
        res.status(200).json({ blobHash: session.blobHash, size, stored: true, deduped: true });
        return;
      }

      const parts = store.listUploadParts(session.uploadId);
      const orderedIndexes = parts.map((p) => p.partIndex);
      const assembled = blobStore.assemble(session.uploadId, orderedIndexes);

      if (assembled.length > maxBlobSize) {
        res.status(413).json({ error: "blob exceeds maximum size", maxBlobSize });
        return;
      }

      const computed = sha256Hex(assembled);
      if (computed !== session.blobHash) {
        // Integrity failure: the reassembled bytes do not hash to the declared
        // address. Reject and discard the bad staging; the client must restart
        // with a fresh session.
        blobStore.discardSession(session.uploadId);
        store.deleteUploadSession(session.uploadId);
        res.status(400).json({
          error: "hash mismatch: reassembled bytes do not match declared blobHash",
          declared: session.blobHash,
          computed,
        });
        return;
      }

      blobStore.put(session.blobHash, assembled);
      store.insertBlobIfAbsent(accountId, session.blobHash, assembled.length);
      blobStore.discardSession(session.uploadId);
      store.deleteUploadSession(session.uploadId);
      res.status(200).json({ blobHash: session.blobHash, size: assembled.length, stored: true });
    },
  );

  // --- Reference tracking: add ------------------------------------------------
  // POST /blobs/:hash/ref-add  body: { accountId }
  // Report that an entity now references this blob. Increments the count and
  // clears the zero point. NO deletion. Uses an explicit ref-add path (not
  // DELETE) so nothing here is ever mistaken for deleting a blob.
  router.post("/:hash/ref-add", json({ limit: "16kb" }), (req: Request, res: Response) => {
    if (!HASH_RE.test(req.params.hash)) {
      res.status(400).json({ error: "hash must be a 64-character hex sha256" });
      return;
    }
    const body = req.body as { accountId?: unknown };
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const rec = store.addBlobReference(body.accountId, req.params.hash);
    if (rec === null) {
      res.status(404).json({ error: "blob not found" });
      return;
    }
    res.status(200).json({
      blobHash: rec.blobHash,
      refCount: rec.refCount,
      zeroRefSeq: rec.zeroRefSeq,
      lastReferenceActivityAt: rec.lastReferenceActivityAt,
    });
  });

  // --- Reference tracking: release --------------------------------------------
  // POST /blobs/:hash/ref-release  body: { accountId }
  // Report that an entity no longer references this blob. Decrements the count
  // (clamped at zero); a true 1 -> 0 transition records the zero point
  // (zeroRefSeq) for later reclaim. NO deletion happens here: at zero the blob
  // is merely eligible, and the default policy is RETAIN.
  router.post("/:hash/ref-release", json({ limit: "16kb" }), (req: Request, res: Response) => {
    if (!HASH_RE.test(req.params.hash)) {
      res.status(400).json({ error: "hash must be a 64-character hex sha256" });
      return;
    }
    const body = req.body as { accountId?: unknown };
    if (typeof body.accountId !== "string" || body.accountId.trim() === "") {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const rec = store.releaseBlobReference(body.accountId, req.params.hash);
    if (rec === null) {
      res.status(404).json({ error: "blob not found" });
      return;
    }
    res.status(200).json({
      blobHash: rec.blobHash,
      refCount: rec.refCount,
      zeroRefSeq: rec.zeroRefSeq,
      lastReferenceActivityAt: rec.lastReferenceActivityAt,
    });
  });

  // --- Existence check --------------------------------------------------------
  // HEAD /blobs/:hash?accountId=
  // Cheap, no body. 200 if this account already has the blob (the client skips
  // uploading it; a retried upload becomes a no-op), 404 otherwise. The size is
  // reported in a header for the curious; the body is always empty.
  router.head("/:hash", (req: Request, res: Response) => {
    if (!HASH_RE.test(req.params.hash)) {
      res.status(400).end();
      return;
    }
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).end();
      return;
    }
    const rec = store.getBlob(accountId, req.params.hash);
    if (rec === null) {
      res.status(404).end();
      return;
    }
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Blob-Size", String(rec.size));
    res.status(200).end();
  });

  // --- Download with HTTP Range -----------------------------------------------
  // GET /blobs/:hash?accountId=
  // Returns the opaque encrypted bytes; the client decrypts. Supports a single
  // Range request (206 + Content-Range) so the platform can stream video and
  // resume partial downloads; a full request returns 200. The account must have
  // the blob (account scoped, like every other route).
  router.get("/:hash", (req: Request, res: Response) => {
    if (!HASH_RE.test(req.params.hash)) {
      res.status(400).json({ error: "hash must be a 64-character hex sha256" });
      return;
    }
    const accountId = queryAccountId(req);
    if (accountId === null) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    const rec = store.getBlob(accountId, req.params.hash);
    if (rec === null) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const stat = blobStore.stat(req.params.hash);
    if (stat === null) {
      // Metadata row exists but the bytes are gone. Reclaim is not built in this
      // phase, so this should not happen; fail closed rather than serve nothing.
      res.status(404).json({ error: "not found" });
      return;
    }
    const size = stat.size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "application/octet-stream");

    const range = parseRange(req.get("range"), size);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${size}`);
      res.status(416).end();
      return;
    }
    if (range === null) {
      res.status(200);
      res.setHeader("Content-Length", String(size));
      res.end(size === 0 ? Buffer.alloc(0) : blobStore.readRange(req.params.hash, 0, size - 1));
      return;
    }
    const { start, end } = range;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    res.end(blobStore.readRange(req.params.hash, start, end));
  });

  return router;
}
