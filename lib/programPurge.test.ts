process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_PROGRAMS_JSON = "[]";

const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const { discoverProgramScopedTables, onProgramPurged, purgeProgram } = require("./programPurge");

beforeEach(() => {
  db.close();
  db.open(":memory:");
});

function seed() {
  const h = db.handle();
  const now = Date.now();
  h.query(
    `INSERT INTO programs (id, name, posture, scope, sources, updated_at)
     VALUES (?, ?, 'active', 'program', ?, ?)`,
  ).run("purge-a", "Purge A", JSON.stringify([{ name: "Purge A Docs", url: "https://a.example/docs" }]), now);
  h.query(
    `INSERT INTO programs (id, name, posture, scope, sources, updated_at)
     VALUES (?, ?, 'active', 'program', ?, ?)`,
  ).run("purge-b", "Purge B", JSON.stringify([{ name: "Purge B Docs", url: "https://b.example/docs" }]), now);
  h.query("INSERT INTO source_cache (name, text, fetched_at) VALUES (?, ?, ?)").run(
    "Purge A Docs::https://a.example/docs",
    "a",
    now,
  );
  h.query("INSERT INTO source_cache (name, text, fetched_at) VALUES (?, ?, ?)").run(
    "Purge B Docs::https://b.example/docs",
    "b",
    now,
  );
  h.query("INSERT INTO draft_source_cache (draft_program_id, source_key, text, fetched_at) VALUES (?, ?, ?, ?)").run(
    "purge-a",
    "draft-a",
    "a",
    now,
  );
  h.exec(
    `CREATE TABLE new_program_state (id INTEGER PRIMARY KEY, program_id TEXT NOT NULL, value TEXT NOT NULL);
     INSERT INTO new_program_state (program_id, value) VALUES ('purge-a', 'a'), ('purge-b', 'b');
     CREATE TABLE new_draft_state (id INTEGER PRIMARY KEY, draft_program_id TEXT NOT NULL, value TEXT NOT NULL);
     INSERT INTO new_draft_state (draft_program_id, value) VALUES ('purge-a', 'a'), ('purge-b', 'b');
     CREATE TABLE draft_sandbox_programs (program_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE draft_sandbox_sources (program_id TEXT NOT NULL, source_name TEXT NOT NULL, text TEXT NOT NULL);
     INSERT INTO draft_sandbox_programs VALUES ('purge-a', '{}', 1), ('purge-b', '{}', 1);
     INSERT INTO draft_sandbox_sources VALUES ('purge-a', 'a', 'a'), ('purge-b', 'b', 'b');`,
  );
  h.query("INSERT INTO answer_cache (question_hash, question, source, answer, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "a",
    "a",
    "a",
    "a",
    now,
  );
  h.query("INSERT INTO answer_cache (question_hash, question, source, answer, created_at) VALUES (?, ?, ?, ?, ?)").run(
    "b",
    "b",
    "b",
    "b",
    now,
  );
  h.query("INSERT INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)").run(
    "ticket-history-backfill:purge-a",
    "a",
    now,
  );
  h.query("INSERT INTO job_leases (name, owner, expires_at) VALUES (?, ?, ?)").run(
    "ticket-history-backfill:purge-b",
    "b",
    now,
  );
  h.query(
    `INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, created_at)
     VALUES ('purge-a', 'C-A', 'T-A', 'U-A', 'question a', ?), ('purge-b', 'C-B', 'T-B', 'U-B', 'question b', ?)`,
  ).run(now, now);
  h.query(
    "INSERT INTO audit_events (program_id, action, created_at) VALUES (?, 'program.created', ?), (?, 'program.created', ?)",
  ).run("purge-a", now, "purge-b", now);
}

test("discovery includes every scoped table, including tables added after the implementation", () => {
  seed();
  const names = new Set(discoverProgramScopedTables(db.handle()).map((table: { name: string }) => table.name));
  assert.ok(names.has("new_program_state"));
  assert.ok(names.has("new_draft_state"));
  assert.ok(names.has("draft_source_cache"));
  assert.ok(names.has("ticket_events"));
  assert.ok(names.has("audit_events"));
});

test("dry-run counts state without changing either program", () => {
  seed();
  const result = purgeProgram(db.handle(), "purge-a", { dryRun: true });
  assert.equal(result.tables.new_program_state, 1);
  assert.equal(result.tables.new_draft_state, 1);
  assert.equal(result.tables.answer_cache, 2);
  assert.equal(result.tables.source_cache, 1);
  assert.equal(result.tables.tickets, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM programs").get().n, 2);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM new_program_state").get().n, 2);
});

test("purge deletes all owned state transactionally, keeps audit events, and leaves other programs intact", () => {
  seed();
  let hookId = "";
  const removeHook = onProgramPurged((programId: string) => {
    hookId = programId;
  });
  const result = purgeProgram(db.handle(), "purge-a", { dryRun: false });
  removeHook();
  assert.equal(hookId, "purge-a");
  assert.equal(result.tables.new_program_state, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM programs WHERE id = 'purge-a'").get().n, 0);
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS n FROM new_program_state WHERE program_id = 'purge-a'").get().n,
    0,
  );
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS n FROM new_program_state WHERE program_id = 'purge-b'").get().n,
    1,
  );
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS n FROM new_draft_state WHERE draft_program_id = 'purge-a'").get().n,
    0,
  );
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM source_cache WHERE name LIKE 'Purge A Docs%'").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM source_cache WHERE name LIKE 'Purge B Docs%'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = 'purge-a'").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = 'purge-b'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM audit_events WHERE program_id = 'purge-a'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM job_leases WHERE name LIKE '%purge-a%'").get().n, 0);
});
