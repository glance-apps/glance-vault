import { Router, json, type NextFunction, type Request, type Response } from "express";
import type { AccountAdmin, AccountRecord, CredentialAdmin, UsageReporter } from "../storage/types.js";
import { timingSafeStringEqual } from "../middleware/auth.js";
import { mintAccountKey, newAccountId } from "../account-keys.js";
import type { BlobStore } from "../storage/blobstore.js";

// Credential administration (Phase 2.1): how an operator actually revokes.
//
// Registered ONLY in per-account mode, exactly like /enroll, and mounted in
// the same public segment (behind CORS and the per-IP rate limiter, before
// the credential middleware): this surface authenticates itself. There is no
// admin UI in this server; these two endpoints are the whole mechanism, and
// they are curl-able — which beats docker exec into a runtime image that
// (correctly) carries no sqlite3 binary. A CLI, if ever wanted, is sugar over
// these endpoints, never over the database: an out-of-process database write
// bypasses the hub eviction and leans entirely on the SSE heartbeat backstop.
//
// TRUST ARGUMENT for guarding this with the enrollment bootstrap secret: that
// secret already grants enrollment into ANY account — full data access —
// so listing and revoking credentials grants strictly less. No new trust
// level is created by reusing it.
//
// The router receives only the CredentialAdmin surface (list + revoke): the
// same narrow-interface discipline as CredentialIssuer. forAccount, issuance,
// the sweeps, and lifecycle are not expressible here.

// THE HOSTED SEAM, same shape as the enrollment validator: "does this
// presented secret authorize credential administration?" A hosted deployment
// swaps THIS FUNCTION's construction (operator auth instead of the bootstrap
// secret) in buildApp; the endpoints, the response shapes, and the store
// surface do not move.
export type AdminGuard = (presentedSecret: string) => boolean;

export function bootstrapAdminGuard(configuredSecret: string): AdminGuard {
  return (presentedSecret) => timingSafeStringEqual(presentedSecret, configuredSecret);
}

// Bearer auth with the bootstrap secret, same header shape as everything
// else. Same rejection bodies as the credential middleware for the same
// conditions: header problems are header problems in both places. Shared by
// every admin router.
function adminAuth(authorize: AdminGuard) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization");
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing or malformed Authorization header" });
      return;
    }
    if (!authorize(header.slice("Bearer ".length))) {
      res.status(401).json({ error: "invalid enrollment secret" });
      return;
    }
    next();
  };
}

// Serialize one credential row for the listing/revoke responses. EXPLICIT
// ALLOWLIST: credentialId, accountId, deviceId, createdAt, revokedAt. The
// credential_hash never leaves this layer — a listing that returned verifier
// hashes would hand out offline-crackable material for every device at once.
function serializeCredential(record: {
  credentialId: string;
  accountId: string;
  deviceId: string;
  createdAt: string;
  revokedAt: string | null;
}) {
  return {
    credentialId: record.credentialId,
    accountId: record.accountId,
    deviceId: record.deviceId,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}

export function adminRouter(
  admin: CredentialAdmin,
  // Usage reporting (Phase 3.1): read-only derived aggregates. Passed as its
  // own narrow surface — this router can list/revoke credentials and read
  // usage aggregates, and can reach nothing else (no forAccount, no issuance,
  // no sweeps). Usage numbers are aggregates ABOUT account data, not account
  // data: no envelope byte, entity id, blob hash, or plaintext-adjacent value
  // crosses this surface.
  usage: UsageReporter,
  authorize: AdminGuard,
  // Called after a revocation is durably stamped, with the revoked
  // credentialId. buildApp wires this to hub.disconnectCredential so live SSE
  // streams for the credential terminate immediately (the in-process path;
  // the heartbeat revalidation covers every other path).
  onRevoked: (credentialId: string) => void,
  // Live SSE connection counts from the hub (per-process by nature — the one
  // usage dimension a multi-replica deployment would need to rethink).
  sseCounts: () => { accountId: string; connections: number }[],
): Router {
  const router = Router();

  router.use(adminAuth(authorize));

  // GET /admin/credentials — every credential, active and revoked, in
  // deterministic order. Revoked-but-lingering rows and the pre-2.1 orphans
  // (live keys until revoked!) are exactly what this listing exists to
  // surface; multiple rows per (account, device) are plainly visible.
  router.get("/credentials", (_req: Request, res: Response) => {
    res.status(200).json({ credentials: admin.listCredentials().map(serializeCredential) });
  });

  // POST /admin/credentials/:credentialId/revoke — stamp revoked_at,
  // idempotently (a re-revoke keeps the original timestamp and reports
  // revokedNow: false), then notify the hub. 404 for an unknown id.
  router.post("/credentials/:credentialId/revoke", (req: Request, res: Response) => {
    const result = admin.revokeCredential(req.params.credentialId);
    if (result === null) {
      res.status(404).json({ error: "unknown credential" });
      return;
    }
    if (result.revokedNow) {
      // Terminate any live SSE streams this credential holds, AFTER the flag
      // is durably stamped: eviction is a consequence of revocation, never a
      // substitute for it.
      onRevoked(result.record.credentialId);
    }
    res.status(200).json({
      ...serializeCredential(result.record),
      revokedNow: result.revokedNow,
    });
  });

  // GET /admin/usage — per-account usage snapshots plus a global rollup.
  // DERIVED CURRENT STATE, never throughput (pruned intents and reclaimed
  // blobs are unrecoverable history, deliberately not reported), and
  // ATTRIBUTION, never volume (blob bytes come from per-account metadata,
  // not from stat-ing the global byte store — a disagreement with du on the
  // volume means a transient orphan from a crash between reclaim's
  // byte-delete and row-delete, or reaper-bounded staging scratch).
  //
  // Accounts are the union of data-table footprints and live SSE
  // subscriptions; a connection-only account reports zero storage. This is
  // the surface the launch-quota decision reads; Phase 3.2's enforcement
  // reads the same numbers in-process through the UsageReporter store
  // surface, never through HTTP.
  router.get("/usage", (_req: Request, res: Response) => {
    const usageRows = usage.listUsage();
    const sse = new Map(sseCounts().map((c) => [c.accountId, c.connections]));

    // Merge: every data account, plus any SSE-only account (byte-exact ids).
    const byAccount = new Map(usageRows.map((u) => [u.accountId, u]));
    for (const accountId of sse.keys()) {
      if (!byAccount.has(accountId)) {
        byAccount.set(accountId, usage.usageForAccount(accountId));
      }
    }
    const accounts = [...byAccount.keys()].sort().map((accountId) => {
      const u = byAccount.get(accountId)!;
      return { ...u, sse: { connections: sse.get(accountId) ?? 0 } };
    });

    const totals = accounts.reduce(
      (t, a) => ({
        storedBytes: t.storedBytes + a.storedBytes.total,
        blobBytes: t.blobBytes + a.storedBytes.blobs,
        envelopeBytes: t.envelopeBytes + a.storedBytes.envelopes + a.storedBytes.intents,
        rows: t.rows + a.counts.rows,
        blobs: t.blobs + a.counts.blobs,
        uploadSessions: t.uploadSessions + a.uploads.sessions,
        stagedBytes: t.stagedBytes + a.uploads.stagedBytes,
        sseConnections: t.sseConnections + a.sse.connections,
      }),
      {
        storedBytes: 0,
        blobBytes: 0,
        envelopeBytes: 0,
        rows: 0,
        blobs: 0,
        uploadSessions: 0,
        stagedBytes: 0,
        sseConnections: 0,
      },
    );

    res.status(200).json({ accounts, totals });
  });

  return router;
}

// Account administration (enrollment-key mode): how an operator hands out
// access on a shared server. Registered ONLY when GLANCEVAULT_ENROLLMENT_MODE
// is account-key, mounted at /admin/accounts, and guarded by the same
// bootstrap secret as the rest of /admin. In that mode the secret no longer
// enrolls devices, so it is purely the operator's secret.
//
// The router receives only the AccountAdmin surface. Account keys appear in a
// create or rotate response ONCE and are never retrievable again (the server
// stores only their hash); the listing never carries a key or a hash.

// Bounds on operator-supplied strings. Generous, but they keep a typo'd paste
// of a whole file out of the registry.
const MAX_ACCOUNT_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 200;

function serializeAccount(record: AccountRecord) {
  return {
    accountId: record.accountId,
    label: record.label,
    createdAt: record.createdAt,
    keyRotatedAt: record.keyRotatedAt,
  };
}

export function accountsAdminRouter(
  accounts: AccountAdmin,
  authorize: AdminGuard,
  // Called with each credential a rotation revoked, after the transaction
  // commits; buildApp wires it to hub.disconnectCredential, as for /revoke.
  onRevoked: (credentialId: string) => void,
  // The registry cap (GLANCEVAULT_MAX_ACCOUNTS); undefined means no cap.
  maxAccounts: number | undefined,
  // Where blob bytes live, so deleting an account can remove its media.
  blobs: BlobStore,
): Router {
  const router = Router();
  router.use(adminAuth(authorize));

  // POST /admin/accounts — body { label?, accountId? }. accountId defaults to
  // a fresh server-generated id; supplying one adopts an id that already holds
  // data (say, a household that enrolled under bootstrap mode) without moving
  // a row. 201 { accountId, label, createdAt, keyRotatedAt, accountKey }.
  router.post("/", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { label?: unknown; accountId?: unknown };

    let label: string | null = null;
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== "string" || body.label.length > MAX_LABEL_LENGTH) {
        res.status(400).json({ error: `label must be a string of at most ${MAX_LABEL_LENGTH} characters` });
        return;
      }
      label = body.label;
    }

    let accountId: string;
    if (body.accountId !== undefined) {
      if (
        typeof body.accountId !== "string" ||
        body.accountId.trim() === "" ||
        body.accountId.length > MAX_ACCOUNT_ID_LENGTH
      ) {
        res.status(400).json({
          error: `accountId must be a non-empty string of at most ${MAX_ACCOUNT_ID_LENGTH} characters`,
        });
        return;
      }
      accountId = body.accountId;
    } else {
      accountId = newAccountId();
    }

    const minted = mintAccountKey();
    const result = accounts.createAccount({ accountId, label, keyHash: minted.keyHash }, maxAccounts);
    if (result === "exists") {
      res.status(409).json({ error: "account already exists" });
      return;
    }
    if (result === "limit") {
      res.status(409).json({ error: "account limit reached", maxAccounts });
      return;
    }
    res.status(201).json({ ...serializeAccount(result), accountKey: minted.accountKey });
  });

  // GET /admin/accounts — every account plus the cap, so an operator can see
  // how many places are left.
  router.get("/", (_req: Request, res: Response) => {
    res.status(200).json({
      accounts: accounts.listAccounts().map(serializeAccount),
      maxAccounts: maxAccounts ?? null,
    });
  });

  // POST /admin/accounts/:accountId/rotate-key — body { revokeDevices? }.
  // Mints a new key; the old one stops enrolling immediately. Account data is
  // never touched. revokeDevices: true also signs out every device of the
  // account (the containment step for a leaked key, since a leaked key may
  // already have enrolled a device). 200 { ...account, accountKey,
  // revokedCredentials }; 404 for an unknown account.
  router.post("/:accountId/rotate-key", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { revokeDevices?: unknown };
    if (body.revokeDevices !== undefined && typeof body.revokeDevices !== "boolean") {
      res.status(400).json({ error: "revokeDevices must be a boolean" });
      return;
    }
    const minted = mintAccountKey();
    const result = accounts.rotateAccountKey(req.params.accountId, minted.keyHash, body.revokeDevices === true);
    if (result === null) {
      res.status(404).json({ error: "unknown account" });
      return;
    }
    for (const credentialId of result.revokedCredentialIds) {
      onRevoked(credentialId);
    }
    res.status(200).json({
      ...serializeAccount(result.record),
      accountKey: minted.accountKey,
      revokedCredentials: result.revokedCredentialIds.length,
    });
  });

  // DELETE /admin/accounts/:accountId — body { confirm: "<accountId>" }.
  // Removes the account and ALL of its data (sync rows, intents, media,
  // devices), signs its devices out, and frees its place under the cap.
  // Irreversible apart from the operator's own backups, hence the confirm
  // field, which must repeat the id. 200 { ...account, deletedRows,
  // revokedCredentials, deletedBlobs }; 404 for an unknown account.
  router.delete("/:accountId", json({ limit: "16kb" }), (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    const body = (req.body ?? {}) as { confirm?: unknown };
    if (body.confirm !== accountId) {
      res.status(400).json({ error: "confirm must repeat the accountId being deleted" });
      return;
    }
    const result = accounts.deleteAccount(accountId);
    if (result === null) {
      res.status(404).json({ error: "unknown account" });
      return;
    }
    for (const credentialId of result.credentialIds) {
      onRevoked(credentialId);
    }
    // After the commit, the bytes the database no longer references. Both
    // calls are idempotent, so a failure here leaves only unreferenced files.
    for (const uploadId of result.uploadIds) {
      blobs.discardSession(uploadId);
    }
    for (const hash of result.blobHashes) {
      blobs.delete(hash);
    }
    res.status(200).json({
      ...serializeAccount(result.record),
      deletedRows: result.deletedRows,
      revokedCredentials: result.credentialIds.length,
      deletedBlobs: result.blobHashes.length,
    });
  });

  return router;
}
