#!/usr/bin/env node
/**
 * Test runner.
 *
 * Node's built-in test runner is used directly (`node --test`), with tsx
 * registered as the loader so TypeScript sources run without a build step.
 *
 * Discovers `*.test.ts` under the workspace and runs them. An optional first
 * argument filters by path substring:
 *
 *   node scripts/run-tests.mjs            # everything
 *   node scripts/run-tests.mjs unit
 *   node scripts/run-tests.mjs security
 *   node scripts/run-tests.mjs e2e
 *
 * Adds no dependencies beyond tsx, which is already a devDependency.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".wrangler",
  "data",
  ".pnpm-store",
]);

/** Recursively collect *.test.ts files. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const filter = process.argv[2];
let files = collect(ROOT).sort();

if (filter) {
  files = files.filter((f) => relative(ROOT, f).includes(filter));
}

if (files.length === 0) {
  console.error(
    filter
      ? `no test files matched filter "${filter}"`
      : "no test files found (*.test.ts)",
  );
  process.exit(1);
}

console.log(`running ${files.length} test file(s)${filter ? ` [${filter}]` : ""}`);
for (const f of files) console.log(`  ${relative(ROOT, f)}`);
console.log("");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-reporter=spec", ...files],
  { stdio: "inherit", cwd: ROOT, env: process.env },
);

process.exit(result.status ?? 1);
