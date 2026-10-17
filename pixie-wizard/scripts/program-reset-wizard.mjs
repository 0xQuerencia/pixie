import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { checkResetGuards, databaseFingerprint } from "../lib/resetGuards.ts";

const { Pool } = pg;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function parseArgs(argv) {
  const options = {
    programId: "",
    execute: false,
    confirm: "",
    allowProduction: false,
    phrase: "",
    output: path.join(process.cwd(), "archive"),
    archiveOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--program") options.programId = argv[++index] || "";
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--confirm") options.confirm = argv[++index] || "";
    else if (arg === "--allow-production") options.allowProduction = true;
    else if (arg === "--phrase") options.phrase = argv[++index] || "";
    else if (arg === "--output") options.output = argv[++index] || options.output;
    else if (arg === "--archive-only") options.archiveOnly = true;
    else if (!arg.startsWith("-")) options.programId ||= arg;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: bun scripts/program-reset-wizard.mjs PROGRAM_ID [--execute --confirm FINGERPRINT] [--allow-production --phrase RESET-FINGERPRINT]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.programId) throw new Error("a program id is required");
  if (options.archiveOnly && options.execute) throw new Error("--archive-only cannot be combined with --execute");
  return options;
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

const RESET_TABLES = [
  "hosted_programs",
  "hosted_program_channels",
  "hosted_program_helpers",
  "hosted_entitlements",
  "wizard_entitlements",
  "hosted_audit_events",
];

async function existingTables(client) {
  const rows = await client.query(
    "select table_name from information_schema.tables where table_schema = current_schema() and table_name = any($1::text[])",
    [RESET_TABLES],
  );
  return new Set(rows.rows.map((row) => row.table_name));
}

async function snapshot(client, programId, createdAt, available = new Set(RESET_TABLES)) {
  const tables = {};
  for (const table of RESET_TABLES) {
    if (!available.has(table)) {
      tables[table] = [];
      continue;
    }
    const query =
      table === "hosted_programs"
        ? "select * from hosted_programs where id = $1"
        : `select * from ${table} where program_id = $1`;
    try {
      tables[table] = (await client.query(query, [programId])).rows;
    } catch (error) {
      if (error?.code === "42P01") tables[table] = [];
      else throw error;
    }
  }
  const payload = { version: 1, programId, createdAt, hostname: os.hostname(), tables };
  const checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, sha256: checksum };
}

function writeSnapshot(output, programId, snapshotData) {
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, `pixie-wizard-${programId}-${stamp()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(snapshotData, null, 2)}\n`, { flag: "wx" });
  return file;
}

async function counts(client, programId, available = new Set(RESET_TABLES)) {
  const tables = {};
  for (const table of RESET_TABLES.filter((name) => name !== "hosted_entitlements")) {
    if (!available.has(table)) {
      tables[table] = 0;
      continue;
    }
    const query =
      table === "hosted_programs"
        ? "select count(*)::int as count from hosted_programs where id = $1"
        : `select count(*)::int as count from ${table} where program_id = $1`;
    try {
      tables[table] = (await client.query(query, [programId])).rows[0]?.count || 0;
    } catch (error) {
      if (error?.code === "42P01") tables[table] = 0;
      else throw error;
    }
  }
  return tables;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = required("DATABASE_URL");
  const fingerprint = databaseFingerprint(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: /sslmode=require/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const client = await pool.connect();
    try {
      if (!options.execute) {
        const available = await existingTables(client);
        const summary = await counts(client, options.programId, available);
        if (!summary.hosted_programs) throw new Error(`${options.programId} does not exist`);
        if (options.archiveOnly) {
          const archive = await snapshot(client, options.programId, new Date().toISOString(), available);
          const archivePath = writeSnapshot(options.output, options.programId, archive);
          console.log(`wizard program archive written: ${options.programId}`);
          console.log(JSON.stringify({ fingerprint, archivePath, checksum: archive.sha256, counts: summary }, null, 2));
          return;
        }
        console.log(`wizard program reset dry-run: ${options.programId}`);
        console.log(JSON.stringify({ fingerprint, counts: summary }, null, 2));
        return;
      }
      const guard = checkResetGuards({
        fingerprint,
        confirm: options.confirm,
        allowProduction: options.allowProduction,
        phrase: options.phrase,
        railwayEnvironment: process.env.RAILWAY_ENVIRONMENT,
        nodeEnv: process.env.NODE_ENV,
      });
      if (!guard.ok) throw new Error(guard.error);
      await client.query("begin");
      try {
        const available = await existingTables(client);
        const summary = await counts(client, options.programId, available);
        if (!summary.hosted_programs) throw new Error(`${options.programId} does not exist`);
        const archive = await snapshot(client, options.programId, new Date().toISOString(), available);
        const archivePath = writeSnapshot(options.output, options.programId, archive);
        await client.query("delete from hosted_programs where id = $1", [options.programId]);
        await client.query("commit");
        console.log(`wizard program reset executed: ${options.programId}`);
        console.log(JSON.stringify({ fingerprint, archivePath, checksum: archive.sha256, counts: summary }, null, 2));
      } catch (error) {
        await client.query("rollback").catch(() => null);
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`wizard program reset refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
