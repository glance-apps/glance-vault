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
| Auth model | `GLANCEVAULT_AUTH_MODE` | `authMode` | `shared` |
| Enrollment secret | `GLANCEVAULT_ENROLLMENT_SECRET` | `enrollmentSecret` | none (required in `per-account` mode) |
| Listen port | `GLANCEVAULT_PORT` | `port` | `8080` |
| Device auth token | `GLANCEVAULT_DEVICE_TOKEN` | `deviceToken` | none (required) |
| Allowed CORS origins | `GLANCEVAULT_ALLOWED_ORIGINS` | `allowedOrigins` | none (no cross-origin) |
| Request logging | `GLANCEVAULT_REQUEST_LOG` | `requestLog` | on |
| Trust proxy | `GLANCEVAULT_TRUST_PROXY` | `trustProxy` | `loopback` |
| Per-IP rate limiting | `GLANCEVAULT_RATE_LIMIT` | `rateLimit` | on |
| Rate-limit window (s) | `GLANCEVAULT_RATE_LIMIT_WINDOW_SECONDS` | `rateLimitWindowSeconds` | 60 |
| Rate-limit max/window | `GLANCEVAULT_RATE_LIMIT_MAX` | `rateLimitMax` | 600 |
| Max SSE connections (total) | `GLANCEVAULT_MAX_SSE_CONNECTIONS` | `maxSseConnections` | 1024 |
| Upload-session TTL (h) | `GLANCEVAULT_UPLOAD_SESSION_TTL_HOURS` | `uploadSessionTtlHours` | 24 |
| Upload-session sweep (min) | `GLANCEVAULT_UPLOAD_SESSION_SWEEP_MINUTES` | `uploadSessionSweepMinutes` | 60 |

`GLANCEVAULT_ALLOWED_ORIGINS` is a comma-separated list of origins; the
`allowedOrigins` config file field is an array. The environment variable wins
over the file. When neither is set, no cross-origin requests are allowed. A
single `*` entry allows any origin. Preflight OPTIONS requests are answered
before auth, so browser clients work without sending the device token on the
preflight.

Every client that connects cross-origin must be listed. That includes the
dayGLANCE **Electron desktop** app, whose renderer sends `Origin: app://dayglance`
— omit it and the desktop app's SSE/`fetch` is blocked by the browser engine and
it silently degrades to polling. A typical allow list is
`app://dayglance,https://app.example.com` (replace the second entry with your
real production web origin(s)). See `config.example.json` / `.env.example`.

**Abuse limits.** Per-IP rate limiting is on by default (a coarse backstop on top
of the reverse proxy; default 600 requests/IP/minute, `429` with `Retry-After`
past that). Because the server runs behind a TLS-terminating proxy, `req.ip` is
only correct when Express is told which hop to trust: `GLANCEVAULT_TRUST_PROXY`
defaults to `loopback` (a proxy on localhost, matching the compose setup). Set it
to a hop count (e.g. `1`) if your topology differs. `/events` (SSE) is additionally
bounded by a per-account cap (64) and a process-wide total cap
(`GLANCEVAULT_MAX_SSE_CONNECTIONS`, default 1024); an over-cap connection gets a
clean `429`.

The config file path defaults to `./config.json` and can be overridden with
`GLANCEVAULT_CONFIG`. See `config.example.json` and `.env.example`.

Request logging is on by default: the server prints one concise line per
request (method, a redacted route template, status, duration), skipping the
`/healthz` health check so it does not drown out real traffic. The query string
and dynamic path segments (accountId, the plaintext `entityId`, blob hashes) are
stripped — a request to `/sync/dayglance/dailyNotes:2026-07-10?accountId=house-1`
logs as `GET /sync/:app/:entityId` — so no per-user metadata reaches the logs.
This is the first thing to check when a client "does nothing" — if no line
appears when the client acts, the request never reached the server (see
[Connecting a browser app](#connecting-a-browser-app)). Set
`GLANCEVAULT_REQUEST_LOG=off` to silence it.

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

### Auth model (`GLANCEVAULT_AUTH_MODE`)

`shared` (the default) is the model described above and the only one that does
anything today: one instance-wide device token, and each request names the
account it acts on. That is the right trust boundary for a self-hosted instance
run by one household or operator.

`per-account` turns on per-device credentials that the server resolves to an
account itself. In this mode the Bearer token every scoped request presents is
the device's own credential — the shared device token authenticates nothing
(the server warns about this at startup) — and the server derives the operative
account from the credential: a request whose `accountId` does not byte-exactly
match the credential's account is rejected with `403`, and an absent, malformed,
or unrecognized credential gets `401 invalid credential`. Devices obtain their
credential at `POST /enroll` by exchanging the admin-configured bootstrap secret
(`GLANCEVAULT_ENROLLMENT_SECRET`, required in this mode):

```
curl -X POST https://vault.example.com/enroll \
  -H 'Content-Type: application/json' \
  -d '{"enrollmentSecret":"<the bootstrap secret>","accountId":"house-1","deviceId":"kitchen-tablet"}'
# -> 201 {"credentialId":"...","credential":"gvc_...","accountId":"house-1",...}
```

The `credential` value appears in that response once and is never retrievable
again (the server stores only a hash). The device saves its credential and
**discards the bootstrap secret** — nothing ever asks for the secret again, and
re-enrolling always mints a fresh credential rather than returning an old one.

`shared` deployments are unaffected: switching modes is an explicit operator
decision, and enrolled credentials mean nothing to a `shared`-mode server.

#### Revoking a credential (per-account mode)

Two admin endpoints exist only in `per-account` mode, authenticated with the
same bootstrap secret as enrollment (holding that secret already grants
enrollment into any account, so revocation grants strictly less):

```
# List every credential (active and revoked; verifier hashes are never returned).
curl -H 'Authorization: Bearer <the bootstrap secret>' \
  https://vault.example.com/admin/credentials

# Revoke one. Idempotent; a re-revoke keeps the original timestamp.
curl -X POST -H 'Authorization: Bearer <the bootstrap secret>' \
  https://vault.example.com/admin/credentials/<credentialId>/revoke
```

A revoked credential is rejected on its next request, and any live push
stream it holds is closed (immediately when revoked through this endpoint; a
revocation written directly to the database is caught by the push stream's
next heartbeat). Re-enrolling a device also revokes its previous credential
automatically, so re-enrollment is rotation: the old credential dies when its
replacement is born. Revocation deletes nothing — account data, the salt, and
device sync cursors are untouched, and a revoked device re-enrolls with the
bootstrap secret to resume.

#### Usage accounting (per-account mode)

`GET /admin/usage` (same bootstrap-secret auth) reports per-account usage plus
a global rollup: stored bytes (sync envelopes split per app, intent envelopes,
blob bytes), row counts split live/tombstone, current non-expired intents,
in-flight upload sessions with their staged bytes (reported separately from
stored), and live push connections. The numbers are **derived current state**,
computed on read — record-only, nothing is enforced. Two properties worth
knowing: tombstones and not-yet-reclaimed blobs are charged to the account
(they occupy real disk the account cannot free on demand), and blob bytes are
**attribution, not volume** — they come from per-account metadata, not from
stat-ing the blob directory, so a transient orphan left by a crash mid-reclaim
(or reaper-bounded upload scratch) can make `du` read slightly higher.
Shared-mode deployments don't get this endpoint; `du` on the data volume
serves a single-household instance.

An unrecognized value is rejected at startup rather than quietly falling back,
so a typo cannot leave you believing an auth model is on when it is not.

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

### Running as a specific user (file permissions)

The SQLite file lives on the mounted data volume, so the container's user has to
be able to write that directory. When it cannot, better-sqlite3 fails on boot
with `unable to open database file` (`SQLITE_CANTOPEN`).

Out of the box the container runs as the image's `node` user (uid/gid
`1000:1000`), which owns the named volume the compose files create — so the
default setup needs no configuration. If you need the server to run as a
different user (for example NAS platforms like Unraid, which expect
`nobody:users`, `99:100`), use Docker's own `user:` directive against a **bind
mount you own on the host** rather than a named volume:

```yaml
services:
  glancevault:
    image: ghcr.io/glance-apps/glance-vault:latest
    user: "99:100"                 # match the owner of the directory below
    volumes:
      - /mnt/user/appdata/glancevault:/data   # a host dir owned by 99:100
    # ...device token, ports, etc. as in docker-compose.yml
```

A bind mount uses the host directory's ownership directly, so as long as that
directory is owned by (or writable by) the uid you run as, the server can create
the database with no extra steps. This is why a bind mount — not a named volume —
is the right choice here: a fresh named volume inherits the image's ownership
(`node`), which a different uid can't write. On Unraid the appdata directory is
already `nobody:users`, so `user: "99:100"` with a bind mount into it just works.

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
browser or the Electron desktop app on a different origin, set
`GLANCEVAULT_ALLOWED_ORIGINS` to their origins (for example
`app://dayglance,https://app.example.com`) so CORS permits them. The device token
is sent in the `Authorization` header, so it rides over the proxy unchanged.

The `flush_interval -1` line is required for the real-time push endpoint to work
through the proxy. On nginx the equivalent is `proxy_buffering off` for the
`/events` location (the server also sends `X-Accel-Buffering: no`, which nginx
honors). Any reverse proxy in front of the server must disable response
buffering for `/events`, or SSE nudges get batched and clients silently fall
back to polling.

Because per-IP rate limiting keys on the client address, the proxy must forward
`X-Forwarded-For` and the server must trust it. `GLANCEVAULT_TRUST_PROXY` defaults
to `loopback`, which is correct when the proxy runs on the same host and connects
over localhost (the compose default). Caddy and nginx both set
`X-Forwarded-For` automatically; if you front the server with additional hops,
set `GLANCEVAULT_TRUST_PROXY` to the number of trusted proxies so a client cannot
spoof its address and evade the limit.

### Connecting a browser app

The GLANCE apps run in the browser, so a browser-enforced rule — not the vault
server — is the usual reason a client can reach the vault yet "Save does
nothing" with no obvious error. Two things to get right:

- **CORS.** A browser app served from a different origin than the vault must be
  allow-listed, or the browser blocks the request before the app sees a
  response. Set `GLANCEVAULT_ALLOWED_ORIGINS` to the app's origin (for example
  `https://app.example.com`). With it unset, no cross-origin request is allowed.
  The Electron desktop app counts here too: its renderer's origin is
  `app://dayglance`, so include it in the list or the desktop app's real-time
  push (and every `fetch`) is blocked and it falls back to polling.
- **No mixed content.** A page loaded over `https://` cannot call a vault at
  `http://…`; the browser blocks the insecure request silently. Serve the vault
  over HTTPS (see [Behind Caddy](#behind-caddy)) and enter its `https://` URL in
  the app. Pointing an HTTPS app at a plain `http://host:8080` vault will fail
  with nothing shown in the app.

When a save or sync "does nothing," open the browser's DevTools **Console** and
**Network** tabs and retry: a CORS or mixed-content block shows up there. Cross-
check the server side with request logging (on by default, see
[Configuration](#configuration)) — if no line is logged when the client acts,
the request never left the browser, which points at one of the two rules above.

## Hit /healthz

```
curl http://localhost:8080/healthz
```

Expected response:

```json
{ "status": "ok", "version": "0.1.0", "schemaVersion": 6, "authMode": "shared" }
```

`authMode` is the server's configured auth model — `"shared"` or `"per-account"`,
the same strings as `GLANCEVAULT_AUTH_MODE` — so a client can discover which
setup flow a server needs before enrolling. The endpoint stays public and needs
no token in either mode.

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
| DELETE | `/sync/:app/:entityId` | Soft-delete a row (sets a tombstone, advances seq); optional `deletedAt` query param |

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

A soft-delete (`DELETE /sync/:app/:entityId`) accepts an optional `deletedAt`
query param (epoch milliseconds). When present it is stored and returned on the
row (as `deletedAt`) so clients can apply tombstone last-writer-wins; when
omitted it is stored as `null`, which clients read as delete-wins. The server
only stores and echoes this value — it never orders or merges on it (ordering
stays purely by `seq`). Live rows always carry `deletedAt: null`.

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

# Soft-delete a row. Pass an optional deletedAt (epoch ms) for tombstone LWW.
curl -s -X DELETE "http://localhost:8080/sync/dayglance/task-1?accountId=house-1&deletedAt=1752000000000" \
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
