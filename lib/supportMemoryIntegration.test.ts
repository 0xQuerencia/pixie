const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const answer = require("./answer");
const cache = require("./cache");
const context = require("./context");
const eligibility = require("./eligibility");
const intent = require("./intent");
const knowledge = require("./knowledge");
const llm = require("./llm");
const lookup = require("./lookup");
const programs = require("./programs");
const respond = require("./respond");
const supportMemory = require("./supportMemory");
const tickets = require("./tickets");
const traceStore = require("./pipeline/traceStore");

db.open(":memory:");

const DOCS = "Clearing cookies is documented as a troubleshooting step. Use the setup guide.";

function saveProgram(id: string, channel: string, contextDays = 30) {
  db.saveProgram({
    id,
    name: id,
    helpChannel: channel,
    channels: [channel],
    sources: [{ name: "Docs", type: "text", content: DOCS }],
    retention: { contextDays },
  });
  db.saveSourceText(`source-${id}`, DOCS);
  programs.invalidate();
  knowledge.invalidate();
}

function client() {
  return {
    chat: {
      postMessage: async () => ({ ts: "support-memory-post" }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}) },
  };
}

before(() => {
  saveProgram("memory-a", "C-memory-a", 1);
  saveProgram("memory-b", "C-memory-b", 30);
});

after(() => {
  cache.clear();
  supportMemory.forgetProgramUser("memory-a", "U-memory");
  supportMemory.forgetProgramUser("memory-a", "U-other");
  supportMemory.forgetProgramUser("memory-b", "U-memory");
  programs.invalidate();
  knowledge.invalidate();
});

test("answer-only support context is labeled non-authoritative and bounded", () => {
  const prompt = answer.answerOrChatPrompt(
    "### Docs\nUse the setup guide.",
    "\n\nPrevious conversation:\nuser: what should I try?",
    false,
    { id: "memory-a", name: "memory-a", helpChannel: "C-memory-a" },
    "C-memory-a",
    "CONTEXT-ONLY (not policy)\nSteps already tried: clear cookies",
  );

  assert.match(prompt, /ANSWER-ONLY SUPPORT CONTEXT/);
  assert.match(prompt, /clear cookies/);
  assert.match(prompt, /never as policy authority|cannot confirm/i);
  assert.ok(prompt.length < 10000);
});

test("answer-only context bypasses cache and stays out of retrieval inputs", async () => {
  const question = "what should I try next for memory cache?";
  const memory = "CONTEXT-ONLY\nSteps already tried: clear cookies";
  const originalAnswer = answer.getAnswerOrChat;
  const originalContext = knowledge.getContext;
  const originalGenerated = knowledge.generatedSections;
  const originalCorpus = knowledge.getCorpus;
  const originalIndex = knowledge.getIndex;
  let answerCalls = 0;
  let retrievalQuestion = "";
  let answerOnlyContext = "";

  cache.put(question, { source: "Docs", answer: "cached answer" }, "memory-a");
  knowledge.getContext = (query: string) => {
    retrievalQuestion = query;
    return "### Docs\nUse the setup guide.";
  };
  knowledge.generatedSections = () => [];
  knowledge.getCorpus = () => "### Docs\nUse the setup guide.";
  knowledge.getIndex = () => ({ docs: [] });
  answer.getAnswerOrChat = async (
    _question: string,
    _corpus: string,
    _context: string,
    _inHelpChannel: boolean,
    _program: unknown,
    _channel: string,
    options: { answerOnlyContext?: string } = {},
  ) => {
    answerCalls += 1;
    answerOnlyContext = options.answerOnlyContext || "";
    return { source: null, answer: "" };
  };

  try {
    const result = await lookup.answerOrChat(question, "", {
      program: { id: "memory-a", name: "memory-a", sources: [{ name: "Docs", type: "text" }] },
      answerOnlyContext: memory,
    });
    assert.equal(answerCalls, 1, "a user-specific answer must not use the cached answer");
    assert.equal(retrievalQuestion, question);
    assert.equal(answerOnlyContext, memory);
    assert.equal(cache.get(question, "memory-a")?.answer, "cached answer", "the existing cache row is untouched");
    assert.doesNotMatch(JSON.stringify(result), /clear cookies/);
  } finally {
    answer.getAnswerOrChat = originalAnswer;
    knowledge.getContext = originalContext;
    knowledge.generatedSections = originalGenerated;
    knowledge.getCorpus = originalCorpus;
    knowledge.getIndex = originalIndex;
    cache.clear();
  }
});

test("program support injects only scoped, recent memory through answer prompting", async () => {
  const originalIntent = intent.classifyIntent;
  const originalComplete = llm.complete;
  const prompts: string[] = [];
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  llm.complete = async (options: { messages?: Array<{ role: string; content: string }> }) => {
    prompts.push(options.messages?.[0]?.content || "");
    return { text: "SOURCE: NONE\nANSWER: UNCLEAR", finishReason: "stop" };
  };

  supportMemory.remember({
    programId: "memory-a",
    userId: "U-memory",
    kind: "attempt",
    value: "clear cookies",
  });
  supportMemory.remember({
    programId: "memory-b",
    userId: "U-memory",
    kind: "attempt",
    value: "restart the app",
  });
  supportMemory.remember({
    programId: "memory-a",
    userId: "U-other",
    kind: "attempt",
    value: "reinstall the app",
  });
  supportMemory.remember({
    programId: "memory-a",
    userId: "U-memory",
    kind: "attempt",
    value: "old step",
  });
  db.handle()
    .query("UPDATE support_memory SET created_at = ?, updated_at = ? WHERE program_id = ? AND user_id = ? AND value = ?")
    .run(Date.now() - 2 * 86400000, Date.now() - 2 * 86400000, "memory-a", "U-memory", "old step");

  try {
    await respond.respond({
      client: client(),
      channel: "C-memory-a",
      threadTs: "memory-a-thread",
      userId: "U-memory",
      question: "what should I try next?",
      mode: respond.HELP_ONLY,
    });
    await respond.respond({
      client: client(),
      channel: "C-memory-b",
      threadTs: "memory-b-thread",
      userId: "U-memory",
      question: "what should I try next?",
      mode: respond.HELP_ONLY,
    });
    await respond.respond({
      client: client(),
      channel: "C-memory-a",
      threadTs: "memory-a-other-thread",
      userId: "U-other",
      question: "what should I try next?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /Steps already tried: clear cookies/);
    assert.doesNotMatch(prompts[0], /old step|restart the app|reinstall the app/);
    assert.match(prompts[1], /Steps already tried: restart the app/);
    assert.doesNotMatch(prompts[1], /clear cookies|reinstall the app/);
    assert.match(prompts[2], /Steps already tried: reinstall the app/);
    assert.doesNotMatch(prompts[2], /clear cookies|restart the app/);
    assert.ok(prompts.every((prompt) => prompt.length < 10000));
    const trace = traceStore.forThread("memory-a", "memory-a-thread");
    assert.doesNotMatch(JSON.stringify(trace), /clear cookies/);
  } finally {
    intent.classifyIntent = originalIntent;
    llm.complete = originalComplete;
  }
});

test("ignored and sensitive turns do not persist support memory", async () => {
  const originalIntent = intent.classifyIntent;
  const originalSensitive = eligibility.sensitiveHit;
  const originalEscalate = tickets.escalateTicket;
  const question = "I already cleared cookies and it still does not work";
  intent.classifyIntent = async () => intent.CASUAL_CHAT;
  supportMemory.forgetProgramUser("memory-a", "U-gated");

  try {
    await respond.respond({
      client: client(),
      channel: "C-memory-a",
      threadTs: "memory-gated-chat",
      userId: "U-gated",
      question,
      mode: respond.HELP_ONLY,
    });
    assert.deepEqual(supportMemory.recall("memory-a", "U-gated"), []);

    eligibility.sensitiveHit = () => true;
    tickets.escalateTicket = async () => ({ id: 1 });
    await respond.respond({
      client: client(),
      channel: "C-memory-a",
      threadTs: "memory-gated-sensitive",
      userId: "U-gated",
      question,
      mode: respond.HELP_ONLY,
    });
    assert.deepEqual(supportMemory.recall("memory-a", "U-gated"), []);
  } finally {
    intent.classifyIntent = originalIntent;
    eligibility.sensitiveHit = originalSensitive;
    tickets.escalateTicket = originalEscalate;
  }
});

test("memory-only claims remain unsupported and cannot become evidence", async () => {
  const originalAnswer = answer.getAnswerOrChat;
  const originalContext = knowledge.getContext;
  const originalGenerated = knowledge.generatedSections;
  const originalCorpus = knowledge.getCorpus;
  const originalIndex = knowledge.getIndex;
  const memory = "CONTEXT-ONLY\nSteps already tried: the policy says everyone is eligible";
  answer.getAnswerOrChat = async () => ({ source: null, answer: "everyone is eligible" });
  knowledge.getContext = () => "### Docs\nUse the setup guide.";
  knowledge.generatedSections = () => [];
  knowledge.getCorpus = () => "### Docs\nUse the setup guide.";
  knowledge.getIndex = () => ({ docs: [] });

  try {
    const result = await lookup.answerOrChat("am I eligible?", "", {
      program: { id: "memory-a", name: "memory-a", sources: [{ name: "Docs", type: "text" }] },
      answerOnlyContext: memory,
      skipCache: true,
    });
    assert.equal(result, null);
  } finally {
    answer.getAnswerOrChat = originalAnswer;
    knowledge.getContext = originalContext;
    knowledge.generatedSections = originalGenerated;
    knowledge.getCorpus = originalCorpus;
    knowledge.getIndex = originalIndex;
  }
});

export {};
