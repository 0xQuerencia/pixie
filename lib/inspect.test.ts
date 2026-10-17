process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const docs = require("./programDocs");
const inspect = require("./inspect");
const lookup = require("./lookup");

before(() => {
  db.close();
  db.open(":memory:");
});

test("inspect returns scoped provenance and does not write cache or metrics", async () => {
  programs.saveProgram({ id: "inspect-a", name: "Inspect A", lifecycle: "testing", helpChannel: "C-INSPECT" });
  docs.createDoc("inspect-a", {
    section: "faq",
    title: "Submission FAQ",
    body: "Submit projects before the deadline.",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
  const original = lookup.lookupAnswer;
  lookup.lookupAnswer = async () => ({
    source: "Submission FAQ",
    answer: "Submit projects before the deadline.",
    verification: { sendable: true },
  });
  const beforeMetrics = db.handle().query("SELECT COUNT(*) AS n FROM metrics").get().n;
  const beforeCache = db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get().n;
  try {
    const result = await inspect.inspect("inspect-a", "When do I submit?");
    assert.equal(result.decision, "answer");
    assert.equal(result.grounded, true);
    assert.equal(result.retrieved[0].docId > 0, true);
    assert.equal(result.retrieved[0].trust, "official");
    assert.ok(result.trace.steps.some((step) => step.name === "retrieval"));
  } finally {
    lookup.lookupAnswer = original;
  }
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM metrics").get().n, beforeMetrics);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_cache").get().n, beforeCache);
});

test("inspect previews escalation without creating work", async () => {
  programs.saveProgram({ id: "inspect-b", name: "Inspect B", lifecycle: "draft", helpChannel: "C-INSPECT-B" });
  const original = lookup.lookupAnswer;
  lookup.lookupAnswer = async () => null;
  try {
    const result = await inspect.inspect("inspect-b", "unknown question");
    assert.equal(result.decision, "escalate");
    assert.equal(result.escalation.channel, "C-INSPECT-B");
  } finally {
    lookup.lookupAnswer = original;
  }
});

test("read-only inspection does not suppress concurrent normal telemetry", async () => {
  programs.saveProgram({
    id: "inspect-concurrent",
    name: "Concurrent",
    lifecycle: "testing",
    helpChannel: "C-CONCURRENT",
  });
  const original = lookup.lookupAnswer;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  lookup.lookupAnswer = async () => {
    await waiting;
    return { answer: "not grounded", verification: { sendable: false } };
  };
  const before = db.handle().query("SELECT COUNT(*) AS n FROM metrics WHERE kind = 'concurrent_normal'").get().n;
  try {
    const inspection = inspect.inspect("inspect-concurrent", "question");
    await new Promise((resolve) => setTimeout(resolve, 0));
    db.recordMetric("concurrent_normal");
    release();
    await inspection;
  } finally {
    lookup.lookupAnswer = original;
  }
  const after = db.handle().query("SELECT COUNT(*) AS n FROM metrics WHERE kind = 'concurrent_normal'").get().n;
  assert.equal(after, before + 1);
});
