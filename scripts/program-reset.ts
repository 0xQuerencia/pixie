import crypto = require("node:crypto");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import sqlite = require("bun:sqlite");

const { Database } = sqlite;
const purge = require("../lib/programPurge");
const ROOT = path.join(__dirname, "..");

type Row = Record<string, unknown>;

function row(value: unknown): Row {
  return value && typeof value === "object" ? (value as Row) : {};
}


function parseArgs(argv: string[]) {
  const options = {
    dbPath: process.env.PIXIE_DB_PATH || path.join(ROOT, "pixie.db"),
    programId: "",
    all: false,
    execute: false,
    archive: "",
    confirm: "",
    allowProduction: false,
    ignoreRunning: false,
    phrase: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.dbPath = argv[++index] || options.dbPath;
    else if (arg === "--program") options.programId = argv[++index] || "";
    else if (arg === "--all") options.all = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--archive") options.archive = argv[++index] || "";
    else if (arg === "--confirm") options.confirm = argv[++index] || "";
    else if (arg === "--allow-production") options.allowProduction = true;
    else if (arg === "--ignore-running") options.ignoreRunning = true;
    else if (arg === "--phrase") options.phrase = argv[++index] || "";
    else if (!arg.startsWith("-")) options.programId ||= arg;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: bun scripts/program-reset.ts [PROGRAM_ID|--program ID|--all] [--execute --archive PATH --confirm FINGERPRINT]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.all && !options.programId) throw new Error("a program id or --all is required");
  if (options.all && options.programId) throw new Error("choose one program id or --all");
  return options;
}

function fingerprint(dbPath: string, digests: unknown) {
  return crypto
    .createHash("sha256")
    .update(`${path.resolve(dbPath)}\n${os.hostname()}\n${JSON.stringify(digests)}`)
    .digest("hex")
    .slice(0, 8);
}

function guard(options: ReturnType<typeof parseArgs>, expected: string) {
  if (options.confirm !== expected) throw new Error(`confirmation fingerprint mismatch; expected ${expected}`);
  const production = Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === "production";
  if (production && (!options.allowProduction || options.phrase !== `RESET-${expected}`)) {
    throw new Error(`production reset requires --allow-production and --phrase RESET-${expected}`);
  }
}

function manifestPath(archivePath: string) {
  const base = path.basename(archivePath, path.extname(archivePath)).replace(/^pixie-archive-/, "");
  const candidates = [
    path.join(path.dirname(archivePath), base, "manifest.json"),
    path.join(path.dirname(archivePath), `${base}.manifest.json`),
    path.join(path.dirname(archivePath), "manifest.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function sameDigests(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verifyArchive(live: ReturnType<typeof Database>, archivePath: string, ids: string[], liveDigests: unknown) {
  const manifestFile = manifestPath(archivePath);
  if (!manifestFile) throw new Error("archive manifest.json not found beside archive database");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Row;
  if (manifest.archiveDbPath !== path.resolve(archivePath)) throw new Error("archive path does not match manifest");
  const expectedHash = String(manifest.sha256 || manifest.dbSha256 || "");
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (!expectedHash || expectedHash !== actualHash) throw new Error("archive sha256 does not match manifest");
  const archive = new Database(archivePath, { readonly: true, create: false });
  try {
    const archived = purge.digest(archive, ids);
    if (!sameDigests(archived, liveDigests)) {
      const drift = Object.keys(liveDigests as Row).filter(
        (table) => JSON.stringify((archived as Row)[table]) !== JSON.stringify((liveDigests as Row)[table]),
      );
      throw new Error(`archive does not match the live data that would be deleted (differs: ${drift.join(", ")})`);
    }
  } finally {
    archive.close();
  }
}

function printSummary(mode: string, target: string, results: Row | Record<string, unknown>) {
  console.log(`program reset ${mode}: ${target}`);
  console.log(JSON.stringify(results, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(options.dbPath);
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  if (options.execute && !options.archive) throw new Error("--execute requires --archive PATH");
  const db = options.execute ? new Database(dbPath) : new Database(dbPath, { readonly: true, create: false });
  try {
    if (options.execute) db.exec("BEGIN IMMEDIATE");
    const ids: string[] = options.all ? purge.programIds(db) : [options.programId];
    const digests = purge.digest(db, ids);
    const expected = fingerprint(dbPath, digests);
    if (options.execute) {
      const running = options.ignoreRunning ? [] : purge.runningInstances(db);
      if (running.length > 0) {
        throw new Error(`a Pixie instance looks active (unexpired job leases: ${running.join(", ")}); stop it first`);
      }
      guard(options, expected);
      verifyArchive(db, path.resolve(options.archive), ids, digests);
    }
    const result = options.all
      ? purge.purgeAllPrograms(db, { dryRun: !options.execute })
      : purge.purgeProgram(db, options.programId, { dryRun: !options.execute });
    if (options.execute) db.exec("COMMIT");
    printSummary(options.execute ? "executed" : "dry-run", options.all ? "all programs" : options.programId, result);
    if (!options.execute) console.log(`confirm fingerprint (binds this database, host and current data): ${expected}`);
  } catch (error: unknown) {
    if (options.execute) {
      try {
        db.exec("ROLLBACK");
      } catch (_) {}
    }
    throw error;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`program reset refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
