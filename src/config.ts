import { readFileSync } from "node:fs";

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
}

interface FileConfig {
  storagePath?: string;
  port?: number;
  deviceToken?: string;
}

const DEFAULT_STORAGE_PATH = "./data/glancevault.db";
const DEFAULT_PORT = 8080;

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

  return { storagePath, port, deviceToken };
}
