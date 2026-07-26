_Phase plan for the multi-user prerequisites (items 1 to 3). Not for the public repo._

This plan sequences **only items 1, 2, and 3** from the GLANCEvault Pro Prerequisites and Build Notes document. It deliberately stops at the go/no-go decision. Nothing here commits to operating a hosted service; every phase below improves the free self-hosted product on its own merits, which is why they are safe to build before the go/no-go is answered.

## Source of truth and how to use this with Code

- The **GLANCEvault Pro Prerequisites and Build Notes** document is the source of truth for _what_ and _why_. This document is the source of truth for _order_ and _fencing_. The **GLANCEvault server spec** is the source of truth for the existing architecture (schema, handlers, tombstone-GC invariant, SQLite/Postgres abstraction).
- Tell Code explicitly: implement only the named phase, do not invent behavior not specified here or in the prerequisites doc, and do not pull work forward from a later phase.
- One phase is one PR. Merge and verify before starting the next. Do not batch phases.
- Server work lives in `glance-vault`. Client work lives in `glance-sync` and the apps. Because Code runs one repo per session, phases are tagged **[server]** or **[client]**, and a client phase is a separate session from the server phase it depends on. Have Code commit to a throwaway branch per phase so the work can be synced via git.
- For each phase, Code must (a) name any design decision it hits rather than silently choosing, surfacing it in the PR description, and (b) provide **runtime instrumentation** proving the phase works, not just static reasoning. Static analysis alone does not close a phase.

## The safety net that makes this sequence low-risk

Every server phase lands behind `AUTH_MODE`, defaulting to `shared`. In `shared` mode, behavior is byte-for-byte identical to what self-hosters run today. The new per-account path is only active under `AUTH_MODE=per-account`. This means:

- Every phase can merge to `main` without disturbing the shipped self-hosted product.
- The per-account path can be built and tested incrementally without a big-bang cutover.
- If a phase regresses the new path, `shared` mode is unaffected and no existing user is harmed.

Code must treat "shared mode behavior is unchanged" as a hard invariant and include a regression check for it in every server phase.

## What is out of scope for this entire plan

Name these to Code up front so it does not pull them in:

- **Postgres.** Items 1 to 3 are built and verified on SQLite, which is what self-hosters run. The Postgres port is a hosted-only concern gated behind the go/no-go. See the `seq` note in Phase 1.3, which is the one place the design must not paint Postgres into a corner.
- **Billing, Paddle, license keys.** All Pro-specific and gated behind the go/no-go. Enrollment in this plan uses a self-host-appropriate secret, not a purchased key. See Phase 1.2.
- **Item 4 (metadata minimization).** Separate, protocol-level, longest lead time. Not touched here.
- **Item 6 (key-to-account indirection).** Pro-specific. Not built here, but Phase 1.1 must be designed so it is a clean later addition. See Phase 1.1's design constraint.
- **Item 5 and 7 (entitlement state machine, DR).** Post go/no-go.

---

# Item 1: per-account credential binding

The foundation. Everything in items 2 and 3 depends on the server knowing _which account_ a request belongs to from the credential, not from a client-supplied parameter it trusts.

## Phase 1.1 [server]: credential store and AUTH_MODE scaffold

**In scope:** Add the credential store schema (a credential maps to a device and an account). Add the `AUTH_MODE=shared|per-account` switch, defaulting to `shared`. In `shared` mode nothing about request handling changes; the store simply exists and is unused. This is pure addition.

**Design constraint (item 6 pre-enablement):** the stable internal identity is `account_id`. A credential _maps to_ an `account_id`; a credential value must never _be_ the account identity. This keeps item 6 (a license key mapping to the same `account_id`) a clean later addition rather than a migration. Have Code confirm in the PR that nothing downstream treats the credential value as the account key.

**Out of scope:** issuance, enrollment, any handler changes, any derivation logic. This phase only creates the table and the flag.

**Regression risks:** schema migration must be idempotent and must not touch existing tables' data. Verify the existing three-table schema and its `account_id` composite keys are untouched.

**Verification:** migration runs cleanly on a copy of real self-hosted data; re-running it is a no-op; `shared` mode startup and a normal sync round-trip are unchanged.

## Phase 1.2 [server]: enrollment and credential issuance

**In scope:** the endpoint where a device exchanges an enrollment secret for a per-device credential bound to an account, then **discards the enrollment secret**. Retaining it on the device defeats later revocation, so the flow must be exchange-then-discard.

**Design decision to surface:** what the enrollment secret _is_ for a self-hoster, given billing and license keys are out of scope. Likely an admin-configured bootstrap secret or an admin-minted enrollment token, since there is no Paddle in this plan. Code should propose the mechanism in the PR description and not silently pick one. The mechanism must be swappable later so that the Pro path (license key as the enrollment secret) drops in without reworking the exchange itself.

**Out of scope:** derivation and rejection (Phase 1.3), revocation (Phase 2.x). A credential issued here is not yet _enforced_ anywhere; that is the next phase.

**Regression risks:** issuance must be inert in `shared` mode. Multiple devices enrolling to one account must each get a distinct credential (household model), and this must not collide with the existing `devices` table cursors used by tombstone GC.

**Verification:** in `per-account` mode, two devices enroll to the same account and receive distinct credentials; the enrollment secret is provably not persisted on the device after exchange; `shared` mode is unaffected.

## Phase 1.3 [server]: derive accountId server-side, reject mismatches, all handlers

**The core security change.** Today any token-holder can act on any account by varying the `accountId` parameter. This phase makes the operative `account_id` come from the authenticated credential, and rejects any client-supplied `accountId` that disagrees.

**In scope:** every handler that takes an account scope: batch, list, row-GET, soft-delete, salt, blobs, and SSE. Prefer **structural enforcement** over a per-handler checklist: a scoped data-access handle constructed from the authenticated credential, such that an unscoped query is not expressible rather than merely not written. **Before changing anything, have Code report where an unscoped query is currently constructible**, framed as a findings pass, not a fix. Then implement the scoped handle.

**Closes two sub-issues, which are verification points, not extra work:**
- Salt squatting: only the owning account can write its salt, so `PUT /salt/:accountId` can no longer be pre-seeded by a hostile caller.
- Cross-account writes and deletes: these need no key and are immediately destructive, and E2E does not mitigate them. After this phase they are rejected.

**`seq` design note (the one Postgres-facing constraint):** on SQLite, per-account `seq` monotonicity currently rides on serialized single-writer writes. Do not deepen a reliance on single-writer serialization in a way that would be hard to undo when Postgres (concurrent writers, needing a sequence or row lock) is ported later. This is a _design caution to surface_, not a mandate to build the Postgres path now. Ask Code to note in the PR whether its changes assume single-writer serialization for `seq` correctness.

**Out of scope:** revocation, quotas, the Postgres port itself.

**Regression risks:** the highest-stakes phase. The tombstone-GC invariant (never GC a soft-delete row whose `seq` is below any device cursor) must be preserved across the device/credential changes. `shared` mode must remain byte-for-byte identical. A mistake here is a cross-tenant breach, so verification is behavioral and adversarial.

**Verification (runtime, adversarial):** a credential for account A supplying `accountId` B is rejected with a consistent status on every one of the seven handlers; a hammer test confirms account A can never read, write, or delete account B's rows, salt, or blobs; salt squatting is proven impossible; `shared` mode passes an unchanged round-trip.

## Phase 1.4 [client]: send the per-account credential

**In scope:** the client sends its per-account credential instead of the shared token. Per the prerequisites doc the wire shape is already forward-compatible (Bearer token plus `accountId`), so this is _what token it sends_, not a protocol change. Low lead time.

**Out of scope:** revocation UX (Phase 2.2), over-quota UX (Phase 3.3), any enrollment UI beyond what is needed to obtain and store the credential.

**Regression risks:** a client pointed at a `shared`-mode server must still work, since not every server the client talks to will be in `per-account` mode. The client cannot assume the new mode.

**Verification:** a `per-account` client round-trips against a `per-account` server; the same client still round-trips against a `shared`-mode server.

---

# Item 2: token revocation and containment

Needs the credential store from item 1. Today rotating the shared token 401s the entire fleet; this makes revocation per-credential.

## Phase 2.1 [server]: individual credential revocation

**In scope:** per-credential revocation with a consistent terminal status (401/403). One device can be revoked without disturbing others on the same account.

**Design decision to surface:** revocation list versus short-lived tokens plus refresh. Code should lay out the trade-off in the PR (a revocation list is simple but must be checked on every request; short-lived-plus-refresh contains exposure automatically but adds a refresh flow) and recommend one rather than silently choosing.

**Out of scope:** the client re-enroll experience (Phase 2.2). Billing-driven lapse is explicitly _not_ this; that is item 5's entitlement state machine and must use a distinct status so the client does not treat a billing lapse as an auth failure. Do not let Code conflate revocation with lapse.

**Regression risks:** revocation state must not break the tombstone-GC device-cursor logic. A revoked device's cursor handling must be defined so GC safety is preserved.

**Verification (runtime):** one of two enrolled devices is revoked mid-session; the revoked device gets the terminal status on its next request; the other device continues uninterrupted; GC invariant still holds.

## Phase 2.2 [client]: clean re-enroll on revocation

**In scope:** when a device receives the terminal revoked status, it presents a clean re-authenticate/re-enroll path rather than a dead-end error. Clients already treat 401/403 as terminal; this phase confirms that produces a sane UX for the single-device-revoked case.

**Out of scope:** over-quota UX, lapse UX (item 5).

**Regression risks:** the re-enroll affordance must not fire spuriously on a transient network 401 versus a real revocation. Define the distinction.

**Verification:** a revoked device walks through re-enroll and returns to working sync; a transient 401 does not trigger a false re-enroll prompt.

---

# Item 3: per-account quotas, caps, and usage accounting

Needs identity from item 1. This is also the billing foundation, so metering comes first and enforcement second. Record usage from day one even before enforcing.

## Phase 3.1 [server]: usage accounting (record-only)

**In scope:** per-account metering of stored bytes (envelopes plus blobs), row/entity counts, intent volume, concurrent uploads, and SSE connections. **Record only. Do not enforce.** This phase is measurement, which makes it low-risk and lets real numbers inform the launch quota (open decision, sized against the lifeGLANCE media user, not the dayGLANCE task user).

**Out of scope:** any 413/429 response, any limit. Purely observational.

**Regression risks:** metering must add negligible overhead to the write path and must be correct under concurrent uploads. It must not itself become a serialization bottleneck.

**Verification:** metered numbers match ground truth for a seeded account across all five dimensions; write-path latency is not materially affected.

## Phase 3.2 [server]: quota enforcement

**In scope:** enforce per-account limits with clear over-quota responses (413 for storage, 429 for rate/connection caps). Enforcement must **fail gracefully mid-upload** rather than after bytes are already committed, per the prerequisites doc.

**Design decision to surface:** the initial limit numbers are an open decision and should not be hardcoded blindly. Code should make limits configurable and propose defaults, flagging that the real number is set later against Phase 3.1 data.

**Scale note to record (not build):** the shipped rate-limiter and SSE caps are in-memory per-process. A future multi-replica deployment needs shared state or proxy-level enforcement. Out of scope here (single-replica launch shape), but Code should not design enforcement in a way that assumes it can _never_ be moved to shared state.

**Out of scope:** multi-replica coordination, the client over-quota UX (Phase 3.3).

**Regression risks:** a mis-set or mis-evaluated quota could reject legitimate writes. Enforcement must be off or effectively unlimited by default so no self-hoster is surprised by a cap they did not set.

**Verification (runtime):** an account pushed past a configured storage limit gets a graceful mid-upload 413 with no partial-corruption; a connection cap returns 429; an account under limit is unaffected; default config imposes no surprise cap.

## Phase 3.3 [client]: over-quota UX

**In scope:** the client surfaces "storage full / upgrade" rather than a generic sync failure on 413/429. Net-new client UX with real lead time, per the prerequisites doc. Should compose with the revoked/re-enroll states from Phase 2.2 rather than duplicate them.

**Out of scope:** anything implying a purchase flow (billing is gated behind the go/no-go).

**Regression risks:** must distinguish over-quota from a generic sync failure and from a revocation, so the user sees the right message for the right condition.

**Verification:** an over-quota client shows the correct distinct message; a normal sync failure and a revocation each still show their own correct state.

---

# Stop here: go/no-go

After Phase 3.3, all of items 1 to 3 are built and the free self-hosted product is strictly better: per-device credentials, individual revocation, and usage visibility. **This is the decision point** described in the prerequisites doc. Do not start item 5 (billing), item 7 (DR), the Postgres port, or any Hetzner provisioning until the go/no-go is a conscious yes. The point of no return is the first payment.
