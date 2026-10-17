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
