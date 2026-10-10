process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const programs = require("../programs");
const traceStore = require("./traceStore");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("trace store keeps ticket-scoped stages and drops unknown fields", () => {
  traceStore.append({
    programId: "trace-program",
    ticketId: 41,
    threadTs: "thread-41",
    requestId: "request-41",
    stage: "grounding",
    payload: { claims: [{ claim: "safe" }], apiKey: "do-not-store", headers: { cookie: "nope" } },
  });
  const rows = traceStore.forTicket("trace-program", 41);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].payload, { verdict: "unknown", claims: [{ claim: "safe" }] });
  assert.equal(rows[0].requestId, "request-41");
  assert.deepEqual(traceStore.forTicket("other-program", 41), []);
});

test("trace store applies stage DTOs and scrubs secret values regardless of field names", () => {
  traceStore.append({
    programId: "trace-dto",
    threadTs: "thread-dto",
    stage: "retrieval",
    payload: {
      question:
        'Bearer abc.def.ghi eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature xoxb-secret sk-proj-secret cookie=private token="also-private"',
      sources: [
        {
          source: "Docs xoxp-secret",
          heading: "safe heading",
          lexical: 0.1,
          semantic: 0.2,
          total: 0.3,
          excerpt: "drop this field",
        },
      ],
      systemPrompt: "drop this field",
      arbitrary: "drop this field",
    },
  });

  const payload = traceStore.forThread("trace-dto", "thread-dto")[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ["question", "sources"]);
  assert.equal(JSON.stringify(payload).includes("abc.def.ghi"), false);
  assert.equal(JSON.stringify(payload).includes("eyJhbGciOiJIUzI1NiJ9"), false);
  assert.equal(JSON.stringify(payload).includes("xoxb-secret"), false);
  assert.equal(JSON.stringify(payload).includes("sk-proj-secret"), false);
  assert.equal(JSON.stringify(payload).includes("session=private"), false);
  assert.equal(JSON.stringify(payload).includes("cookie=private"), false);
  assert.equal(JSON.stringify(payload).includes("also-private"), false);
  assert.equal(payload.sources[0].source.includes("xoxp-secret"), false);
  assert.equal("excerpt" in payload.sources[0], false);
});

test("grounding trace keeps only the short claim DTO", () => {
  traceStore.append({
    programId: "trace-grounding",
    threadTs: "grounding-thread",
    stage: "grounding",
    payload: {
      verdict: "supported",
      grounded: true,
      claims: [
        {
          claim: "A supported claim",
          supported: true,
          evidenceIds: ["e-1", "e-2"],
          reason: "r".repeat(400),
          thought: "drop this",
        },
      ],
      errors: ["drop this"],
    },
  });

  const payload = traceStore.forTicket("trace-grounding", 999999)[0];
  assert.equal(payload, undefined);
  const stored = traceStore.forThread("trace-grounding", "grounding-thread")[0];
  assert.deepEqual(Object.keys(stored.payload).sort(), ["claims", "verdict"]);
  assert.equal(stored.payload.claims[0].supported, true);
  assert.deepEqual(stored.payload.claims[0].evidenceIds, ["e-1", "e-2"]);
  assert.ok(stored.payload.claims[0].reason.length <= 200);
  assert.equal("thought" in stored.payload.claims[0], false);
});

test("trace payload truncation stays valid and keeps a stored field", () => {
  const id = traceStore.append({
    programId: "trace-large",
    ticketId: 7,
    stage: "retrieval",
    payload: { question: "question ".repeat(5000), sources: [] },
  });
  const raw = db.handle().query("SELECT payload_json FROM answer_traces WHERE id = ?").get(id).payload_json;
  assert.doesNotThrow(() => JSON.parse(raw));
  const row = traceStore.forTicket("trace-large", 7)[0];
  assert.ok(row.payload.question.length > 0);
  assert.notDeepEqual(row.payload, {});
});

test("thread history is program-scoped and reads do not sweep expired rows", () => {
  const first = traceStore.append({
    programId: "trace-thread-a",
    threadTs: "shared-thread",
    stage: "decision",
    payload: { expectedAction: "reply" },
    ttlMs: 60_000,
  });
  traceStore.append({
    programId: "trace-thread-b",
    threadTs: "shared-thread",
    stage: "decision",
    payload: { expectedAction: "handoff" },
  });
  db.handle()
    .query("UPDATE answer_traces SET expires_at = ? WHERE id = ?")
    .run(Date.now() - 1, first);

  assert.deepEqual(traceStore.forThread("trace-thread-a", "shared-thread"), []);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE id = ?").get(first).n, 1);
  assert.equal(traceStore.forThread("trace-thread-b", "shared-thread").length, 1);
  assert.equal(traceStore.sweepExpired("trace-thread-a"), 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE id = ?").get(first).n, 0);
});

test("append uses the program traces retention policy", () => {
  programs.saveProgram({
    id: "trace-retention",
    name: "Trace retention",
    retention: { tracesDays: 2 },
  });
  programs.invalidate();
  const id = traceStore.append({
    programId: "trace-retention",
    stage: "intent",
    payload: { intent: "question" },
  });
  const row = db.handle().query("SELECT created_at, expires_at FROM answer_traces WHERE id = ?").get(id);
  assert.ok(Math.abs(row.expires_at - row.created_at - 2 * 86400000) < 1000);
});

export {};
