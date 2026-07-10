import type { Request, Response, NextFunction } from "express";

// Minimal request logging: one concise line per request, emitted once the
// response is sent. This exists to answer the first question in any connectivity
// report — did the client's request even reach the server? — which was
// previously unanswerable because nothing logged request traffic at all. It runs
// before CORS and auth, so a blocked preflight (OPTIONS ... 204 with no allow
// headers) and a rejected token (... 401) both show up, which is exactly the
// signal an operator needs when a client "does nothing" and the cause is unclear.
//
// PRIVACY: the log line NEVER contains request-identifying user data. Two things
// are deliberately kept out:
//   - the query string (dropped entirely) — accountId rides there on every
//     endpoint, and it identifies a household.
//   - dynamic path segments — the single-row GET/DELETE path carries a plaintext
//     entityId ("dailyNotes:2026-07-10", "tasks:<uuid>", "singleton:...") and the
//     blob paths carry a content hash. Both are collapsed to a stable route
//     template (":entityId", ":hash", ":uploadId", etc.).
// The Authorization header (the device token) is never read into the log. What
// remains is a route template plus method/status/duration — enough to diagnose
// reachability, with no per-user metadata leaked to stdout or a log aggregator.
//
// GET /healthz is skipped: the Docker healthcheck pings it every 30s, so logging
// it would bury real traffic. The log sink is injectable (defaulting to
// console.log, matching the reclaim sweep) so tests can observe output without
// capturing stdout.

// Collapse a concrete request path into a stable route template with no
// user-identifying segments. Rules mirror the mounted routers (sync, intents,
// salt, blobs, events); an unrecognized shape is redacted conservatively rather
// than logged raw. Operates on req.path only (never the query string).
export function redactPath(path: string): string {
  // Split into non-empty segments; keep a leading "/" on the rebuilt template.
  const parts = path.split("/").filter((p) => p !== "");
  if (parts.length === 0) {
    return "/";
  }

  const out: string[] = [];
  switch (parts[0]) {
    case "sync": {
      // /sync/:app/(batch|device|list) keep the literal tail; /sync/:app/:entityId
      // redacts the entity segment.
      out.push("sync");
      if (parts[1] !== undefined) out.push(":app");
      if (parts[2] !== undefined) {
        out.push(parts[2] === "batch" || parts[2] === "device" || parts[2] === "list" ? parts[2] : ":entityId");
      }
      // Any extra segments (there are none in the real routes) are redacted.
      for (let i = 3; i < parts.length; i++) out.push(":seg");
      break;
    }
    case "intents": {
      // /intents/(batch|list) — both are safe literals; anything else is redacted.
      out.push("intents");
      if (parts[1] !== undefined) {
        out.push(parts[1] === "batch" || parts[1] === "list" ? parts[1] : ":seg");
      }
      for (let i = 2; i < parts.length; i++) out.push(":seg");
      break;
    }
    case "salt": {
      // /salt/:accountId — the account id identifies a household; always redact.
      out.push("salt");
      if (parts[1] !== undefined) out.push(":accountId");
      for (let i = 2; i < parts.length; i++) out.push(":seg");
      break;
    }
    case "blobs": {
      out.push("blobs");
      if (parts[1] === "uploads") {
        // /blobs/uploads, /blobs/uploads/:uploadId, .../parts/:index, .../finalize
        out.push("uploads");
        if (parts[2] !== undefined) out.push(":uploadId");
        if (parts[3] !== undefined) {
          out.push(parts[3] === "parts" || parts[3] === "finalize" ? parts[3] : ":seg");
        }
        if (parts[4] !== undefined) out.push(":index");
        for (let i = 5; i < parts.length; i++) out.push(":seg");
      } else if (parts[1] !== undefined) {
        // /blobs/:hash and /blobs/:hash/(ref-add|ref-release)
        out.push(":hash");
        if (parts[2] !== undefined) {
          out.push(parts[2] === "ref-add" || parts[2] === "ref-release" ? parts[2] : ":seg");
        }
        for (let i = 3; i < parts.length; i++) out.push(":seg");
      }
      break;
    }
    case "events":
      out.push("events");
      for (let i = 1; i < parts.length; i++) out.push(":seg");
      break;
    default:
      // Unknown route (a 404, a probe): redact every segment so a scanner cannot
      // reflect arbitrary data into the log.
      for (let i = 0; i < parts.length; i++) out.push(":seg");
      break;
  }
  return "/" + out.join("/");
}

export function requestLog(
  log: (message: string) => void = (m) => console.log(m),
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (req.path === "/healthz") {
      next();
      return;
    }
    const startNs = process.hrtime.bigint();
    // Capture the path at request time. req.path is stable and carries no query
    // string; redactPath collapses any user-identifying segment to a template.
    const route = redactPath(req.path);
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      log(`${req.method} ${route} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
    });
    next();
  };
}
