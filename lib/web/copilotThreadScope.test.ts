process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const api = require("./api");
const context = require("../context");
const lookup = require("../lookup");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("copilot ignores a thread that belongs to another program", async () => {
  const sync = api.internalProgramSync("program-b", {
    name: "Program B",
    workspaceId: "W-B",
    claimedBy: "U-helper-b",
    programChannels: [],
  });
  assert.equal(sync.ok, true);

  const threadTs = "collision-thread-idor";
  context.addToThread(threadTs, "user", "Program A private incident: BLUE-ORCHID", "U-member-a", "C-A");

  const originalAnswerOrChat = lookup.answerOrChat;
  let capturedThreadContext = "";
  lookup.answerOrChat = async (question, threadContext) => {
    capturedThreadContext = threadContext;
    return { answer: "safe deterministic test reply" };
  };

  try {
    const response = await api.internalCopilot("draft", {
      programId: "program-b",
      actorId: "U-helper-b",
      question: "summarize this thread",
      threadTs,
    });
    assert.doesNotMatch(capturedThreadContext, /BLUE-ORCHID/);
    assert.equal(capturedThreadContext, "");
    assert.ok(response);
  } finally {
    lookup.answerOrChat = originalAnswerOrChat;
  }
});
