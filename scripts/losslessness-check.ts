// Phase 2 losslessness check. A one-off, standalone, READ-ONLY dogfood script.
// It is not a server feature and not a CI test.
//
// What it does: for each GLANCE app, read the current file-tier sync payload
// (one JSON file per entity on a WebDAV directory), shred it into rows, seed a
// running Phase 1 GLANCEvault server, pull the rows back out, and diff the
// returned envelope bytes against the originals byte-for-byte. The apps never
// touch the server and nothing on disk is modified.
//
// Envelope file structure this script depends on:
//
//   The @glance-apps/sync package writes one file per entity, named
//   <entityId>.json, into the app's sync directory. Each file is a JSON object
//   containing at least:
//     - id:         the stable entity id (the same value as the filename stem)
//     - ciphertext: a base64-encoded byte string holding the full Phase 2.7
//                   envelope (salt + nonce + ciphertext)
//
//   The ciphertext bytes are treated as fully opaque here, exactly as the
//   server treats them. This script never decrypts and never parses the
//   ciphertext. The entity id is taken from the `id` field, falling back to the
//   filename stem if `id` is absent.
//
// Source of truth for the above: the GLANCEvault server spec (docs, the
// Envelope interface in section 3.3: entityId plus ciphertext bytes) and the
// Phase 2 task brief. The @glance-apps/sync repo (glance-sync) is a sibling
// repo on the operator machine but was not accessible from the environment this
// script was authored in, so the field names and encoding are documented here
// from the spec. If the on-disk shape differs, adjust readEnvelopes below; it
// is the single place that knows the file format.
//
// Run with:
//   npx tsx scripts/losslessness-check.ts
//
// Configuration (all via environment variables, see .env.phase2.example):
//   VAULT_URL, VAULT_TOKEN, ACCOUNT_ID,
//   SYNC_DIR_DAYGLANCE, SYNC_DIR_LASTGLANCE, SYNC_DIR_LIFEGLANCE

import { readdir, readFile } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const BATCH_SIZE = 100;
const PAGE_LIMIT = 1000;

interface AppTarget {
  app: string;
  dirEnv: string;
  dir: string;
}

interface DiskEnvelope {
  entityId: string;
  bytes: Buffer;
}

interface AppResult {
  app: string;
  filesRead: number;
  rowsSeeded: number;
  rowsRetrieved: number;
  mismatches: number;
}

function die(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// Read and validate all configuration up front. Collects every problem before
// exiting so the operator sees all of them at once rather than one per run.
function loadConfig(): {
  vaultUrl: string;
  vaultToken: string;
  accountId: string;
  targets: AppTarget[];
} {
  const problems: string[] = [];

  const vaultUrl = process.env.VAULT_URL ?? "";
  const vaultToken = process.env.VAULT_TOKEN ?? "";
  const accountId = process.env.ACCOUNT_ID ?? "";

  if (vaultUrl.trim() === "") problems.push("VAULT_URL is not set");
  if (vaultToken.trim() === "") problems.push("VAULT_TOKEN is not set");
  if (accountId.trim() === "") problems.push("ACCOUNT_ID is not set");

  const targets: AppTarget[] = [
    { app: "dayglance", dirEnv: "SYNC_DIR_DAYGLANCE", dir: process.env.SYNC_DIR_DAYGLANCE ?? "" },
    { app: "lastglance", dirEnv: "SYNC_DIR_LASTGLANCE", dir: process.env.SYNC_DIR_LASTGLANCE ?? "" },
    { app: "lifeglance", dirEnv: "SYNC_DIR_LIFEGLANCE", dir: process.env.SYNC_DIR_LIFEGLANCE ?? "" },
  ];

  for (const t of targets) {
    if (t.dir.trim() === "") {
      problems.push(`${t.dirEnv} is not set`);
      continue;
    }
    if (!existsSync(t.dir) || !statSync(t.dir).isDirectory()) {
      problems.push(`${t.dirEnv} (${t.dir}) does not exist or is not a directory`);
      continue;
    }
    const jsonFiles = jsonFileNames(t.dir);
    if (jsonFiles.length === 0) {
      problems.push(`${t.dirEnv} (${t.dir}) contains no .json files`);
    }
  }

  if (problems.length > 0) {
    console.error("Configuration problems:");
    for (const p of problems) {
      console.error(`  - ${p}`);
    }
    process.exit(1);
  }

  return { vaultUrl: vaultUrl.replace(/\/+$/, ""), vaultToken, accountId, targets };
}

// Synchronous directory listing used during validation. Reads only the names,
// not the file contents.
function jsonFileNames(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json"));
}

// The account id used for one app. Per-app suffix so the seeded rows are
// trivially distinguishable from real household data in the SQLite file, and so
// the three apps do not share a cursor space during the check.
function appAccountId(accountId: string, app: string): string {
  return `${accountId}-${app}`;
}

// Read every .json envelope file in a directory. Returns one DiskEnvelope per
// unique entity id. A malformed file or a file missing its ciphertext is a hard
// error: losslessness must be exact, so nothing is silently skipped.
async function readEnvelopes(dir: string): Promise<DiskEnvelope[]> {
  const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".json"));
  const byId = new Map<string, Buffer>();

  for (const name of names) {
    const full = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, "utf8"));
    } catch (err) {
      die(`Could not parse ${full} as JSON: ${String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null) {
      die(`Envelope file ${full} is not a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;

    const ciphertext = obj.ciphertext;
    if (typeof ciphertext !== "string") {
      die(
        `Envelope file ${full} has no string "ciphertext" field ` +
          `(keys present: ${Object.keys(obj).join(", ") || "none"})`,
      );
    }

    const idField = typeof obj.id === "string" && obj.id.trim() !== "" ? obj.id : null;
    const entityId = idField ?? basename(name, ".json");

    // base64-decode to the raw envelope bytes. This is the canonical form used
    // for both seeding and the final byte comparison, so a non-canonical base64
    // on disk cannot cause a false mismatch.
    byId.set(entityId, Buffer.from(ciphertext, "base64"));
  }

  return [...byId.entries()].map(([entityId, bytes]) => ({ entityId, bytes }));
}

async function vaultFetch(
  vaultUrl: string,
  vaultToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${vaultUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${vaultToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`${init.method ?? "GET"} ${path} returned ${res.status}: ${text}`);
  }
  return res;
}

// Seed all envelopes for one app in batches of BATCH_SIZE. Returns the total
// number of rows written as reported by the server.
async function seed(
  cfg: { vaultUrl: string; vaultToken: string },
  app: string,
  accountId: string,
  envelopes: DiskEnvelope[],
): Promise<number> {
  const batchCount = Math.ceil(envelopes.length / BATCH_SIZE);
  console.log(
    `Seeding ${app}: ${envelopes.length} files in ${batchCount} ` +
      `batch${batchCount === 1 ? "" : "es"} of up to ${BATCH_SIZE}...`,
  );

  let written = 0;
  for (let start = 0, batchNo = 1; start < envelopes.length; start += BATCH_SIZE, batchNo++) {
    const slice = envelopes.slice(start, start + BATCH_SIZE);
    const rows = slice.map((e) => ({ entityId: e.entityId, envelope: e.bytes.toString("base64") }));
    const res = await vaultFetch(cfg.vaultUrl, cfg.vaultToken, `/sync/${app}/batch`, {
      method: "POST",
      body: JSON.stringify({ accountId, rows }),
    });
    const body = (await res.json()) as { written: number; maxSeq: number };
    written += body.written;
    console.log(`  ${app} batch ${batchNo}/${batchCount}: wrote ${body.written} (maxSeq ${body.maxSeq})`);
  }
  return written;
}

// Fetch every row for one app back out, paginating on hasMore until exhausted.
// Returns a map of entity id to the returned envelope bytes.
async function fetchAll(
  cfg: { vaultUrl: string; vaultToken: string },
  app: string,
  accountId: string,
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  let since = 0;
  let page = 0;
  for (;;) {
    page++;
    const url =
      `/sync/${app}/list?accountId=${encodeURIComponent(accountId)}` +
      `&since=${since}&limit=${PAGE_LIMIT}`;
    const res = await vaultFetch(cfg.vaultUrl, cfg.vaultToken, url);
    const body = (await res.json()) as {
      rows: Array<{ entityId: string; envelope: string; seq: number }>;
      hasMore: boolean;
    };
    for (const row of body.rows) {
      out.set(row.entityId, Buffer.from(row.envelope, "base64"));
      since = row.seq;
    }
    console.log(`  Fetching ${app}: page ${page} (${body.rows.length} rows, total ${out.size})`);
    if (!body.hasMore) break;
  }
  console.log(`Fetching ${app}: done, ${out.size} rows retrieved`);
  return out;
}

// Compare retrieved bytes against the originals. Counts a mismatch for any
// entity that is missing from the retrieved set or whose bytes differ.
function countMismatches(envelopes: DiskEnvelope[], retrieved: Map<string, Buffer>): number {
  let mismatches = 0;
  for (const e of envelopes) {
    const got = retrieved.get(e.entityId);
    if (got === undefined) {
      console.error(`  MISMATCH: ${e.entityId} was not returned by the server`);
      mismatches++;
      continue;
    }
    if (!got.equals(e.bytes)) {
      console.error(
        `  MISMATCH: ${e.entityId} bytes differ ` +
          `(original ${e.bytes.length} bytes, returned ${got.length} bytes)`,
      );
      mismatches++;
    }
  }
  return mismatches;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`GLANCEvault losslessness check against ${cfg.vaultUrl}`);
  console.log(`Base account id: ${cfg.accountId} (per-app suffix applied)`);
  console.log("");

  const results: AppResult[] = [];

  for (const target of cfg.targets) {
    const accountId = appAccountId(cfg.accountId, target.app);
    console.log(`=== ${target.app} (account ${accountId}) ===`);

    const envelopes = await readEnvelopes(target.dir);
    const filesRead = jsonFileNames(target.dir).length;
    console.log(`Read ${filesRead} files, ${envelopes.length} unique entities from ${target.dir}`);

    const rowsSeeded = await seed(cfg, target.app, accountId, envelopes);
    const retrieved = await fetchAll(cfg, target.app, accountId);
    const mismatches = countMismatches(envelopes, retrieved);

    results.push({
      app: target.app,
      filesRead,
      rowsSeeded,
      rowsRetrieved: retrieved.size,
      mismatches,
    });
    console.log("");
  }

  console.log("=== Summary ===");
  let allPass = true;
  for (const r of results) {
    const pass = r.mismatches === 0 && r.rowsRetrieved === r.rowsSeeded;
    if (!pass) allPass = false;
    console.log(
      `${r.app}: files=${r.filesRead} seeded=${r.rowsSeeded} ` +
        `retrieved=${r.rowsRetrieved} mismatches=${r.mismatches} -> ${pass ? "PASS" : "FAIL"}`,
    );
  }

  if (!allPass) {
    die("losslessness check FAILED: see mismatches above");
  }
  console.log("");
  console.log("losslessness check PASSED: every app round-tripped byte-for-byte");
}

main().catch((err) => {
  die(`unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
