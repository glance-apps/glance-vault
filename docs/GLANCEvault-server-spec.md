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
  assignments and entity types. Lives need zero schema change. (Per-Life
  export-as-artifact is a v3.0 client concern, independent of sync.)

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
   enabled. (See section 11 for why intents cannot move per-app: they are the
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

### 3.2 Three tiers behind one interface

| Tier | Backend | Cursor | Dedupe | Reads | Push | Media |
|---|---|---|---|---|---|---|
| File | WebDAV, iCloud Drive | synthetic (time + filename) | client-side | list-and-filter | no | no |
| Serverless | Vercel + Postgres + object storage | real `seq` | server-side | indexed incremental | no | yes |
| Always-on | self-hosted container | real `seq` | server-side | indexed incremental | yes (SSE/WS) | yes |

All three satisfy the same client transport interface. Clients branch on a
capability flag, never on backend identity. Most "rich" features need only a
database, not a live connection; only push (and media streaming) require an
always-on process. This is why a Vercel deploy is a real upgrade over the
file tier and not merely "WebDAV again," even though it polls rather than
pushes.

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
  push: boolean;           // SSE/WebSocket. File and Vercel: false
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

What the database backend offers that the file tier cannot. Split by tier,
because some need only a database (so they also work on Vercel) and some need
the always-on container.

### Database-tier (self-hosted container AND Vercel/Postgres)

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

### Always-on-tier only (self-hosted container, not Vercel)

- Real-time push (SSE/WebSocket): instant sync and instant cross-app intents
  instead of polling. This is what makes the suite feel alive, a dayGLANCE
  completion lighting up lastGLANCE immediately.
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

### 5.2 SQLite vs Postgres

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

### 7.2 Why this is the easy shape

Intents are pure insert-only TTL events: no merge, no conflict resolution.
They are essentially the insert-only completion rows with an expiry. The
`@glance-apps/intents` package is already transport-abstracted, so adding a
database transport is cheap. Two free upgrades over the file tier: cursor-
based delivery (`seq > cursor`) instead of list-and-filter, and on the
always-on tier, push, so cross-app nudges arrive instantly.

### 7.3 Dual transport, per user

This is per-user, not a codebase removal. `@glance-apps/intents` stays
dual-transport and feature-detected, exactly like sync. File-tier users keep
file-tier intents (and the Tasker contract is independent of either, per
7.1). GLANCEvault is the everything-replacement for the user who opts in.

### 7.4 Salt migration

Intents crypto currently derives from an intents-owned root key with the root
salt stored on the WebDAV endpoint. On the database tier that salt moves to
ordinary server state (per section 3.4). Same HKDF-per-envelope scheme,
different storage location for the salt.

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

### 8.3 Open implementation details (to detail at the media phase)

- Byte transfer pattern: bytes should flow directly between client and
  storage via presigned-URL-style transfer rather than through application
  logic. This sidesteps serverless function size and timeout limits and is
  more efficient. The server mediates references and auth; bytes do not
  transit app code.
- Blob storage abstracts like the database: local-disk volume on the
  self-hosted container, object storage (S3/R2/Vercel Blob) on the serverless
  tier. Keep blob access behind an interface like the SQLite/Postgres split.
- Blob table shape (account scope, hash, refcount or reference tracking,
  size, created time) to be finalized at the media phase.
- Upload path: thumbnail generation is a required step on the upload path,
  not a deferred background nicety, because the thumbnail is content the rest
  of the household depends on. The "add media" flow must handle generation
  failure (corrupt image, unsupported format) by failing the upload cleanly
  rather than publishing a reference to a thumbnail that was never made.
- Pin / un-pin control surface: the download-to-keep option promotes a lazy-
  streamed full-res blob to locally pinned (guarantees offline availability,
  e.g. on a flight); the inverse un-pins and reclaims space. Pinned full-res
  is the one thing that can grow unbounded on a device, so the un-pin control
  matters. Exact UX to detail at the media phase.

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

## 10. Related Client Bugs (context, fixed separately)

Surfaced by the sync audit, fixed ahead of the backend, in current shipping
code, because they affect file-tier users today:

- dayGLANCE: recurring task templates lacked a modification timestamp. Fix:
  stamp `lastModified` on recurring mutations. Full fix (insert-only
  completion rows) folds into this spec's schema.
- dayGLANCE: habits used `Date.now().toString()` as ID. Fix:
  `crypto.randomUUID()`, forward-only.
- lastGLANCE: category and chore reorders wrote `sort_order` without bumping
  `updated_at`. Fix: bump `updated_at` on reorder.

## 11. Build Phases

Phases 0 through 2 prove the server on real data before any app code changes,
because the server stores opaque bytes and cannot tell real ciphertext from
random data. The intents transport (Phase 6) lands after both dayGLANCE and
lastGLANCE are on database sync, because intents are cross-app and fully
exercising them needs two apps on the backend. Media (Phase 7) lands right
before the lifeGLANCE cutover (Phase 8), since media is not relevant until
lifeGLANCE. Both are deliberately kept out of the high-risk sync engine work
(Phase 3) since they are lower-risk additions. App cutover order is
lastGLANCE, then dayGLANCE, then lifeGLANCE, so that Lives are established
before lifeGLANCE moves.

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
  dirty tracking, seq-mismatch reconciliation, partial-write safety) and the
  per-row crypto change (one envelope per row, salt fetched from the server).
  The heart of the project and the main risk. File tier stays intact as
  fallback.
- Phase 4: Cut over lastGLANCE sync first (lower stakes, cleaner data model,
  insert-only completions already). Retain the file-tier payload untouched as
  backup. Run real multi-device for a week or two.
- Phase 5: Cut over dayGLANCE sync once lastGLANCE has proven the path. Same
  posture: retain the file payload, delete nothing.
- Phase 6: Intents transport. Implement the database intents transport in
  `@glance-apps/intents` (insert-only writes to `intent_events`, cursor
  delivery, push on the always-on tier), feature-detected and dual with the
  file tier. With both apps on database sync, exercise cross-app intents end
  to end. Migrate the intents salt to server state.
- Phase 7: Media blob store. Server-side blob storage (abstracted: local disk
  for the container, object storage for serverless), presigned-style byte
  transfer, content-addressed dedup, reference-counted GC, the blob table,
  and the client-side reference, thumbnail generation, and selective caching.
- Phase 8: Cut over lifeGLANCE sync (after Lives are established in the app),
  with milestone media via the Phase 7 blob store. Same retain-the-file-
  payload posture.
- Phase 9: Demote the file tier to the frozen tier for bring-your-own-
  Nextcloud self-hosters. Write the Vercel deploy guide against the proven
  server.

Reversibility discipline: never delete a file-tier payload until its app has
run clean on the server for real. Any surprise is then a one-line revert to
the old transport.

## 12. Deferred / Out of Scope (recorded so it is not lost)

- Paid hosted product: billing, sign-up, multi-tenant separation of untrusted
  users. The hosted version would scope multiple households via `account_id`,
  each still internally trusted.
- Real authentication system: multi-tenant registration and credential
  storage. Near-term, device-to-server auth for a single-user self-hosted
  instance is a config-file token, not a system.
- Per-Life export-as-artifact (lifeGLANCE v3.0): the memorial/gift use cases
  may imply a per-Life encryption boundary rather than one household key.
  This is a client-side export concern, independent of the sync backend, and
  is fleshed out later.
- Tier downgrade (backend to file tier) with existing media: an edge case,
  since media cannot exist on the file tier. Out of scope for now.

---

## Milestone 0 Code Prompt

```
Stand up a new standalone server for GLANCEvault. This is Phase 0 only:
skeleton, schema, health check, device-token auth, containerized. It should
build, run, hold tables, and authenticate a device token. It does NOT yet
implement sync, intents, or media endpoints (those are later phases).

Work in a NEW repository (suggested name: glancevault), separate from the app
repos. Use main as the working branch and do the work on a feature branch off
main, then commit so I can sync state across Claude desktop and Code.
Throwaway branch is fine.

Stack: pick a small, boring, well-supported stack suited to a single-binary
or single-container self-hosted server (Node/TypeScript or Go are both fine;
choose one and justify in one line). SQLite as the storage backend for this
phase. Keep storage access behind a thin interface so Postgres can be added
later without touching handlers.

Build:

1. Schema and migrations for three tables, exactly as below. envelope is an
   opaque byte column; the server never parses it.

   sync_rows:
     account_id   TEXT      NOT NULL   -- household/instance scope
     app          TEXT      NOT NULL   -- e.g. 'dayglance', 'lastglance', 'lifeglance'
     entity_id    TEXT      NOT NULL   -- stable client UUID
     seq          INTEGER   NOT NULL   -- server-assigned monotonic per account
     envelope     BLOB      NOT NULL   -- opaque encrypted bytes
     deleted      INTEGER   NOT NULL DEFAULT 0
     server_mtime TEXT      NOT NULL   -- ISO timestamp
     PRIMARY KEY (account_id, app, entity_id)
   Index on (account_id, app, seq).

   intent_events:
     account_id   TEXT      NOT NULL
     event_id     TEXT      NOT NULL   -- client UUID
     seq          INTEGER   NOT NULL   -- server-assigned monotonic per account
     envelope     BLOB      NOT NULL   -- opaque encrypted bytes
     expires_at   TEXT      NOT NULL   -- ISO timestamp, TTL
     server_mtime TEXT      NOT NULL
     PRIMARY KEY (account_id, event_id)
   Index on (account_id, seq).

   devices:
     account_id    TEXT    NOT NULL
     device_id     TEXT    NOT NULL
     last_seen_seq INTEGER NOT NULL DEFAULT 0
     last_active   TEXT    NOT NULL
     PRIMARY KEY (account_id, device_id)

2. A per-account monotonic seq source (e.g. a counter row or table) bumped
   inside the same transaction as a write. Not used yet, but build the helper
   and unit-test that concurrent bumps stay monotonic.

3. Config loaded from a file and/or env: storage path, listen port, and a
   single device auth token (a shared secret). No registration, no user
   model, no multi-tenant logic.

4. Device-token auth middleware: requests present the token (Authorization
   header, Bearer), middleware rejects anything else with 401. Single valid
   token from config is enough for this phase.

5. GET /healthz returning 200 with a small JSON body (status, version,
   schema version). No auth required on this endpoint.

6. Dockerfile and a docker-compose example that runs the server with a
   mounted volume for the SQLite file and the token supplied via env. It must
   start clean on an empty volume (run migrations on boot). The compose
   example should reflect that all three GLANCE apps will point at this one
   server.

7. A README section: how to configure the token, run via compose, and hit
   /healthz. Follow the no-em-dash convention in all docs and comments.

Do NOT:
- Implement any sync, intents, or media endpoints. Those are later phases.
- Add a media/blob table in this phase. Its design is not finalized.
- Implement any crypto, key handling, salt storage, or envelope parsing. The
  server treats envelope as opaque bytes forever.
- Add any user registration, account creation, billing, or multi-tenant
  separation. account_id is just a column for now.
- Add SSE/WebSocket/push.
- Add Postgres in this phase, but keep the storage interface clean enough
  that adding it later does not touch request handlers.
- Use em dashes anywhere in code comments, docs, or commit messages.

Deliver:
- The feature branch committed, with a short commit per logical piece
  (schema/migrations, seq helper, auth + health, docker).
- A one-paragraph summary: stack chosen and why, how to run it, and
  confirmation that /healthz works on a fresh empty volume.
- Confirm the seq monotonicity unit test passes.
```
