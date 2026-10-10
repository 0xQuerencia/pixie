type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");

db.open(":memory:");

test("claimMessage is atomic — only the first caller wins", () => {
  assert.equal(db.claimMessage("111.1", "C1"), true);
  assert.equal(db.claimMessage("111.1", "C1"), false);
  assert.equal(db.wasAnswered("111.1"), true);
  assert.equal(db.wasAnswered("999.9"), false);
});

test("thread messages come back in order and are capped", () => {
  for (let i = 0; i < db.MAX_THREAD_MESSAGES + 5; i++) {
    db.addThreadMessage("t1", "user", `msg ${i}`, "U1");
  }
  const messages = db.getThreadMessages("t1");
  assert.equal(messages.length, db.MAX_THREAD_MESSAGES);
  assert.equal(messages.at(-1).content, `msg ${db.MAX_THREAD_MESSAGES + 4}`);
});

test("touchThread records that pixie spoke without clobbering on later writes", () => {
  db.touchThread("t2", "C1", { pixieSpoke: true });
  db.touchThread("t2", "C1", {});
  assert.equal(db.getThread("t2").pixie_spoke, 1);
});

test("user topics are capped at the most recent N", () => {
  for (let i = 0; i < db.MAX_USER_TOPICS + 4; i++) {
    db.recordTopic("U2", `topic-${i}`, true);
  }
  assert.equal(db.getTopics("U2").length, db.MAX_USER_TOPICS);
});

test("user topics keep old rows readable and scope new rows by program", () => {
  db.handle().query("DELETE FROM user_topics").run();
  db.recordUserTopic("U-topic-scope", "legacy topic", true);
  db.recordUserTopic("U-topic-scope", "same topic", true, "program-a");
  db.recordUserTopic("U-topic-scope", "same topic", false, "program-b");

  assert.deepEqual(
    db.userTopics("U-topic-scope", "program-a").map((row: TestAny) => [row.topic, row.program_id]),
    [["same topic", "program-a"]],
  );
  assert.deepEqual(
    db.userTopics("U-topic-scope", "program-b").map((row: TestAny) => [row.topic, row.program_id]),
    [["same topic", "program-b"]],
  );
  assert.equal(
    db.userTopics("U-topic-scope").some((row: TestAny) => row.topic === "legacy topic" && row.program_id === null),
    true,
  );
});

test("legacy user topic tables gain program scope without losing old rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-db-topics-"));
  const filename = path.join(directory, "test.db");
  const { Database } = require("bun:sqlite");

  try {
    db.close();
    db.ensureSchema(filename);
    const legacy = new Database(filename);
    legacy.exec("DROP TABLE user_topics");
    legacy.exec(`
      CREATE TABLE user_topics (
        user_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        was_helpful INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, topic)
      )
    `);
    legacy
      .query("INSERT INTO user_topics (user_id, topic, was_helpful, created_at) VALUES (?, ?, ?, ?)")
      .run("U-old-topic", "old topic", 1, Date.now());
    legacy.query("DELETE FROM schema_data_migrations WHERE version = ?").run("user_topics_scope_v1");
    legacy.close();

    db.open(filename);
    const columns = db.handle().query("PRAGMA table_info(user_topics)").all();
    assert.ok(columns.some((column: TestAny) => column.name === "program_id"));
    assert.deepEqual(
      db.userTopics("U-old-topic").map((row: TestAny) => [row.topic, row.program_id]),
      [["old topic", null]],
    );
    db.recordUserTopic("U-old-topic", "old topic", true, "new-program");
    assert.deepEqual(
      db.userTopics("U-old-topic", "new-program").map((row: TestAny) => [row.topic, row.program_id]),
      [["old topic", "new-program"]],
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    db.open(":memory:");
  }
});

test("answer cache round-trips and misses on an unknown key", () => {
  cache.putCachedAnswer("hash-a", "how do i join", { source: "Acme FAQ", answer: "just sign up" });

  const hit = cache.getCachedAnswer("hash-a");
  assert.equal(hit.source, "Acme FAQ");
  assert.equal(hit.answer, "just sign up");
  assert.ok(hit.ageMs >= 0);
  assert.equal(cache.getCachedAnswer("hash-missing"), null);
});

test("every hit bumps the ask count", () => {
  cache.putCachedAnswer("hash-count", "whats the deadline", { source: "Acme FAQ", answer: "august 18" });
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 1);
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 2);
  assert.equal(cache.getCachedAnswer("hash-count").askCount, 3);
});

test("a refresh updates the answer without counting as an ask", () => {
  const countOf = (question: TestAny) => cache.topCached(50).find((r: TestAny) => r.question === question)?.ask_count;

  cache.putCachedAnswer("hash-refresh", "how do i submit", { source: "Acme Docs", answer: "old answer" });
  cache.getCachedAnswer("hash-refresh");
  cache.getCachedAnswer("hash-refresh");
  const before = countOf("how do i submit");

  cache.putCachedAnswer(
    "hash-refresh",
    "how do i submit",
    { source: "Acme Docs", answer: "new answer" },
    { refreshed: true },
  );

  assert.equal(countOf("how do i submit"), before, "a refresh is pixie updating itself, not somebody asking");
  assert.equal(cache.getCachedAnswer("hash-refresh").answer, "new answer");
});

test("sweep keeps a question people still ask and drops one nobody does", () => {
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000;

  cache.putCachedAnswer("hash-popular", "how do i join", { source: "Acme FAQ", answer: "sign up" });
  cache.putCachedAnswer("hash-forgotten", "some one-off thing", { source: "Acme Docs", answer: "whatever" });

  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, last_asked_at = ? WHERE question_hash = ?")
    .run(old, old, "hash-forgotten");
  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, last_asked_at = ? WHERE question_hash = ?")
    .run(old, Date.now(), "hash-popular");

  db.sweep();

  assert.notEqual(cache.getCachedAnswer("hash-popular"), null, "a question still being asked must survive");
  assert.equal(cache.getCachedAnswer("hash-forgotten"), null, "a phrasing nobody has asked in a week goes");
});

test("staleCacheEntries returns the stalest most-asked first", () => {
  cache.clearCache();
  const old = Date.now() - 60 * 60 * 1000;

  cache.putCachedAnswer("s-rare", "rare question", { source: "Acme Docs", answer: "a" });
  cache.putCachedAnswer("s-common", "common question", { source: "Acme Docs", answer: "b" });
  cache.putCachedAnswer("s-fresh", "fresh question", { source: "Acme Docs", answer: "c" });

  db.handle().query("UPDATE answer_cache SET refreshed_at = ? WHERE question_hash IN ('s-rare','s-common')").run(old);
  db.handle().query("UPDATE answer_cache SET ask_count = 30 WHERE question_hash = 's-common'").run();

  const stale = cache.staleCacheEntries(30 * 60 * 1000, 10);
  assert.deepEqual(
    stale.map((r: TestAny) => r.question),
    ["common question", "rare question"],
    "fresh entries are left alone, and the most-asked stale one comes first",
  );
});

test("topGaps groups identical questions and counts them", () => {
  db.recordGap("Whats the deadline", "U1", "C1");
  db.recordGap("whats the deadline  ", "U2", "C1");
  db.recordGap("U2 again, separately", "U2", "C1");
  db.recordGap("something else entirely", "U3", "C1");
  db.recordGap("and another different one", "U3", "C1");

  const gaps = db.topGaps(10);

  const deadline = gaps.find((g: TestAny) => g.question === "whats the deadline");
  assert.ok(deadline);
  assert.equal(deadline.ask_count, 2);
  assert.equal(deadline.askers, 2);

  assert.ok(!gaps.some((g: TestAny) => g.question === "something else entirely"));
  assert.ok(!gaps.some((g: TestAny) => g.question === "and another different one"));
});

test("feedback is one vote per user and can be changed or removed", () => {
  db.recordFeedback("m1", "U1", 1);
  db.recordFeedback("m1", "U1", -1);
  db.recordFeedback("m1", "U2", 1);

  let totals = db.feedbackTotals();
  assert.equal(totals.up, 1);
  assert.equal(totals.down, 1);

  db.removeFeedback("m1", "U1");
  totals = db.feedbackTotals();
  assert.equal(totals.down, 0);
});

test("medianLatency returns null with no data and a value once recorded", () => {
  assert.equal(db.medianLatency("nothing_recorded"), null);
  db.recordMetric("median_fixture", 100);
  db.recordMetric("median_fixture", 200);
  db.recordMetric("median_fixture", 300);
  assert.equal(db.medianLatency("median_fixture"), 200);
});

test("rate limit counts only requests inside the window", () => {
  db.recordRequest("U9");
  db.recordRequest("U9");
  assert.equal(db.countRecentRequests("U9", 60000), 2);
  assert.equal(db.countRecentRequests("U9", -1), 0);
});

test("recentUserMessages returns the newest N, oldest first", () => {
  for (const t of ["one", "two", "three", "four"]) {
    db.recordUserMessage({ userId: "U-recent", channel: "C-recent", text: t });
  }
  const rows = db.recentUserMessages("U-recent", { channel: "C-recent", limit: 3 });
  assert.deepEqual(
    rows.map((r: TestAny) => r.text),
    ["two", "three", "four"],
  );
});

test("recentUserMessages scopes to a channel when given one", () => {
  db.recordUserMessage({ userId: "U-scope", channel: "C-a", text: "in channel a" });
  db.recordUserMessage({ userId: "U-scope", channel: "C-b", text: "in channel b" });

  assert.deepEqual(
    db.recentUserMessages("U-scope", { channel: "C-a" }).map((r: TestAny) => r.text),
    ["in channel a"],
  );
  assert.equal(db.recentUserMessages("U-scope", {}).length, 2);
});

test("recentUserMessages keeps only the newest MAX_USER_MESSAGES per person", () => {
  for (let i = 0; i < db.MAX_USER_MESSAGES + 5; i++) {
    db.recordUserMessage({ userId: "U-cap", channel: "C-cap", text: `msg ${i}` });
  }
  const all = db.recentUserMessages("U-cap", { channel: "C-cap", limit: 100 });
  assert.equal(all.length, db.MAX_USER_MESSAGES);
  assert.equal(all[all.length - 1].text, `msg ${db.MAX_USER_MESSAGES + 4}`);
});

test("recentUserMessages ignores empty text and unknown users", () => {
  db.recordUserMessage({ userId: "U-empty", channel: "C-e", text: "   " });
  assert.deepEqual(db.recentUserMessages("U-empty", { channel: "C-e" }), []);
  assert.deepEqual(db.recentUserMessages(null), []);
});

test("sweep runs without error", () => {
  assert.doesNotThrow(() => db.sweep());
});

test("answer cache survives a normal reopen and clearCache remains explicit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-db-"));
  const filename = path.join(directory, "test.db");

  try {
    db.close();
    db.open(filename);
    cache.putCachedAnswer("reopen-hash", "a persistent question", {
      source: "Acme FAQ",
      answer: "a persistent answer",
    });

    db.close();
    db.open(filename);
    assert.equal(cache.getCachedAnswer("reopen-hash").answer, "a persistent answer");

    cache.clearCache();
    assert.equal(cache.getCachedAnswer("reopen-hash"), null);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    db.open(":memory:");
  }
});

test("legacy auto-approved facts are quarantined once and clear the answer cache", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-db-quarantine-"));
  const filename = path.join(directory, "test.db");
  const { Database } = require("bun:sqlite");
  const legacyId = 9001;

  try {
    db.close();
    db.ensureSchema(filename);
    const legacy = new Database(filename);
    legacy
      .query(
        `INSERT INTO learned_facts
          (id, question, answer, author_id, status, source_ts, channel, program_id, category, ticket_id, resolver_id, verified_at, support_count, last_supported_at, auto_learned, created_at)
         VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        legacyId,
        "legacy auto question",
        "legacy auto answer",
        "U-legacy",
        "legacy-source",
        "C-legacy",
        "legacy-program",
        "legacy-category",
        77,
        "U-resolver",
        123,
        4,
        456,
        Date.now(),
      );
    legacy
      .query(
        `INSERT INTO answer_cache (question_hash, question, source, answer, created_at, ask_count, last_asked_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run("legacy-cache", "legacy cached question", "Legacy", "stale answer", Date.now(), Date.now(), Date.now());
    legacy.query("DELETE FROM schema_data_migrations WHERE version = ?").run("legacy_auto_learned_v1");
    legacy.close();

    db.open(filename);
    const row = db.getLearnedFactById(legacyId);
    assert.equal(row.status, "candidate");
    assert.equal(row.verified_at, null);
    assert.equal(row.auto_learned, 1);
    assert.deepEqual(
      [row.id, row.program_id, row.ticket_id, row.resolver_id, row.question, row.answer],
      [legacyId, "legacy-program", 77, "U-resolver", "legacy auto question", "legacy auto answer"],
    );
    assert.equal(
      db.approvedFacts(50, "legacy-program").some((fact: TestAny) => fact.question === "legacy auto question"),
      false,
    );
    assert.equal(
      db.listReviewableLearnedFacts("legacy-program").some((fact: TestAny) => fact.id === legacyId),
      true,
    );
    assert.equal(db.handle().query("SELECT 1 FROM answer_cache WHERE question_hash = ?").get("legacy-cache"), null);

    db.close();
    db.open(filename);
    assert.equal(db.getLearnedFactById(legacyId).status, "candidate");
    assert.equal(
      db
        .handle()
        .query("SELECT COUNT(*) AS n FROM schema_data_migrations WHERE version = ?")
        .get("legacy_auto_learned_v1").n,
      1,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    db.open(":memory:");
  }
});

test("trusted learned reads exclude auto-learned rows and superseded review rows", () => {
  db.handle().query("DELETE FROM learned_facts").run();
  const auto = db.addLearnedFact({
    question: "legacy trusted read question",
    answer: "must wait",
    status: "approved",
    programId: "trusted-read-program",
    autoLearned: true,
    sourceTs: "trusted-read-auto",
  });
  const human = db.addLearnedFact({
    question: "human trusted read question",
    answer: "safe answer",
    status: "approved",
    programId: "trusted-read-program",
    sourceTs: "trusted-read-human",
  });
  const superseded = db.addLearnedFact({
    question: "superseded review question",
    answer: "old answer",
    status: "candidate",
    programId: "trusted-read-program",
    sourceTs: "trusted-read-superseded",
  });
  db.handle().query("UPDATE learned_facts SET superseded_by = ? WHERE id = ?").run(human, superseded);

  assert.deepEqual(
    db.approvedFacts(50, "trusted-read-program").map((fact: TestAny) => fact.question),
    ["human trusted read question"],
  );
  assert.equal(
    db.listReviewableLearnedFacts("trusted-read-program").some((fact: TestAny) => fact.id === auto),
    true,
  );
  assert.equal(
    db.listReviewableLearnedFacts("trusted-read-program").some((fact: TestAny) => fact.id === superseded),
    false,
  );
});

test("source text survives a restart", () => {
  db.saveSourceText("Acme Docs", "## Get\n\n50 px an hour rising to 86 px an hour");

  const stored = db.loadSourceText("Acme Docs");
  assert.match(stored.text, /86 px an hour/);
  assert.ok(stored.fetchedAt > 0);
});

test("re-fetching a source replaces the stored copy rather than piling up", () => {
  db.saveSourceText("Rewritten", "first");
  db.saveSourceText("Rewritten", "second");

  assert.equal(db.loadSourceText("Rewritten").text, "second");
});

test("loadSourceText returns null for a source that has never been fetched", () => {
  assert.equal(db.loadSourceText("Never Fetched"), null);
});

test("topGaps requires at least two distinct askers, not just two asks", () => {
  db.handle().query("DELETE FROM doc_gaps").run();

  for (let i = 0; i < 8; i++) db.recordGap("does pixie have a boyfriend", "U_TROLL", "C1");
  for (const u of ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"]) {
    db.recordGap("how do i submit my project", u, "C1");
  }

  const gaps = db.topGaps(10);
  const questionText = (g: TestAny) => g.question;

  assert.ok(
    !gaps.some((g: TestAny) => questionText(g) === "does pixie have a boyfriend"),
    "one asker is not a gap regardless of how many times they ask",
  );
  assert.ok(
    gaps.some((g: TestAny) => questionText(g) === "how do i submit my project"),
    "eight distinct askers is a gap",
  );
});

test("topGaps ranks by askers, not by raw asks", () => {
  db.handle().query("DELETE FROM doc_gaps").run();

  for (const u of ["U1", "U2", "U3"]) for (let i = 0; i < 3; i++) db.recordGap("the real question", u, "C1");
  for (const u of ["A", "B", "C", "D", "E"]) db.recordGap("the rarer question", u, "C1");

  const gaps = db.topGaps(10);
  const real = gaps.find((g: TestAny) => g.question === "the real question");
  const rare = gaps.find((g: TestAny) => g.question === "the rarer question");
  assert.equal(real.askers, 3);
  assert.equal(rare.askers, 5);
  assert.ok(gaps.indexOf(rare) < gaps.indexOf(real), "rarer question ranks above louder one");
});

test("a question a maintainer has dropped stays out of the auto-ranked list", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM gap_rejections").run();

  for (const u of ["U1", "U2", "U3"]) db.recordGap("how do i submit my project", u, "C1");
  db.recordGapRejection("how do i submit my project");

  const gaps = db.topGaps(10);
  assert.ok(
    !gaps.some((g: TestAny) => g.question === "how do i submit my project"),
    "a human-rejected question should be hidden from the auto-ranked list",
  );
});

test("clearing a rejection brings a question back into the list", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM gap_rejections").run();

  for (const u of ["U1", "U2", "U3"]) db.recordGap("how do i submit my project", u, "C1");
  db.recordGapRejection("how do i submit my project");
  assert.equal(db.topGaps(10).length, 0);

  db.clearGapRejection("how do i submit my project");
  assert.equal(db.topGaps(10).length, 1);
});

test("a rejection is keyed on the normalized question, so wording doesn't matter", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM gap_rejections").run();

  for (const u of ["U1", "U2", "U3"]) db.recordGap("HOW do i Submit   my project", u, "C1");
  db.recordGapRejection("how do i submit my project");

  assert.equal(db.topGaps(10).length, 0);
});

test("learned facts are strictly program-scoped; legacy unowned rows get their channel's program", () => {
  const h = db.handle();
  h.query("DELETE FROM learned_facts").run();
  db.addLearnedFact({
    question: "acme q",
    answer: "acme a",
    authorId: "U1",
    status: "approved",
    channel: "C_ACME",
    programId: null,
  });
  db.addLearnedFact({
    question: "orphan q",
    answer: "orphan a",
    authorId: "U1",
    status: "approved",
    channel: "C_GONE",
    programId: null,
  });
  db.addLearnedFact({
    question: "b2b q",
    answer: "b2b a",
    authorId: "U1",
    status: "approved",
    channel: "C_B2B",
    programId: "b2b",
  });

  assert.deepEqual(
    db.approvedFacts(50, "b2b").map((f: TestAny) => f.question),
    ["b2b q"],
  );
  assert.deepEqual(
    db.approvedFacts(50, "acme").map((f: TestAny) => f.question),
    [],
  );

  const res = db.assignUnownedLearnedFacts((ch: TestAny) => (ch === "C_ACME" ? "acme" : null));
  assert.deepEqual(res, { unowned: 2, assigned: 1, remaining: 1 });
  assert.deepEqual(
    db.approvedFacts(50, "acme").map((f: TestAny) => f.question),
    ["acme q"],
  );
  assert.deepEqual(
    db.approvedFacts(50, "b2b").map((f: TestAny) => f.question),
    ["b2b q"],
  );
  assert.deepEqual(
    db.assignUnownedLearnedFacts(() => "b2b"),
    { unowned: 1, assigned: 1, remaining: 0 },
  );
  assert.deepEqual(
    db.approvedFacts(50, "acme").map((f: TestAny) => f.question),
    ["acme q"],
  );
});

test("a corpus with no program never sees another program's taught facts", () => {
  db.handle().query("DELETE FROM learned_facts").run();
  db.addLearnedFact({ question: "a q", answer: "a a", authorId: "U1", status: "approved", programId: "prog-a" });
  db.addLearnedFact({ question: "unowned q", answer: "u a", authorId: "U1", status: "approved", programId: null });
  assert.deepEqual(
    db.approvedFacts(50, null).map((f: TestAny) => f.question),
    ["unowned q"],
  );
  assert.deepEqual(
    db.approvedFacts(50, "prog-a").map((f: TestAny) => f.question),
    ["a q"],
  );
});

test("channel-less legacy facts go to whatever the resolver names for them", () => {
  db.handle().query("DELETE FROM learned_facts").run();
  db.addLearnedFact({
    question: "era q",
    answer: "era a",
    authorId: "U1",
    status: "approved",
    channel: null,
    programId: null,
  });
  const res = db.assignUnownedLearnedFacts((ch: TestAny) => (ch ? null : "acme"));
  assert.deepEqual(res, { unowned: 1, assigned: 1, remaining: 0 });
  assert.deepEqual(
    db.approvedFacts(50, "acme").map((f: TestAny) => f.question),
    ["era q"],
  );
});
export {};

test("sweep deletes expired support memory and traces but keeps live rows", () => {
  const supportMemory = require("./supportMemory");
  const traceStore = require("./pipeline/traceStore");
  supportMemory.remember({ programId: "sweep-p", userId: "U1", kind: "problem", value: "live row", ttlMs: 60_000 });
  supportMemory.remember({ programId: "sweep-p", userId: "U1", kind: "attempt", value: "expired row", ttlMs: 60_000 });
  db.handle()
    .query("UPDATE support_memory SET expires_at = ? WHERE value = ?")
    .run(Date.now() - 1000, "expired row");
  traceStore.append({ programId: "sweep-p", threadTs: "sweep-t", stage: "decision", payload: { action: "reply" } });
  db.handle()
    .query("UPDATE answer_traces SET expires_at = ? WHERE program_id = ?")
    .run(Date.now() - 1000, "sweep-p");
  db.sweep();
  const memoryRows = db.handle().query("SELECT value FROM support_memory WHERE program_id = 'sweep-p'").all();
  assert.deepEqual(
    memoryRows.map((row: { value: string }) => row.value),
    ["live row"],
  );
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE program_id = 'sweep-p'").get().n, 0);
});
