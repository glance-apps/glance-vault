# glance-vault

Optional self-hosted backend for the GLANCE apps: zero-knowledge sync,
cross-device intents, and media storage.

Status: Phase 0 (server skeleton). It builds, runs, holds the schema, and
authenticates a device token. Sync, intents, and media endpoints are not
implemented yet; those are later phases. See
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
