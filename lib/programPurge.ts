import crypto = require("node:crypto");
import fs = require("node:fs");
import path = require("node:path");

type Binding = string | number | boolean | null | Uint8Array;
interface Statement {
  all(...bindings: Binding[]): unknown[];
  get(...bindings: Binding[]): unknown;
  run(...bindings: Binding[]): { changes: number };
}
interface DatabaseLike {
  query(sql: string): Statement;
  transaction(fn: () => void): () => void;
}
interface ScopedTable {
  name: string;
  columns: Set<string>;
}
interface PurgeResult {
  tables: Record<string, number>;
}
type PurgeHook = (programId: string) => void;

const APP_ROOT = path.join(__dirname, "..");
const hooks = new Set<PurgeHook>();
const AUDIT_TABLE = "audit_events";

function quote(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function objectRow(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function tableNames(db: DatabaseLike): string[] {
  return db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(objectRow(row).name || ""))
    .filter(Boolean);
}

function columns(db: DatabaseLike, table: string): Set<string> {
  return new Set(
    db
      .query(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => String(objectRow(row).name || ""))
      .filter(Boolean),
  );
}

function discoverProgramScopedTables(db: DatabaseLike): ScopedTable[] {
  return tableNames(db)
    .map((name) => ({ name, columns: columns(db, name) }))
    .filter(({ columns: tableColumns }) => tableColumns.has("program_id") || tableColumns.has("draft_program_id"));
}

function sourceObjects(programId: string, db: DatabaseLike): Record<string, unknown>[] {
  const rows: unknown[] = [];
  const stored = db.query("SELECT sources FROM programs WHERE id = ?").get(programId);
  const storedSources = objectRow(stored).sources;
  if (typeof storedSources === "string") {
    try {
      rows.push(JSON.parse(storedSources) as unknown);
    } catch (_) {}
  } else rows.push(storedSources);
  for (const filename of ["programs.json", "sources.json"]) {
    const fullPath = path.join(APP_ROOT, filename);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
      if (filename === "programs.json" && Array.isArray(value)) {
        const program = value.find((item) => objectRow(item).id === programId);
        rows.push(program ? objectRow(program).sources : null);
      } else if (filename === "sources.json" && ["pixl", "ysws-global"].includes(programId)) rows.push(value);
    } catch (_) {}
  }
  const sources: Record<string, unknown>[] = [];
  for (const value of rows) {
    if (!Array.isArray(value)) continue;
    for (const item of value) if (item && typeof item === "object") sources.push(item as Record<string, unknown>);
  }
  return sources;
}

function sourceCacheKeys(db: DatabaseLike, programId: string): string[] {
  const keys = new Set<string>();
  for (const source of sourceObjects(programId, db)) {
    const name = typeof source.name === "string" ? source.name : "";
    if (!name) continue;
    keys.add(name);
    if (typeof source.url === "string" && source.url) keys.add(`${name}::${source.url}`);
    if (!source.url) {
      const inline = JSON.stringify({ type: source.type, content: source.content });
      const digest = crypto.createHash("sha256").update(inline).digest("hex");
      keys.add(`${name}::inline::${digest}`);
    }
  }
  return [...keys];
}

function sqlFor(table: ScopedTable, programId: string): { where: string; params: Binding[] } {
  const clauses: string[] = [];
  const params: Binding[] = [];
  if (table.columns.has("program_id")) {
    clauses.push("program_id = ?");
    params.push(programId);
  }
  if (table.columns.has("draft_program_id")) {
    clauses.push("draft_program_id = ?");
    params.push(programId);
  }
  return { where: clauses.map((clause) => `(${clause})`).join(" OR "), params };
}

function addTarget(targets: Map<string, ScopedTable>, table: ScopedTable) {
  if (table.name !== AUDIT_TABLE) targets.set(table.name, table);
}

function targetsFor(db: DatabaseLike): Map<string, ScopedTable> {
  const targets = new Map<string, ScopedTable>();
  for (const table of discoverProgramScopedTables(db)) addTarget(targets, table);
  const names = new Set(tableNames(db));
  if (names.has("programs")) targets.set("programs", { name: "programs", columns: new Set(["id"]) });
  if (names.has("answer_cache")) targets.set("answer_cache", { name: "answer_cache", columns: new Set() });
  if (names.has("source_cache")) targets.set("source_cache", { name: "source_cache", columns: new Set(["name"]) });
  if (names.has("job_leases")) targets.set("job_leases", { name: "job_leases", columns: new Set(["name"]) });
  return targets;
}

function selector(
  db: DatabaseLike,
  table: ScopedTable,
  programId: string,
  ownedSourceKeys: string[] = sourceCacheKeys(db, programId),
): { where: string; params: Binding[] } {
  if (table.name === "programs") return { where: "id = ?", params: [programId] };
  if (table.name === "answer_cache") return { where: "1 = 1", params: [] };
  if (table.name === "source_cache") {
    return ownedSourceKeys.length
      ? { where: `name IN (${ownedSourceKeys.map(() => "?").join(",")})`, params: ownedSourceKeys }
      : { where: "1 = 0", params: [] };
  }
  if (table.name === "job_leases") return { where: "instr(name, ?) > 0", params: [programId] };
  return sqlFor(table, programId);
}

function countRows(db: DatabaseLike, table: ScopedTable, programId: string, ownedSourceKeys: string[]): number {
  const { where, params } = selector(db, table, programId, ownedSourceKeys);
  const row = objectRow(db.query(`SELECT COUNT(*) AS count FROM ${quote(table.name)} WHERE ${where}`).get(...params));
  return Number(row.count || 0);
}

function notify(programId: string) {
  const builtins: PurgeHook[] = [
    () => require("./programs").invalidate(),
    () => require("./knowledge").invalidate(),
    () => require("./draftSandbox").clear(),
    () => require("./resolutionWatcher").stop(),
    () => require("./ticketBackfill").stop(),
  ];
  for (const hook of [...builtins, ...hooks]) {
    try {
      hook(programId);
    } catch (_) {}
  }
}

function onProgramPurged(hook: PurgeHook): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

function purgeProgram(db: DatabaseLike, programId: string, { dryRun = false }: { dryRun?: boolean } = {}): PurgeResult {
  if (!programId.trim()) throw new Error("programId is required");
  const targets = targetsFor(db);
  const ownedSourceKeys = sourceCacheKeys(db, programId);
  const result: PurgeResult = { tables: {} };
  for (const [name, table] of targets) result.tables[name] = countRows(db, table, programId, ownedSourceKeys);
  if (dryRun) return result;
  db.transaction(() => {
    for (const [name, table] of targets) {
      const { where, params } = selector(db, table, programId, ownedSourceKeys);
      db.query(`DELETE FROM ${quote(name)} WHERE ${where}`).run(...params);
    }
  })();
  notify(programId);
  return result;
}

function programIds(db: DatabaseLike): string[] {
  const ids = new Set<string>();
  for (const table of tableNames(db)) {
    const tableColumns = columns(db, table);
    for (const column of ["program_id", "draft_program_id"]) {
      if (!tableColumns.has(column)) continue;
      for (const row of db.query(`SELECT DISTINCT ${quote(column)} AS id FROM ${quote(table)}`).all()) {
        const id = objectRow(row).id;
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  if (tableNames(db).includes("programs")) {
    for (const row of db.query("SELECT id FROM programs").all()) {
      const id = objectRow(row).id;
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids].sort();
}

function purgeAllPrograms(db: DatabaseLike, { dryRun = false }: { dryRun?: boolean } = {}) {
  const results: Record<string, PurgeResult> = {};
  for (const programId of programIds(db)) results[programId] = purgeProgram(db, programId, { dryRun });
  return results;
}

export = {
  discoverProgramScopedTables,
  sourceCacheKeys,
  onProgramPurged,
  purgeProgram,
  purgeAllPrograms,
};
