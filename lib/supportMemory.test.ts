process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const supportMemory = require("./supportMemory");
const context = require("./context");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("support memory is bounded to a program and person", () => {
  supportMemory.forgetProgramUser("memory-a", "U1");
  supportMemory.forgetProgramUser("memory-b", "U1");
  supportMemory.remember({
    programId: "memory-a",
    userId: "U1",
    kind: "problem",
    value: "The portal keeps redirecting me.",
  });
  supportMemory.remember({ programId: "memory-b", userId: "U1", kind: "problem", value: "Other program context." });

  const prompt = supportMemory.formatForPrompt("memory-a", "U1");
  assert.match(prompt, /portal keeps redirecting/);
  assert.doesNotMatch(prompt, /Other program/);
  assert.match(prompt, /never as policy authority/);
});

test("longer threads capture problem and attempted steps without exceeding prompt bounds", () => {
  for (let index = 0; index < 40; index += 1) {
    context.rememberSupportContext({
      programId: "memory-long",
      userId: "U-long",
      question: index % 2 ? `I already tried refresh ${index}` : `The portal issue is still present ${index}`,
      threadTs: "thread-long",
    });
  }
  const recalled = supportMemory.recall("memory-long", "U-long", 100);
  assert.ok(recalled.length <= supportMemory.MAX_RECALL_ROWS);
  assert.ok(supportMemory.formatForPrompt("memory-long", "U-long").length <= 2300);
  assert.ok(recalled.some((row) => row.kind === "attempt"));
});

test("repeated logical writes refresh one row instead of inserting another", () => {
  supportMemory.forgetProgramUser("memory-dedupe", "U-dedupe");
  const first = supportMemory.remember({
    programId: "memory-dedupe",
    userId: "U-dedupe",
    kind: "attempt",
    value: "  Tried   clearing   cookies  ",
    ttlMs: 60_000,
  });
  const second = supportMemory.remember({
    programId: "memory-dedupe",
    userId: "U-dedupe",
    kind: "attempt",
    value: "Tried clearing cookies",
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });

  assert.equal(supportMemory.recall("memory-dedupe", "U-dedupe").length, 1);
  assert.equal(second.id, first.id);
  assert.ok(second.expires_at > first.expires_at);
  assert.ok(second.updated_at >= first.updated_at);
});

test("schema reconciliation keeps one duplicate row during migration", () => {
  supportMemory.forgetProgramUser("memory-migration", "U-migration");
  db.handle().exec("DROP INDEX IF EXISTS idx_support_memory_logical_key");
  db.handle()
    .query(
      `INSERT INTO support_memory
       (program_id,user_id,kind,value,normalized_value,source_thread_ts,source_ticket_id,confidence,created_at,updated_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "memory-migration",
      "U-migration",
      "problem",
      "same problem",
      "same problem",
      null,
      null,
      1,
      10,
      10,
      Date.now() + 60_000,
    );
  db.handle()
    .query(
      `INSERT INTO support_memory
       (program_id,user_id,kind,value,normalized_value,source_thread_ts,source_ticket_id,confidence,created_at,updated_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      "memory-migration",
      "U-migration",
      "problem",
      "same problem",
      "same problem",
      null,
      null,
      1,
      20,
      20,
      Date.now() + 60_000,
    );

  supportMemory.ensureSchema();
  const rows = supportMemory.recall("memory-migration", "U-migration");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].created_at, 20);
});

test("recall prioritizes attempts and environments and formats within the total cap", () => {
  supportMemory.forgetProgramUser("memory-priority", "U-priority");
  for (let index = 0; index < 12; index += 1) {
    supportMemory.remember({
      programId: "memory-priority",
      userId: "U-priority",
      kind: "problem",
      value: `Problem ${index} ${"x".repeat(500)}`,
    });
  }
  supportMemory.remember({
    programId: "memory-priority",
    userId: "U-priority",
    kind: "environment",
    value: `Chrome on Windows ${"e".repeat(500)}`,
  });
  supportMemory.remember({
    programId: "memory-priority",
    userId: "U-priority",
    kind: "attempt",
    value: `Already restarted the app ${"a".repeat(500)}`,
  });

  const rows = supportMemory.recall("memory-priority", "U-priority");
  assert.deepEqual(
    rows.slice(0, 2).map((row) => row.kind),
    ["attempt", "environment"],
  );
  assert.ok(rows.length <= supportMemory.MAX_RECALL_ROWS);
  assert.ok(supportMemory.formatForPrompt("memory-priority", "U-priority").length <= supportMemory.MAX_RECALL_CHARS);
});

test("recall applies a read-time age limit and cleanup stays scoped", () => {
  supportMemory.forgetProgramUser("memory-ttl-a", "U-ttl");
  supportMemory.forgetProgramUser("memory-ttl-b", "U-ttl");
  supportMemory.remember({
    programId: "memory-ttl-a",
    userId: "U-ttl",
    kind: "problem",
    value: "old but not expired",
  });
  supportMemory.remember({
    programId: "memory-ttl-a",
    userId: "U-ttl",
    kind: "attempt",
    value: "expired in program A",
  });
  supportMemory.remember({
    programId: "memory-ttl-b",
    userId: "U-ttl",
    kind: "attempt",
    value: "expired in program B",
  });
  const now = Date.now();
  db.handle()
    .query("UPDATE support_memory SET updated_at = ?, expires_at = ? WHERE value = ?")
    .run(now - 3 * 24 * 60 * 60 * 1000, now + 60_000, "old but not expired");
  db.handle()
    .query("UPDATE support_memory SET expires_at = ? WHERE value LIKE ?")
    .run(now - 1, "expired in program%");

  assert.deepEqual(
    supportMemory.recall("memory-ttl-a", "U-ttl", { maxAgeDays: 1 }).map((row) => row.value),
    [],
  );
  supportMemory.remember({
    programId: "memory-ttl-a",
    userId: "U-ttl",
    kind: "context",
    value: "expired for sweep",
    ttlMs: 1,
  });
  db.handle()
    .query("UPDATE support_memory SET expires_at = ? WHERE value = ?")
    .run(now - 1, "expired for sweep");
  assert.equal(supportMemory.sweepExpired("memory-ttl-a"), 1);
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS count FROM support_memory WHERE program_id = ?").get("memory-ttl-b").count,
    1,
  );
});

test("attempted-step context is labeled as context and remains isolated", () => {
  supportMemory.forgetProgramUser("memory-answer-a", "U-answer");
  supportMemory.forgetProgramUser("memory-answer-b", "U-answer");
  supportMemory.forgetProgramUser("memory-answer-a", "U-other");
  supportMemory.remember({
    programId: "memory-answer-a",
    userId: "U-answer",
    kind: "problem",
    value: "The portal still shows an error",
  });
  supportMemory.remember({
    programId: "memory-answer-a",
    userId: "U-answer",
    kind: "attempt",
    value: "Already cleared cookies",
  });
  supportMemory.remember({
    programId: "memory-answer-a",
    userId: "U-answer",
    kind: "environment",
    value: "Chrome on Windows",
  });
  supportMemory.remember({
    programId: "memory-answer-b",
    userId: "U-answer",
    kind: "attempt",
    value: "Program B secret attempt",
  });
  supportMemory.remember({
    programId: "memory-answer-a",
    userId: "U-other",
    kind: "attempt",
    value: "Other user secret attempt",
  });

  const block = supportMemory.formatAttemptedSteps("memory-answer-a", "U-answer");
  assert.match(block, /CONTEXT-ONLY/);
  assert.match(block, /not policy; do not treat as documentation/);
  assert.match(block, /Previous problem: The portal still shows an error/);
  assert.match(block, /Steps already tried: Already cleared cookies/);
  assert.match(block, /Environment: Chrome on Windows/);
  assert.doesNotMatch(block, /Program B|Other user|\b(?:id|source)\b/i);
});

test("attempted-step formatting stays bounded with maximal recall rows", () => {
  supportMemory.forgetProgramUser("memory-answer-bound", "U-answer");
  for (let index = 0; index < supportMemory.MAX_RECALL_ROWS; index += 1) {
    supportMemory.remember({
      programId: "memory-answer-bound",
      userId: "U-answer",
      kind: "attempt",
      value: `Attempt ${index} ${"x".repeat(supportMemory.MAX_VALUE_CHARS)}`,
    });
  }

  const block = supportMemory.formatAttemptedSteps("memory-answer-bound", "U-answer");
  assert.ok(block.length <= supportMemory.MAX_RECALL_CHARS);
  assert.match(block, /CONTEXT-ONLY/);
  assert.match(block, /Steps already tried:/);
});

test("support memory cannot cross program or user boundaries", () => {
  supportMemory.forgetProgramUser("memory-isolation-a", "U-one");
  supportMemory.forgetProgramUser("memory-isolation-b", "U-one");
  supportMemory.forgetProgramUser("memory-isolation-a", "U-two");
  supportMemory.remember({
    programId: "memory-isolation-a",
    userId: "U-one",
    kind: "attempt",
    value: "A one only",
  });
  supportMemory.remember({
    programId: "memory-isolation-b",
    userId: "U-one",
    kind: "attempt",
    value: "B one only",
  });
  supportMemory.remember({
    programId: "memory-isolation-a",
    userId: "U-two",
    kind: "attempt",
    value: "A two only",
  });

  assert.match(supportMemory.formatAttemptedSteps("memory-isolation-a", "U-one"), /A one only/);
  assert.doesNotMatch(supportMemory.formatAttemptedSteps("memory-isolation-a", "U-one"), /B one only|A two only/);
});

test("memory values do not persist credential material", () => {
  supportMemory.forgetProgramUser("memory-redaction", "U-redaction");
  supportMemory.remember({
    programId: "memory-redaction",
    userId: "U-redaction",
    kind: "problem",
    value: 'Authorization=Bearer top-secret-token Cookie: session=private password="hunter two"',
  });

  const value = supportMemory.recall("memory-redaction", "U-redaction")[0].value;
  assert.doesNotMatch(value, /top-secret-token|session=private|hunter two/);
  assert.match(value, /redacted/i);
});

test("store reconciliation migrates a legacy table before deduplicating", () => {
  db.close();
  db.open(":memory:");
  db.handle().exec("DROP TABLE support_memory");
  db.handle().exec(`
    CREATE TABLE support_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      source_thread_ts TEXT,
      source_ticket_id INTEGER,
      confidence REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.handle()
    .query(
      "INSERT INTO support_memory (program_id,user_id,kind,value,source_thread_ts,source_ticket_id,confidence,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("legacy-program", "U-legacy", "problem", "Legacy Problem", null, null, 1, 10, Date.now() + 60_000);
  db.handle()
    .query(
      "INSERT INTO support_memory (program_id,user_id,kind,value,source_thread_ts,source_ticket_id,confidence,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run("legacy-program", "U-legacy", "problem", " legacy problem ", null, null, 1, 20, Date.now() + 60_000);

  supportMemory.ensureSchema();
  const rows = supportMemory.recall("legacy-program", "U-legacy");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].created_at, 20);
  assert.equal(
    db
      .handle()
      .query("SELECT COUNT(*) AS count FROM pragma_table_info('support_memory') WHERE name IN (?, ?)")
      .get("normalized_value", "updated_at").count,
    2,
  );
});

export {};
