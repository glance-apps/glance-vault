// A combined entry point: the GLANCEvault server (this repo's dist/) and a
// read-only GLANCEvault MCP host for dayGLANCE (#2280), one process, two ports.
//
// The host wiring follows the README outline in @glance-apps/dayglance-mcp and the
// plumbing proven in packages/dayglance-vault/test/hostPull.e2e.test.js: a file-
// backed sync engine, the shared merge rules after every pull, the /events change
// nudge with coalescing, and a slow fallback pull for a stream whose connection
// died silently. Reads only: nothing here pushes user edits — the only pushes are
// the housekeeping rows reconcile/prune mark dirty.
//
// Configuration comes from the environment (see .env.example / docker-compose.yml).

import { loadConfig } from "./dist/config.js";
import { SqliteStore } from "./dist/storage/sqlite.js";
import { DiskBlobStore } from "./dist/storage/disk-blobstore.js";
import { buildApp } from "./dist/server.js";
import { reclaimSweep } from "./dist/reclaim.js";
import { reapUploadSessions } from "./dist/upload-reaper.js";
import { SERVER_VERSION, SCHEMA_VERSION } from "./dist/version.js";
import { TARGET_SCHEMA_VERSION } from "./dist/storage/migrations.js";

import { McpServer } from "@modelcontextprotocol/server";
import { startMcpListener, LOCALHOST_NAMES } from "@glance-apps/mcp-host";
import { buildMcpReadState, handleMcpRequest, registerReadTools, registerResources } from "@glance-apps/dayglance-mcp";
import { createDbSyncEngine, createVaultClient, setSyncPassphrase } from "@glance-apps/sync";
import {
  vaultEngineCallbacks,
  reconcileCrossList,
  pruneAllTombstones,
  tombstoneCutoff,
  openWebSseStream,
  createVaultEventClient,
  createNudgeCoalescer,
  createKindFilter,
  withOwnAckRecording,
  isOwnWriteSeq,
} from "@glance-apps/dayglance-vault";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync, chmodSync } from "node:fs";

// ── 1. The GLANCEvault server itself (same boot sequence as src/index.ts) ──────
function startVaultServer() {
  const config = loadConfig();
  if (SCHEMA_VERSION !== TARGET_SCHEMA_VERSION) {
    throw new Error(`SCHEMA_VERSION (${SCHEMA_VERSION}) != migration set (${TARGET_SCHEMA_VERSION})`);
  }
  const store = new SqliteStore(config.storagePath);
  store.migrate();
  const blobStore = new DiskBlobStore(config.blobStorePath);
  const app = buildApp(config, store, blobStore);
  const server = app.listen(config.port, () => {
    console.log(`GLANCEvault ${SERVER_VERSION} on port ${config.port} (auth ${config.authMode}, schema v${store.schemaVersion()})`);
  });
  if (config.blobReclaim) {
    const policy = { reclaim: true, gracePeriodMs: config.blobGracePeriodMs, deadDevicePeriodMs: config.blobDeadDevicePeriodMs };
    const t = setInterval(() => { try { reclaimSweep(store, blobStore, policy); } catch (e) { console.error("reclaim:", e); } }, config.blobReclaimIntervalMs);
    t.unref();
  }
  const ut = setInterval(() => { try { reapUploadSessions(store, blobStore, config.uploadSessionTtlMs); } catch (e) { console.error("upload-reaper:", e); } }, config.uploadSessionSweepIntervalMs);
  ut.unref();
  return { config, close: () => { clearInterval(ut); server.close(); store.close(); } };
}

// ── 2. The MCP host: one more device that pulls, reads, and answers ────────────
async function startHost(vaultConfig) {
  const port = Number(process.env.MCP_HOST_PORT || 7893);
  const dataDir = process.env.MCP_HOST_DATA_DIR || "/data/mcp-host";
  const passphrase = process.env.MCP_PASSPHRASE;
  const token = process.env.MCP_BEARER_TOKEN;
  const accountId = process.env.MCP_ACCOUNT_ID;
  const timeZone = process.env.MCP_USER_TIMEZONE || "UTC";
  const weekStartDay = Number(process.env.MCP_WEEK_START || 1);
  const userSyncId = process.env.MCP_USER_ID || "";
  const bind = process.env.MCP_BIND || "0.0.0.0";
  const vaultUrl = process.env.MCP_VAULT_URL || `http://127.0.0.1:${vaultConfig.port}`;
  const vaultToken = vaultConfig.deviceToken;

  if (!passphrase) throw new Error("MCP_PASSPHRASE is required (your dayGLANCE sync passphrase)");
  if (!token) throw new Error("MCP_BEARER_TOKEN is required (AI clients authenticate with it)");
  if (!accountId) throw new Error("MCP_ACCOUNT_ID is required (must match the account the devices sync under)");
  mkdirSync(dataDir, { recursive: true });

  // File-backed sync bookkeeping (cursors, dirty set, device id). Must stay
  // synchronous and durable on return, exactly like the engine expects of
  // localStorage.
  const storage = {
    getItem: (k) => { try { return readFileSync(join(dataDir, k), "utf8"); } catch { return null; } },
    setItem: (k, v) => { writeFileSync(join(dataDir, k), String(v)); try { chmodSync(join(dataDir, k), 0o600); } catch {} },
    removeItem: (k) => { try { unlinkSync(join(dataDir, k)); } catch {} },
  };

  // The host's copy of the synced slices. The root key is re-derived from the
  // passphrase + vault salt at boot and never persisted: nothing writable by an
  // attacker lands on disk.
  const data = {};
  setSyncPassphrase(passphrase);

  const engine = createDbSyncEngine({
    storageKeyPrefix: "mcp-host",
    appId: "dayglance",
    accountId,
    vaultUrl,
    vaultToken,
    deviceId: "mcp-host",
    cryptoDBName: "unused-with-hooks",
    storage,
    // Consuming nudges means recording our own writes' acks, as the app does.
    vaultClient: withOwnAckRecording(createVaultClient({ vaultUrl, vaultToken })),
    nativeGetSyncKey: async () => null,
    nativeStoreSyncKey: () => {},
    ...vaultEngineCallbacks(() => data, (id) => engine.markDirty(id)),
  });

  // One cycle at a time; a nudge arriving mid-cycle queues exactly one more.
  let inflight = null; let again = false; let authHalted = false;
  const runCycle = () => {
    if (authHalted) return Promise.resolve();
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      do {
        again = false;
        const pull = await engine.pullRemoteChanges();
        reconcileCrossList(data, (id) => engine.markDirty(id));
        pruneAllTombstones(data, tombstoneCutoff());
        const push = await engine.pushDirtyRows();
        console.log(`mcp-host: cycle done (pulled ${pull?.received ?? "?"} rows, pushed ${push?.written ?? 0})`);
      } while (again);
    })().catch((err) => {
      const msg = String(err?.message ?? err);
      if (/401|invalid credential|unauthorized/i.test(msg)) {
        // A 401 means the credential or the account moved under us; retrying
        // forever would hammer the vault. Halt; reads keep answering from the
        // last good state.
        authHalted = true;
        console.error("mcp-host: vault rejected the credential (401). Stopping sync; check MCP_ACCOUNT_ID / device token.");
        client?.stop(); coalescer.cancel(); clearInterval(fallbackTimer);
      } else {
        console.error("mcp-host: cycle failed:", msg);
      }
    }).finally(() => { inflight = null; });
    return inflight;
  };

  const deps = {
    bridge: {
      // Never rejects: a failure answers with a typed error, not with "nothing".
      async request(method, params) {
        try {
          const state = buildMcpReadState(data, { now: Date.now(), timeZone, userSyncId, weekStartDay });
          return handleMcpRequest(state, { method, params });
        } catch (err) {
          return { ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
        }
      },
      async ping() { return true; },
      dispose() {},
    },
    now: () => Date.now(),
    timeZone: () => timeZone,
    includeNativeEvents: () => false, // a headless host has no device calendar
    multiUserEnabled: () => !!data.multiUserEnabled,
  };

  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // The published host (BIND_ADDR) is the address clients actually name in their
  // Host header; adding it here keeps compose's single BIND_ADDR switch from
  // requiring the same value a second time.
  const bindAddr = (process.env.BIND_ADDR || "").trim();
  if (bindAddr && !["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"].includes(bindAddr)) {
    allowedHosts.push(bindAddr.includes(":") ? `[${bindAddr}]` : bindAddr);
  }
  const listener = startMcpListener({
    name: "dayGLANCE",
    host: bind,
    portOverride: port,
    defaultPort: 7893,
    token: () => token,
    allowedHosts: allowedHosts.length ? [...LOCALHOST_NAMES, ...allowedHosts] : undefined,
    allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
    createServer: () => {
      // A fresh McpServer per request (kit README); registration is cheap.
      const s = new McpServer({ name: "dayGLANCE", version: "1.0.0" });
      registerReadTools(s, deps);
      registerResources(s, deps);
      return s;
    },
  });
  if (!listener) throw new Error("mcp-host: listener refused to start (see messages above)");
  console.log(`mcp-host: MCP endpoint on ${bind}:${port}/mcp (read-only)`);

  // Live nudges from the vault's /events stream, coalesced into cycles...
  const coalescer = createNudgeCoalescer({
    kinds: ["sync"],
    kindFilter: createKindFilter({ sync: "dayglance" }),
    isOwnSeq: isOwnWriteSeq,
    onDrain: () => { void runCycle(); },
  });
  const client = createVaultEventClient({
    getConnection: () => ({ vaultUrl, vaultToken, accountId }),
    openStream: openWebSseStream,
    onEvent: (evt) => { coalescer.handleEvent(evt); },
    onStateChange: (state, detail) => { if (state === "stopped") console.log("mcp-host: event stream stopped:", detail ?? ""); },
  });
  client.start?.();
  // ...plus a slow periodic pull, because the stream cannot detect a connection
  // that died silently. (The 401 branch above stops both.)
  const fallbackTimer = setInterval(() => { void runCycle(); }, Number(process.env.MCP_PULL_FALLBACK_MS || 300000));
  fallbackTimer.unref();

  await runCycle(); // first sync at startup, not a nudge
  return { listener, engine, stop: () => { client?.stop?.(); coalescer.cancel(); clearInterval(fallbackTimer); } };
}

// ── 3. Main ────────────────────────────────────────────────────────────────────
const vault = startVaultServer();
startHost(vault.config).catch((err) => { console.error("mcp-host failed:", err); process.exit(1); });
const shutdown = (sig) => { console.log(sig + ", shutting down."); vault.close(); process.exit(0); };
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
