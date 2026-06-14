import type { Request, Response, NextFunction } from "express";

// CORS for browser clients (the PWA and Electron renderer). Allowed origins are
// configurable; a request from an allowed origin gets the matching CORS headers,
// and preflight OPTIONS requests are answered here with 204.
//
// This middleware must run BEFORE the device-token auth middleware: a preflight
// OPTIONS request never carries the Authorization header, so it would otherwise
// be rejected with 401 before the browser ever sends the real request.
//
// The device token travels in the Authorization header, not a cookie, so there
// is no need for Access-Control-Allow-Credentials. A literal "*" in the allow
// list permits any origin.
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type";
const MAX_AGE_SECONDS = "86400";

export function cors(allowedOrigins: string[] | undefined) {
  const origins = allowedOrigins ?? [];
  const allowAll = origins.includes("*");
  const allowList = new Set(origins);

  return function (req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    const originAllowed =
      typeof origin === "string" && (allowAll || allowList.has(origin));

    if (originAllowed) {
      // Echo the specific origin (with Vary) unless a wildcard is configured.
      if (allowAll) {
        res.setHeader("Access-Control-Allow-Origin", "*");
      } else {
        res.setHeader("Access-Control-Allow-Origin", origin as string);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", MAX_AGE_SECONDS);
    }

    // Answer preflight here, before auth. A disallowed origin still gets a 204
    // but without the allow headers, so the browser blocks the real request.
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
