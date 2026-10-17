import crypto = require("node:crypto");

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
type TableDigest = { count: number; sha256: string };

const hooks = new Set<PurgeHook>();
const AUDIT_TABLE = "audit_events";
const CHANNEL_STATE_TABLES = [
  "threads",
  "answered_messages",
  "thread_messages",
  "user_messages",
  "muted_threads",
  "thread_takeover",
  "active_guides",
  "answered_threads",
];

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

function parseList(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch (_) {
    return [];
  }
}

function programChannels(db: DatabaseLike, programId: string): string[] {
  const names = new Set(tableNames(db));
  const found = new Set<string>();
  if (names.has("program_channels")) {
    for (const row of db.query("SELECT channel_id FROM program_channels WHERE program_id = ?").all(programId)) {
      const id = objectRow(row).channel_id;
      if (typeof id === "string" && id) found.add(id);
    }
  }
  if (names.has("programs")) {
    const row = objectRow(db.query("SELECT channels, help_channel FROM programs WHERE id = ?").get(programId));
    for (const id of [...parseList(row.channels), row.help_channel]) {
      if (typeof id === "string" && id) found.add(id);
    }
  }
  if (names.has("draft_sandbox_bindings")) {
    for (const row of db.query("SELECT channel_id FROM draft_sandbox_bindings WHERE program_id = ?").all(programId)) {
      const id = objectRow(row).channel_id;
      if (typeof id === "string" && id) found.add(id);
    }
  }
  return [...found].sort();
}

function targetsFor(db: DatabaseLike): Map<string, ScopedTable> {
  const targets = new Map<string, ScopedTable>();
  const names = new Set(tableNames(db));
  for (const table of discoverProgramScopedTables(db)) if (table.name !== AUDIT_TABLE) targets.set(table.name, table);
  if (names.has("programs")) targets.set("programs", { name: "programs", columns: new Set(["id"]) });
  if (names.has("job_leases")) targets.set("job_leases", { name: "job_leases", columns: new Set(["name"]) });
  for (const name of CHANNEL_STATE_TABLES) {
    if (names.has(name)) targets.set(name, { name, columns: columns(db, name) });
  }
  return targets;
}

function selector(db: DatabaseLike, table: ScopedTable, programId: string): { where: string; params: Binding[] } {
  if (table.name === "programs") return { where: "id = ?", params: [programId] };
  if (table.name === "job_leases") {
    return {
      where: "(name = ? OR substr(name, -length(?) - 1) = ':' || ?)",
      params: [programId, programId, programId],
    };
  }
  if (CHANNEL_STATE_TABLES.includes(table.name) && !table.columns.has("program_id")) {
    const channels = programChannels(db, programId);
    if (channels.length === 0) return { where: "1 = 0", params: [] };
    return { where: `channel IN (${channels.map(() => "?").join(",")})`, params: channels };
  }
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

function selectorForIds(db: DatabaseLike, table: ScopedTable, programIds: string[]) {
  const parts = programIds.map((id) => selector(db, table, id)).filter((part) => part.where !== "1 = 0");
  if (parts.length === 0) return { where: "1 = 0", params: [] as Binding[] };
  return { where: parts.map((part) => `(${part.where})`).join(" OR "), params: parts.flatMap((part) => part.params) };
}

function countRows(db: DatabaseLike, table: ScopedTable, programId: string): number {
  const { where, params } = selector(db, table, programId);
  return Number(
    objectRow(db.query(`SELECT COUNT(*) AS count FROM ${quote(table.name)} WHERE ${where}`).get(...params)).count || 0,
  );
}

function digest(db: DatabaseLike, programIds: string[]): Record<string, TableDigest> {
  const out: Record<string, TableDigest> = {};
  for (const [name, table] of [...targetsFor(db)].sort(([a], [b]) => a.localeCompare(b))) {
    const { where, params } = selectorForIds(db, table, programIds);
    let rows: unknown[];
    try {
      rows = db.query(`SELECT * FROM ${quote(name)} WHERE ${where} ORDER BY rowid`).all(...params);
    } catch (_) {
      rows = db.query(`SELECT * FROM ${quote(name)} WHERE ${where} ORDER BY 1`).all(...params);
    }
    const hash = crypto.createHash("sha256");
    for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
    out[name] = { count: rows.length, sha256: hash.digest("hex") };
  }
  return out;
}

function targetTables(db: DatabaseLike): string[] {
  return [...targetsFor(db).keys()].sort();
}

function scopedRows(db: DatabaseLike, name: string, programIds: string[]): unknown[] {
  const table = targetsFor(db).get(name);
  if (!table) return [];
  const { where, params } = selectorForIds(db, table, programIds);
  return db.query(`SELECT * FROM ${quote(name)} WHERE ${where}`).all(...params);
}

function runningInstances(db: DatabaseLike, at = Date.now()): string[] {
  if (!tableNames(db).includes("job_leases")) return [];
  return db
    .query("SELECT name FROM job_leases WHERE expires_at > ? ORDER BY name")
    .all(at)
    .map((row) => String(objectRow(row).name || ""))
    .filter(Boolean);
}

function notify(programId: string) {
  const builtins: PurgeHook[] = [
    () => require("./programs").invalidate(),
    () => require("./knowledge").invalidate(),
    () => require("./draftSandbox").clear(),
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
  const result: PurgeResult = { tables: {} };
  for (const [name, table] of targets) result.tables[name] = countRows(db, table, programId);
  if (dryRun) return result;
  const plans = [...targets].map(([name, table]) => ({ name, ...selector(db, table, programId) }));
  db.transaction(() => {
    for (const { name, where, params } of plans) db.query(`DELETE FROM ${quote(name)} WHERE ${where}`).run(...params);
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
  const ids = programIds(db);
  for (const programId of ids) results[programId] = purgeProgram(db, programId, { dryRun: true });
  if (!dryRun) {
    db.transaction(() => {
      for (const programId of ids) purgeProgram(db, programId, { dryRun: false });
      if (tableNames(db).includes("source_cache")) db.query("DELETE FROM source_cache").run();
    })();
  }
  return results;
}

export = {
  discoverProgramScopedTables,
  programChannels,
  programIds,
  targetTables,
  scopedRows,
  digest,
  runningInstances,
  onProgramPurged,
  purgeProgram,
  purgeAllPrograms,
};
