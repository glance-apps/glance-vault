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
  // Blob reclaim (garbage collection) policy (Phase 7 final step). DEFAULT is
  // RETAIN: reclaim is OFF, and a blob at zero references is kept forever (zero
  // data-loss risk, correct for a self-hoster). Reclaim is a deliberate operator
  // opt-in. When false, NOTHING is ever deleted; the reference tracking just
  // sits there. Optional in the type so test config literals may omit it.
  blobReclaim?: boolean;
  // Grace window (ms) reclaim condition 2 needs: a blob is eligible only once
  // now - last_reference_activity_at >= this, giving a slow-but-alive device
  // time to surface a reference it added. Operator-configured; default 30 days.
  blobGracePeriodMs?: number;
  // Dead-device threshold (ms) reclaim condition 3 needs: a device whose last
  // activity is older than this is treated as DEAD and excluded from the
  // "all devices acked past the zero point" check (you cannot wait forever for a
  // vanished device). Operator-configured; default 90 days.
  blobDeadDevicePeriodMs?: number;
  // How often the periodic reclaim sweep runs (ms) when reclaim is ON. Reclaim
  // is heavier than the lazy intents prune, so it runs on a schedule rather than
  // on a request hot path. Default 1 hour.
  blobReclaimIntervalMs?: number;
}

interface FileConfig {
  storagePath?: string;
  port?: number;
  deviceToken?: string;
  allowedOrigins?: string[];
  blobStorePath?: string;
  maxBlobSize?: number;
  // Reclaim tunables are expressed in operator-friendly units in the file/env
  // (on/off, days, minutes) and normalized to ms in loadConfig.
  blobReclaim?: boolean;
  blobGracePeriodDays?: number;
  blobDeadDevicePeriodDays?: number;
  blobReclaimIntervalMinutes?: number;
}

const DEFAULT_STORAGE_PATH = "./data/glancevault.db";
const DEFAULT_PORT = 8080;
const DAY_MS = 24 * 60 * 60 * 1000;
// Reclaim defaults. RETAIN (off) is the safe default; the grace and dead-device
// windows match spec section 8.3.
export const DEFAULT_BLOB_GRACE_PERIOD_MS = 30 * DAY_MS;
export const DEFAULT_BLOB_DEAD_DEVICE_PERIOD_MS = 90 * DAY_MS;
export const DEFAULT_BLOB_RECLAIM_INTERVAL_MS = 60 * 60 * 1000;
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

  // Blob reclaim policy. DEFAULT IS RETAIN (off). Reclaim turns on only when the
  // operator explicitly opts in; an unrecognized value is treated as off.
  const reclaimEnv = env.GLANCEVAULT_BLOB_RECLAIM;
  let blobReclaim: boolean;
  if (reclaimEnv !== undefined) {
    blobReclaim = ["on", "true", "1", "yes"].includes(reclaimEnv.trim().toLowerCase());
  } else if (typeof file.blobReclaim === "boolean") {
    blobReclaim = file.blobReclaim;
  } else {
    blobReclaim = false;
  }

  const blobGracePeriodMs = resolveDuration(
    env.GLANCEVAULT_BLOB_GRACE_PERIOD_DAYS,
    file.blobGracePeriodDays,
    DAY_MS,
    DEFAULT_BLOB_GRACE_PERIOD_MS,
    "GLANCEVAULT_BLOB_GRACE_PERIOD_DAYS",
  );
  const blobDeadDevicePeriodMs = resolveDuration(
    env.GLANCEVAULT_BLOB_DEAD_DEVICE_DAYS,
    file.blobDeadDevicePeriodDays,
    DAY_MS,
    DEFAULT_BLOB_DEAD_DEVICE_PERIOD_MS,
    "GLANCEVAULT_BLOB_DEAD_DEVICE_DAYS",
  );
  const blobReclaimIntervalMs = resolveDuration(
    env.GLANCEVAULT_BLOB_RECLAIM_INTERVAL_MINUTES,
    file.blobReclaimIntervalMinutes,
    60 * 1000,
    DEFAULT_BLOB_RECLAIM_INTERVAL_MS,
    "GLANCEVAULT_BLOB_RECLAIM_INTERVAL_MINUTES",
  );

  return {
    storagePath,
    port,
    deviceToken,
    allowedOrigins,
    blobStorePath,
    maxBlobSize,
    blobReclaim,
    blobGracePeriodMs,
    blobDeadDevicePeriodMs,
    blobReclaimIntervalMs,
  };
}

// Resolve a duration config expressed in operator-friendly units (days,
// minutes) to milliseconds. Env (a string) takes precedence over the file value
// over the built-in default. The value must be a positive number.
function resolveDuration(
  envValue: string | undefined,
  fileValue: number | undefined,
  unitMs: number,
  defaultMs: number,
  envName: string,
): number {
  const raw = envValue ?? (fileValue != null ? String(fileValue) : undefined);
  if (raw === undefined) {
    return defaultMs;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${envName}: ${raw}`);
  }
  return Math.round(n * unitMs);
}

function splitOrigins(value: string): string[] {
  return value
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "");
}
