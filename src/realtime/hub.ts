// In-process, account-scoped pub/sub for real-time push (Phase 9, spec §14.3).
//
// A registry mapping account_id -> the set of currently-connected SSE
// connections for that account. A write path publishes a NUDGE (nudge-only: just
// the account's latest seq, never any payload) and every connection subscribed
// to that account receives it. The client responds by running its existing
// authenticated sync/intent drain; push only replaces the poll TIMER with an
// instant signal, so polling remains the correctness backstop.
//
// Deliberately in-memory and single-container. Push at multi-tenant scale (many
// persistent connections, horizontal scaling of stateful connections) is the
// hard part and defers with the paid product (spec §13, §14.3); do NOT build
// clustering/redis here. The AccountHub interface is the seam: a scaled pub/sub
// (e.g. Redis fan-out) can replace InProcessAccountHub later behind this same
// interface without touching the endpoint or the emission hooks.

// The nudge payload. Zero-knowledge by construction: it carries only the
// account's latest seq — a signal, never a payload, plaintext, or row content.
// "account is now at seq N, go sync"; the client compares N to its cursor and
// drains sync + intents if it is behind.
//
// `app` names WHICH writer advanced the seq. The seq is one per-account counter
// shared across every app namespace, so without it a consumer cannot tell a
// nudge for its own rows from one for another app's. Sync emits carry the
// route's app namespace; the intents insert path carries the fixed tag
// "intents" (intents are account scoped, not namespaced). It is a hint, never a
// filter the server applies: the nudge still goes to every connection on the
// account. Optional so a nudge remains valid without it — a consumer treats a
// missing app as "unknown, drain as before". The `ready` frame deliberately
// omits it: that is a reconcile point, not attributable to one writer.
export interface Nudge {
  seq: number;
  app?: string;
}

// The best-effort emission callback the write paths call after a write commits.
// Wired to AccountHub.publish in buildApp. Must never throw to its caller (a
// slow/dead connection must never block or fail the underlying write).
export type Emit = (accountId: string, nudge: Nudge) => void;

// A single connected client for one account. The hub knows nothing about HTTP:
// it only needs a stable id (for set membership) and a way to deliver a nudge.
// deliver() is expected to be self-contained — the hub treats ANY throw from it
// as a dead connection and evicts the subscriber, so a broken pipe can never
// propagate back to a writer calling publish().
export interface Subscriber {
  readonly id: number;
  // The credential this connection authenticated with (Phase 2.1), so
  // revocation can find and terminate its stream. undefined in shared mode,
  // where connections have no credential identity.
  readonly credentialId?: string;
  deliver(nudge: Nudge): void;
  // Server-initiated close (Phase 2.1): end the underlying response. Called by
  // disconnectCredential AFTER the subscriber is removed from the registry, so
  // a throwing close can never leave a zombie registration. Must be safe to
  // call on an already-ended response.
  close(): void;
}

export interface AccountHub {
  // Register a connection for an account. Returns false if the account is at the
  // per-account connection cap (the caller should then refuse the connection);
  // true once registered.
  subscribe(accountId: string, sub: Subscriber): boolean;
  // Remove a connection. Idempotent: unsubscribing an unknown/already-removed
  // subscriber is a harmless no-op. Empty account sets are dropped so the
  // registry never leaks keys for accounts with no live connections.
  unsubscribe(accountId: string, sub: Subscriber): void;
  // Deliver a nudge to every connection for an account. BEST-EFFORT and
  // non-blocking: it never throws, and a connection whose deliver() throws is
  // dropped rather than propagated. A no-op when the account has no connections.
  publish(accountId: string, nudge: Nudge): void;
  // Terminate every connection authenticated by this credential (Phase 2.1):
  // remove each matching subscriber from the registry, then close its stream.
  // Returns the number of connections closed. Idempotent — a credential with
  // no live connections is a harmless zero. Called by the admin revoke path;
  // the SSE heartbeat revalidation is the backstop for revocations written
  // outside this process.
  disconnectCredential(credentialId: string): number;

  // Live connection count for one account (0 when none). Introspection for
  // tests and future metrics.
  connectionCount(accountId: string): number;

  // Every account with at least one live connection, with its count, in
  // deterministic accountId order (Phase 3.1 usage reporting). Introspection
  // only. NOTE: per-process by nature — under multiple replicas each replica
  // reports its own connections; this is the one usage dimension that would
  // need a shared registry (or scrape-and-sum) in a multi-replica deployment.
  connectionCounts(): { accountId: string; connections: number }[];
  // Total live connections across all accounts. Introspection.
  totalConnections(): number;
}

// A sane default cap on concurrent connections per account. A single account is
// a household with a handful of devices; this is far above any legitimate use
// and exists only so a misbehaving or malicious client cannot grow the registry
// without bound. Tune via the constructor if ever needed.
export const DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT = 64;

// A process-wide ceiling on total live SSE connections across ALL accounts. The
// per-account cap alone does not bound the registry, because a caller can open
// connections under many distinct accountIds (accountId is caller-supplied, and
// one device token authorizes them all in this trust model); without a global
// cap that is an unbounded memory/file-descriptor growth vector. This ceiling
// is far above any single-instance/household deployment and exists purely as a
// backstop. Tune via the constructor for a larger deployment.
export const DEFAULT_MAX_CONNECTIONS_TOTAL = 1024;

export class InProcessAccountHub implements AccountHub {
  private readonly byAccount = new Map<string, Set<Subscriber>>();
  private readonly maxPerAccount: number;
  private readonly maxTotal: number;
  private total = 0;

  constructor(
    maxPerAccount: number = DEFAULT_MAX_CONNECTIONS_PER_ACCOUNT,
    maxTotal: number = DEFAULT_MAX_CONNECTIONS_TOTAL,
  ) {
    this.maxPerAccount = maxPerAccount;
    this.maxTotal = maxTotal;
  }

  subscribe(accountId: string, sub: Subscriber): boolean {
    // Global ceiling first: refuse once the process is at its total-connection
    // cap, regardless of which account is asking.
    if (this.total >= this.maxTotal) {
      return false;
    }
    let set = this.byAccount.get(accountId);
    if (set === undefined) {
      set = new Set();
      this.byAccount.set(accountId, set);
    }
    if (set.size >= this.maxPerAccount) {
      // Do not leave an empty set behind if this was a fresh account key.
      if (set.size === 0) {
        this.byAccount.delete(accountId);
      }
      return false;
    }
    set.add(sub);
    this.total += 1;
    return true;
  }

  unsubscribe(accountId: string, sub: Subscriber): void {
    const set = this.byAccount.get(accountId);
    if (set === undefined) {
      return;
    }
    // Only adjust the global counter when a member was actually removed, so a
    // repeated/idempotent unsubscribe cannot drive the count below zero.
    if (set.delete(sub)) {
      this.total -= 1;
    }
    // Drop the account key entirely once its last connection is gone so the
    // registry does not accumulate empty sets for churned accounts.
    if (set.size === 0) {
      this.byAccount.delete(accountId);
    }
  }

  publish(accountId: string, nudge: Nudge): void {
    const set = this.byAccount.get(accountId);
    if (set === undefined || set.size === 0) {
      return;
    }
    // Iterate a snapshot so evicting a dead subscriber mid-loop is safe. Each
    // deliver is isolated: a throw evicts only that connection and never aborts
    // the fan-out or reaches the writer that called publish.
    for (const sub of [...set]) {
      try {
        sub.deliver(nudge);
      } catch {
        this.unsubscribe(accountId, sub);
      }
    }
  }

  disconnectCredential(credentialId: string): number {
    let closed = 0;
    // Snapshot both levels, same discipline as publish: eviction mid-iteration
    // must not upset the walk, and a throwing close() must not abort the rest.
    for (const [accountId, set] of [...this.byAccount.entries()]) {
      for (const sub of [...set]) {
        if (sub.credentialId !== credentialId) {
          continue;
        }
        // Unsubscribe FIRST so a throw from close() cannot leave the dead
        // subscriber registered, then end the stream best-effort.
        this.unsubscribe(accountId, sub);
        try {
          sub.close();
        } catch {
          // The socket was already gone; removal was the part that mattered.
        }
        closed += 1;
      }
    }
    return closed;
  }

  connectionCount(accountId: string): number {
    return this.byAccount.get(accountId)?.size ?? 0;
  }

  connectionCounts(): { accountId: string; connections: number }[] {
    return [...this.byAccount.entries()]
      .map(([accountId, set]) => ({ accountId, connections: set.size }))
      .sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  }

  totalConnections(): number {
    return this.total;
  }
}
