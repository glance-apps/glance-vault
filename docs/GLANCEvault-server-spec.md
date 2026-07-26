# GLANCEvault: Design Spec and Build Plan

Status: draft for build. Self-host server first, paid hosted product deferred.

GLANCEvault is the backend server: it carries durable sync, cross-device
intents, multi-user, and (for lifeGLANCE) milestone media for the GLANCE
apps. It is distinct from the existing `@glance-apps/sync` package (repo
`glance-sync`) and `@glance-apps/intents` package (repo `glance-intents`),
which are the client-side transports. GLANCEvault is the thing those clients
can point at instead of a file tier.

## 1. Purpose and Scope

GLANCEvault is an optional self-hosted database backend for the GLANCE apps,
following the Bitwarden model: the apps point at either a self-hosted server
or (eventually) a paid hosted instance, speaking one protocol with a
swappable endpoint. Self-hosters run it for free.

This document covers the self-hosted server and the client work to consume
it. It does not design the paid hosted product.

### In scope

- A standalone server (its own repo), SQLite-backed for self-hosters,
  Postgres-capable for a future hosted version, same server code.
- A row-grained, zero-knowledge sync model: the server stores opaque
  encrypted bytes and never decrypts.
- A cross-device intents transport hosted by the same server, so a user who
  enables the backend needs only one endpoint.
- An encrypted media blob store for lifeGLANCE milestone media (images,
  audio, video). Backend-only; the file tier does not get media.
- Multi-user for trusted households (users are ordinary synced rows).
- Support for all three apps: dayGLANCE, lastGLANCE, lifeGLANCE.
- A selectable client transport so the database backend sits alongside the
  existing file tier rather than replacing it in the codebase.

### Explicitly deferred

- Billing, subscriptions, sign-up flows, and anything in the
  "create a GLANCEvault account" product layer.
- Multi-tenant separation of multiple untrusted users sharing one database.
  The trust boundary is the instance, not the human.

### Carried forward

- Multi-user functionality for trusted households (family, roommates).
  Users are a synced entity. The "Me" designation stays device-local and
  must never sync.
- lifeGLANCE Lives: a `life_id` attribute lives INSIDE the encrypted
  envelope on lifeGLANCE entities, invisible to the server exactly like user
  assignments and entity types. Lives need zero schema change.

## 2. Key Decisions and Rationale

1. Build the self-host server first and dogfood it. The paid hosted product
   is a separate, later decision gated on real demand. The people asking for
   a self-hosted backend are, by definition, the ones who will run it free;
   the paying audience for hosted sync is a different and quieter group.

2. Keep the file tier (WebDAV, iCloud Drive) as a deliberately frozen
   "simple tier." It is the only zero-extra-service option, the only free
   sync path for Android, Windows, and Linux users without a NAS, and it
   still backs the file-tier intents path. It is not maintained to feature
   parity with the database tier.

3. The database tier is the "rich tier." It is not rescuing the apps from
   data loss (the current per-item merge is better than a naive
   last-write-wins). It closes narrower gaps and adds capabilities the file
   tier cannot offer (see section 4).

4. Zero-knowledge is preserved at row granularity. The server assigns a
   monotonic sequence number per write (no plaintext needed) but cannot
   merge ciphertext content. Conflict avoidance therefore comes from row
   granularity, not from server-side merging. The principle: the server
   orders, granularity prevents conflict.

5. Encryption is always on, one code path. There is no unencrypted self-host
   mode. The encrypted path is required for untrusted hosts (Vercel,
   DigitalOcean) regardless, so making encryption conditional would fork the
   hardest, riskiest component (the sync engine) on both client and server
   for almost no benefit. The cached-root-key design (Phase 2.7) already
   removes the passphrase-re-entry UX cost, and always-encrypted gives
   defense in depth on self-host boxes (backups, cloud drives, accidental
   port exposure) for free.

6. When a user fully enables the backend (END STATE, post-Phase 6), it
   replaces every file-based cross-device transport for that user: durable
   sync AND cross-device intents both move to the server. That user runs one
   endpoint, not "a database for sync plus a WebDAV server still alive for
   intents." This is per-user, not a removal from the codebase; file-tier
   users keep file-tier transports.

   Important transition caveat: sync transport and intents transport are
   INDEPENDENTLY selectable. "Enable the backend" is really two switches, not
   one, and they do not have to flip together. This is what makes the per-app
   sync cutover possible while intents remain shared across apps. During the
   cutover window (Phases 4 and 5), a user runs backend sync WITH WebDAV
   intents still enabled. That is the designed transition configuration, not a
   degraded state. Consequence: a self-hoster cannot retire their
   Nextcloud/WebDAV endpoint when they first enable backend sync; intents
   still need it until the global intents cutover (Phase 6). The
   single-endpoint benefit arrives at Phase 6, not when the backend is first
   enabled. (See section 12 for why intents cannot move per-app: they are the
   cross-app channel between the very apps being cut over one at a time.)

7. Local-first: the backend is a sync and replication target, NOT the system
   of record. The apps hold their own data locally and stay fully functional
   offline after initial load. This is categorically different from Actual
   Budget or Paperless, where the app is a thin client and no server means no
   app. The GLANCE apps keep working with the server down, the network gone,
   or a subscription lapsed; a lapsed GLANCEvault degrades to "no sync," not
   "no app." This principle is WHY sync is row-replication rather than
   query-the-server. The one asterisk is large media: structured data is
   always fully local and offline, but a lifetime of video cannot fit on a
   phone, so media uses selective caching (recent or viewed media local, the
   rest fetched on demand). The offline guarantee is ironclad for structured
   data and necessarily softer for big media.

8. Media is a backend-only feature. The file tier does NOT get a sidecar blob
   store; it would inherit the file tier's eventual-consistency and
   conflict-copy problems with no clean GC story, and is not worth building.
   Consequence: lifeGLANCE milestone media requires GLANCEvault. A file-tier
   or iCloud lifeGLANCE works but without milestone media. Because tier is
   instance-level, a household is either all-file-tier (no media) or
   all-backend (media works); there is no mixed-household degradation case.

## 3. Architecture

### 3.1 Deployment topology

A single `docker-compose.yml` runs the GLANCEvault server plus its database
(SQLite by default). All three apps point at that one server. The apps are
clients (browser PWA, Electron, mobile); only the server touches the
database. The apps do not share the database directly. The `app` column
namespaces each app's rows in the shared tables. For self-hosters this is the
same Docker deployment model they already use for dayGLANCE, so bundling the
backend into the same compose adds no new operational muscle.

### 3.2 Tiers behind one interface

Two tiers ship: the file tier (frozen, simple) and the always-on container
(the full-featured backend). A serverless tier is supported by the
architecture but is NOT shipped or documented for now (see note below).

| Tier | Backend | Cursor | Dedupe | Reads | Push | Media | Shipped |
|---|---|---|---|---|---|---|---|
| File | WebDAV, iCloud Drive | synthetic (time + filename) | client-side | list-and-filter | no | no | yes |
| Always-on | self-hosted container | real `seq` | server-side | indexed incremental | yes (SSE/WS) | yes | yes |
| Serverless | Vercel/Lambda + Postgres + object storage | real `seq` | server-side | indexed incremental | no | yes | no (architecture-supported) |

All tiers satisfy the same client transport interface. Clients branch on a
capability flag, never on backend identity.

Serverless tier, deferred not cancelled: a serverless deploy (functions plus
managed Postgres plus object storage) is a coherent target, and the storage
and blob abstractions are kept tier-agnostic so it remains buildable later
with no rework. It is dropped from the near-term build and rollout for two
reasons. First, the audience asking for a self-hosted backend runs containers
almost by definition, so the no-hardware serverless user was always more
adjacent than core. Second, serverless cannot do push (short-lived functions
do not hold persistent connections), so it would be a polling-only tier
needing its own parity story. The same tier-agnostic abstractions that would
enable a serverless deploy also enable a paid hosted Postgres product,
so keeping them costs nothing and preserves both options. The Vercel deploy
guide is not written for now; if a serverless guide is ever justified, the
architecture already supports it.

Hosted tier, engine decided: if the paid hosted product proceeds, it runs
**Postgres, self-managed, on the same box as the server**, while SQLite
remains the default and documented path for self-hosters. Postgres is chosen
for row-level security as a database-enforced isolation backstop under
multi-tenant auth. Note the `seq` divergence in 5.4: Postgres needs a
sequence or `SELECT ... FOR UPDATE` on the per-account counter, and both
engines need test coverage so behavior does not diverge between self-host and
hosted. Whether the hosted product proceeds at all is an open decision
tracked in the GLANCEvault Pro Prerequisites and Build Notes document.

### 3.3 Transport interface (already defined)

```typescript
type Cursor = string; // opaque; client never parses it

interface Envelope {
  entityId: string;        // stable client UUID; idempotency + version key
  ciphertext: Uint8Array;  // full Phase 2.7 envelope (salt + nonce + ciphertext)
  app?: string;            // coarse routing metadata, unencrypted, kept tiny
  createdAt: number;       // client clock, advisory only
}

interface GlanceTransport {
  list(since: Cursor | null, limit?: number): Promise<ListResult>;
  put(env: Envelope): Promise<void>;     // idempotent on entityId
  get(entityId: string): Promise<Envelope | null>;
  delete(entityId: string): Promise<void>;
  readonly capabilities: TransportCapabilities;
}

interface TransportCapabilities {
  push: boolean;           // SSE (Phase 9; WS added per-feature later, §14). File: false; container: true
  serverSequence: boolean; // server assigns ordering. File: false
  serverDedupe: boolean;   // server rejects dup entityId. File: false
  presence: boolean;
  media: boolean;          // blob store available. File: false
}
```

### 3.4 Zero-knowledge boundary and the salt

The server stores the existing self-describing Phase 2.7 envelope bytes
intact and treats them as opaque. It never sees the root key, never sees
plaintext, and cannot field-merge two envelopes. Two consequences:

- `seq` assignment is fine (incrementing a counter needs no plaintext).
- The "which side is newer" decision for a mutable entity still rides on the
  client-supplied `lastModified` inside the encrypted row. `seq` orders
  writes; it cannot compare content.

These are two different jobs and must not be conflated:

- `seq` answers "what changed since I last looked" (the cursor).
- `lastModified` answers "who wins when the same entity was edited in two
  places at once."

The same boundary applies to media: the server stores encrypted blobs
opaquely and therefore cannot generate thumbnails or transcode video.
Thumbnails are generated client-side and stored as their own small encrypted
blobs.

The salt is not secret. Its only jobs are uniqueness and defeating
precomputation; it lives in the clear alongside the ciphertext by design. The
secret is the passphrase, which never leaves the client. So the server may
store the salt safely even on an untrusted host (Vercel, DigitalOcean): a
salt without the passphrase is useless. On the database tier the salt stops
being a special WebDAV file at a known path and becomes ordinary server state
(a config value or a single row) served over the API. A new device fetches it
to derive the same key from the passphrase. The salt cannot be eliminated
without eliminating key derivation, which (per decision 5) is not an option.

## 4. First-Class Capabilities (build-toward reference)

What the backend offers that the file tier cannot. Split into two groups by
what each capability requires: most need only a database (a query inside one
request), and a few need a persistent connection on the always-on container.
The container is the shipped backend tier, so in practice it provides all of
these. The split is retained because it also marks what a future serverless
or paid-hosted Postgres deploy could and could not offer: the database group
would carry over, the persistent-connection group would not.

### Needs only a database (container today; a serverless/Postgres deploy too)

- Server-assigned monotonic `seq`: deterministic, skew-proof ordering, which
  retires the fragile client-side `stampTaskTimestamps` mechanism.
- Efficient incremental reads (`WHERE seq > cursor`, indexed) instead of
  list-the-whole-directory-and-filter. This is the capability lifeGLANCE most
  needs, since file-tier reads degrade as history grows and a life is the
  largest history there is.
- Server-side dedupe (`ON CONFLICT`) rather than client-side.
- Per-row writes: no read-merge-write whole-file amplification, and no 412
  retry storms under contention.
- Coordinated tombstone GC via device cursors instead of a guessed time
  window.
- Media blob store: content-addressed dedup, lazy and ranged fetch, selective
  sync, reference-counted cleanup (see section 8).
- Server-enforced TTL on intents, so expiry is not a client chore.

### Needs a persistent connection (always-on container only)

- Real-time push (SSE/WebSocket): instant sync and instant cross-app intents
  instead of polling. This is what makes the suite feel alive, a dayGLANCE
  completion lighting up lastGLANCE immediately. Built in Phase 9.
- Presence: live awareness of other household devices (the `presence`
  capability flag).
- Media streaming with range requests rather than download-then-play.

## 5. Schema

Postgres-flavored. SQLite deltas noted below. The media blob table is
described in section 8 (Media and Blob Store), not here, because its design
has open implementation details and should not bloat the Phase 0 migrations.

```sql
-- Durable per-entity state. One row per entity, or per event for insert-only types.
CREATE TABLE sync_rows (
  account_id   TEXT        NOT NULL,   -- household/instance scope; constant for single-tenant self-host
  app          TEXT        NOT NULL,   -- 'dayglance' | 'lastglance' | 'lifeglance'; plaintext, for per-app fetch
  entity_id    TEXT        NOT NULL,   -- stable client UUID; idempotency + version key
  seq          BIGINT      NOT NULL,   -- server-assigned, monotonic per account; THE cursor
  envelope     BYTEA       NOT NULL,   -- full Phase 2.7 envelope; server stores opaquely
  deleted      BOOLEAN     NOT NULL DEFAULT FALSE,
  server_mtime TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, app, entity_id)
);
CREATE INDEX idx_cursor ON sync_rows (account_id, app, seq);

-- Cross-device intents. Insert-only, TTL-expiring, cross-app routing.
CREATE TABLE intent_events (
  account_id  TEXT        NOT NULL,
  event_id    TEXT        NOT NULL,   -- client UUID; idempotency key
  seq         BIGINT      NOT NULL,   -- server-assigned; cursor for delivery
  envelope    BYTEA       NOT NULL,   -- opaque encrypted intent payload
  expires_at  TIMESTAMPTZ NOT NULL,   -- TTL; server prunes past this
  server_mtime TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, event_id)
);
CREATE INDEX idx_intent_cursor ON intent_events (account_id, seq);

-- Device cursors, for coordinated tombstone GC.
CREATE TABLE devices (
  account_id    TEXT        NOT NULL,
  device_id     TEXT        NOT NULL,
  last_seen_seq BIGINT      NOT NULL DEFAULT 0,
  last_active   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_id)
);
```

Notes:

- `entity_type` is deliberately NOT a column. The client learns whether a row
  is a task or a habit by decrypting it. The only query sync runs is
  "everything since my cursor," which does not filter by type. Free privacy
  win, zero operational cost. `life_id` is likewise inside the envelope, not
  a column.
- `account_id` is a household/instance scope, not a product account. For a
  single-tenant self-hosted box it is effectively a constant. It stays in the
  schema because designing it in now is free and adding it later is not.

### 5.1 Row strategy by entity

| Data | Row strategy | Conflict behavior |
|---|---|---|
| tasks, chores, habits, goals, projects, categories, GTD frames, lifeGLANCE milestones | one mutable row per entity, keyed by stable UUID | UPSERT on `entity_id`; higher `seq` wins the whole row (entity-grain LWW, matches current `merge.js` semantics) |
| completion events, instance completions, habit logs | one insert-only row per event, fresh UUID each | never collide; idempotent re-insert; union falls out free |
| intents | one insert-only row per event in `intent_events`, with TTL | never collide; idempotent re-insert; expire past TTL |
| media | reference in the entity envelope; bytes in the blob store | content-addressed; immutable; see section 8 |

The insert-only strategy is the structurally correct fix for the
`completedDates` and GTD-exception collisions. lastGLANCE already uses this
shape for CompletionEvents; dayGLANCE should move toward it.

### 5.2 Entity discrimination: structural sniff vs explicit `_kind`

The adapter has to know what kind of entity a decrypted row is, because the
server stores no type column (entity_type is deliberately not a column; see
section 5 notes). Two approaches, and the right one depends on the app:

- Structural sniff (lastGLANCE): derive kind from the decrypted shape's field
  names, with a load-bearing check order. Works only when entity shapes are
  distinct. lastGLANCE has four well-separated types, so this is sufficient
  there.
- Explicit in-envelope `_kind` (dayGLANCE): carry a `_kind` field inside the
  entity. Required when shapes are not distinguishable. dayGLANCE's
  `tasks`, `unscheduledTasks`, `recurringTasks`, `recycleBin`, and
  `todayRoutines` are the IDENTICAL task shape (all stamped through one
  `stampTaskTimestamps`), so a structural sniff cannot separate scheduled vs
  inbox vs today-routine. dayGLANCE therefore carries `_kind` and uses a
  composite `${kind}:${id}` entityId. Because the envelope is JSON-stringified
  before AES-GCM, `_kind` is sealed inside the ciphertext and the server never
  sees it: still zero-knowledge.

Guidance: entity-rich apps (dayGLANCE, and lifeGLANCE later) should default to
explicit `_kind` rather than structural sniffing. The sniff is a lastGLANCE
convenience that does not generalize. `_kind` is the durable pattern.

Composite entityId caveat: keying by `${kind}:${id}` means the same logical
record under two kinds is two different rows. For records that MOVE between
kinds (e.g. a dayGLANCE task moving unscheduled -> scheduled -> recycle bin,
keeping its `id`), a move must be represented as a tombstone on the old
`${kind}:${id}` plus an insert on the new one, or the record can end up live
under two rows (appearing in two lists). This is a real cross-list
reconciliation requirement on the apply/merge path, not a representability
problem (the losslessness roundtrip does not exercise it).

### 5.3 Bundle rows and merge granularity (silent-loss risk)

Some app state does not decompose into per-item rows with their own
timestamps. dayGLANCE has several such bundles: `routineDefinitions`,
`habitLogs`, `habitLogTimestamps`, `routineCompletions`, `completedTaskUids`,
the tombstone maps, and the paired `*Enabled`/`*UpdatedAt` flags. Mapping each
bundle as a SINGLE row is lossless for one device, but the row merges by
entity-grain last-writer-wins, so two devices editing DIFFERENT entries in the
same bundle between syncs produce two versions of that one row and LWW
discards one. That is silent data loss on concurrent edits, the same shape as
the `completedDates` collision generalized across every bundle.

A single-device losslessness test cannot catch this; it only appears with
concurrent multi-device edits. So each bundle row needs a deliberate merge
decision, not a default upsert:

- Bundles with per-key timestamps (e.g. `habitLogTimestamps` exists precisely
  so habit logs can be merged by recency) should merge key-by-key using those
  timestamps, not LWW the whole row.
- Bundles without per-key timestamps need either a merge strategy added
  (set-union for append-only maps like `completedTaskUids` and tombstone maps,
  which only grow) or an honest acknowledgement of the LWW loss window.
- The apply step for these rows is therefore special (map-merge), not a plain
  upsert. This is app-side adapter logic, not a server or `@glance-apps/sync`
  change.

Convergence requires re-pushing the merged superset, not apply-step merge
alone. The vault stores one row per entityId, upserted last-write-wins, and
two devices editing different entries in the same bundle row clobber each
other AT THE VAULT before either reads the other's value, so merging only on
apply cannot recover the lost entry. The fix (proven in the dayGLANCE cutover,
borrowed from the file tier's `remoteChanged` mechanism): when a bundle merge
leaves a device richer than the row it just pulled, the device re-pushes the
merged superset. Because the per-bundle merges are commutative and monotonic
(set-union, per-key max-timestamp), this converges and terminates. Any bundle
whose merge is NOT monotonic would not be safe under this scheme and must be
flagged rather than shipped. The dayGLANCE cutover found no such bundle.

This is the core merge-correctness work of the dayGLANCE cutover and must be
proven with a multi-device test before going live.

### 5.4 SQLite vs Postgres

The only real divergence is `seq` assignment. SQLite serializes all writes
through a single writer, so a per-account counter bumped inside the same
transaction is naturally correct. Postgres needs a sequence or a
`SELECT ... FOR UPDATE` on a per-account counter to keep `seq` monotonic
under concurrent writers. Everything else is identical (schema, queries,
envelope as `BYTEA`/`BLOB`, indexes), so the storage abstraction stays thin
and one codebase runs both.

## 6. Client Write Path (sync)

The schema is the easy half. The client engine is the heavy lift, because
today's model is download-whole-file, merge in memory, upload-whole-file, and
the new path is diff-to-rows, push only changes. The merge semantics are
preserved; the mechanics change.

### 6.1 Diff step

```
collectChanges():
  dirty = entities mutated since last successful push
  for each d in dirty:
    if insert-only type:  emit INSERT row (fresh UUID, never seen by server)
    else:                 emit UPSERT row (stable entity_id, encrypted envelope)
  emit tombstone rows for local deletes since last push
```

The client keeps a local high-water mark (the `seq` of its last successful
sync) and a dirty set. Clean rows are not touched.

### 6.2 Optimistic write and the seq-mismatch case

Clean path: no one wrote since this device's cursor. The server assigns new
`seq` values, returns them, the client advances its high-water mark.

Contended path (server ahead of the client's cursor): the analog of today's
WebDAV 412, resolved the same way but row-grained.

```
on seq-conflict (remote ahead of my cursor):
  pull rows where seq > my_cursor
  for each remote row R:
    local = my version of R.entity_id
    if no local copy:            apply R
    else if R is insert-only:    apply R (unions naturally, never conflicts)
    else:                        entity-grain LWW; whichever side is newer
                                 wins the WHOLE row (same rule as merge.js)
  re-attempt my still-pending writes on top of the new cursor
```

This is not new conflict logic. It is the existing per-item, newer-wins-the-
whole-item rule relocated, with `seq` providing the cursor and catch-up
mechanism.

### 6.3 Idempotency

Mutable writes are UPSERT on stable `entity_id`; insert-only writes carry a
client-generated UUID. Re-sending a batch after a dropped connection is
harmless: the upsert overwrites identically, the insert collides on its UUID
and no-ops.

### 6.4 Partial-write safety

A row-grained write is a batch and can partially apply if a connection drops.
The rule that makes this self-healing: advance the local high-water mark only
on full server ack. On any failure, keep the dirty set and retry. Never mark
clean optimistically. Un-acked rows stay dirty and are re-sent idempotently
next cycle.

### 6.5 Push trigger (push-on-write, not cadence-only)

A local write must trigger a debounced push (roughly 2 to 5 seconds), not
only ride the periodic sync interval. Interval-only delivery is a correctness
defect, not just a latency one: browsers and WebView shells heavily throttle
or suspend background-tab timers, so a backgrounded source device may not hit
its interval for a long time, and dirty rows sit undelivered until something
else (app reopen, tab focus) forces a cycle. This was observed in the
lastGLANCE GLANCEvault test: completions logged on a backgrounded desktop did
not reach the vault (and therefore did not reach a vault-only iPad) until the
desktop app was reopened.

Requirements:

- Writes mark rows dirty AND schedule a debounced push; the push is not
  contingent on the interval tick.
- The interval remains as a backstop for catch-up and for delivering anything
  a missed push left behind, but it is not the primary delivery path.
- Push-on-write drives the GLANCEvault (DB) transport only. The file tier
  (WebDAV) deliberately stays on its cadence model (load, focus, interval) and
  does NOT get push-on-write, because its full-payload upload makes per-write
  pushes expensive. This is how lastGLANCE shipped and is the intended design,
  not a gap. On a dual-write device (WebDAV plus GLANCEvault), a local write
  pushes to the vault within the debounce window and reaches WebDAV only on the
  next cadence tick. That is fine: the two transports are not meant to converge
  with each other; each independently converges the household, and a
  vault-only device reads from the vault, so WebDAV lagging is invisible to it.
  (If an app ever wants push-on-write to also drive WebDAV, that is net-new
  work and would want a much longer debounce given the full-payload cost. The
  default, matching lastGLANCE, is vault-only push.)

Where this lives: the row protocol and merge logic are in `@glance-apps/sync`,
but cadence and triggers (the interval, visibility/focus listeners, and this
debounced push-on-write) currently live in each app's own integration layer,
not in the package. The package is deliberately mechanism, not policy. So the
fix is applied per app, not once in the shared engine, which is exactly why
the per-app requirement below exists. Hoisting trigger policy into the shared
package is an option if the three apps' trigger logic turns out identical and
the duplication becomes annoying, but it is not required and would couple all
three apps to one cadence implementation. Default: keep triggers app-side.

This requirement applies to every app as it adopts GLANCEvault (lastGLANCE,
then dayGLANCE, then lifeGLANCE), not just the first. Because triggers are
app-side, the fix does NOT propagate automatically; each cutover must
re-apply and confirm push-on-write, or the cutover is not actually proven:
a test that looks clean can still be stranding writes until app reopen.

### 6.6 Cursor invariant (the pull cursor advances only on pull)

This is a hard correctness invariant of the sync engine, fixed in
`@glance-apps/sync` 1.4.0. It must not regress.

The pull cursor (the `since` value, the high-water mark for reads) means "the
highest seq I have actually consumed." A push consumes nothing, so a push MUST
NOT advance the pull cursor. Push tracks its own progress in a SEPARATE
push-ack marker.

Why this matters: the server assigns pushed rows the highest seqs in the
account. If a push advances the shared pull cursor to the seq it just wrote
(the pre-1.4.0 bug), the next pull lists only rows above that, and any remote
row written by another device but not yet pulled sits below the cursor and is
permanently skipped. For mutable entities a later rewrite can converge, but
insert-only rows (completion events, the core lastGLANCE data) are never
rewritten and are lost forever. This was a live data-loss bug; the fix splits
the pull cursor from the push-ack marker so push can never move the pull
cursor.

Consequences that follow from the invariant:

- Cycle ordering (push-then-pull vs pull-then-push) no longer affects
  correctness, because the pull always lists from the highest seq it has truly
  consumed regardless of what push did. lastGLANCE keeps the engine default
  (push-then-pull); dayGLANCE composes pull-then-push for an unrelated reason
  (its wrapper commits a React-state mirror only on success). Pull-then-push
  is therefore an OPTIONAL marginal-freshness choice, NOT a data-loss
  mitigation. Do not re-introduce an app-side reorder believing it guards
  against the cursor bug; the package guards against it.
- On upgrade, an existing stored cursor is read as pull-progress (the
  conservative reading: a device never resumes ahead of what it consumed). No
  migration step. Note: the fix stops FUTURE skips; rows already permanently
  skipped before the upgrade are not recovered by it. A one-time forced
  re-pull from seq 0 (idempotent for insert-only apply) is the way to true up
  a device suspected of missing pre-fix data.

The same "a cursor advances only on what it actually consumed" principle
applies to the intents RECEIVE cursor (section 7.6) and is the reason the
intents codec produces no `seq` on outbound rows (7.2): a send must never be
able to advance a receive cursor.

## 7. Intents Transport

When a user enables GLANCEvault, cross-device intents move to the server
alongside sync. That user no longer needs any file-based transport.

### 7.1 What moves and what does not

What moves: the file-based cross-device transport only, i.e. the WebDAV
events directory. Cross-device intents now flow through `intent_events`.

What does NOT move, because it was never a cross-device transport:

- Local Android intents (Tasker firing an OS-level intent caught by a
  BroadcastReceiver on the same device). This is on-device IPC.
- Web URL deep-link intent paths.

The standalone-app guarantee is unaffected: an app talking to the database is
still standalone with respect to the other apps.

### 7.2 Shape: codec plus app-owned delivery (NOT a sync-style transport)

Intents are pure insert-only TTL events: no merge, no conflict resolution.
But "add a database transport to the intents package" turned out to be the
wrong mental model, and the spec previously got this wrong by calling it the
"easy shape." `@glance-apps/intents` is a CODEC library, not a transport. It
owns envelope encode/decode and cursor formatting; it does NOT own HTTP, the
receive cursor, polling, or delivery. Delivery is APP-OWNED, the same boundary
the WebDAV intents path already used. This differs from `@glance-apps/sync`,
which IS a stateful engine that owns its transport. The two packages are
deliberately different shapes: sync is hard and stateful so it owns the
engine; intents are insert-only fire-and-forget so a codec plus app-owned
delivery suffices. Do not try to unify them by hoisting a transport interface
into the intents package; that reverses the documented app-owned boundary.

So the intents work is THREE pieces, not one:

1. Server endpoints (`glance-vault`): insert-only write to `intent_events`,
   list-since-cursor, TTL prune. The table existed from Phase 0; the endpoints
   were built when intents were. The server filters expired rows (`expires_at
   > now`) so a client never sees an expired intent; expiry is server-enforced,
   not a client chore. Prune is lazy-on-write; an idle account's expired rows
   are harmless dead storage (invisible because list filters them) until the
   next write triggers a sweep. A background sweep is deferred paid-tier work.
2. Codec helpers (`glance-intents`, the `vault/` module): `buildIntentRow`
   (raw envelope -> the `{eventId, envelope(base64), expiresAt}` row a client
   POSTs), `parseIntentRow` (a listed row -> envelope), `parseSince`/
   `formatSince`. Wire format is camelCase, the envelope is opaque base64 in
   both directions, the row carries no `accountId` (scope only, never returned)
   and does carry `serverMtime`. The codec produces NO `seq` on outbound rows
   (seq is server-assigned), so a send is structurally incapable of advancing
   a receive cursor.
3. App-owned transport (each app): send, the receive cursor, the paginated
   receive loop, transport selection, and the durable outbox (7.5). This is
   where the cursor discipline, the encryption, and the never-lose-data
   machinery live, because that is where the state lives.

Two upgrades over the file tier: cursor-based delivery (`seq > cursor`) instead
of list-and-filter, and on the always-on tier, push.

### 7.3 Dual transport, per user, WebDAV stays available

Per-user, not a codebase removal. File-tier users keep WebDAV/iCloud intents;
those paths (send AND receive) remain fully available and are NOT deprecated.
People do NOT need GLANCEvault to get intents. GLANCEvault intents are an
ADDITION alongside WebDAV, selected by an independent opt-in toggle. A user may
run WebDAV intents, vault intents, or both. The Tasker on-device contract is
independent of either (per 7.1).

### 7.4 Always-encrypted (the zero-knowledge contract, enforced)

GLANCEvault intents are ALWAYS encrypted, no exceptions, matching decision 5
(encryption always on) for sync. This was initially built WRONG: the vault
intents path inherited the WebDAV intents encryption MODEL, where encryption
is gated on an optional `encryptionEnabled` flag that is off by default and
unreachable for a vault-only user. The result was plaintext intents written to
the zero-knowledge vault on both send (plaintext fallback when the flag was
off) and receive (an `encrypted !== true` branch that routed plaintext). That
violated the entire premise of the vault. The enforced design:

- SEND: the vault deliverer ALWAYS builds an encrypted envelope. There is no
  plaintext branch for the vault, ever. If the key is unavailable, the send
  does not fall back to plaintext and does not drop; it holds (7.5).
- RECEIVE: a non-encrypted row arriving over the vault is REJECTED (logged,
  cursor advanced past it so it cannot wedge, never routed). A plaintext row on
  the vault is a contract violation. The WebDAV receive path is unchanged
  (WebDAV may legitimately carry plaintext per its own config).

Key derivation: vault intents derive `deriveIntentsRootKey(syncPassphrase,
vaultSalt)`, the SAME function the WebDAV intents path uses, but fed the vault
salt (the server-stored `/salt/:accountId` value sync already uses) instead of
the WebDAV-file salt. Reusing the sync salt is safe: intents and sync derive
DIFFERENT keys from the same salt because their HKDF info strings differ
(`glance-intents-envelope-v1` vs `glance-sync:entity:<id>`); the salt is just
shared random bytes and sharing them couples nothing. The derived intents key
is cached in its OWN slot, distinct from the WebDAV intents key slot, because
the two are different keys (different salts) and must not collide.

Cross-app contract: the intents derivation is app-agnostic (no app-specific
value anywhere), so two GLANCE apps with the same passphrase and same vault
salt derive byte-identical keys and their intents are mutually decryptable.
This is a lock-step requirement: both apps must derive identically or
cross-app intents become encrypted-but-undecryptable. Verified by comparing
the derivation in each app.

Key setup timing: the vault intents key is derived once, when the user enables
vault intents (the toggle's save handler, BEFORE the app reloads, so the key
is derived while the passphrase is in memory and then persists across the
reload in its cache slot). "Passphrase available" is checked SEPARATELY from
"vault connection present" (the connection can exist while the passphrase is
null after a reload). If the passphrase is null at enable, the user is
prompted once (reusing the sync passphrase modal); cancel leaves vault intents
disabled with no key cached. After this one-time setup the cached key serves
all deliveries across all reloads with no further prompt, the same way sync's
own key and the WebDAV intents key survive reloads. The passphrase is entered
once (at vault sync setup) and generally never again; vault intents setup is
its own separate moment (sync may have been running for a long time before
intents is enabled), which is exactly why the enable-time prompt exists rather
than assuming the passphrase is present.

### 7.5 Never lose an intent: the durable outbox

The original intents send path (both WebDAV and vault) was fire-and-forget:
intents were built in memory and transmitted with no local record. Any failure
(no key, failed POST/PUT, no connection, app restart mid-send) dropped them
silently, and the emit-site change-snapshot advanced before the async send
resolved, so the change was forgotten with nothing to retry from. This was a
data-loss bug independent of encryption, affecting every transport. The fix is
a durable OUTBOX, one for all transports:

- An intent is persisted to a durable store (IndexedDB) at emit time, BEFORE
  any transmit, keyed by a stable `event_id` stamped at emit (the event_id is
  the outbox entry id AND the server idempotency key, born at enqueue so it is
  stable across retries).
- Delivery is a flush over the outbox: each pending entry tracks per-transport
  status (`pending`/`delivered`/`given-up`) and per-transport attempt counts.
  Encryption happens at flush, inside each deliverer (the outbox stores the RAW
  intent, never an envelope, so no plaintext envelope is ever persisted to
  disk). A deliverer returns delivered / transient / permanent. An entry is
  removed only when every enabled target is delivered-or-given-up.
- Key-not-ready is a TRANSIENT result: the vault target stays pending and
  retries when the key appears. So an intent emitted before encryption setup,
  or before a passphrase is available, waits in the outbox rather than dropping
  or sending plaintext.
- Bounded give-up: a target that fails `MAX_OUTBOX_ATTEMPTS` (generous, 50;
  much higher than the receive side because re-delivery is idempotent and
  losing outbound data is worse than retrying) is given up loudly with the
  event_id, so a genuinely undeliverable intent surfaces rather than retrying
  forever.
- Flush triggers: on enqueue, app start, the poll cadence, and right after
  vault key setup completes (so a freshly-enabled device flushes held intents
  once its key exists). The change-snapshot / "sent today" marker advances only
  AFTER durable enqueue, not after send, so a failed enqueue does not consume
  the change.
- Server idempotency (insert-only on `eventId`) makes every retry safe; a
  re-delivered intent is a server no-op.

### 7.6 Uniform receive failure model

The receive drain treats every row through one bounded-retry model, the same
whether the failure is a decrypt failure, a missing key, or a handler throw:

- Success -> advance cursor, clear the per-seq failure counter.
- TRANSIENT (handler threw; OR the vault key is not yet available) -> do NOT
  advance; hold and retry next poll using a persisted per-seq counter; give up
  at `MAX_INTENT_RETRIES` (5) with a loud log + advance so a permanently-stuck
  row cannot wedge the channel forever.
- PERMANENT (decrypt fails with the key PRESENT, i.e. genuinely bad ciphertext;
  OR a plaintext row over the vault; OR a malformed/unroutable row; OR a soft
  handler failure) -> advance + log.

The key distinction is decrypt-failure CAUSE: key-absent is transient (the key
will appear, e.g. after setup; hold and retry), key-present-but-decrypt-fails
is permanent (retrying never helps; advance). Collapsing the two either way is
wrong: blanket-advance loses the transient case (an intent that arrived before
setup), blanket-hold wedges on a genuinely bad row. Receive uses its OWN
cursor and the receive failure counter; this is the inbound mirror of the
outbox's outbound retry, and the two never share state.

### 7.7 Salt migration (subsumed by 7.4)

The pending "salt migration" (move the intents salt off the WebDAV file to
server state) was completed as part of the always-encrypted fix in 7.4: vault
intents reuse the server-stored `/salt/:accountId` value rather than a
WebDAV-file salt. Same HKDF-per-envelope scheme, salt sourced from the vault.
WebDAV intents (for file-tier users) keep their WebDAV-file salt; the two
transports use their own salts and own key slots.

## 8. Media and Blob Store

Backend-only (decision 8). Relevant to lifeGLANCE milestone media; lands as
its own phase right before the lifeGLANCE cutover.

### 8.1 Settled design

- A separate, content-addressed, encrypted blob store. The sync row carries
  only a small reference (blob hash plus metadata such as type and
  dimensions); the bytes live separately and are uploaded and fetched out of
  band, lazily. Media never goes inline in a sync row.
- Content-addressing gives dedup for free (the same image referenced twice
  stores once) and idempotent upload (re-upload of a known hash no-ops).
- Reference-counted: a blob is GC'd when no live row references it.
- Inline vs blob is decided by TYPE, not size. Structured fields (text,
  dates, references, notes, regardless of length) always live in the row
  envelope: they participate in entity-grain merge and stay fully local and
  offline. Binary media (image, audio, video, regardless of size) always go
  to the blob store. Rationale: a size threshold would make a field's storage
  location and its merge behavior depend on content length, so a long text
  note would behave like an immutable blob (new-blob-on-edit churn) instead
  of a normal mergeable field. Type is stable and predictable. Size serves
  only as a guardrail: cap envelope size (a few hundred KB) as a sanity check
  to catch a structured field that is ballooning, not as a routing rule.
- Thumbnails are their own small blobs, eagerly prefetched for fast timeline
  render; full-resolution blobs are fetched lazily on demand. This keeps one
  binary model rather than special-casing inline binary. Thumbnails are
  generated client-side (the zero-knowledge server cannot make them).
- A thumbnail is content, not a regenerable derivative. The originating
  device (the one uploading the media) generates the thumbnail once at upload
  time and stores it as its own content-addressed blob; it then syncs and is
  cached like any other content. It is NOT regenerated per device. This is
  load-bearing: a device can only generate a thumbnail from the full-
  resolution original, and the whole point of lazy full-res is that most
  devices never hold most originals. So "each device makes its own thumbnail"
  silently assumes every device has every original, which is exactly what the
  model avoids. Generate-once-and-share is therefore both the correct design
  and the cheaper one (the thumbnail is computed a single time across the
  household). Because the thumbnail is content rather than a derivative, a
  separate content-addressed blob (not bundling both resolutions in one
  object) is the consistent choice: it dedups and travels on its own without
  being chained to a possibly-uncached full-res object.
- Thumbnails sync eagerly like structured data; every synced device pulls
  every thumbnail in the background. Result: the timeline renders fully
  offline (every milestone shows its image) on any synced device, not just
  the device that took the photo. Full-resolution media is lazy: online,
  tapping a thumbnail streams the full blob; offline, full-res is available
  only for items previously downloaded or cached. This is the unavoidable
  asterisk from decision 7: thumbnails offline is "everything," full-res
  offline is "what you have kept."
- Blobs-before-reference ordering (invariant, the media analog of the
  partial-write rule in section 6.4): a device must never publish an entity
  row referencing a blob until that blob is durably stored. Upload order is
  blobs first (thumbnail and full-res), entity reference last. Otherwise
  another device pulls the row, tries to fetch the referenced blob, and gets
  a miss. Content-addressing makes a retried blob upload a no-op, so this is
  safe to retry.
- Selective caching (per decision 7): recent or viewed media is local, the
  rest fetched on demand. Structured data remains fully local regardless.

### 8.2 Already implemented (forward-compat groundwork in lifeGLANCE)

Milestone media in lifeGLANCE is local-only today (it does not sync; a remote
device shows a placeholder). Ahead of the media phase, lifeGLANCE was made
forward-compatible so the eventual cutover is a transport-plus-blob-store
change rather than an entity migration:

- The milestone entity carries three nullable reference slots: `media_id`
  (audio/video), `photo_id`, and `thumbnail_id`. Added to `buildMilestone`,
  default null.
- They are initialized to the existing local blob-key convention, gated on
  the existing flags so no phantom references are created: `media_id = m.id`
  only when `media_type` is non-null; `photo_id = ${m.id}-photo` only when
  `has_photo`. A one-time startup backfill applied the same gated rule to
  existing milestones.
- The current slot values are DETERMINISTIC: every device computes the same
  `media_id`/`photo_id` from data it already has (the synced milestone id and
  the synced `has_photo`/`media_type` flags). So the slots do not propagate
  through sync; each device's backfill independently arrives at identical
  values. The backfill deliberately does NOT bump `updated_at`, because the
  values need no propagation and bumping would force a needless full-array
  re-upload. This is correct ONLY because the value is deterministic. (A code
  comment in lifeGLANCE records this so it is not mistaken for the missing-
  timestamp class of sync bug and "fixed" into churn.)
- `thumbnail_id` is a reserved slot, intentionally left null. Thumbnail
  generation is NOT implemented and remains a Phase 7 task.
- No change to `@glance-apps/sync` was needed: `buildPayload` spreads the
  whole milestone object, so the field-agnostic last-writer-wins merge carries
  the new fields automatically. Verified, not assumed.

Consequence: the lifeGLANCE media cutover (Phase 8) is a transport swap plus
blob-store wiring. The reference slots already exist and resolve correctly on
every device (via deterministic backfill, not propagation); what remains is
pointing them at content-addressed blobs and adding thumbnail generation.

Phase 8 caveat: once the slots hold REAL blob references (content hashes the
uploading device computes and other devices cannot derive), the values stop
being deterministic. At that point the reference genuinely must propagate, so
writing a real blob id MUST bump `updated_at` like any normal synced mutation.
Do not carry the current local-only, no-timestamp-bump pattern into Phase 8;
it is correct only for the convention-based placeholder values.

### 8.3 Resolved design decisions (Phase 7)

These settle the items that section 8.1 left at the principle level. They were
worked out in a dedicated Phase 7 design pass and should be treated as the
build spec, with the same status as the rest of section 8.

**Content addressing and encryption (the load-bearing decision).** A blob is
addressed by the hash of its CIPHERTEXT, and encryption is DETERMINISTIC:
AES-GCM under the shared account vault key, with a content-derived nonce
(nonce = a keyed hash of the plaintext, e.g. HMAC(account-key, plaintext)
truncated to the nonce length). Identical plaintext under the same account key
therefore produces identical ciphertext, hence the same blob id, hence dedup
and idempotent upload. The address is a hash of opaque ciphertext, so a
keyless server learns nothing from it (no plaintext-hash leak, no confirmation
attack), preserving zero-knowledge.

- Why not the obvious alternatives: random-IV encryption is simplest but
  defeats dedup (identical plaintext yields different ciphertext) and makes
  retried uploads create duplicates; convergent encryption (content-derived
  KEY) gives dedup without a shared key but is weak precisely because the key
  is not secret. The household ALREADY shares the vault key, so we get dedup
  with a real secret key by deriving the NONCE (not the key) from content.
- Nonce-reuse safety: GCM nonce reuse is catastrophic only across DIFFERENT
  plaintexts. Here the nonce is a function of the plaintext, so two different
  plaintexts get different nonces (collision-resistant hash) and a nonce
  repeats only when the message is byte-identical, in which case there is
  nothing to leak. This is safe in plain WebCrypto; no AES-GCM-SIV needed. The
  construction must be implemented carefully and this safety argument kept with
  the code.
- Key derivation: blobs use the account vault root key with their OWN HKDF
  info string (e.g. `glance-blob-v1`), domain-separated from sync
  (`glance-sync:entity:<id>`) and intents (`glance-intents-envelope-v1`), the
  same pattern those two already use. Same root, separate domains.
- The addressing scheme is effectively schema: changing it later re-addresses
  every blob. Deterministic/dedup-capable addressing is therefore built in from
  the start even though dedup volume for a personal timeline may be modest;
  the point is not to foreclose it and to get idempotent uploads (retry
  safety, the media analog of the intents event_id) for free.

**Whole-blob storage, NOT chunked/manifest.** A blob is one content-addressed
unit (one video = one blob = one hash). No manifests, no chunk-level GC, no
two-level reference graph. Chunked content-addressed storage was considered for
large video and deliberately REJECTED as over-engineering for a self-hosted
personal-scale product. Video is handled by transfer robustness and a size cap
(below), not by a storage redesign. Chunked encryption remains a possible
FUTURE optimization if, and only if, whole-file encryption of large videos is
measured to be too slow on real devices; it is not built on spec.

**Size limit (what makes whole-blob sufficient).** An operator-configurable
maximum blob size caps the input to a size the whole-blob approach handles
cleanly. This is the boundary below which the simple design is correct, and is
what lets chunked storage stay deferred with confidence. Enforced TWICE: at the
client on the PLAINTEXT size BEFORE any encrypt/upload work (UX: reject early
with a clear message, never spend effort on a file that will be rejected), AND
at the server on the received blob (the real guarantee, since the client check
is only UX and a client may be modified or buggy). The limit value is operator/
tier policy (a self-hoster sets it high; a future commercial tier uses it as a
per-plan storage lever), the same hybrid-policy posture as GC below.

**Transfer model.** Direct authenticated transfer to the server (the app server
IS the storage on the shipping container tier; "presigned-URL-style" from the
old 8.3 applies only to a future object-storage tier). Upload: client computes
the hash, does a cheap existence check (HEAD or a check endpoint) and uploads
the bytes ONLY if the server lacks that hash (so dedup saves BANDWIDTH, not
just storage, and a retried upload of an existing hash is a no-op). Because
video is first-class, large uploads are RESUMABLE (upload in parts the server
reassembles into the single blob; resume from the last acked part after an
interruption) and downloads support HTTP RANGE requests (so the platform can
stream video and resume partial downloads). Resumable transfer of a whole blob
is a TRANSFER-layer concern and does not change the whole-blob storage model;
it is not chunked content-addressing. Storage stays behind an interface
(local disk now, object storage later), unchanged endpoints across backends.

**Garbage collection: reference tracking + hybrid operator policy.** The hard
part, because a wrong reclaim loses irreplaceable media and the server cannot
read the encrypted references inside entities.

- Users never delete a BLOB directly. Users delete ENTITIES (milestones),
  which RELEASE references. This is the only safe primitive: with dedup, a blob
  one entity stops referencing may still be referenced by another (possibly on
  a not-yet-synced device), so "delete the photo" can only ever mean "release
  my reference," never "destroy the bytes."
- Clients report reference add/release; the server maintains per-blob reference
  counts. Zero references is NECESSARY but NOT SUFFICIENT for reclaim.
- Reclaim requires ALL of: (1) zero references, (2) a grace period elapsed
  since last reference activity, and (3) every non-dead device has synced
  (acked) past the cursor point where the blob went to zero, so no
  long-offline device can have added a reference the server has not yet seen.
  Condition 3 uses the `devices` table (the same coordination point sync uses
  for tombstone GC). The dangerous direction is exclusively a long-offline
  device that ADDED a reference the server never saw; conditions 2 and 3
  protect against it. The reverse (offline device still holds a reference the
  server thinks released) merely fails safe (keeps the blob longer).
- A device past an operator-configured DEAD threshold is excluded from
  condition 3 (you cannot wait forever, which is just never-GC). This is the
  one irreducible residual: a blob reclaimed after grace + dead-threshold,
  where the only holder of the original was a device dead longer than the
  threshold. The design makes it rare, bounded, opt-in, and recoverable (next).
- Self-heal: a dangling reference (an entity pointing at a reclaimed blob)
  surfaces as a graceful "media unavailable" placeholder, never a hard error.
  Any device that still holds the original bytes RE-UPLOADS them on next sync;
  because of content-addressing the re-upload lands at the SAME address and is
  idempotent, healing the gap automatically. Data is truly lost only if the
  blob was reclaimed AND no device anywhere still holds the original, a far
  narrower window than "any offline device."
- HYBRID OPERATOR POLICY (the commercial lever): what happens at zero
  references is operator-configured. DEFAULT is RETAIN (never reclaim, zero
  data-loss risk), correct for a self-hoster where storage is cheap and the
  operator controls it. Reclaim-after-grace is the OPT-IN a storage-conscious
  operator (notably the future commercial hosted tier, which pays per GB)
  turns on knowingly. Crucially, the reference-TRACKING machinery is identical
  either way (you must know a blob is at zero regardless); only the action at
  zero differs. So one mechanism serves both tiers, and the safe default
  protects anyone who does not opt in. The reclaim path's correctness bar is
  set by the commercial tier (a premature reclaim loses a photo) even though
  the self-host retain path ships first and is forgiving of tracking bugs (a
  leaked orphan only wastes disk).

**Blob table shape.** Account scope, blob hash (the content address), reference
count (or the reference-tracking state condition 3 needs, including the cursor
point a blob reached zero), size, created time, and last-reference-activity
time (for the grace window). Finalize exact columns at build, but it must carry
enough to evaluate the three reclaim conditions.

**Thumbnails / posters as content (confirming 8.1).** A photo thumbnail and a
video poster frame (or short preview) are each their OWN content-addressed
blob, generated once by the uploading device, referenced by the entity
alongside the full-res/video reference, and uploaded under the blobs-before-
reference rule. Generation is a required, synchronous step on the upload path
(per 8.3's prior note): a generation failure fails the upload cleanly rather
than publishing a reference to a thumbnail that was never made. This fills the
reserved `thumbnail_id` slot from 8.2.

**Pin / un-pin (confirming 8.1).** The download-to-keep control promotes a
lazy-streamed full-res/video blob to locally pinned for guaranteed offline
availability; un-pin reclaims the local space. Pinned full-res is the one thing
that can grow unbounded on a device, so the un-pin control matters. This is a
client-local caching concern, independent of server-side GC.

## 9. Retention

- Sync payloads need no log compaction. In a row-grained DB the database is
  the always-current snapshot: one current row per entity plus tombstones.
- Intents (`intent_events`) are disposable: pure TTL, server prunes past
  `expires_at`. Default 14 days. (File-tier intents keep the same TTL in the
  events directory.)
- Tombstone GC is coordinated via `devices.last_seen_seq`. A tombstone at
  `seq = T` is safe to hard-delete once `min(last_seen_seq)` across the
  account's devices exceeds `T`. To prevent a vanished device from blocking
  GC forever, age out devices inactive past a threshold (placeholder: 90
  days) from the `min`. This settles the current asymmetry (dayGLANCE prunes
  at 90 days, lastGLANCE never prunes) with a deliberate policy.
- Media blobs are reference-counted; a blob with no live referencing row is
  GC'd. Detail the safe-delete timing (analogous to tombstone GC, accounting
  for devices that have not yet seen a reference removal) at the media phase.

## 10. Remote Backup

Remote backup is NOT part of the sync design; it is an orthogonal concern, and
GLANCEvault changes who owns it. Backup is a point-in-time durable copy for
disaster recovery; sync is continuous multi-device convergence. They answer
different questions.

GLANCEvault is all-or-nothing per household (decision 6: tier is
instance-level), so the backup story splits cleanly along the same line:

- File-tier users KEEP app-level remote backup. They have no server, so the
  in-app backup to a file destination is still their only durable off-device
  copy. Unchanged.
- GLANCEvault users: app-level remote backup is killed. The server already
  holds a complete, current, encrypted copy of all household state, so it IS
  the durable off-device copy. Backing it up is the operator's job, standard
  server ops: it is one SQLite file (use Litestream for continuous replication
  to object storage, or a file copy) or a Postgres dump (`pg_dump`). Anyone
  running a container is expected to back up their own database; re-introducing
  an in-app WebDAV backup would resurrect the exact file-tier dependency the
  backend retires. So for backend users the in-app backup feature goes dormant
  and backup becomes a server-ops task, which also simplifies their mental
  model: the container holds everything, back up its volume, done.

Zero-knowledge carries through for free, as long as the backup operates on the
STORED layer. The database holds ciphertext (the Phase 2.7 envelopes), so a
database backup, a Litestream replica, or a `pg_dump` is also ciphertext and
can be shipped to any object store without leaking anything. The passphrase
never leaves the clients. Do not design a "backup" that decrypts first.

Note on what the server does and does not protect against: the server reduces
but does not eliminate backup's value even for backend users. It is a single
point of failure (hence the operator backing up its volume), and corruption
introduced on a client syncs TO the server, so the server copy is not immune
to a client-side data bug. Operator-side database backups (especially
point-in-time replication like Litestream) cover both cases.

## 11. Related Client Bugs (context, fixed separately)

Surfaced by the sync audit, fixed ahead of the backend, in current shipping
code, because they affect file-tier users today:

- dayGLANCE: recurring task templates lacked a modification timestamp. Fix:
  stamp `lastModified` on recurring mutations. Full fix (insert-only
  completion rows) folds into this spec's schema.
- dayGLANCE: habits used `Date.now().toString()` as ID. Fix:
  `crypto.randomUUID()`, forward-only.
- lastGLANCE: category and chore reorders wrote `sort_order` without bumping
  `updated_at`. Fix: bump `updated_at` on reorder.

## 12. Build Phases

Phases 0 through 2 prove the server on real data before any app code changes,
because the server stores opaque bytes and cannot tell real ciphertext from
random data. The intents transport (Phase 6) lands after both dayGLANCE and
lastGLANCE are on database sync, because intents are cross-app and fully
exercising them needs two apps on the backend. Media (Phase 7) lands right
before the lifeGLANCE cutover (Phase 8), since media is not relevant until
lifeGLANCE. Both are deliberately kept out of the high-risk sync engine work
(Phase 3) since they are lower-risk additions. App cutover order is
lastGLANCE, then dayGLANCE, then lifeGLANCE.

The lifeGLANCE cutover is gated on MEDIA (Phase 7), not on Lives. lifeGLANCE
is the media app, and lifeGLANCE-on-backend-without-media would be a confusing
half-state, so it cuts over all at once (structured sync plus media together).
The cutover is deliberately NOT gated on the Lives feature: the goal is to
ship GLANCEvault across the suite before the large Lives effort begins.
When Lives lands later, it adds an in-envelope `life_id` attribute, which is
additive and syncs automatically through the field-agnostic merge with no
backend change and no re-cutover. This is the same move already proven when
`media_id`/`photo_id`/`thumbnail_id` were added to lifeGLANCE milestones (see
section 8.2). The one thing to watch is not `life_id` itself but whatever else
a big Lives effort touches; landing that on a live backend rather than the
file tier is a known, accepted tradeoff of shipping the backend first.

Why intents cannot move per-app, and what runs during the transition: intents
are the cross-app channel between dayGLANCE and lastGLANCE. If sync moved an
app's intents to the backend at the same time as its sync, then during the
window where lastGLANCE is on the backend but dayGLANCE is still on WebDAV,
the two apps would be writing to two different intent mailboxes and the
cross-app channel would be severed (a dayGLANCE completion written to WebDAV,
a lastGLANCE looking for it on the backend). So intents stay on WebDAV for ALL
users through Phases 4 and 5, regardless of sync transport, and move globally
in one coordinated step at Phase 6. A backend-sync user keeps WebDAV intents
the entire time; that is the designed transition config (see decision 6).

The Phase 6 intents cutover is much softer than the sync cutovers, because
intents are TTL-disposable (14 days, no durable history). There is no
backfill, no losslessness test, no migration. The flip can even tolerate a
brief both-transports-active period: new intents write to the backend while
any in-flight WebDAV intents drain or harmlessly expire within the TTL window.
A missed intent is low-stakes and re-triggerable, so Phase 6 should not be
over-engineered to the sync cutover's standard.

- Phase 0: Server skeleton. New repo, SQLite-backed, the three-table schema,
  health check, config-file device-token auth, containerized. Stands up and
  holds tables; does nothing useful yet. Designed to host sync, intents, and
  later media, but no transport is implemented yet.
- Phase 1: Sync transport endpoints, proven with synthetic blobs. list-since-
  cursor, upsert batch, get, `seq` assignment. Hammer with garbage-byte
  envelopes. Proves `seq` monotonicity, idempotency on `entity_id`, and
  `ON CONFLICT`. No crypto, no client, no real data.
- Phase 2: Read-only losslessness test (the centerpiece dogfood). A one-off
  script reads the current file-tier sync payload, shreds it into rows, seeds
  the server, pulls rows back, reassembles, and diffs against the original.
  Read-only against real production data; the apps never touch the server.
- Phase 3: DB sync transport in the client, behind the existing interface,
  selectable (not a replacement). Includes the engine rewrite (per-entity
  dirty tracking, seq-mismatch reconciliation, partial-write safety,
  push-on-write per section 6.5) and the per-row crypto change (one envelope
  per row, salt fetched from the server). The heart of the project and the
  main risk. Delivery is POLLING here (cursor-based incremental reads); real-
  time server push is deliberately deferred to Phase 9 so it does not bloat
  this already-hard, already-risky phase. File tier stays intact as fallback.
- Phase 4: Cut over lastGLANCE sync first (lower stakes, cleaner data model,
  insert-only completions already). Retain the file-tier payload untouched as
  backup. Run real multi-device for a week or two.
- Phase 5: Cut over dayGLANCE sync once lastGLANCE has proven the path. Same
  posture: retain the file payload, delete nothing.
- Phase 6: Intents transport. NOT one step: (a) server endpoints in
  `glance-vault` (insert-only write, list-since-cursor, TTL prune over the
  Phase-0 `intent_events` table); (b) codec helpers in `glance-intents`
  (`buildIntentRow`/`parseIntentRow`/`parseSince`/`formatSince`), since the
  package is a CODEC, not a transport (see section 7.2); (c) app-owned
  transport in each app (send, receive cursor, paginated drain, transport
  selection); (d) a durable OUTBOX in each app so no intent is ever lost
  (section 7.5); (e) always-encrypted enforcement keyed off the sync passphrase
  + vault salt, with plaintext rejected on receive (section 7.4); (f) the
  uniform bounded-retry receive failure model (section 7.6). Feature-detected
  and dual with the file tier; WebDAV intents stay available (not deprecated).
  With both apps on database sync, cross-app intents were exercised end to end
  (round-trip confirmed both directions). The intents salt migration was
  subsumed into the always-encrypted fix (vault intents reuse `/salt/:accountId`).
  Several latent bugs surfaced and were fixed during this phase: plaintext on
  the vault (send and receive), fire-and-forget data loss on every transport, a
  send/receive key-slot mismatch, and a transient-failure-advances-cursor loss
  on receive. (Real-time push for intents is added in Phase 9 along with push
  for sync; until then intents deliver by polling the cursor.)
- Phase 7: Media blob store. Server-side blob storage (abstracted behind a
  storage interface: local disk for the container today, object storage if a
  serverless or hosted deploy is built later), presigned-style byte transfer,
  content-addressed dedup, reference-counted GC, the blob table, and the
  client-side reference, thumbnail generation, and selective caching.
- Phase 8: Cut over lifeGLANCE, structured sync and milestone media together
  via the Phase 7 blob store (gated on media, not on the Lives feature). Same
  retain-the-file-payload posture as the other cutovers.
- Phase 9: Real-time push (SSE). Add real-time push over Server-Sent Events on
  the always-on container for both sync and intents, replacing polling as the
  primary delivery on that tier: a change on one device pushes to others
  instantly, and cross-app intents arrive immediately (e.g. a lastGLANCE
  completion lighting up dayGLANCE the moment it happens). Layered on the proven
  polling foundation as an enhancement, which is why it lands late rather than
  in Phase 3. Polling remains the reconnect/catch-up backstop; nothing is ever
  delivered ONLY by push. Neither the server nor any client has any push
  machinery today (verified: no SSE/WebSocket/EventSource in glance-vault), so
  this is a both-ends build: server-side emission plus client-side consumption.
  See section 14 for the SSE design and the SSE-vs-WebSocket decision.
- Phase 10: File-tier demotion and the GLANCEvault "graduation." Demote the
  file tier (WebDAV/iCloud) to the frozen bring-your-own-Nextcloud/iCloud tier,
  and use this phase to take GLANCEvault out of beta: clean up the settings
  modals/screens across the apps, finalize the Pro tier surfaces, and do the
  positioning work for the paid GLANCEvault Pro (Paddle, Hetzner, the pricing
  already settled in section 13). This is a status/positioning-plus-cleanup
  milestone more than a transport build, which is why it follows the push work
  rather than bundling with it.

Reversibility discipline: never delete a file-tier payload until its app has
run clean on the server for real. Any surprise is then a one-line revert to
the old transport.

## 14. Real-time push design (Phase 9)

### 14.1 Transport decision: SSE now, WebSocket added per-feature later

Phase 9 uses Server-Sent Events (SSE), not WebSocket. The reasoning, recorded so
a future reader does not mistake this for a fork that excluded WebSocket:

The push job here is one-directional: the server tells a client "your account
has new activity, go sync." The client's reply is a NORMAL authenticated HTTP
sync/intent-drain request, the same one it already makes on the poll cadence.
So push only replaces the poll TIMER with an instant NUDGE; it never needs the
client to stream back over the persistent connection, because every
client-to-server need is already an ordinary HTTP request. That is exactly SSE's
model (server to client over plain HTTP, auto-reconnect, rides the existing
auth/CORS/proxy path), and SSE is dramatically simpler to build, debug, and
operate than WebSocket. Hetzner/Caddy support SSE with `flush_interval -1`.

Crucially, choosing SSE does NOT foreclose WebSocket. SSE and WebSocket can run
side by side on the same Node server. Push-for-sync stays on SSE (where a
one-directional notification belongs, forever); if a genuinely bidirectional
real-time feature is ever built, it gets a WebSocket endpoint added surgically
for that feature, without disturbing the SSE sync-push. The architecture is
therefore "SSE for notifications; WebSocket added per-feature for true
bidirectional real-time," and Phase 9's SSE choice is the correct right-sized
tool for sync-push regardless of what collaboration features come later.

### 14.2 Future use cases and when WebSocket would be added

Every collaboration feature currently envisioned for the suite is
server-to-client notification plus HTTP writes, i.e. SSE-solvable: shared Lives
and family timelines in lifeGLANCE, shared household state in lastGLANCE,
aggregated team-progress sharing in goalGLANCE, share-token collaboration across
the suite, and lifeGLANCE Studio hosted-export "your export is ready"
notifications. All of these are "someone writes via HTTP, others are nudged to
sync": SSE.

WebSocket becomes the right tool only for TRUE bidirectional real-time, which in
this suite would most naturally appear as:
- Live presence ("who is active / here / doing this right now"), most natural
  in lastGLANCE (household: who is doing which chore now) and goalGLANCE (team:
  who is active during a check-in). Presence is continuous bidirectional status,
  which SSE-plus-HTTP-heartbeat only approximates awkwardly. This is the single
  most WebSocket-native pattern in the suite.
- Live co-editing with cursors/positions, meaning simultaneous editing of a shared
  artifact seeing each other live (Figma/Docs style): possible if dayGLANCE
  shared calendars, lifeGLANCE Studio collaborative memorial/wedding projects,
  or goalGLANCE team boards ever grow into live co-editing rather than
  async state-sharing.
- Live team sessions in goalGLANCE, everyone in a shared live view during a
  standup, with real-time presence and reactions.
- Sub-second claim/lock races (e.g. lastGLANCE "I've got the trash" claimed
  instantly so two people don't collide), borderline; SSE-solvable but a case
  where WebSocket's bidirectionality is cleaner.

None of these are near-term (Phase 9 is sync-push only; collaboration is later).
When any of them is scoped, WebSocket is the expected tool and is ADDED alongside
the SSE push, not in place of it. So SSE now is not a limitation.

### 14.3 Push design (nudge-only, polling-backstopped)

- NUDGE-ONLY: push carries only a signal ("account X has new activity" / a new
  seq is available), NOT the encrypted payloads. The client responds by running
  its existing authenticated sync/intent-drain. This keeps push dumb, reuses the
  proven sync/drain machinery unchanged, and keeps the zero-knowledge story
  clean (push carries no plaintext, just "go look").
- POLLING IS THE BACKSTOP, ALWAYS: push is an optimization, not a delivery
  guarantee. A device that is connected drains on nudge; a disconnected device
  (backgrounded, mobile, network drop) falls back to polling and catches up on
  reconnect. Nothing is delivered only by push, so if push breaks, delivery
  degrades to today's working polling; the correctness backstop is untouched.
- SERVER-SIDE: an in-process pub/sub keyed by account_id maps to that account's
  connected SSE connections; a write (new seq, or a landed intent) emits a nudge
  to the account's connections. Single-container in-memory pub/sub is simple;
  push at multi-tenant scale (many persistent connections, horizontal scaling of
  stateful connections) is the hard part and defers with the paid product
  (section 13), not Phase 9.
- SCOPE: vault tier only (the file tier stays polling/frozen), suite-wide across
  all three apps, covering BOTH sync and intents.
- BUILD SEQUENCE: server-side SSE emission first (hold connections, emit nudges
  on writes, proven in isolation), then one app consumes it end to end
  (nudge to sync/drain), then roll to the other two, the same server-first,
  one-app-slice, then-propagate discipline used for the blob store and the
  cutovers.

## 13. Deferred / Out of Scope (recorded so it is not lost)

- Paid hosted product: **no longer deferred.** Prerequisites, blockers, and
  open decisions are tracked in the separate GLANCEvault Pro Prerequisites and
  Build Notes document. Retained here for context: the hosted version scopes
  multiple households via `account_id`, each still internally trusted, and the
  shared-schema tenancy model is settled (see that document). A paid tier run
  on the SAME always-on container architecture preserves real-time push for
  free (it is the identical server plus an operations and billing layer). The
  push capability is free; push at multi-tenant scale (many persistent
  connections, horizontal scaling of stateful connections) is the part that
  takes real engineering, and launch shape is single-replica as a result.
- Real authentication system: multi-tenant registration and credential
  storage. **Superseded for the hosted product** by item 1 (per-account
  credential binding) and item 6 (key-to-account indirection) in the Pro
  prerequisites document. Still accurate for self-host: device-to-server auth
  for a single-user self-hosted instance is a config-file token, not a system,
  and that model must keep working after Pro ships.
- Tier downgrade (backend to file tier) with existing media: an edge case,
  since media cannot exist on the file tier. Out of scope for now.
