process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const supportMemory = require("./supportMemory");
const handoffContext = require("./handoffContext");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("handoff packet explains the question, attempted steps, and escalation reason", () => {
  supportMemory.forgetProgramUser("handoff-program", "U-handoff");
  supportMemory.remember({
    programId: "handoff-program",
    userId: "U-handoff",
    kind: "attempt",
    value: "Already tried refreshing the portal",
  });
  const packet = handoffContext.build({
    programId: "handoff-program",
    userId: "U-handoff",
    question: "The submit button is still disabled",
    reason: "no supported answer was found",
    sources: ["Submission guide"],
  });
  assert.match(packet, /submit button is still disabled/);
  assert.match(packet, /Already tried refreshing/);
  assert.match(packet, /no supported answer/);
  assert.match(packet, /Submission guide/);
  assert.doesNotMatch(packet, /chain of thought/i);
});

export {};
