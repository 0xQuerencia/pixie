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

export {};
