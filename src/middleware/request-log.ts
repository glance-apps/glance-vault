import type { Request, Response, NextFunction } from "express";

// Minimal request logging: one concise line per request, emitted once the
// response is sent. This exists to answer the first question in any connectivity
// report — did the client's request even reach the server? — which was
// previously unanswerable because nothing logged request traffic at all. It runs
// before CORS and auth, so a blocked preflight (OPTIONS ... 204 with no allow
// headers) and a rejected token (... 401) both show up, which is exactly the
// signal an operator needs when a client "does nothing" and the cause is unclear.
//
// GET /healthz is skipped: the Docker healthcheck pings it every 30s, so logging
// it would bury real traffic. The log sink is injectable (defaulting to
// console.log, matching the reclaim sweep) so tests can observe output without
// capturing stdout.
export function requestLog(
  log: (message: string) => void = (m) => console.log(m),
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (req.path === "/healthz") {
      next();
      return;
    }
    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
    });
    next();
  };
}
