# GLANCEvault + MCP host, one container

A reference deployment for issue #2280: the read-only GLANCEvault-client MCP host
running in the same container and process as the GLANCEvault server itself. Built on
the shared packages only — no copied merge logic: `@glance-apps/mcp-host` (listener and
safety kit), `@glance-apps/dayglance-mcp` (tools, read model, state),
`@glance-apps/dayglance-vault` (rows, merge rules, /events client), `@glance-apps/sync`
2.4+ (engine with injectable storage).

What you get on a headless box, with no desktop session, Xvfb or display server:

- port 8080 — the GLANCEvault sync server (unchanged), what devices sync against;
- port 7893 — `/mcp`, the read-only dayGLANCE MCP surface (six read tools + resources,
  the same names and schemas as the desktop server, per one reference).

The host is just another device: it pulls, decrypts locally with a passphrase you hand
it, applies the same merge and tombstone rules, and answers reads from that state.
Writes are not exposed yet — the consent tiers, journal and rate limit land with the
write side per the issue.

## Run

```bash
cp examples/mcp-vault-host/.env.example .env   # fill the four required values
docker compose -f examples/mcp-vault-host/docker-compose.yml up --build -d
curl http://127.0.0.1:8080/healthz             # server ok
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7893/mcp   # 401 without the token = correct
```

Point MCP clients at `http://<host>:7893/mcp` with
`Authorization: Bearer <MCP_BEARER_TOKEN>` (streamable HTTP; no stdio bridge needed).

## The four required values

| Name | What it is | Where it comes from |
|---|---|---|
| `GLANCEVAULT_DEVICE_TOKEN` | the vault's device token | the one your devices already use (it is this server's own config) |
| `MCP_PASSPHRASE` | the sync passphrase | what the user typed when setting up GLANCEvault sync; held in memory only, re-derived per boot, never persisted |
| `MCP_BEARER_TOKEN` | the MCP gate | generate here: `openssl rand -hex 32`; clients present it on every bind |
| `MCP_ACCOUNT_ID` | the vault account namespace | must match what the devices sync under. It is not shown in the app UI yet; read it from the vault DB: `sqlite3 -readonly /path/data/glancevault.db 'select * from accounts;'` |

Per-device settings (they do not sync; see `.env.example`): IANA timezone, week start,
and, in multi-user accounts, which user this host answers for. A server that runs on UTC
without the timezone set reads the user's Wednesday evening as Thursday — this is the
most quietly wrong thing a host can get wrong.

## Reachability: one switch

`BIND_ADDR` decides where both ports are published (`127.0.0.1` by default) and the
host adds that same value to the MCP Host allowlist automatically. Reverse-proxying by
hostname or setting `BIND_ADDR=0.0.0.0` are the only cases that also need an explicit
`MCP_ALLOWED_HOSTS`. `MCP_ALLOWED_ORIGINS` concerns browser-based MCP clients only;
CLI clients send no Origin.

## Known sharp edges (as of the current package versions)

- `dayglance-mcp@0.1.0` peers `mcp-host ^0.1.0` while latest is 0.2.0 — the Dockerfile
  installs with `--legacy-peer-deps` until the releases align.
- `dayglance-mcp` peers zod ^4; a v3 install fails at runtime with a message that does
  not name zod.
- The sync `storage` contract must stay synchronous and durable on return (cursors and
  dirty set are written before the request that depends on them); this example backs it
  with a small 0600 file store under `/data/mcp-host`.
- One account per process: the derived root key is module state in `@glance-apps/sync`.
- Bind-mounting the data directory instead of the named volume requires the host
  directory to be writable by uid 1000 (the runtime image's user), or the server dies
  at boot with a permission error.

## Keeping data fresh

The /`events` stream nudges a coalesced pull (debounced), and a slow fallback pull
(default 5 minutes) covers a stream whose connection died silently. A 401 stops both
loops rather than retrying forever; reads keep answering from the last good state.
