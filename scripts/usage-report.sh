#!/usr/bin/env bash
# usage-report.sh: a readable usage report for a GLANCEvault server running
# with docker compose in per-account mode.
#
# Run it on the server, from the folder that holds docker-compose.yml:
#   ./usage-report.sh            # report
#   ./usage-report.sh --json     # same data as JSON, for scripts
#
# It needs nothing on the host but docker. The report runs inside the
# container, reads the admin secret from the container's own environment
# (GLANCEVAULT_ENROLLMENT_SECRET), and calls the admin API on localhost. "Last
# active" comes from a read-only look at the SQLite file, because the admin API
# does not expose it; if that read fails, the report still prints, with "?".
#
# Environment overrides:
#   GLANCEVAULT_SERVICE   compose service name (default: glancevault)
set -euo pipefail

SERVICE="${GLANCEVAULT_SERVICE:-glancevault}"
FORMAT="text"
case "${1:-}" in
  "") ;;
  --json) FORMAT="json" ;;
  -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

if [ ! -f docker-compose.yml ] && [ ! -f compose.yml ] && [ ! -f docker-compose.yaml ] && [ ! -f compose.yaml ]; then
  echo "No compose file here. Run this from the folder that holds docker-compose.yml." >&2
  exit 1
fi

# The report program. Node reads it from stdin (CommonJS), runs in /app inside
# the image, so better-sqlite3 resolves from the server's own node_modules.
read -r -d '' REPORT_JS <<'NODE' || true
const FORMAT = process.env.REPORT_FORMAT || "text";
const port = process.env.GLANCEVAULT_PORT || "8080";
const secret = process.env.GLANCEVAULT_ENROLLMENT_SECRET || "";
const dbPath = process.env.GLANCEVAULT_STORAGE_PATH || "/data/glancevault.db";
const base = `http://127.0.0.1:${port}`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function get(path, auth = true) {
  const res = await fetch(base + path, auth ? { headers: { Authorization: `Bearer ${secret}` } } : {});
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function ago(iso) {
  if (iso === undefined) return "?";
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function latest(...isos) {
  const xs = isos.filter(Boolean);
  if (xs.length === 0) return isos.some((x) => x === undefined) ? undefined : null;
  return xs.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

function table(headers, rows, rightAlign = new Set()) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (cells) => cells
    .map((c, i) => (rightAlign.has(i) ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i])))
    .join("  ").trimEnd();
  return [fmt(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)].join("\n");
}

// Last-active times live only in the database. Read-only, and optional.
function readActivity() {
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const devices = db.prepare("SELECT account_id, device_id, last_active FROM devices").all();
      const writes = db.prepare("SELECT account_id, MAX(server_mtime) AS last_write FROM sync_rows GROUP BY account_id").all();
      return {
        devices: new Map(devices.map((d) => [`${d.account_id}\u0000${d.device_id}`, d.last_active])),
        writes: new Map(writes.map((w) => [w.account_id, w.last_write])),
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

(async () => {
  if (!secret) fail("GLANCEVAULT_ENROLLMENT_SECRET is not set in the container, so the admin API cannot be used.");

  const health = await get("/healthz", false);
  if (health.status !== 200) fail(`Server not healthy: /healthz returned ${health.status}`);
  if (health.body.authMode !== "per-account") {
    fail(`This server runs in "${health.body.authMode}" mode. Usage reports need GLANCEVAULT_AUTH_MODE=per-account.`);
  }

  const [accountsRes, credsRes, usageRes] = await Promise.all([
    get("/admin/accounts"),
    get("/admin/credentials"),
    get("/admin/usage"),
  ]);
  for (const [name, r] of [["credentials", credsRes], ["usage", usageRes]]) {
    if (r.status !== 200) fail(`/admin/${name} returned ${r.status}: ${JSON.stringify(r.body)}`);
  }
  // /admin/accounts exists only in account-key enrollment mode.
  const registry = accountsRes.status === 200 ? accountsRes.body : null;

  const activity = readActivity();
  const usageById = new Map(usageRes.body.accounts.map((u) => [u.accountId, u]));
  const credentials = credsRes.body.credentials;

  // Every account that is registered, holds data, or has a credential.
  const ids = new Set([
    ...(registry ? registry.accounts.map((a) => a.accountId) : []),
    ...usageById.keys(),
    ...credentials.map((c) => c.accountId),
  ]);
  const regById = new Map((registry ? registry.accounts : []).map((a) => [a.accountId, a]));

  const accounts = [...ids].sort().map((accountId) => {
    const reg = regById.get(accountId);
    const u = usageById.get(accountId);
    const devices = credentials
      .filter((c) => c.accountId === accountId && c.revokedAt === null)
      .map((c) => ({
        deviceId: c.deviceId,
        enrolledAt: c.createdAt,
        lastActive: activity.error ? undefined : activity.devices.get(`${accountId}\u0000${c.deviceId}`) ?? null,
      }));
    const lastWrite = activity.error ? undefined : activity.writes.get(accountId) ?? null;
    return {
      accountId,
      label: reg ? reg.label : null,
      registered: !!reg,
      createdAt: reg ? reg.createdAt : null,
      keyRotatedAt: reg ? reg.keyRotatedAt : null,
      devices,
      revokedCredentials: credentials.filter((c) => c.accountId === accountId && c.revokedAt !== null).length,
      lastWrite,
      lastActive: latest(lastWrite, ...devices.map((d) => d.lastActive)),
      storage: u ? u.storedBytes : { envelopesByApp: {}, envelopes: 0, intents: 0, blobs: 0, total: 0 },
      counts: u ? u.counts : { rows: 0, liveRows: 0, tombstones: 0, blobs: 0 },
      liveConnections: u ? u.sse.connections : 0,
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    server: { version: health.body.version, schemaVersion: health.body.schemaVersion },
    maxAccounts: registry ? registry.maxAccounts : null,
    accounts,
    totals: usageRes.body.totals,
    activityError: activity.error ?? null,
  };

  if (FORMAT === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const out = [];
  const cap = report.maxAccounts ? ` of ${report.maxAccounts}` : "";
  out.push(`GLANCEvault usage report  ${report.generatedAt.replace("T", " ").slice(0, 16)} UTC`);
  out.push(`Server ${report.server.version}, ${accounts.length}${cap} accounts, ${bytes(report.totals.storedBytes)} stored, ${report.totals.sseConnections} live connections`);
  out.push("");

  if (accounts.length === 0) {
    out.push("No accounts yet.");
  } else {
    out.push(table(
      ["Account", "Label", "Devices", "Last active", "Items", "Media", "Storage", "Live"],
      accounts.map((a) => [
        a.accountId,
        a.label ?? (a.registered ? "-" : "(not registered)"),
        a.devices.length,
        ago(a.lastActive),
        a.counts.liveRows,
        a.counts.blobs,
        bytes(a.storage.total),
        a.liveConnections,
      ]),
      new Set([2, 4, 5, 6, 7]),
    ));

    for (const a of accounts) {
      out.push("");
      out.push(`${a.label ? `${a.label} (${a.accountId})` : a.accountId}`);
      if (a.createdAt) out.push(`  Created ${a.createdAt.slice(0, 10)}${a.keyRotatedAt ? `, key rotated ${a.keyRotatedAt.slice(0, 10)}` : ""}`);
      if (a.devices.length === 0) {
        out.push("  No devices enrolled yet");
      } else {
        for (const d of a.devices) {
          out.push(`  Device ${d.deviceId}: enrolled ${d.enrolledAt.slice(0, 10)}, last synced ${ago(d.lastActive)}`);
        }
      }
      if (a.revokedCredentials) out.push(`  ${a.revokedCredentials} revoked credential(s)`);
      const apps = Object.entries(a.storage.envelopesByApp).sort((x, y) => y[1] - x[1]);
      if (a.storage.total > 0) {
        const parts = apps.map(([app, n]) => `${app} ${bytes(n)}`);
        if (a.storage.blobs) parts.push(`media ${bytes(a.storage.blobs)}`);
        if (a.storage.intents) parts.push(`intents ${bytes(a.storage.intents)}`);
        out.push(`  Storage: ${parts.join(", ")}`);
        out.push(`  Items: ${a.counts.liveRows} live, ${a.counts.tombstones} deleted, last change ${ago(a.lastWrite)}`);
      } else {
        out.push("  No data synced yet");
      }
    }
  }

  if (report.activityError) {
    out.push("");
    out.push(`Note: could not read last-active times from the database (${report.activityError}).`);
  }
  console.log(out.join("\n"));
})().catch((err) => fail(String(err && err.stack ? err.stack : err)));
NODE

printf '%s\n' "$REPORT_JS" | docker compose exec -T -e REPORT_FORMAT="$FORMAT" "$SERVICE" node -
