import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { rateLimit } from "../src/middleware/rate-limit.js";

// Drive the middleware directly with tiny fake req/res objects and an injectable
// clock, so the fixed-window behavior is exercised deterministically without a
// live server or real time.
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  ended: boolean;
}

function makeReq(ip: string, path = "/sync/dayglance/list"): Request {
  return { ip, path } as unknown as Request;
}

function makeRes(): { res: Response; out: FakeRes } {
  const out: FakeRes = { statusCode: 0, headers: {}, body: undefined, ended: false };
  const res = {
    setHeader(k: string, v: string) {
      out.headers[k.toLowerCase()] = v;
    },
    status(code: number) {
      out.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      out.body = payload;
      out.ended = true;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

// Run one request through the middleware, returning whether next() was called
// (i.e. the request was allowed) and the captured response.
function run(mw: ReturnType<typeof rateLimit>, req: Request): { allowed: boolean; out: FakeRes } {
  const { res, out } = makeRes();
  let allowed = false;
  mw(req, res, () => {
    allowed = true;
  });
  return { allowed, out };
}

test("allows up to max requests per IP per window, then 429s", () => {
  let clock = 1000;
  const mw = rateLimit({ windowMs: 60_000, max: 3, now: () => clock });

  // First 3 from the same IP pass.
  for (let i = 0; i < 3; i++) {
    const { allowed } = run(mw, makeReq("1.2.3.4"));
    assert.equal(allowed, true, `request ${i + 1} within the limit is allowed`);
  }
  // The 4th is throttled with a Retry-After header.
  const fourth = run(mw, makeReq("1.2.3.4"));
  assert.equal(fourth.allowed, false, "the 4th request is blocked");
  assert.equal(fourth.out.statusCode, 429);
  assert.ok(Number(fourth.out.headers["retry-after"]) >= 1, "a Retry-After is set");
});

test("the window rolls over: after windowMs the same IP is allowed again", () => {
  let clock = 0;
  const mw = rateLimit({ windowMs: 1000, max: 1, now: () => clock });

  assert.equal(run(mw, makeReq("9.9.9.9")).allowed, true, "first is allowed");
  assert.equal(run(mw, makeReq("9.9.9.9")).allowed, false, "second within the window is blocked");

  clock += 1001; // advance past the window
  assert.equal(run(mw, makeReq("9.9.9.9")).allowed, true, "allowed again after the window rolls over");
});

test("limits are per-IP: one client's flood does not throttle another", () => {
  let clock = 0;
  const mw = rateLimit({ windowMs: 60_000, max: 1, now: () => clock });

  assert.equal(run(mw, makeReq("1.1.1.1")).allowed, true);
  assert.equal(run(mw, makeReq("1.1.1.1")).allowed, false, "IP A is throttled");
  assert.equal(run(mw, makeReq("2.2.2.2")).allowed, true, "IP B is unaffected");
});

test("/healthz is exempt from rate limiting", () => {
  let clock = 0;
  const mw = rateLimit({ windowMs: 60_000, max: 1, now: () => clock });
  // Many health checks from the same IP never get throttled.
  for (let i = 0; i < 5; i++) {
    assert.equal(run(mw, makeReq("1.2.3.4", "/healthz")).allowed, true, "healthz always passes");
  }
});
