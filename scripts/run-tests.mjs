#!/usr/bin/env node
// Hermetic per-file test runner: every lib/**/*.test.{js,ts} runs in its own
// `bun test <file>` process so bun:test module state (and the shared DB
// handle) can never leak between files. A bare `bun test` at the repo root
// also discovers pixie-wizard/ tests (see bunfig.toml), so `bun test` (the
// "test" script) means this file.
//
// The dashboard's tests (pixie-wizard/**/*.test.ts) need the same isolation:
// several of them mock.module("./pixieCore"), and in one shared process that
// mock leaks into the next file as "Export named ... not found". --wizard
// runs those, one process each, with cwd pixie-wizard; --all runs both.
//
// Usage:
//   bun scripts/run-tests.mjs [--wizard|--all] [--filter <substring>] [--junit <dir>] [--concurrency N]
import { readdirSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib");
const WIZARD = path.join(ROOT, "pixie-wizard");

function collectTests(dir, suffixes = [".test.js", ".test.ts"]) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTests(full, suffixes));
    else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) out.push(full);
  }
  return out.sort();
}

// Hermetic child env: strip every credential-shaped variable plus the Jev and
// database overrides, so a local .env can never turn unit tests into live
// integration tests. The bunfig preload still pins PIXIE_DB_PATH=:memory: and
// JEV_ENABLED=false inside each child.
function hermeticEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.endsWith("_API_KEY") ||
      key.endsWith("_TOKEN") ||
      key.startsWith("SLACK_") ||
      key.startsWith("JEV_") ||
      key.startsWith("EXPERIENTIAL_") ||
      key === "DATABASE_URL" ||
      key === "PIXIE_TEST_ALLOW_NETWORK" ||
      key === "PIXIE_ANSWER_BASE_URL" ||
      key === "PIXIE_PING_BASE_URL" ||
      key === "PIXIE_ANSWER_PROVIDER"
    ) {
      delete env[key];
    }
  }
  env.TZ = "UTC";
  return env;
}

function runOne(file, junitDir) {
  return new Promise((resolve) => {
    const rel = path.relative(ROOT, file);
    const inWizard = file.startsWith(WIZARD + path.sep);
    const args = ["test", inWizard ? `./${path.relative(WIZARD, file)}` : file];
    if (junitDir) {
      const out = path.join(junitDir, `${rel.replaceAll(path.sep, "__").replace(/\.test\.[jt]s$/, "")}.xml`);
      args.push("--reporter=junit", `--reporter-outfile=${out}`);
    }
    const start = Date.now();
    const child = spawn("bun", args, { cwd: inWizard ? WIZARD : ROOT, env: hermeticEnv(), stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("close", (code, signal) => {
      resolve({ file: rel, code: code ?? 1, signal, ms: Date.now() - start, output });
    });
    child.on("error", (err) => {
      resolve({ file: rel, code: 1, signal: null, ms: Date.now() - start, output: String(err) });
    });
  });
}

function parseArgs(argv) {
  const opts = { filter: null, junit: null, concurrency: 4, lib: true, wizard: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wizard") Object.assign(opts, { lib: false, wizard: true });
    else if (argv[i] === "--all") Object.assign(opts, { lib: true, wizard: true });
    else if (argv[i] === "--filter") opts.filter = argv[++i] ?? null;
    else if (argv[i] === "--junit") opts.junit = argv[++i] ?? null;
    else if (argv[i] === "--concurrency") opts.concurrency = Math.max(1, Number(argv[++i]) || 4);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: bun scripts/run-tests.mjs [--wizard|--all] [--filter <substring>] [--junit <dir>] [--concurrency N]");
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let files = [
  ...(opts.lib ? collectTests(LIB) : []),
  ...(opts.wizard ? [...collectTests(path.join(WIZARD, "lib"), [".test.ts"]), ...collectTests(path.join(WIZARD, "app"), [".test.ts"])] : []),
];
if (opts.filter) {
  // Match against the repo-relative path: the absolute worktree path itself
  // may contain the substring (e.g. a `pixie-w-jev` checkout matches "jev").
  files = files.filter((f) => path.relative(ROOT, f).includes(opts.filter));
}
if (files.length === 0) {
  console.error("run-tests: no test files matched");
  process.exit(2);
}
if (opts.junit) mkdirSync(path.resolve(ROOT, opts.junit), { recursive: true });

const results = new Array(files.length);
let next = 0;
async function worker() {
  while (next < files.length) {
    const idx = next++;
    results[idx] = await runOne(files[idx], opts.junit ? path.resolve(ROOT, opts.junit) : null);
    const r = results[idx];
    const status = r.code === 0 ? "PASS" : `FAIL(${r.code})`;
    console.log(`${status} ${r.file} (${r.ms}ms)`);
    if (r.code !== 0) {
      const tail = r.output.trim().split("\n").slice(-80).join("\n");
      if (tail) console.log(`--- ${r.file} output tail ---\n${tail}\n--- end ---`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker));

const failed = results.filter((r) => r.code !== 0);
console.log(`\nrun-tests: ${results.length - failed.length}/${results.length} files passed`);
if (failed.length > 0) {
  console.log(`failed: ${failed.map((r) => r.file).join(", ")}`);
  process.exit(1);
}
