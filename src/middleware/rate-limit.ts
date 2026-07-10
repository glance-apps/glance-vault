import type { Request, Response, NextFunction } from "express";

// Basic in-memory, per-IP rate limiting. A fixed-window counter per client IP:
// at most `max` requests per `windowMs`; the (window + 1)th request is answered
// with 429 and a Retry-After header until the window rolls over. This is a
// coarse abuse backstop, not a fairness scheduler — it exists so a single client
// (or a leaked-token flood) cannot hammer auth or exhaust the process, on top of
// whatever the reverse proxy enforces.
//
// No dependency and no background timer: expired windows are swept lazily (a
// bounded pass no more than once per window) so the map cannot grow without
// bound from churned IPs, and there is no unref'd timer to leak in tests.
//
// IP ATTRIBUTION: req.ip is only meaningful when Express is told which proxies to
// trust (app.set("trust proxy", ...)), because the server sits behind a
// TLS-terminating reverse proxy. With trust proxy unset, every request appears to
// come from the proxy's address and shares one bucket. server.ts configures
// trust proxy from config; see the README reverse-proxy section.
//
// /healthz is exempt: the container healthcheck pings it every 30s from the
// loopback proxy and must never be throttled.

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  // Injectable clock for tests; production uses Date.now.
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: RateLimitOptions) {
  const windowMs = opts.windowMs;
  const max = opts.max;
  const now = opts.now ?? (() => Date.now());
  const windows = new Map<string, Window>();
  let nextSweep = 0;

  return function (req: Request, res: Response, next: NextFunction): void {
    if (req.path === "/healthz") {
      next();
      return;
    }
    const t = now();

    // Lazy sweep: at most once per window, drop expired entries so the map stays
    // bounded even under a flood of one-shot IPs.
    if (t >= nextSweep) {
      for (const [key, w] of windows) {
        if (t >= w.resetAt) {
          windows.delete(key);
        }
      }
      nextSweep = t + windowMs;
    }

    // A missing/blank req.ip (should not happen behind a proxy, but be safe)
    // collapses to a single shared bucket rather than bypassing the limit.
    const key = req.ip ?? "unknown";
    let w = windows.get(key);
    if (w === undefined || t >= w.resetAt) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.count += 1;

    if (w.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }

    next();
  };
}
