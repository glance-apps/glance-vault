# glance-vault

Optional self-hosted backend for the GLANCE apps: zero-knowledge sync,
cross-device intents, and media storage.

Status: Phase 1 (sync transport). The server builds, runs, holds the schema,
authenticates a device token, and serves the sync transport endpoints. Intents
and media endpoints are not implemented yet; those are later phases. See
`docs/GLANCEvault-server-spec.md` for the full design and build plan.

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

## Hit /healthz

```
curl http://localhost:8080/healthz
```

Expected response:

```json
{ "status": "ok", "version": "0.1.0", "schemaVersion": 1 }
```

## Sync transport endpoints

All sync endpoints sit under `/sync` and require the device token. The `:app`
path segment must be one of `dayglance`, `lastglance`, or `lifeglance`; anything
else is rejected with 400. The `envelope` field is opaque bytes: base64-encoded
on the wire and stored as a BLOB the server never parses.

| Method | Path | Purpose |
|---|---|---|
| POST | `/sync/:app/batch` | Upsert a batch of rows, each assigned a new seq |
| GET | `/sync/:app/list` | Incremental fetch of rows with `seq > since` |
| GET | `/sync/:app/:entityId` | Fetch a single row, or 404 |
| DELETE | `/sync/:app/:entityId` | Soft-delete a row (sets a tombstone, advances seq) |

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
set -a; . ./.env.phase2; set +a
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
