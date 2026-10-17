import crypto = require("node:crypto");
import exec = require("node:child_process");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import sqlite = require("bun:sqlite");

const { Database } = sqlite;
const purge = require("../lib/programPurge");
const ROOT = path.join(__dirname, "..");

type Row = Record<string, unknown>;

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function row(value: unknown): Row {
  return value && typeof value === "object" ? (value as Row) : {};
}

function parseArgs(argv: string[]) {
  const options = {
    dbPath: process.env.PIXIE_DB_PATH || path.join(ROOT, "pixie.db"),
    output: path.join(ROOT, "archive"),
    questions: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") options.dbPath = argv[++index] || options.dbPath;
    else if (arg === "--output") options.output = argv[++index] || options.output;
    else if (arg === "--export-questions") options.questions = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/program-archive.ts [--db PATH] [--output DIR] [--export-questions]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const FULL_COPY_TABLES = ["answer_cache", "source_cache"];

function tableRows(source: ReturnType<typeof Database>, name: string, programIds: string[], targets: Set<string>) {
  if (targets.has(name)) return purge.scopedRows(source, name, programIds);
  if (FULL_COPY_TABLES.includes(name)) return source.query(`SELECT * FROM ${quote(name)}`).all();
  return [];
}

function shouldArchiveTable(name: string, targets: Set<string>) {
  return targets.has(name) || FULL_COPY_TABLES.includes(name);
}

function schema(source: ReturnType<typeof Database>) {
  return source
    .query(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name",
    )
    .all()
    .map((value: unknown) => row(value));
}

function programIds(
  source: ReturnType<typeof Database>,
  scopedTables: ReturnType<typeof purge.discoverProgramScopedTables>,
) {
  const ids = new Set<string>();
  for (const value of source.query("SELECT id FROM programs").all()) {
    const id = row(value).id;
    if (typeof id === "string" && id) ids.add(id);
  }
  for (const table of scopedTables) {
    for (const column of ["program_id", "draft_program_id"]) {
      if (!table.columns.has(column)) continue;
      for (const value of source.query(`SELECT DISTINCT ${quote(column)} AS id FROM ${quote(table.name)}`).all()) {
        const id = row(value).id;
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  return [...ids].sort();
}

function copyRows(
  source: ReturnType<typeof Database>,
  archive: ReturnType<typeof Database>,
  name: string,
  values: unknown[],
) {
  if (values.length === 0) return 0;
  const columns = source
    .query(`PRAGMA table_info(${quote(name)})`)
    .all()
    .map((value: unknown) => String(row(value).name || ""));
  const insert = archive.query(
    `INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
  );
  for (const value of values) {
    const sourceRow = row(value);
    insert.run(...columns.map((column) => sourceRow[column] as string | number | boolean | null | Uint8Array));
  }
  return values.length;
}

function copyFiles(bundleDir: string) {
  for (const filename of ["programs.json", "sources.json", "program.json"]) {
    const source = path.join(ROOT, filename);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(bundleDir, filename));
  }
  const files = new Set<string>();
  for (const filename of ["programs.json", "sources.json"]) {
    const source = path.join(ROOT, filename);
    if (!fs.existsSync(source)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(source, "utf8")) as unknown;
      collectFiles(value, files);
    } catch (_) {}
  }
  const knowledgeDir = path.join(bundleDir, "knowledge");
  for (const file of files) {
    const relative = path.relative(ROOT, file);
    const destination = path.join(knowledgeDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
}

function collectFiles(value: unknown, files: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files);
    return;
  }
  if (!value || typeof value !== "object") return;
  const source = row(value);
  if (typeof source.url === "string" && source.url.startsWith("file://")) {
    const relative = decodeURIComponent(source.url.slice("file://".length)).replace(/^\.\//, "");
    const fullPath = path.resolve(ROOT, relative);
    if (fullPath.startsWith(`${ROOT}${path.sep}`) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile())
      files.add(fullPath);
  }
  for (const child of Object.values(source)) collectFiles(child, files);
}

function questionsForProgram(source: ReturnType<typeof Database>, programId: string) {
  const questions: Row[] = [];
  for (const value of source
    .query("SELECT id, question, thread_ts, created_at FROM tickets WHERE program_id = ? ORDER BY created_at, id")
    .all(programId)) {
    const ticket = row(value);
    questions.push({
      source: "ticket",
      question: ticket.question,
      ticketId: ticket.id,
      threadTs: ticket.thread_ts,
      createdAt: ticket.created_at,
    });
  }
  for (const value of source
    .query("SELECT id, question, message_ts, created_at FROM doc_gaps WHERE program_id = ? ORDER BY created_at, id")
    .all(programId)) {
    const gap = row(value);
    questions.push({
      source: "doc_gap",
      question: gap.question,
      gapId: gap.id,
      messageTs: gap.message_ts,
      createdAt: gap.created_at,
    });
  }
  const threads = new Set(
    questions.map((item) => item.threadTs).filter((value): value is string => typeof value === "string" && value),
  );
  for (const threadTs of threads) {
    const message = row(
      source
        .query(
          "SELECT id, role, content, user_id, created_at FROM thread_messages WHERE thread_ts = ? ORDER BY id LIMIT 1",
        )
        .get(threadTs),
    );
    if (message.content)
      questions.push({
        source: "thread",
        question: message.content,
        threadTs,
        messageId: message.id,
        role: message.role,
        userId: message.user_id,
        createdAt: message.created_at,
      });
  }
  return { programId, questions };
}

function gitCommit() {
  try {
    return exec.execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (_) {
    return null;
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(options.dbPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`database not found: ${sourcePath}`);
  fs.mkdirSync(options.output, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const bundleDir = path.join(options.output, stamp);
  const dbPath = path.join(options.output, `pixie-archive-${stamp}.db`);
  fs.mkdirSync(bundleDir, { recursive: false });
  const source = new Database(sourcePath, { readonly: true, create: false });
  source.exec("PRAGMA query_only = ON");
  source.exec("BEGIN");
  const scopedTables = purge.discoverProgramScopedTables(source);
  const targets = new Set<string>(purge.targetTables(source));
  const ids = programIds(source, scopedTables);
  const archive = new Database(dbPath, { create: true });
  archive.exec("PRAGMA foreign_keys = OFF");
  const objects = schema(source);
  for (const object of objects.filter((item: Row) => item.type === "table")) archive.exec(String(object.sql));
  const rowCounts: Record<string, number> = {};
  const archivedTables: string[] = [];
  for (const object of objects.filter((item: Row) => item.type === "table")) {
    const name = String(object.name);
    if (!shouldArchiveTable(name, targets)) continue;
    archivedTables.push(name);
    rowCounts[name] = copyRows(source, archive, name, tableRows(source, name, ids, targets));
  }
  const tableDigests = purge.digest(source, ids);
  source.exec("COMMIT");
  for (const object of objects.filter((item: Row) => item.type !== "table")) archive.exec(String(object.sql));
  archive.close();
  source.close();
  copyFiles(bundleDir);
  if (options.questions) {
    const questionSource = new Database(sourcePath, { readonly: true, create: false });
    for (const id of ids) {
      const questionPath = path.join(bundleDir, `questions.${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
      fs.writeFileSync(questionPath, `${JSON.stringify(questionsForProgram(questionSource, id), null, 2)}\n`);
    }
    questionSource.close();
  }
  const hash = crypto.createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex");
  const manifest = {
    version: 2,
    sourceDbPath: sourcePath,
    archiveDbPath: path.resolve(dbPath),
    sha256: hash,
    dbSha256: hash,
    rowCounts,
    tableDigests,
    archivedTables,
    programIds: ids,
    gitCommit: gitCommit(),
    createdAt,
    hostname: os.hostname(),
  };
  fs.writeFileSync(path.join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { dbPath: path.resolve(dbPath), manifestPath: path.join(bundleDir, "manifest.json"), rowCounts, programIds: ids },
      null,
      2,
    ),
  );
}

main();
