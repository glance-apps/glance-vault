_Working notes for the hosted, paid GLANCEvault service. Not for the public repo._

## Current state (the baseline Pro builds on)

The self-hosted vault's trust boundary is **the instance, not the human**: one instance-wide device token, `accountId` supplied as a request parameter. This is correct and safe for self-hosting: a single household/trusted operator running their own instance. It is **not** a defect; it's the right scope for that deployment, and the shipped hardening (per-IP rate limiting, global SSE cap, log redaction, per-account blob dedup, upload-session reaper) matches that model.

Everything below is what changes when _mutually-untrusting users share one instance_. Hosted launch is gated on items 1, 2, 3, 5, and 6. Item 4 is strongly recommended alongside and constrains launch copy (see item 4). Item 7 is operational rather than architectural but must exist before the first paying customer.

## Go/no-go: whether to operate a hosted service at all

**This decision has not been made and does not need to be made yet. Nothing below commits to it until the point marked out here.**

Two different commitments are easy to blend together and should not be:

- **Building GLANCEvault** is shipping software. It gets written, it works, it is done. Walking away breaks nothing for anyone.
- **Operating GLANCEvault Pro** is running a production service. Continuous obligation, custody of other people's data, solo operation alongside a demanding day job, customers who can email when it breaks, and no clean exit once someone has paid.

Every hard thing in this document belongs to the second commitment.

**The decision point: after items 1, 2, and 3 land, before starting item 5 (billing), item 7 (DR), or provisioning the Hetzner and Postgres deployment.**

Items 1, 2, and 3 improve the free self-hosted product on their own merits. Per-device credentials, individual revocation, and usage accounting are worth having in a household deployment whether or not anything is ever sold. Building them costs nothing in optionality and leaves a better free product either way. Item 6 is Pro-specific but cheap and worth doing alongside. Everything past that point is spend, custody, and commitment.

**Information available at the decision point that is not available now:**

- The actual effort cost of the multi-user work, measured rather than estimated.
- Whether App Store revenue from the three apps is materializing, which changes how much this tier needs to earn.
- Whether users are actually asking for hosted sync, versus it being assumed demand.

**Point of no return: accepting the first payment.** After that, custody is real and withdrawal has a cost to other people.

**The honest comparative read:** hosted GLANCEvault is a legitimate business, but it is the most operationally demanding item on the roadmap and close to the least differentiated (sync is a commodity compared on price), and it carries custodial responsibility for the smallest revenue per unit of risk of anything being built. At USD 29.99 a year, one hundred subscribers is roughly USD 3,000 gross before Paddle's cut and hosting.

**The lower-risk alternative already on the roadmap:** lifeGLANCE Studio is software sold rather than a service operated. No custody, no database to keep alive, no incident that begins with an email. If the goal is revenue that does not route through Apple or Google, Studio reaches it without the operational tail, and it is more differentiated than sync. Studio and Pro are not mutually exclusive, but if only one gets built, this is the argument for which.

## 1. Per-account credential binding · **BLOCKER** · _client coordination: minimal_

Today any token-holder can act on any account by varying `accountId`; data-layer scoping is correct but nothing binds a token to an account.

Build: issue a credential **per device, bound to an account**, derive the operative `accountId` **from the authenticated credential server-side**, validate/reject any client-supplied `accountId` that mismatches. Every handler (batch, list, row-GET, soft-delete, salt, blobs, SSE).

_Per-device rather than per-account: RESOLVED._ An account is a shared data set, not a person, so a household is one account, one subscription, one license key, and any number of devices. Credentials must therefore be per device, otherwise revoking one lost phone forces a reissue for everyone in the household. Enrollment: the user pastes the license key once per device, the device exchanges it for its own credential bound to the household account, and **the device then discards the key**. Retaining the key on the device defeats revocation entirely, since whoever holds a stolen phone would simply re-enroll. Two people wanting genuinely separate private data need separate accounts and separate subscriptions, which is the correct outcome rather than a loophole, since two accounts consume two accounts' worth of storage.

_Product note for site copy:_ everything on an account is visible to every device on that account. There is no partial-sharing model. The honest framing is that GLANCEvault syncs a household's data, and separate private data means a separate account. Expect this question and answer it plainly rather than letting people discover it.

Closes two sub-issues for free:

- **Salt squatting.** First-write-wins `PUT /salt/:accountId` lets a hostile caller pre-seed a bogus salt; per-account creds mean only the owner writes its salt.
- **Cross-account writes/deletes.** These need no key and are immediately destructive (E2E does _not_ mitigate this; it only protects read confidentiality, leaving ciphertext + plaintext entityIds exposed on cross-account reads).

_Client note:_ dayGLANCE already sends a Bearer token + `accountId`; the wire shape is forward-compatible. The client change is only _what token it sends_ (per-account instead of shared), no protocol rework. Low lead time.

_Implementation note:_ the handler list above is a list of places to get right, and the failure mode for missing one is a cross-tenant breach. Prefer structural enforcement over an audit checklist: a scoped data-access handle constructed from the authenticated credential, so that an unscoped query is not expressible rather than merely not written. If hosted runs Postgres, row-level security sits underneath that as a database-enforced backstop. Ask Code to report where an unscoped query is currently constructible before changing anything.

## 2. Token revocation & containment · **HIGH** · _client coordination: confirm terminal-state handling_

No revocation path today; rotating the shared token 401s the whole fleet.

Build: credential store with per-device/per-account issuance and **individual revocation** (revocation list, or short-lived tokens + refresh). Define consistent 401/403 on revoked creds.

_Client note:_ clients already treat 401/403 as terminal (they stop and require re-auth). Confirm that behavior produces a clean re-enroll UX rather than a dead-end error when _one_ device is revoked mid-session. Possible small client-side "re-authenticate" affordance.

## 3. Per-account quotas, caps & usage accounting · **HIGH** · _client coordination: over-quota UX_

No per-tenant limits; one tenant can exhaust shared disk/connections. The shipped rate-limiter and caps are process-wide backstops, not per-tenant fairness.

Build: per-account quotas covering stored bytes (envelopes + blobs), row/entity counts, intent volume, concurrent uploads, SSE connections, with clear over-quota responses (413/429). **Requires identity from #1.**

_This is also your billing foundation._ Per-account usage accounting is what you meter and charge on, so it's likely the first thing built, not the last. Record usage metrics from day one even before enforcing limits.

_Client note:_ clients need to handle 413/quota-exceeded gracefully (surface "storage full / upgrade" rather than a generic sync failure). This is net-new client UX with real lead time.

_Scale note:_ the shipped rate-limiter and SSE caps are **in-memory per-process**. A multi-replica hosted deployment needs shared state (Redis or similar) or proxy-level enforcement; the current implementation won't coordinate across instances.

_Seat caps: decided against._ Seats are a proxy for resource consumption, and the resources are meterable directly (stored bytes, SSE connections, request rate), so the proxy adds nothing. Three supporting reasons: (a) `account_id` is household scope by design, so multi-device and multi-person use within a household is the intended model, not abuse; (b) key sharing is self-deterring, because sharing a key means sharing a namespace and therefore exposing your own data to whoever you shared with, which is categorically unlike sharing a streaming password; (c) enforcing seats would require device-identifying data, which cuts against the product positioning. Retain a **per-account concurrent SSE cap** as abuse containment, documented as such rather than as licensing. The `devices` table's client-generated `device_id` (used for GC cursors) is sufficient identity for that and is not a fingerprint.

_Tiering note:_ if paid tiers are ever introduced, tier on **stored bytes**. It tracks actual hosting cost and it maps to the real usage gradient: a dayGLANCE task user consumes almost nothing, a lifeGLANCE family-history user with scanned photo archives consumes almost all of it. Media is backend-only (spec decision 8), so lifeGLANCE media users are Pro users by necessity and are the population quota sizing should be built around.

## 4. Metadata minimization · **MEDIUM** · _client coordination: REQUIRED, protocol-level_

Even with perfect isolation, a hosted operator sees plaintext `entityId`s (`dailyNotes:2026-07-10`, `tasks:<uuid>`, `singleton:deletedTaskIds`), per-row seqs/timestamps, blob sizes/hashes, intent TTLs, revealing which dates have notes, task counts, deletion activity, media presence/sizes per account. Inherent to the design; the log-redaction change removed it from _logs_ only, not from what the DB holds. A real privacy exposure for a "zero-knowledge" product under an _untrusted_ operator (you).

Build: opaque/hashed row keys instead of semantic entityIds, blob-size padding/coarsening, minimized plaintext intent routing.

_Client note:_ **cannot be done server-side alone.** It is a protocol change spanning client and server, and it interacts with flows that depend on today's key shapes: quarantine-healing single-row GET, the salt-probe, and tombstone LWW. Must be co-designed with the sync-client roadmap and scoped explicitly against those behaviors. Longest lead time of the four.

_Copy and policy constraint:_ this is the same shape as the iCloud carve-out already made in the privacy audit, a zero-knowledge claim that holds for content and does not hold for metadata. Because item 4 has the longest lead time and hosted launch should not wait on it, the launch copy and privacy policy must be carved to claim only what ships. Concretely, until item 4 lands, GLANCEvault Pro cannot be described as zero-knowledge without qualification; the accurate claim is that the operator holds ciphertext and cannot read content, while row keys, timing, and blob sizes remain visible. Decide this before any Pro copy goes on glance-apps.com, not after.

## 5. Entitlement state machine (billing lifecycle) · **BLOCKER** · _client coordination: REQUIRED_

Distinct from item 2 and must not reuse it. Item 2 is credential revocation (lost device, re-enroll). This is subscription state: active, grace, lapsed, refunded, charged-back.

The governing constraint is spec decision 7: a lapsed GLANCEvault degrades to "no sync," not "no app." Clients treat 401/403 as terminal auth failure and will surface a re-authenticate flow, which is the wrong response to an expired card. Lapse therefore needs a **third client state**, distinct from both authenticated and auth-broken.

Build:

- Distinct status for entitlement lapse. `402 Payment Required` is semantically exact and effectively unused in the wild, so it carries no collision risk; alternatively `403` with a machine-readable reason code. Do not use `401`.
- **Lapse behavior: pull allowed, push rejected.** Devices continue converging on data already paid for, and lapsing never destroys or strands anything.
- Retention ladder: full service, then grace, then pull-only, then deletion after explicit advance warning. Deletion must be announced and explicit because the data is unrecoverable by the operator under any circumstance.
- Chargeback halts entitlement immediately but follows the same retention ladder. Do not couple a fraud signal to immediate data destruction.
- Paddle webhook handling for renewal, cancellation, payment failure, refund, and chargeback events, mapping each to a state transition.

_Client note:_ net-new UX with real lead time. Needs a lapsed-but-authenticated state in the sync client that reads as a billing problem rather than a broken connection, and it should compose with the over-quota UX from item 3 rather than duplicate it.

## 6. Key-to-account indirection and rotation · **BLOCKER** · _client coordination: minimal_

The original license-key-as-identity sketch had the license key serving directly as the account ID. That is incompatible with revocation: when a key leaks or must be reissued, identity-equals-key means rotation orphans the namespace and the user loses their data.

Build: the license key **maps to** a stable internal `account_id` rather than being it. Rotation reissues a key and rebinds the mapping, leaving `account_id` and all data untouched. One indirection, cheap now, structural surgery later.

This is a requirement rather than a nicety because of the observation in item 1: E2E does **not** mitigate writes and deletes. A leaked key holder can destroy an account's data without ever possessing the passphrase, because writes require no decryption. Rotation is the containment path for that scenario, and without indirection there is no rotation.

_Client note:_ the client stores whatever key the user pastes; rebinding is server-side. The only client-visible change is that entering a reissued key resumes the same account rather than starting an empty one.

## 7. Hosted disaster recovery · **HIGH** · _client coordination: none_

Spec section 10 assigns database backup to the operator, which is correct for self-hosting. In hosted, the operator is you, and the custodial position changes: users have no other copy of server-side state and the data is unrecoverable without their passphrase, so an operator-side loss is permanent for them.

Compounding factor: spec section 13 notes that push at multi-tenant scale is the part requiring real engineering, and the scale note in item 3 above confirms the rate-limiter and SSE caps are per-process. Launch shape is therefore single-replica, which makes one Hetzner box a single point of failure for a paid service.

Build:

- Continuous backup to object storage with point-in-time recovery. Postgres path is WAL archiving plus periodic base backups (pgBackRest or WAL-G). Litestream, named in spec section 10, applies to the SQLite self-host path only and is not the hosted mechanism.
- A **tested restore**, not a configured backup. Restore drill before the first paying customer, then quarterly: restore onto a scratch server and confirm real data comes back.
- **The restore drill is not delegable.** Implementation is delegated to Code and cannot be verified by reading it, so a backup that has been silently failing for months is invisible until it is needed. Behavioral verification is the only real confirmation. Everywhere else in this build that constraint is a mild inconvenience; for backups it is the whole thing.
- **Disk-space alerting at 70%.** The most common death of a self-managed Postgres is a full disk, at which point the database stops accepting writes. This is the single highest-value alarm here because storage grows with customer media.
- Zero-knowledge carries through for free as long as backup operates on the stored (ciphertext) layer, per spec section 10. Do not design a backup that decrypts.
- Decide and publish an availability posture. A paid service on one box is defensible at this scale if stated plainly; it is not defensible if implied otherwise.

_Ongoing burden, stated honestly:_ one to two evenings of setup, then roughly one to two hours per quarter for the restore drill and monitoring review, plus about half a day per year for a Postgres major-version upgrade, plus the tail risk of an incident arriving at an inconvenient time with no second person to hand it to. Minor security updates are a container image bump. OS patching is largely automatic.

## Cross-cutting: back-compat with existing self-hosters

When Pro introduces per-account credentials, the **self-hosted shared-token model must keep working**; existing self-hosters can't be forced to migrate. Server mode flag: `AUTH_MODE=shared|per-account`, defaulting to `shared` so existing deployments are unaffected by upgrade.

## Repository split: RESOLVED

**Auth lives in the OSS repo behind the `AUTH_MODE` flag. Billing and Paddle integration live in a separate private repo.**

Rationale for auth staying public:

- The scoping refactor in item 1 is cross-cutting, threaded through every handler, and lands in the public server regardless of who ships the credential logic. Only the small verify-credential-and-return-account piece could ever have been separated, and once the refactor is public that remainder is not worth protecting.
- Hidden auth code is a liability rather than an asset. The product's claim is that people can read the code holding their data, and that claim is strongest when the hosted service demonstrably runs the same server. Nothing about comparing a token against a stored hash gives an attacker leverage.
- Two codebases drift, and drift in auth code is the expensive kind. One person cannot maintain two auth paths against one sync protocol indefinitely.
- The protection would be imaginary anyway: GLANCEvault is MIT-licensed, so anyone wanting to run a competing hosted version can fork it today and write their own auth. The moat is the three apps and the brand, not the server.

_Not a package._ A shared package was considered and rejected. The existing `@glance-apps/sync`, `billing`, and `intents` packages each serve multiple client apps, which is what makes a package pay for itself. Vault auth has exactly one consumer, so a package would add publishing and version-matching overhead with no sharing benefit. Billing goes in a private repo rather than a private package for the same reason.

Rationale for billing staying private: it is operational rather than architectural, involves secrets and webhook endpoints, and is useless to self-hosters.

## Hosted storage engine: RESOLVED

**Postgres for the hosted deployment, self-managed on the Hetzner box. SQLite remains the default and the documented path for self-hosters.**

Postgres over SQLite because the worst realistic failure in this product is one customer's data appearing in another customer's account, and row-level security is the only mechanism that catches a mis-scoped query at the database rather than in code review. That backstop matters more than usual here given that implementation is delegated and cannot be verified by inspection.

Self-managed over third-party managed Postgres for two reasons:

- **Subprocessor exposure.** Per item 4, whoever holds the database sees plaintext row keys, timestamps, and blob sizes, which is real metadata about user behavior. A managed provider would inherit that exposure, adding a party the user never chose to a product sold on the premise that nobody else touches anything. Self-managing contains that exposure to the operator the user knowingly trusts.
- **Unit economics.** EU-resident managed Postgres runs roughly EUR 19 to 20 per month, about EUR 240 a year, against a USD 29.99 subscription. That is eight to ten subscribers existing solely to fund the database before hosting, object storage, and Paddle's cut.

_Deployment shape:_ one box running both the server and Postgres. Splitting the database onto its own server doubles cost and buys nothing at launch volumes.

_Build note:_ spec section 5.4 identifies the only real SQLite/Postgres divergence as `seq` assignment. SQLite serializes writes through a single writer; Postgres needs a sequence or `SELECT ... FOR UPDATE` on the per-account counter to keep `seq` monotonic under concurrent writers. Both engines need test coverage or behavior will diverge between what self-hosters run and what Pro runs.

_Cost context (verify before committing, Hetzner repriced four times in 2026):_ the cost-optimized CX and CAX lines rose roughly 30 to 38% across the April and June 2026 increases and remain viable at roughly EUR 5.50 to 8.50 per month. The dedicated-vCPU CPX and CCX lines rose 113 to 176% and are no longer a bargain, but this workload is disk and I/O bound rather than CPU bound and does not need them. Volume and object storage priced separately.

_Revisit trigger:_ move to managed Postgres if and when the operational burden costs more than roughly EUR 240 a year of time. EU-incorporated options to look at first are DanubeData (already on Hetzner hardware) and Sliplane.

## Assets already in place for Pro

- **`deletedAt` per-row delete timestamps** (shipped for sync-client 1.6.0). The server now stamps and stores per-row deletion times. Useful groundwork for any future audit log, retention policy, or "recently deleted" recovery feature.
- **Account-scoped everything.** All data-layer queries already filter by `account_id`; #1 is about _authenticating_ the account, not adding scoping.
- **Tombstone-GC invariant** documented at the `devices` stub: never GC a soft-delete row whose seq is below any device cursor. Any future GC work must honor this or it breaks stale-device resurrection protection across the whole fleet.

## Gate summary

Items 1, 2, 3, 5, and 6 hard-block any shared hosted deployment. Item 7 blocks the first paying customer even though it is operational rather than architectural. Item 4 is strongly recommended, schedules with the client roadmap, and constrains launch copy until it lands. **Current self-hosted launch: none of these block, today's model is correctly scoped for it.**

## Tenancy partitioning: settled, recorded so it is not relitigated

Multi-tenancy is shared-schema with `account_id` in the composite primary key of `sync_rows`, `intent_events`, and `devices`, with every data-layer query filtering on it and `seq` monotonic per account. This is already built and is the right answer. A file-per-tenant SQLite alternative was considered and rejected: it would break the Postgres path preserved in spec section 3.2 for a hosted product, break the thin storage abstraction in spec section 5.4 where one codebase runs both engines, and break the coordinated tombstone GC that reads `min(last_seen_seq)` across an account's devices.

The open work is **authentication of the account, not partitioning of it** (item 1).

## Open decisions

Ordered by when they have to be made.

**Before build starts:**

1. ~~Where Pro auth lives.~~ **RESOLVED:** OSS repo behind `AUTH_MODE`, billing in a private repo. See "Repository split" above.
2. ~~SQLite or Postgres for hosted.~~ **RESOLVED:** Postgres, self-managed on the Hetzner box. See "Hosted storage engine" above.

**After items 1, 2, and 3 land, before any Pro-specific spend:**

3. **Go/no-go on operating a hosted service at all.** See "Go/no-go" above. This is the largest open decision in the document and everything below it is conditional on a yes.

**Before first payment (conditional on #3):**

4. Lapse status code: `402` or `403`-with-reason (item 5).
5. Retention ladder durations: grace period, pull-only period, deletion notice period (item 5).
6. Initial quota number for stored bytes, sized against the lifeGLANCE media user rather than the dayGLANCE task user (item 3).
7. Availability posture to publish for a single-replica service (item 7).

**Before any Pro copy ships on glance-apps.com (conditional on #3):**

8. How zero-knowledge is qualified in Pro marketing and privacy documentation given that item 4 will not have landed (item 4). Legal drafting question rather than an engineering one; deserves its own pass.

**Deferrable:**

9. Item 4 scheduling against the sync-client roadmap.
10. Whether stored-bytes tiers are introduced at launch or later (item 3). Meter from day one regardless.

## Confirmed decisions (recorded so they are not relitigated)

- **No seat caps.** Meter stored bytes, SSE connections, and request rate directly rather than counting people or devices. Retain a per-account concurrent SSE cap as abuse containment, documented as such. Reversible: a device-based tier can be introduced later for new customers without touching existing ones.
- **Lapsed subscriptions degrade rather than lock out.** Pull allowed, push rejected, per item 5. Consistent with spec decision 7. Hard lockout gains no leverage in a local-first product where the user's data is already on their devices; it only looks punitive. Reversible: policy, not structure.
- **License key maps to a stable internal `account_id` rather than being it,** per item 6. Not reversible once customers have data, which is why it is settled now.
- **Credentials are per device, bound to a household account,** per item 1.
- **Auth public behind a flag, billing private.** See "Repository split."
- **Postgres, self-managed, one box.** See "Hosted storage engine."

## Platform vision: what a server enables beyond sync

_Forward-looking. None of this is launch-gating and none of it should influence the go/no-go, which is decided on the sync product alone. This section exists so the upside is recorded rather than rediscovered, and so nothing built for launch forecloses it. Everything here is post-launch and most of it is a distant maybe._

Once GLANCEvault holds authenticated per-account credentials and a push channel, it stops being a storage layer and becomes a platform the whole suite can draw on. The framing worth holding: the "vault" name may eventually undersell it, but that is a naming problem for later.

### The load-bearing primitive: share tokens

One concept unlocks nearly all of the collaboration upside. A **share token** is a scoped, revocable credential granting access to a single resource at a single permission level, without exposing the account's license key. Built once in GLANCEvault, every app in the suite inherits it.

- Any resource in any app can be tokenized: a Life, a Goal, a lastGLANCE checklist, a dayGLANCE project.
- The token is always scoped to one resource and one permission tier. The consuming app calls a GLANCEvault API with the token and gets back a permitted resource stream; it needs to know nothing about the token mechanism itself.
- It fits the no-accounts model, because the token _is_ the identity for that resource, exactly as the license key is the identity for the account.
- Suggested permission tiers: owner (full control, manages collaborators), contributor (add and edit own entries, suggest edits to others'), viewer (read-only).

The viewer tier is notable because it need not require the app installed at all: a hosted read-only view URL serves the viewer, which is Studio-adjacent territory and a natural Studio upsell moment.

**Share tokens double as the growth mechanism.** Every time a subscriber shares a token with a non-subscriber, that person hits a contextual "you need GLANCEvault to collaborate" moment while already looking at something they want to join. It is organic rather than pushy, because the value is self-evident at the point of friction. A person invited to co-build a memorial timeline is a warm prospect for their own subscription, and a free invite grace period (e.g. 30 days of contributor access) is a natural trial driver.

_Honest caveat:_ full contributor access requires both parties to have credentials, since the server must authenticate each participant. The grace-period invite is how that is softened.

### Use cases the primitive unlocks, per app

- **lifeGLANCE:** shared Lives and family timelines (grandparent adds entries from memory, grandchildren add photos and context); couple timelines feeding the wedding/anniversary Studio export as a genuine collaboration artifact rather than one person's view; memorial construction, where family collectively builds a deceased's timeline while grief is fresh, and the time-sensitivity makes real-time feel right; biography and journalism projects pairing a subject with a writer.
- **goalGLANCE:** share a Goal with an accountability partner who sees progress live and can leave check-ins but cannot touch other goals. Shared-accountability is a category people already pay for (Beachbody, Noom, coaching apps), and the privacy-preserving version shares only aggregated progress, not individual task lists.
- **lastGLANCE:** share a household checklist with a partner or roommate, both marking items done and adding recurring tasks. Competes with shared to-do apps on the local-first privacy angle.
- **dayGLANCE:** share a single project with a collaborator, scoped to that project rather than the full day plan. Useful for freelancers without adopting a full PM tool.
- **Studio:** hosted-export viewer links are just a read-only variant of the same token primitive.

### Transport: why none of this is foreclosed by shipping SSE

**This is settled and recorded so a future reader does not mistake the SSE choice for a fork that excluded WebSocket.** Every collaboration feature currently envisioned is the same shape: someone writes via ordinary authenticated HTTP, and other participants' devices get a server-to-client nudge to go sync. That is SSE's exact model (server-to-client over plain HTTP, auto-reconnect, rides the existing auth/CORS/proxy path), and clients already have a perfectly good client-to-server channel in normal HTTP requests. So shared Lives, family timelines, shared household state, aggregated team progress, share-token collaboration, and Studio "your export is ready" notifications are all SSE-solvable.

WebSocket becomes the right tool only for _true bidirectional real-time_, where the client must continuously stream to the server over a persistent connection. In this suite that would be:

- **Live presence** ("who is doing which chore right now" in lastGLANCE, "who is active during a check-in" in goalGLANCE). The most WebSocket-native pattern in the suite.
- **Live co-editing** with cursors and positions (Figma/Docs style), if any shared artifact ever grows from async state-sharing into simultaneous live editing.
- **Live team sessions** in goalGLANCE: everyone in a shared live view during a standup, with presence and reactions.
- **Sub-second claim/lock races**, borderline and SSE-approximable.

The layering, decided: **SSE for notifications, forever, because a sync nudge is one-directional by nature; WebSocket added surgically per-feature if and when a genuinely bidirectional real-time feature is scoped.** The two run side by side on the same Node server, which Hetzner and Caddy support (SSE needs `flush_interval -1` in Caddy). The mistake would be treating this as an SSE-for-all-versus-WebSocket-for-all fork; it is neither. The near-term push work is unambiguously SSE, and the WebSocket-native features (lastGLANCE household presence, goalGLANCE team-live-sessions) are the ones to reach for WebSocket _when_ scoped, not before.

_Implication for launch:_ nothing here changes what gets built first. It confirms the sync-push transport is correct as-is and that the platform upside is additive rather than blocked. The one thing worth doing early is designing the share-token layer cleanly, since it is the primitive everything else depends on and is expensive to retrofit awkwardly.
