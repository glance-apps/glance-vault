# glance-vault

Optional self-hosted backend for the GLANCE apps: zero-knowledge sync,
cross-device intents, and media storage.

[![Container image](https://img.shields.io/badge/ghcr.io-glance--apps%2Fglance--vault-2496ED?logo=docker&logoColor=white)](https://github.com/glance-apps/glance-vault/pkgs/container/glance-vault)

```
docker pull ghcr.io/glance-apps/glance-vault:latest
```

Images are published to the GitHub Container Registry on every push to `main`,
tagged with both `latest` and the short commit SHA.

Status: the sync transport, cross-device intents, the salt store, the
content-addressed media/blob store, and server-side real-time push (SSE) are
implemented. The server builds, runs, holds the schema, authenticates a device
token, serves those endpoints, and stores one key-derivation salt per account.
Client-side consumption of the push channel is a later step; clients still poll
today. See `docs/GLANCEvault-server-spec.md` for the full design and build plan.

## What Phase 0 includes

- The three-table sync-model schema (`sync_rows`, `intent_events`, `devices`)
  plus a per-account monotonic sequence source, created by migrations that run
  on boot.
- A thin storage interface with a SQLite implementation. Postgres can be added
  later behind the same interface without touching request handlers.
- Device-token auth middleware (a single shared secret, Bearer token).
- A public `GET /healthz` endpoint.
- A Dockerfile and a docker-compose example with a mounted volume for the
  SQLite file.

The server stores the `envelope` column as opaque bytes and never parses it.
There is no crypto, no key handling, and no user model in this server.

## Stack

Node and TypeScript with Express and better-sqlite3. This matches the existing
`@glance-apps/*` TypeScript client packages, so the whole stack stays one
language, and better-sqlite3 gives a synchronous single-writer model that makes
the per-account sequence counter naturally monotonic.

## Configuration

Config is read from an optional JSON file and overlaid with environment
variables. Environment variables win over the file, and both win over the
built-in defaults.

| Setting | Env var | Config file key | Default |
|---|---|---|---|
| SQLite file path | `GLANCEVAULT_STORAGE_PATH` | `storagePath` | `./data/glancevault.db` |
| Listen port | `GLANCEVAULT_PORT` | `port` | `8080` |
| Device auth token | `GLANCEVAULT_DEVICE_TOKEN` | `deviceToken` | none (required) |
| Allowed CORS origins | `GLANCEVAULT_ALLOWED_ORIGINS` | `allowedOrigins` | none (no cross-origin) |

`GLANCEVAULT_ALLOWED_ORIGINS` is a comma-separated list of origins; the
`allowedOrigins` config file field is an array. The environment variable wins
over the file. When neither is set, no cross-origin requests are allowed. A
single `*` entry allows any origin. Preflight OPTIONS requests are answered
before auth, so browser clients work without sending the device token on the
preflight.

The config file path defaults to `./config.json` and can be overridden with
`GLANCEVAULT_CONFIG`. See `config.example.json` and `.env.example`.

### The device token

This is the single shared secret every client presents. There is no
registration and no user model in this phase: one valid token is the whole auth
policy. Generate a long random value, for example:

```
openssl rand -hex 32
```

Set it as `GLANCEVAULT_DEVICE_TOKEN` (or `deviceToken` in the config file).
Clients send it as a Bearer token:

```
Authorization: Bearer <your-token>
```

Requests without a valid token are rejected with 401. `GET /healthz` is the
one exception and needs no token.

## Run with docker compose

All three GLANCE apps (dayGLANCE, lastGLANCE, lifeGLANCE) point at this one
server. The compose example reflects that: one endpoint, one token, with the
`app` column on the server namespacing each app's rows.

```
cp .env.example .env
# edit .env and set GLANCEVAULT_DEVICE_TOKEN to a long random secret
docker compose -f docker-compose.example.yml up --build
```

The SQLite file lives on a named volume, so it survives restarts. On a fresh,
empty volume the server runs migrations on boot and comes up working.

## Deploy in production

For a real deployment, use `docker-compose.yml`, which pulls the prebuilt image
from `ghcr.io/glance-apps/glance-vault:latest` instead of building from source.
It mounts a named volume for the SQLite file, sets `restart: unless-stopped`, and
includes a healthcheck against `/healthz`.

```
cp .env.example .env
# edit .env: set GLANCEVAULT_DEVICE_TOKEN, and GLANCEVAULT_ALLOWED_ORIGINS if
# browser clients will connect cross-origin
docker compose up -d
docker compose ps        # STATUS shows "healthy" once the healthcheck passes
curl http://localhost:8080/healthz
```

The server port is published on `127.0.0.1` only, so it is reached through a
TLS-terminating reverse proxy rather than exposed directly. To pick up a new
image after a push to `main`, run `docker compose pull && docker compose up -d`.

### Behind Caddy

Caddy gives you automatic HTTPS. A minimal `Caddyfile` stanza:

```
vault.example.com {
    reverse_proxy 127.0.0.1:8080 {
        # Required for the SSE push endpoint (GET /events): stream nudges to the
        # client immediately instead of buffering them. Without this the
        # real-time push degrades to the polling backstop.
        flush_interval -1
    }
}
```

Then point the GLANCE apps at `https://vault.example.com`. If those apps run in a
browser on a different origin, set `GLANCEVAULT_ALLOWED_ORIGINS` to their origins
(for example `https://app.example.com`) so CORS permits them. The device token is
sent in the `Authorization` header, so it rides over the proxy unchanged.

The `flush_interval -1` line is required for the real-time push endpoint to work
through the proxy. On nginx the equivalent is `proxy_buffering off` for the
`/events` location (the server also sends `X-Accel-Buffering: no`, which nginx
honors). Any reverse proxy in front of the server must disable response
buffering for `/events`, or SSE nudges get batched and clients silently fall
back to polling.

## Hit /healthz

```
curl http://localhost:8080/healthz
```

Expected response:

```json
{ "status": "ok", "version": "0.1.0", "schemaVersion": 3 }
```

## Sync transport endpoints

All sync endpoints sit under `/sync` and require the device token. The `:app`
path segment must be one of `dayglance`, `lastglance`, or `lifeglance`; anything
else is rejected with 400. The `envelope` field is opaque bytes: base64-encoded
on the wire and stored as a BLOB the server never parses.

| Method | Path | Purpose |
|---|---|---|
| POST | `/sync/:app/batch` | Upsert a batch of rows, each assigned a new seq |
| POST | `/sync/:app/device` | Report a device's sync cursor (forward only) |
| GET | `/sync/:app/list` | Incremental fetch of rows with `seq > since` |
| GET | `/sync/:app/:entityId` | Fetch a single row, or 404 |
| DELETE | `/sync/:app/:entityId` | Soft-delete a row (sets a tombstone, advances seq) |

The device cursor (`POST /sync/:app/device`, body `{ accountId, deviceId,
lastSeenSeq }`) records how far a device has synced, advancing `last_seen_seq`
forward only. It is account scoped, not per app, and feeds coordinated tombstone
GC in a later phase. Returns `{ updated: true }`. This is a bookkeeping write: it
does not advance the account `seq` and never fires a real-time push nudge.

The batch body accepts an optional `notify` boolean (default `true`). When a
client persists per-cycle bookkeeping state (device-state / high-water-mark) as a
sync row rather than as content, it should send `notify: false` so the write
still commits and advances `seq` but does **not** fire a push nudge. This is what
keeps SSE push from turning a routine housekeeping write into a self-nudge loop
(nudge → drain → housekeep → nudge). Real content writes omit the flag and nudge
instantly. See [Real-time push](#real-time-push-sse).

`seq` is a server-assigned monotonic cursor per account. Clients page forward by
passing the highest `seq` they have seen as `since`. `list` accepts `limit`
(default 500, max 1000) and returns `hasMore: true` when rows remain past the
returned page.

### Hit the batch endpoint with curl

```
TOKEN=your-device-token
ENVELOPE=$(head -c 32 /dev/urandom | base64)

# Upsert two rows for account "house-1" under dayGLANCE.
curl -s -X POST http://localhost:8080/sync/dayglance/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"accountId\":\"house-1\",\"rows\":[
        {\"entityId\":\"task-1\",\"envelope\":\"$ENVELOPE\"},
        {\"entityId\":\"task-2\",\"envelope\":\"$ENVELOPE\"}]}"
# -> {"written":2,"maxSeq":2}

# Pull everything since the start of time.
curl -s "http://localhost:8080/sync/dayglance/list?accountId=house-1&since=0" \
  -H "Authorization: Bearer $TOKEN"

# Soft-delete a row.
curl -s -X DELETE "http://localhost:8080/sync/dayglance/task-1?accountId=house-1" \
  -H "Authorization: Bearer $TOKEN"
# -> {"seq":3}
```

## Salt store

The key-derivation salt lives as server state so any new device can derive the
same root key from the passphrase. The salt is not secret: its only jobs are
uniqueness and defeating precomputation, so storing it (even on an untrusted
host) is safe because a salt without the passphrase is useless. The server keeps
the salt as an opaque base64 string, stores no passphrase or derived key, and
does no key derivation. Both endpoints require the device token.

| Method | Path | Purpose |
|---|---|---|
| GET | `/salt/:accountId` | Return the account's salt, or 404 if none is stored |
| PUT | `/salt/:accountId` | Store the salt if absent, then return the stored salt |

`PUT` is first-write-wins: if a salt already exists it is returned unchanged and
the supplied value is ignored, so two devices racing to register a salt both end
up with the same one. The response is `{ accountId, salt, createdAt, created }`,
where `created` is true only when this call stored a new salt.

```
TOKEN=your-device-token
SALT=$(head -c 16 /dev/urandom | base64)

# Register the salt for account "house-1" (first writer wins).
curl -s -X PUT http://localhost:8080/salt/house-1 \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"salt\":\"$SALT\"}"
# -> {"accountId":"house-1","salt":"...","createdAt":"...","created":true}

# Any device can fetch it.
curl -s http://localhost:8080/salt/house-1 -H "Authorization: Bearer $TOKEN"
```

## Real-time push (SSE)

`GET /events?accountId=...` is an authenticated, account-scoped [Server-Sent
Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
stream. It carries a **nudge only** — "your account is now at seq N, go sync" —
never any payload, plaintext, or row content. It uses the same device token and
the same `accountId` scoping as every other route, so a token for one account
only ever receives that account's nudges. Push is an optimization layered over
the existing sync/intents transport; **polling remains the delivery backstop**,
so if the connection drops nothing is lost — the client catches up on its next
poll (spec §14).

| Method | Path | Purpose |
|---|---|---|
| GET | `/events?accountId=...` | Subscribe to the account's push nudges (SSE) |

Events on the wire:

- `event: ready` — sent once on connect. `data: {"seq": N}` where `N` is the
  account's current latest seq. A just-connected client compares this to its
  cursor and drains immediately, without waiting for the next write.
- `event: activity` — sent on a **content** write: a sync batch upsert, a sync
  soft-delete, or a landed intent. `data: {"seq": N}` with the account's latest
  seq. Sync and intents share one per-account seq, so this single nudge covers
  both; the client drains sync and intents together.
- `: heartbeat` — an SSE comment line sent every ~20s to keep the connection
  alive through idle proxy/load-balancer timeouts. Clients ignore it.

Only content writes nudge. Bookkeeping writes never do: the device-cursor
endpoint (`POST /sync/:app/device`) does not advance `seq` and never nudges, and
a batch write sent with `notify: false` (used for device-state / high-water-mark
rows) commits without nudging. This prevents a per-cycle housekeeping write from
provoking a nudge → drain → housekeep → nudge self-loop, while genuine content
changes still nudge instantly.

Emission is best-effort and post-commit: a nudge fires only after the write is
durably committed, and a slow or dead connection is dropped, never allowed to
block or fail the underlying write. The pub/sub is in-process and
single-container by design; horizontally-scaled push is deferred with the paid
product (spec §13, §14.3).

> **Reverse proxy:** the `/events` response must not be buffered. Configure
> Caddy with `flush_interval -1` (or nginx with `proxy_buffering off`) as shown
> in [Behind Caddy](#behind-caddy), or nudges are batched and clients fall back
> to polling.

```
# Subscribe to account "house-1" (streams until interrupted).
curl -N http://localhost:8080/events?accountId=house-1 \
  -H "Authorization: Bearer $TOKEN"
# event: ready
# data: {"seq":0}
#
# ... after another device writes ...
# event: activity
# data: {"seq":3}
```

## Scripts

### Phase 2 losslessness check

`scripts/losslessness-check.ts` is a one-off, read-only dogfood script. It reads
the current file-tier sync payload for each app, seeds a running GLANCEvault
server, pulls the rows back out, and diffs the returned envelope bytes against
the originals byte-for-byte. It is the centerpiece Phase 2 check: proof that the
server round-trips real production data losslessly. It never decrypts anything,
never modifies your WebDAV files or app data, and adds no server endpoints.

It runs against a normal running server, so start the server first (see above),
then run the script on the machine that holds the file-tier sync directories.

Configuration is via environment variables (see `.env.phase2.example`):

| Variable | What to put there |
|---|---|
| `VAULT_URL` | Base URL of the running server, e.g. `http://localhost:8080` |
| `VAULT_TOKEN` | The device token the server was started with |
| `ACCOUNT_ID` | Base account id for the check, e.g. `lossless-check` (a per-app suffix is added) |
| `SYNC_DIR_DAYGLANCE` | Path to the dayGLANCE file-tier sync directory |
| `SYNC_DIR_LASTGLANCE` | Path to the lastGLANCE file-tier sync directory |
| `SYNC_DIR_LIFEGLANCE` | Path to the lifeGLANCE file-tier sync directory |

```
cp .env.phase2.example .env.phase2
# edit .env.phase2 to set the token and the three sync directory paths
npm run lossless-check
```

`npm run lossless-check` auto-loads `.env.phase2` if it is present, so there is
no separate step to export the variables. If you keep the config somewhere else,
you can still load it yourself and call the script directly:

```
set -a; . ./my-config.env; set +a
npx tsx scripts/losslessness-check.ts
```

The script seeds each app under its own account id (`lossless-check-dayglance`,
and so on) so the check rows are easy to tell apart from real household data. It
is idempotent: running it again produces the same result. If any environment
variable is missing or any sync directory is absent or empty, it prints a clear
per-item error and exits 1 before doing anything.

A passing run ends like this and exits 0:

```
=== Summary ===
dayglance: files=247 seeded=247 retrieved=247 mismatches=0 -> PASS
lastglance: files=18 seeded=18 retrieved=18 mismatches=0 -> PASS
lifeglance: files=130 seeded=130 retrieved=130 mismatches=0 -> PASS

losslessness check PASSED: every app round-tripped byte-for-byte
```

Any mismatch or a retrieved count that does not equal the seeded count prints
the offending entity ids and exits 1.

## Run from source (development)

```
npm install
npm run build
GLANCEVAULT_DEVICE_TOKEN=dev-secret npm start
```

Or with live reload:

```
GLANCEVAULT_DEVICE_TOKEN=dev-secret npm run dev
```

## Tests

```
npm test
```

This includes a unit test that hammers the per-account sequence counter from
multiple worker threads sharing one SQLite file and asserts the assigned
sequence numbers form a gap-free, duplicate-free run, proving bumps stay
monotonic under concurrent writers.

The sync transport has its own hammer suite (`test/sync.test.ts`) that drives
the real HTTP endpoints against a real SQLite file with synthetic garbage-byte
envelopes. It proves seq monotonicity under concurrent batch writes, batch
idempotency, ON CONFLICT seq advancement, incremental fetch and `hasMore`
correctness, soft-delete, and cross-app isolation.
