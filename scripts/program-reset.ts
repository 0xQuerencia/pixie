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

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
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

function fingerprint(dbPath: string) {
  return crypto
    .createHash("sha256")
    .update(`${path.resolve(dbPath)}${os.hostname()}`)
    .digest("hex")
    .slice(0, 8);
}

function guard(options: ReturnType<typeof parseArgs>, dbPath: string) {
  const expected = fingerprint(dbPath);
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

function tableCount(db: ReturnType<typeof Database>, table: string, manifest: Row): number {
  const ids = Array.isArray(manifest.programIds)
    ? manifest.programIds.filter((id): id is string => typeof id === "string")
    : [];
  let where = "1 = 1";
  let params: (string | number | boolean | null | Uint8Array)[] = [];
  if (table === "job_leases") {
    where = ids.length ? ids.map(() => "instr(name, ?) > 0").join(" OR ") : "1 = 0";
    params = ids;
  }
  const count = row(db.query(`SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${where}`).get(...params)).count;
  return Number(count || 0);
}

function verifyArchive(dbPath: string, archivePath: string) {
  const manifestFile = manifestPath(archivePath);
  if (!manifestFile) throw new Error("archive manifest.json not found beside archive database");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Row;
  const expectedPath = path.resolve(archivePath);
  if (manifest.archiveDbPath !== expectedPath) throw new Error("archive path does not match manifest");
  if (manifest.sourceDbPath !== path.resolve(dbPath)) throw new Error("archive source database does not match --db");
  const expectedHash = String(manifest.sha256 || manifest.dbSha256 || "");
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (!expectedHash || expectedHash !== actualHash) throw new Error("archive sha256 does not match manifest");
  const archive = new Database(archivePath, { readonly: true, create: false });
  const live = new Database(dbPath, { readonly: true, create: false });
  try {
    const counts = row(manifest.rowCounts);
    for (const table of Object.keys(counts)) {
      const archived = tableCount(archive, table, manifest);
      const current = tableCount(live, table, manifest);
      if (archived !== Number(counts[table]) || current !== Number(counts[table])) {
        throw new Error(
          `archive row count mismatch for ${table}: archive=${archived}, live=${current}, manifest=${counts[table]}`,
        );
      }
    }
  } finally {
    archive.close();
    live.close();
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
  if (options.execute) {
    if (!options.archive) throw new Error("--execute requires --archive PATH");
    guard(options, dbPath);
    verifyArchive(dbPath, path.resolve(options.archive));
  }
  const db = options.execute ? new Database(dbPath) : new Database(dbPath, { readonly: true, create: false });
  try {
    const result = options.all
      ? purge.purgeAllPrograms(db, { dryRun: !options.execute })
      : purge.purgeProgram(db, options.programId, { dryRun: !options.execute });
    printSummary(options.execute ? "executed" : "dry-run", options.all ? "all programs" : options.programId, result);
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
