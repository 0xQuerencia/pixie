process.env.PIXIE_DB_PATH = ":memory:";

const { beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const {
  discoverProgramScopedTables,
  onProgramPurged,
  purgeProgram,
  purgeAllPrograms,
  digest,
  runningInstances,
} = require("./programPurge");

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
  h.query(
    "INSERT INTO answer_cache (question_hash, program_id, question, source, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("a", "purge-a", "a", "a", "a", now);
  h.query(
    "INSERT INTO answer_cache (question_hash, program_id, question, source, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("b", "purge-b", "b", "b", "b", now);
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
  assert.equal(result.tables.answer_cache, 1);
  assert.equal(result.tables.source_cache, undefined);
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
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM source_cache WHERE name LIKE 'Purge B Docs%'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_cache WHERE program_id = 'purge-a'").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_cache WHERE program_id = 'purge-b'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = 'purge-a'").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = 'purge-b'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM audit_events WHERE program_id = 'purge-a'").get().n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM job_leases WHERE name LIKE '%purge-a%'").get().n, 0);
});

function threadState(channel: string, thread: string) {
  const h = db.handle();
  h.query("INSERT INTO threads (workspace_id, channel, thread_ts, updated_at) VALUES ('T1', ?, ?, 1)").run(
    channel,
    thread,
  );
  h.query("INSERT INTO muted_threads (workspace_id, channel, thread_ts, muted_at) VALUES ('T1', ?, ?, 1)").run(
    channel,
    thread,
  );
  h.query("INSERT INTO thread_takeover (workspace_id, channel, thread_ts, created_at) VALUES ('T1', ?, ?, 1)").run(
    channel,
    thread,
  );
  h.query("INSERT INTO answered_messages (workspace_id, channel, ts, answered_at) VALUES ('T1', ?, ?, 1)").run(
    channel,
    thread,
  );
}

test("purge removes thread state of the program's channels and nothing else", () => {
  seed();
  const h = db.handle();
  h.query(
    "INSERT INTO program_channels (workspace_id, channel_id, program_id, kind, created_at) VALUES ('T1', 'C-A', 'purge-a', 'help', 1)",
  ).run();
  h.query(
    "INSERT INTO program_channels (workspace_id, channel_id, program_id, kind, created_at) VALUES ('T1', 'C-B', 'purge-b', 'help', 1)",
  ).run();
  threadState("C-A", "100.1");
  threadState("C-B", "200.1");
  purgeProgram(h, "purge-a");
  for (const table of ["threads", "muted_threads", "thread_takeover", "answered_messages"]) {
    assert.equal(h.query(`SELECT COUNT(*) AS n FROM ${table} WHERE channel = 'C-A'`).get().n, 0, table);
    assert.equal(h.query(`SELECT COUNT(*) AS n FROM ${table} WHERE channel = 'C-B'`).get().n, 1, table);
  }
});

test("job leases match the program id exactly, not as a substring", () => {
  seed();
  const h = db.handle();
  h.query(
    "INSERT INTO programs (id, name, posture, scope, updated_at) VALUES ('app', 'App', 'active', 'program', 1)",
  ).run();
  h.query(
    "INSERT INTO job_leases (name, owner, expires_at) VALUES ('appraisal-recompute', 'x', 1), ('ticket-history-backfill:app', 'x', 1)",
  ).run();
  purgeProgram(h, "app");
  const names = h
    .query("SELECT name FROM job_leases ORDER BY name")
    .all()
    .map((row: { name: string }) => row.name);
  assert.ok(names.includes("appraisal-recompute"));
  assert.ok(!names.includes("ticket-history-backfill:app"));
});

test("digests identify the exact rows a reset would delete", () => {
  seed();
  const h = db.handle();
  const before = digest(h, ["purge-a"]);
  assert.deepEqual(digest(h, ["purge-a"]), before);
  h.query("UPDATE tickets SET question = 'changed' WHERE program_id = 'purge-a'").run();
  assert.notDeepEqual(digest(h, ["purge-a"]), before);
  assert.deepEqual(digest(h, ["purge-b"]).tickets, digest(h, ["purge-b"]).tickets);
});

test("purging every program also clears the legacy source cache", () => {
  seed();
  purgeAllPrograms(db.handle());
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM source_cache").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM programs").get().n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM audit_events").get().n, 2);
});

test("a live instance is detected from unexpired job leases", () => {
  seed();
  const h = db.handle();
  h.query("DELETE FROM job_leases").run();
  assert.deepEqual(runningInstances(h), []);
  h.query("INSERT INTO job_leases (name, owner, expires_at) VALUES ('sla-check', 'pod', ?)").run(Date.now() + 60000);
  assert.deepEqual(runningInstances(h), ["sla-check"]);
});

export {};
