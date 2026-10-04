import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";

// Every GLANCEVAULT_* variable config.ts reads, taken from the source itself so a
// newly added variable is covered here without anyone remembering to list it.
const repoFile = (name: string) => new URL(`../${name}`, import.meta.url);
const configSource = readFileSync(repoFile("src/config.ts"), "utf8");
const VARIABLES = [
  ...new Set([...configSource.matchAll(/\benv\.(GLANCEVAULT_[A-Z0-9_]+)/g)].map((m) => m[1])),
].sort();
const REQUIRED = new Set(["GLANCEVAULT_DEVICE_TOKEN"]);
const OPTIONAL = VARIABLES.filter((name) => !REQUIRED.has(name));

test("the variable list extracted from config.ts is non-trivial", () => {
  for (const name of ["GLANCEVAULT_DEVICE_TOKEN", "GLANCEVAULT_CONFIG", "GLANCEVAULT_RATE_LIMIT"]) {
    assert.ok(VARIABLES.includes(name), `${name} not found in config.ts`);
  }
});

// Minimal reader for a compose file's environment: block(s): returns the
// KEY -> raw value mapping. No YAML dependency; the compose files use the plain
// `KEY: value` map form, which is all this needs to understand.
function composeEnvironment(file: string): Map<string, string> {
  const lines = readFileSync(repoFile(file), "utf8").split("\n");
  const vars = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)environment:\s*$/.exec(lines[i]);
    if (!header) continue;
    const indent = header[1].length;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (line.length - line.trimStart().length <= indent) {
        i--;
        break;
      }
      const entry = /^\s*([A-Z0-9_]+):\s*(.*)$/.exec(line);
      assert.ok(entry, `${file}: unexpected environment line: ${line}`);
      vars.set(entry[1], entry[2]);
    }
  }
  return vars;
}

for (const file of ["docker-compose.yml", "docker-compose.example.yml"]) {
  test(`${file} passes every GLANCEVAULT_* variable config.ts reads into the container`, () => {
    const vars = composeEnvironment(file);
    const missing = VARIABLES.filter((name) => !vars.has(name));
    assert.deepEqual(missing, [], `${file} environment: block is missing ${missing.join(", ")}`);
  });

  test(`${file} interpolates each passthrough from the variable of the same name`, () => {
    for (const [name, value] of composeEnvironment(file)) {
      const ref = /\$\{([A-Z0-9_]+)/.exec(value);
      if (ref) assert.equal(ref[1], name, `${file}: ${name} reads \${${ref[1]}}`);
    }
  });
}

// The compose files pass optional settings through as ${VAR:-}, so an unset .env
// line arrives as "". That must behave exactly as if the variable were absent.
const base = { GLANCEVAULT_DEVICE_TOKEN: "test-token" };
const baseline = loadConfig(base);

for (const name of OPTIONAL.filter((n) => n !== "GLANCEVAULT_CONFIG")) {
  test(`empty ${name} is treated as unset`, () => {
    assert.deepEqual(loadConfig({ ...base, [name]: "" }), baseline);
    assert.deepEqual(loadConfig({ ...base, [name]: "   " }), baseline);
  });
}

// GLANCEVAULT_CONFIG is read from process.env (it locates the file the env
// overlays), so exercise it there.
test("empty GLANCEVAULT_CONFIG is treated as unset", () => {
  const saved = process.env.GLANCEVAULT_CONFIG;
  try {
    for (const blank of ["", "   "]) {
      process.env.GLANCEVAULT_CONFIG = blank;
      assert.deepEqual(loadConfig(base), baseline);
    }
  } finally {
    if (saved === undefined) delete process.env.GLANCEVAULT_CONFIG;
    else process.env.GLANCEVAULT_CONFIG = saved;
  }
});
