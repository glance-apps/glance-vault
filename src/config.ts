import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Phase 0 configuration. Loaded from an optional JSON file and overlaid with
// environment variables. There is no user model and no multi-tenant logic:
// just where to store data, what port to listen on, and the single shared
// device token that authenticates every request.
// How the server establishes which account a request acts on.
//   "shared"      — the shipped self-hosted model: one instance-wide device
//                   token, and the account scope is whatever the client asks
//                   for. Correct for a single trusted household/operator.
//   "per-account" — the account is derived server-side from an authenticated
//                   per-device credential. NOT IMPLEMENTED YET: selecting it
//                   today changes no request handling whatsoever, because the
//                   derivation and enforcement land in later phases. The flag
//                   exists now so those phases are additions behind a switch
//                   that already defaults to the shipped behavior.
export type AuthMode = "shared" | "per-account";

export interface Config {
  // Filesystem path to the SQLite database file. The parent directory is
  // expected to exist (the docker-compose example mounts a volume for it).
  storagePath: string;
  // Which auth model the server runs. DEFAULT "shared": byte-for-byte the
  // behavior self-hosters run today. Optional in the type so test config
  // literals may omit it; loadConfig always resolves a concrete value. The
  // only branch on it is registration-level (buildApp registers /enroll in
  // per-account mode); no request handler branches on it.
  authMode?: AuthMode;
  // The admin-configured bootstrap secret a device exchanges for its own
  // per-device credential at POST /enroll (Phase 1.2). REQUIRED in
  // per-account mode (fatal at startup when absent, like a missing
  // deviceToken); ignored in shared mode, where the endpoint is not
  // registered at all. Generate like the device token: openssl rand -hex 32.
  enrollmentSecret?: string;
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
  // Whether to log one concise line per request (method, path, status, duration).
  // DEFAULT ON: it is the operator's first tool for diagnosing "the client does
  // nothing" reports. Optional in the type so test config literals may omit it
  // (and thereby keep logging off in tests); loadConfig always resolves a
  // concrete value.
  requestLog?: boolean;
  // Express "trust proxy" setting. The server sits behind a TLS-terminating
  // reverse proxy, so req.ip (used by rate limiting) is only correct once Express
  // is told which hops to trust. DEFAULT "loopback": trust a proxy on localhost,
  // matching the compose setup that binds 127.0.0.1. Accepts a preset string
  // ("loopback"), a boolean, or a hop count. Optional in the type; loadConfig
  // resolves a concrete value.
  trustProxy?: string | number | boolean;
  // Per-IP rate limiting. DEFAULT ON. A coarse abuse backstop on top of the
  // reverse proxy. Optional in the type so test config literals may omit it
  // (limiter off in tests unless a test opts in); loadConfig resolves a value.
  rateLimit?: boolean;
  // Rate-limit window in ms and the max requests per IP per window. Defaults:
  // 60s window, 600 requests (10 rps sustained per client IP) — generous for a
  // household behind one NAT, restrictive enough to blunt a flood.
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  // Process-wide ceiling on total concurrent SSE connections across all accounts
  // (the global backstop the per-account cap does not provide). Default 1024.
  maxSseConnections?: number;
  // Per-account quotas (Phase 3.2). ALL UNSET BY DEFAULT: when no quota is
  // configured, no enforcement object is constructed at all and behavior is
  // byte-identical to a pre-quota server, in both auth modes — nobody
  // discovers a cap they did not set. When set, limits apply to EVERY account
  // (per-account overrides are a hosted/billing concern, out of scope).
  // Storage gates BLOB-ATTRIBUTABLE bytes (stored blobs + in-flight declared
  // reservations) at the blob path only; envelope bytes are measured by
  // /admin/usage but deliberately unenforced (Phase 3.2 design). In shared
  // mode quotas gate the CLAIMED account and are advisory — a client can
  // evade by renaming; real enforcement implies per-account mode (the server
  // warns at startup).
  quotaStorageBytes?: number;
  quotaRows?: number;
  quotaIntents?: number;
  quotaUploads?: number;
  // Per-account SSE connection cap. This one HAS a default — 64, the constant
  // the hub has always enforced — so configuring it merely tunes existing
  // behavior; leaving it unset changes nothing.
  maxSseConnectionsPerAccount?: number;
  // Stale resumable-upload reaper (Phase 7). An abandoned upload leaves a session
  // row plus staged part bytes on disk; without a reaper they accumulate. A
  // session older than the TTL is swept (staged bytes + row removed). ALWAYS ON
  // (unlike blob reclaim, this only ever removes transfer-layer scratch, never a
  // finalized blob). Defaults: 24h TTL, 60min sweep interval.
  uploadSessionTtlMs?: number;
  uploadSessionSweepIntervalMs?: number;
}

interface FileConfig {
  storagePath?: string;
  // Validated against AuthMode in loadConfig, so the file value is typed loosely
  // here (a hand-edited JSON file can hold anything).
  authMode?: string;
  enrollmentSecret?: string;
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
  quotaStorageMb?: number;
  quotaRows?: number;
  quotaIntents?: number;
  quotaUploads?: number;
  quotaSsePerAccount?: number;
  requestLog?: boolean;
  trustProxy?: string | number | boolean;
  rateLimit?: boolean;
  rateLimitWindowSeconds?: number;
  rateLimitMax?: number;
  maxSseConnections?: number;
  uploadSessionTtlHours?: number;
  uploadSessionSweepMinutes?: number;
}

const DEFAULT_STORAGE_PATH = "./data/glancevault.db";
const DEFAULT_PORT = 8080;
// The shipped self-hosted behavior. Every phase of the per-account work stays
// inert under this default.
export const DEFAULT_AUTH_MODE: AuthMode = "shared";
const AUTH_MODES: AuthMode[] = ["shared", "per-account"];
const DAY_MS = 24 * 60 * 60 * 1000;
// Reclaim defaults. RETAIN (off) is the safe default; the grace and dead-device
// windows match spec section 8.3.
export const DEFAULT_BLOB_GRACE_PERIOD_MS = 30 * DAY_MS;
export const DEFAULT_BLOB_DEAD_DEVICE_PERIOD_MS = 90 * DAY_MS;
export const DEFAULT_BLOB_RECLAIM_INTERVAL_MS = 60 * 60 * 1000;
// Rate-limit defaults: 60s window, 600 requests per IP per window.
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const DEFAULT_RATE_LIMIT_MAX = 600;
// Process-wide SSE connection ceiling across all accounts.
export const DEFAULT_MAX_SSE_CONNECTIONS = 1024;
// Stale-upload-session reaper defaults: 24h TTL, 60min sweep interval.
export const DEFAULT_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_UPLOAD_SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
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

  // Auth model. Env wins over the file over the default, like every other field.
  const authMode = normalizeAuthMode(env.GLANCEVAULT_AUTH_MODE ?? file.authMode);

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

  // Enrollment bootstrap secret (Phase 1.2). Empty/whitespace counts as unset
  // (the compose ${VAR:-} passthrough), like AUTH_MODE. Required in
  // per-account mode: a per-account server with no way to enroll is a
  // misconfiguration, and refusing to boot beats a silent server whose
  // /enroll mysteriously cannot work — the same loud-failure philosophy as
  // the strict AUTH_MODE parsing and the required device token.
  const enrollmentSecretRaw = env.GLANCEVAULT_ENROLLMENT_SECRET ?? file.enrollmentSecret;
  const enrollmentSecret =
    enrollmentSecretRaw !== undefined && enrollmentSecretRaw.trim() !== ""
      ? enrollmentSecretRaw
      : undefined;
  if (authMode === "per-account" && enrollmentSecret === undefined) {
    throw new Error(
      "GLANCEVAULT_AUTH_MODE=per-account requires an enrollment secret. " +
        "Set GLANCEVAULT_ENROLLMENT_SECRET (or enrollmentSecret in the config file); " +
        "generate one like the device token, e.g. openssl rand -hex 32.",
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

  // Request logging. DEFAULT ON. Any of off/false/0/no (case-insensitive) turns
  // it off; anything else leaves it on. Env wins over the file over the default.
  const requestLogEnv = env.GLANCEVAULT_REQUEST_LOG;
  let requestLog: boolean;
  if (requestLogEnv !== undefined) {
    requestLog = !["off", "false", "0", "no"].includes(requestLogEnv.trim().toLowerCase());
  } else if (typeof file.requestLog === "boolean") {
    requestLog = file.requestLog;
  } else {
    requestLog = true;
  }

  // Trust proxy. Env wins over file over the default ("loopback"). Numeric
  // strings become a hop count; "true"/"false" become booleans; any other string
  // (e.g. "loopback") is passed through to Express as-is.
  const trustProxyRaw = env.GLANCEVAULT_TRUST_PROXY ?? file.trustProxy;
  const trustProxy = normalizeTrustProxy(trustProxyRaw);

  // Per-IP rate limiting. DEFAULT ON; off only on an explicit off/false/0/no.
  const rateLimitEnv = env.GLANCEVAULT_RATE_LIMIT;
  let rateLimit: boolean;
  if (rateLimitEnv !== undefined) {
    rateLimit = !["off", "false", "0", "no"].includes(rateLimitEnv.trim().toLowerCase());
  } else if (typeof file.rateLimit === "boolean") {
    rateLimit = file.rateLimit;
  } else {
    rateLimit = true;
  }

  const rateLimitWindowMs = resolveDuration(
    env.GLANCEVAULT_RATE_LIMIT_WINDOW_SECONDS,
    file.rateLimitWindowSeconds,
    1000,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    "GLANCEVAULT_RATE_LIMIT_WINDOW_SECONDS",
  );
  const rateLimitMax = resolveCount(
    env.GLANCEVAULT_RATE_LIMIT_MAX,
    file.rateLimitMax,
    DEFAULT_RATE_LIMIT_MAX,
    "GLANCEVAULT_RATE_LIMIT_MAX",
  );
  const maxSseConnections = resolveCount(
    env.GLANCEVAULT_MAX_SSE_CONNECTIONS,
    file.maxSseConnections,
    DEFAULT_MAX_SSE_CONNECTIONS,
    "GLANCEVAULT_MAX_SSE_CONNECTIONS",
  );

  // Quotas (Phase 3.2). Absent = unlimited = no gate constructed. The
  // storage quota arrives in operator-friendly MiB and is normalized to bytes.
  const quotaStorageBytes = resolveOptionalCount(
    env.GLANCEVAULT_QUOTA_STORAGE_MB,
    file.quotaStorageMb,
    "GLANCEVAULT_QUOTA_STORAGE_MB",
    1024 * 1024,
  );
  const quotaRows = resolveOptionalCount(env.GLANCEVAULT_QUOTA_ROWS, file.quotaRows, "GLANCEVAULT_QUOTA_ROWS");
  const quotaIntents = resolveOptionalCount(
    env.GLANCEVAULT_QUOTA_INTENTS,
    file.quotaIntents,
    "GLANCEVAULT_QUOTA_INTENTS",
  );
  const quotaUploads = resolveOptionalCount(
    env.GLANCEVAULT_QUOTA_UPLOADS,
    file.quotaUploads,
    "GLANCEVAULT_QUOTA_UPLOADS",
  );
  const maxSseConnectionsPerAccount = resolveOptionalCount(
    env.GLANCEVAULT_QUOTA_SSE_PER_ACCOUNT,
    file.quotaSsePerAccount,
    "GLANCEVAULT_QUOTA_SSE_PER_ACCOUNT",
  );

  const uploadSessionTtlMs = resolveDuration(
    env.GLANCEVAULT_UPLOAD_SESSION_TTL_HOURS,
    file.uploadSessionTtlHours,
    60 * 60 * 1000,
    DEFAULT_UPLOAD_SESSION_TTL_MS,
    "GLANCEVAULT_UPLOAD_SESSION_TTL_HOURS",
  );
  const uploadSessionSweepIntervalMs = resolveDuration(
    env.GLANCEVAULT_UPLOAD_SESSION_SWEEP_MINUTES,
    file.uploadSessionSweepMinutes,
    60 * 1000,
    DEFAULT_UPLOAD_SESSION_SWEEP_INTERVAL_MS,
    "GLANCEVAULT_UPLOAD_SESSION_SWEEP_MINUTES",
  );

  return {
    storagePath,
    authMode,
    enrollmentSecret,
    port,
    deviceToken,
    allowedOrigins,
    blobStorePath,
    maxBlobSize,
    blobReclaim,
    blobGracePeriodMs,
    blobDeadDevicePeriodMs,
    blobReclaimIntervalMs,
    requestLog,
    trustProxy,
    rateLimit,
    rateLimitWindowMs,
    rateLimitMax,
    maxSseConnections,
    quotaStorageBytes,
    quotaRows,
    quotaIntents,
    quotaUploads,
    maxSseConnectionsPerAccount,
    uploadSessionTtlMs,
    uploadSessionSweepIntervalMs,
  };
}

// Resolve an OPTIONAL positive-integer setting: absent everywhere stays
// undefined (which for quotas means "no limit, no gate"). Same env-over-file
// precedence and positive-integer validation as resolveCount; unitMultiplier
// converts operator units (e.g. MiB) to internal units (bytes).
function resolveOptionalCount(
  envValue: string | undefined,
  fileValue: number | undefined,
  envName: string,
  unitMultiplier = 1,
): number | undefined {
  const raw = envValue !== undefined && envValue.trim() !== "" ? envValue : fileValue != null ? String(fileValue) : undefined;
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${envName}: ${raw}`);
  }
  return n * unitMultiplier;
}

// Resolve the auth mode. Unlike the on/off flags above (which coerce anything
// unrecognized to their safe default), an unrecognized value here is FATAL: this
// switch decides how requests are authenticated, and a typo silently falling
// back to "shared" is exactly the failure that must not happen once later phases
// make "per-account" mean something. Validated like port and maxBlobSize.
//
// Whitespace-only is treated as unset rather than invalid, so an env var
// deliberately passed through empty (the `${VAR:-}` pattern the compose file
// uses for optional settings) selects the default instead of refusing to boot.
// Matching is case-insensitive and trimmed; the value is otherwise exact.
function normalizeAuthMode(raw: string | undefined): AuthMode {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_AUTH_MODE;
  }
  const value = raw.trim().toLowerCase();
  const match = AUTH_MODES.find((mode) => mode === value);
  if (!match) {
    throw new Error(
      `Invalid GLANCEVAULT_AUTH_MODE: ${raw}. Expected one of: ${AUTH_MODES.join(", ")}.`,
    );
  }
  return match;
}

// Normalize a trust-proxy config value (env string or file value) into the shape
// Express's app.set("trust proxy", ...) accepts. Defaults to "loopback".
function normalizeTrustProxy(raw: string | number | boolean | undefined): string | number | boolean {
  if (raw === undefined) {
    return "loopback";
  }
  if (typeof raw === "boolean" || typeof raw === "number") {
    return raw;
  }
  const s = raw.trim();
  if (s.toLowerCase() === "true") return true;
  if (s.toLowerCase() === "false") return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

// Resolve a positive-integer count config (env string over file number over
// default). Rejects a non-integer or non-positive value.
function resolveCount(
  envValue: string | undefined,
  fileValue: number | undefined,
  defaultValue: number,
  envName: string,
): number {
  const raw = envValue ?? (fileValue != null ? String(fileValue) : undefined);
  if (raw === undefined) {
    return defaultValue;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${envName}: ${raw}`);
  }
  return n;
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
