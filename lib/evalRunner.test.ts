process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const docs = require("./programDocs");
const inspect = require("./inspect");
const evalRunner = require("./evalRunner");

before(() => {
  db.close();
  db.open(":memory:");
});

test("eval runner grades active cases and stores a 100 percent pass status", async () => {
  programs.saveProgram({ id: "eval-a", name: "Eval A", lifecycle: "testing" });
  docs.createDoc("eval-a", {
    section: "faq",
    title: "Eval FAQ",
    body: "The answer is green.",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
  const original = inspect.inspect;
  inspect.inspect = async (_programId: string, question: string) => ({
    program: { id: "eval-a", name: "Eval A", lifecycle: "testing" },
    retrieved: [{ docId: 1, section: "faq", trust: "official", updatedAt: Date.now(), excerpt: "green" }],
    answer: question.includes("green") ? "The answer is green." : "The answer is blue.",
    grounded: true,
    decision: "answer",
    escalation: null,
    trace: { steps: [] },
  });
  try {
    evalRunner.createCase("eval-a", { kind: "normal", question: "green", expect: { mode: "answer", mustInclude: ["green"], sources: ["faq"] } });
    const result = await evalRunner.run("eval-a", "test");
    assert.equal(result.status, "passed");
    assert.equal(result.total, 1);
    assert.equal(result.passed, 1);
    assert.equal(evalRunner.latestRun("eval-a").content_hash, docs.contentHash("eval-a"));
  } finally {
    inspect.inspect = original;
  }
});

test("cross-program eval cases require explicit canaries and reject leaked text", async () => {
  programs.saveProgram({ id: "eval-cross", name: "Eval Cross", lifecycle: "testing" });
  const original = inspect.inspect;
  inspect.inspect = async () => ({
    program: { id: "eval-cross", name: "Eval Cross", lifecycle: "testing" },
    retrieved: [],
    answer: "foreign-canary leaked",
    grounded: true,
    decision: "answer",
    escalation: null,
    trace: { steps: [] },
  });
  try {
    evalRunner.createCase("eval-cross", { kind: "cross_program", question: "anything", expect: { mustNotInclude: ["foreign-canary"] } });
    const result = await evalRunner.run("eval-cross", "test");
    assert.equal(result.status, "failed");
    assert.match(result.results[0].failures[0], /forbidden/);
  } finally {
    inspect.inspect = original;
  }
});
