import sqlite = require("bun:sqlite");
import fs = require("node:fs");
import db = require("./db");
import programs = require("./programs");

const { Database } = sqlite;
type ArchiveDb = InstanceType<typeof Database>;

interface HelperRow {
  program_id: string;
  user_id: string;
  helper_source: string | null;
  role: string | null;
  ping_eligible?: number | null;
}
interface ExpertiseRow {
  program_id: string;
  user_id: string;
  tag: string;
  solved_count: number;
}
interface RestorePlan {
  programId: string;
  helpers: number;
  expertise: number;
  skipped: string | null;
}

function hasColumn(archive: ArchiveDb, table: string, column: string) {
  return archive
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((entry) => entry.name === column);
}

function plan(archivePath: string, onlyProgram: string | null = null) {
  if (!fs.existsSync(archivePath)) throw new Error(`archive not found: ${archivePath}`);
  const archive = new Database(archivePath, { readonly: true, create: false });
  try {
    const pingColumn = hasColumn(archive, "program_helpers", "ping_eligible");
    const helpers = archive
      .query<HelperRow, []>(
        `SELECT program_id, user_id, helper_source, role${pingColumn ? ", ping_eligible" : ""} FROM program_helpers WHERE active = 1 ORDER BY program_id, added_at`,
      )
      .all()
      .filter((row) => !onlyProgram || row.program_id === onlyProgram);
    const expertise = archive
      .query<ExpertiseRow, []>("SELECT program_id, user_id, tag, solved_count FROM helper_expertise")
      .all()
      .filter((row) => !onlyProgram || row.program_id === onlyProgram);
    return { helpers, expertise };
  } finally {
    archive.close();
  }
}

function restore(archivePath: string, options: { program?: string | null; execute?: boolean } = {}): RestorePlan[] {
  const { helpers, expertise } = plan(archivePath, options.program || null);
  const ids = [...new Set([...helpers.map((row) => row.program_id), ...expertise.map((row) => row.program_id)])].sort();
  const results: RestorePlan[] = [];
  for (const programId of ids) {
    const rows = helpers.filter((row) => row.program_id === programId);
    const tags = expertise.filter((row) => row.program_id === programId);
    if (!programs.get(programId)) {
      results.push({
        programId,
        helpers: rows.length,
        expertise: tags.length,
        skipped: "program is not in the live database",
      });
      continue;
    }
    if (options.execute) {
      db.handle().transaction(() => {
        for (const row of rows) {
          db.syncHelper({
            programId,
            userId: row.user_id,
            source: row.helper_source || "manual",
            role: row.role || "helper",
          });
          if (row.ping_eligible === 0) db.setHelperPingEligible({ programId, userId: row.user_id, eligible: false });
        }
        for (const tag of tags) {
          db.handle()
            .query(
              `INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(program_id, user_id, tag) DO UPDATE SET solved_count = excluded.solved_count, updated_at = excluded.updated_at`,
            )
            .run(programId, tag.user_id, tag.tag, tag.solved_count, Date.now());
        }
      })();
    }
    results.push({ programId, helpers: rows.length, expertise: tags.length, skipped: null });
  }
  return results;
}

export = { restore, plan };
