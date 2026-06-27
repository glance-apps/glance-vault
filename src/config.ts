import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Phase 0 configuration. Loaded from an optional JSON file and overlaid with
// environment variables. There is no user model and no multi-tenant logic:
// just where to store data, what port to listen on, and the single shared
// device token that authenticates every request.
export interface Config {
  // Filesystem path to the SQLite database file. The parent directory is
  // expected to exist (the docker-compose example mounts a volume for it).
  storagePath: string;
  // TCP port the HTTP server listens on.
  port: number;
  // The single valid device auth token (a shared secret). Required.
  deviceToken: string;
  // Origins allowed for browser CORS requests. Empty means no cross-origin
  // requests are permitted. A single "*" entry allows any origin.
  allowedOrigins: string[];
  // Directory holding the content-addressed blob store (Phase 7). Defaults to a
  // "blobs" directory alongside the SQLite file. The bytes are opaque ciphertext
  // the server never decrypts. Optional in the type so test config literals may
  // omit it; loadConfig always resolves a concrete value.
  blobStorePath?: string;
  // Operator-configured maximum blob size in bytes (Phase 7). The server rejects
  // an over-limit blob — the real guarantee behind the client's pre-upload
  // check. Optional in the type so test config literals may omit it; loadConfig
  // always resolves a concrete value, and buildApp falls back to the default.
  maxBlobSize?: number;
}

interface FileConfig {
  storagePath?: string;
  port?: number;
  deviceToken?: string;
  allowedOrigins?: string[];
  blobStorePath?: string;
  maxBlobSize?: number;
}

const DEFAULT_STORAGE_PATH = "./data/glancevault.db";
const DEFAULT_PORT = 8080;
// 1 GiB. Generous for a self-hoster (video is first-class); an operator running
// a tighter tier lowers it. This is the boundary that lets whole-blob storage
// stay simple (no chunked content-addressing).
export const DEFAULT_MAX_BLOB_SIZE = 1024 * 1024 * 1024;

// Default blob directory: a "blobs" dir next to the SQLite file, so a single
// mounted data volume holds both. ":memory:" (tests) has no directory, so fall
// back to a relative ./data/blobs.
export function defaultBlobStorePath(storagePath: string): string {
  if (storagePath === ":memory:") {
    return "./data/blobs";
  }
  return join(dirname(storagePath), "blobs");
}

// Read an optional JSON config file. Env vars take precedence over file values,
// and both take precedence over the built-in defaults. The config file path
// itself is supplied via GLANCEVAULT_CONFIG (defaults to ./config.json if
// present, otherwise file loading is skipped).
function readFileConfig(): FileConfig {
  const path = process.env.GLANCEVAULT_CONFIG ?? "./config.json";
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as FileConfig;
  } catch (err) {
    // A missing default config file is fine: env vars alone are enough to run.
    // An explicitly requested file that cannot be read or parsed is fatal.
    if (process.env.GLANCEVAULT_CONFIG) {
      throw new Error(`Could not read config file at ${path}: ${String(err)}`);
    }
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = readFileConfig();

  const storagePath =
    env.GLANCEVAULT_STORAGE_PATH ?? file.storagePath ?? DEFAULT_STORAGE_PATH;

  const portRaw = env.GLANCEVAULT_PORT ?? (file.port != null ? String(file.port) : undefined);
  const port = portRaw != null ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const deviceToken = env.GLANCEVAULT_DEVICE_TOKEN ?? file.deviceToken;
  if (!deviceToken || deviceToken.trim() === "") {
    throw new Error(
      "No device token configured. Set GLANCEVAULT_DEVICE_TOKEN or deviceToken in the config file.",
    );
  }

  // Allowed CORS origins. The env var is a comma-separated list and takes
  // precedence over the config file's allowedOrigins array. Absent both, no
  // cross-origin requests are allowed.
  const originsEnv = env.GLANCEVAULT_ALLOWED_ORIGINS;
  let allowedOrigins: string[];
  if (originsEnv !== undefined) {
    allowedOrigins = splitOrigins(originsEnv);
  } else if (Array.isArray(file.allowedOrigins)) {
    allowedOrigins = file.allowedOrigins.map((o) => String(o).trim()).filter((o) => o !== "");
  } else {
    allowedOrigins = [];
  }

  // Blob store directory and the server-side max blob size. Env takes precedence
  // over the config file over the built-in defaults, the same precedence as
  // every other field.
  const blobStorePath =
    env.GLANCEVAULT_BLOB_STORE_PATH ?? file.blobStorePath ?? defaultBlobStorePath(storagePath);

  const maxBlobRaw =
    env.GLANCEVAULT_MAX_BLOB_SIZE ??
    (file.maxBlobSize != null ? String(file.maxBlobSize) : undefined);
  const maxBlobSize = maxBlobRaw != null ? Number(maxBlobRaw) : DEFAULT_MAX_BLOB_SIZE;
  if (!Number.isInteger(maxBlobSize) || maxBlobSize <= 0) {
    throw new Error(`Invalid maxBlobSize: ${maxBlobRaw}`);
  }

  return { storagePath, port, deviceToken, allowedOrigins, blobStorePath, maxBlobSize };
}

function splitOrigins(value: string): string[] {
  return value
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}
