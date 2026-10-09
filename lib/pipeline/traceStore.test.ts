process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const traceStore = require("./traceStore");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("trace store keeps ticket-scoped stages and redacts secrets", () => {
  traceStore.append({
    programId: "trace-program",
    ticketId: 41,
    threadTs: "thread-41",
    requestId: "request-41",
    stage: "grounding",
    payload: { claims: [{ claim: "safe" }], apiKey: "do-not-store" },
  });
  const rows = traceStore.forTicket("trace-program", 41);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.apiKey, "[redacted]");
  assert.equal(rows[0].requestId, "request-41");
  assert.deepEqual(traceStore.forTicket("other-program", 41), []);
});

export {};
