// The blob store interface. Mirrors the DB's Store/SqliteStore split: request
// handlers depend only on this interface, never on a concrete backend. A
// local-disk implementation (DiskBlobStore) ships now; an object-storage
// implementation can be added later by satisfying this same contract, with no
// endpoint change. Identical posture to the SQLite/Postgres split on Store.
//
// The bytes are OPAQUE encrypted ciphertext. The blob store stores and returns
// them intact and never interprets, encrypts, decrypts, or hashes them. The
// content address (a hash of the ciphertext) is computed by the client and
// verified at the transport layer (the routes), not here: hashing is integrity
// logic, not storage. Storage is given a hash to key by and bytes to keep.

export interface BlobStat {
  size: number;
}

export interface BlobStore {
  // True if the whole blob addressed by hash is durably stored.
  exists(hash: string): boolean;

  // Size of the stored blob, or null if it is not stored.
  stat(hash: string): BlobStat | null;

  // Read an inclusive byte range [start, end] of the stored blob. The caller
  // guarantees 0 <= start <= end < size (the route validates the Range header
  // first). Returns just those bytes, without reading the whole object, so a
  // ranged video stream does not load a hundreds-of-MB blob into memory.
  readRange(hash: string, start: number, end: number): Buffer;

  // Idempotent whole-blob store. Writing a hash that is already present is a
  // harmless no-op (content-addressing: same hash means same bytes). The write
  // is atomic, so a concurrent reader never sees a half-written blob.
  put(hash: string, bytes: Buffer): void;

  // --- Resumable upload staging (transfer-layer; opaque, not yet addressed) ---
  // Staged parts are NOT content-addressed: they are the in-flight pieces of a
  // single whole blob, reassembled and verified on finalize. This is a transfer
  // concern only and does not change the whole-blob storage model.

  // Persist one part of an in-flight upload. Overwriting the same part index is
  // safe (a retried part send replaces it), which is what makes resume work.
  writePart(uploadId: string, partIndex: number, bytes: Buffer): void;

  // Reassemble the named part indexes, concatenated in the order supplied, into
  // one buffer (the candidate whole blob the route then hash-verifies).
  assemble(uploadId: string, orderedPartIndexes: number[]): Buffer;

  // Remove all staged parts for a session (on finalize success or on abort).
  discardSession(uploadId: string): void;
}
