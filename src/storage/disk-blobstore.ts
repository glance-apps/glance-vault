import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BlobStat, BlobStore } from "./blobstore.js";

// A blob hash is the lowercase hex SHA-256 of the ciphertext: exactly 64 hex
// characters. Validating the format before it ever touches the filesystem is
// also the path-traversal guard — a 64-char [0-9a-f] string can contain no "/",
// ".." or other separator, so it can only ever name a leaf under the shard
// dirs. The routes validate the same shape on the way in; this is the storage
// layer's own belt-and-suspenders check.
const HASH_RE = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_RE.test(hash)) {
    throw new Error(`invalid blob hash: ${hash}`);
  }
}

// Local-disk BlobStore. Final blobs are stored content-addressed and sharded by
// the first two bytes of the hash (aa/bb/<hash>) so no single directory holds a
// huge flat list of files. In-flight upload parts are staged under a separate
// ".uploads" subtree (the leading dot can never collide with a 2-hex shard dir)
// and reassembled into one whole blob on finalize.
//
// The bytes are opaque ciphertext; this class never interprets them. It is the
// disk analog of SqliteStore: the only concrete backend for now, swappable for
// object storage later behind the BlobStore interface with no route change.
export class DiskBlobStore implements BlobStore {
  private readonly root: string;
  private readonly uploadsRoot: string;

  constructor(root: string) {
    this.root = root;
    this.uploadsRoot = join(root, ".uploads");
  }

  // aa/bb/<hash>: shard by the first two bytes of the hex hash. ~65k shard dirs
  // at the top, ~65k under each, so even a large store never has an oversized
  // flat directory.
  private blobPath(hash: string): string {
    assertHash(hash);
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  private sessionDir(uploadId: string): string {
    // uploadId is a server-minted UUID; reject anything that could escape the
    // staging root just as defensively as the blob hash.
    if (!/^[0-9a-zA-Z_-]{1,128}$/.test(uploadId)) {
      throw new Error(`invalid upload id: ${uploadId}`);
    }
    return join(this.uploadsRoot, uploadId);
  }

  exists(hash: string): boolean {
    return existsSync(this.blobPath(hash));
  }

  stat(hash: string): BlobStat | null {
    const path = this.blobPath(hash);
    if (!existsSync(path)) {
      return null;
    }
    return { size: statSync(path).size };
  }

  // Read just [start, end] (inclusive) with a single positioned read, so a
  // ranged download never pulls the whole blob into memory. An empty range
  // (start > end, only possible for a zero-length blob) yields an empty buffer.
  readRange(hash: string, start: number, end: number): Buffer {
    const path = this.blobPath(hash);
    const length = end - start + 1;
    if (length <= 0) {
      return Buffer.alloc(0);
    }
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, start + read);
        if (n === 0) {
          break; // short file; return what we got (truncated to read bytes)
        }
        read += n;
      }
      return read === length ? buf : buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }

  // Idempotent atomic store. Write to a temp file in the shard dir, then rename
  // into place: rename is atomic on the same filesystem, so a concurrent reader
  // sees either no blob or the complete blob, never a partial one. If the blob
  // already exists (same hash, same bytes) this is a no-op.
  put(hash: string, bytes: Buffer): void {
    const path = this.blobPath(hash);
    if (existsSync(path)) {
      return;
    }
    const dir = join(this.root, hash.slice(0, 2), hash.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    // Suffix the temp name with the hash so two concurrent puts of different
    // blobs into the same shard dir never collide on the temp file.
    const tmp = join(dir, `.tmp-${hash}`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }

  writePart(uploadId: string, partIndex: number, bytes: Buffer): void {
    if (!Number.isInteger(partIndex) || partIndex < 0) {
      throw new Error(`invalid part index: ${partIndex}`);
    }
    const dir = this.sessionDir(uploadId);
    mkdirSync(dir, { recursive: true });
    // Write to a temp file then rename so a part is atomically present once
    // acked; a retried send simply overwrites it.
    const path = join(dir, String(partIndex));
    const tmp = join(dir, `.tmp-${partIndex}`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }

  assemble(uploadId: string, orderedPartIndexes: number[]): Buffer {
    const dir = this.sessionDir(uploadId);
    const chunks: Buffer[] = [];
    for (const idx of orderedPartIndexes) {
      chunks.push(readFileSync(join(dir, String(idx))));
    }
    return Buffer.concat(chunks);
  }

  discardSession(uploadId: string): void {
    rmSync(this.sessionDir(uploadId), { recursive: true, force: true });
  }
}
