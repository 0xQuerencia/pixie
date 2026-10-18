process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const answer = require("./answer");
const llm = require("./llm");
const respond = require("./respond");
const cache = require("./cache");
const intent = require("./intent");
const link = require("./link");
const lookup = require("./lookup");
const reply = require("./reply");
const context = require("./context");
const knowledge = require("./knowledge");
const programs = require("./programs");
const claimVerifier = require("./claimVerifier");
const traceStore = require("./pipeline/traceStore");
const { config } = require("./config");

type SlackElement = { action_id?: string; text?: string };
type SlackBlock = { type?: string; text?: { text?: string }; elements?: SlackElement[] };
type SlackPost = {
  text?: string;
  blocks?: SlackBlock[];
  isUpdate?: boolean;
  username?: string;
  [key: string]: unknown;
};
type StreamOptions = { onText?: (text: string) => void };
type AnswerOptions = StreamOptions & { inHelpChannel?: boolean };
type RichClient = {
  posts: SlackPost[];
  chat: {
    postMessage: (payload: SlackPost) => Promise<{ ts: string }>;
    update: (payload: SlackPost) => Promise<Record<string, unknown>>;
  };
};

db.open(":memory:");

const SAFE_SOURCE_TEXT = [
  "The launch status and project documentation are listed here.",
  "Anyone can join, no team is needed.",
  "Yes, it should be public when the project is submitted.",
  "You can use the Wokwi simulator for firmware testing.",
  "Check your canvas size and the docs for export guidance.",
  "Tier 2 needs a testbench.",
  "Export it as a PNG at native size.",
  "Export as PNG at native size.",
  "Held answer text.",
].join(" ");
const SHARED_TEST_SOURCES = ["Docs", "Acme Docs", "Acme FAQ"].map((name) => ({
  name,
  type: "text",
  content: SAFE_SOURCE_TEXT,
}));

answer.getGroundedAnswer = async () => null;
answer.getAnswerOrChat = async () => null;
let realComplete: typeof llm.complete;
let savedFaq: string[];
let savedProgramsJson: string | undefined;
before(() => {
  savedFaq = config.slack.faqChannels || [];
  config.slack.faqChannels = [
    ...(savedFaq || []),
    "C1",
    "C-where",
    "C-latest",
    "C-followup",
    "C-ctx",
    "C-scope",
    "C-scoped",
    "C-charhand",
    "C0OTHER",
    "C-help",
  ];
  savedProgramsJson = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "shared", name: "Shared", sources: SHARED_TEST_SOURCES }]);
  programs.invalidate();
  for (const source of SHARED_TEST_SOURCES)
    db.saveSourceText(knowledge.sourceCacheKey(source) || source.name, source.content);
  knowledge.invalidate();
  realComplete = llm.complete;
  llm.complete = async () => ({ text: "NONE", finishReason: "stop" });
});
after(() => {
  llm.complete = realComplete;
  config.slack.faqChannels = savedFaq;
  if (savedProgramsJson === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedProgramsJson;
  programs.invalidate();
  knowledge.invalidate();
});

test("isClarifyingQuestion catches a short question handed back to the user", () => {
  assert.equal(respond.isClarifyingQuestion("sorry, what about ridit? could you clarify what you mean?"), true);
  assert.equal(respond.isClarifyingQuestion("hmm what do you mean?"), true);
});

test("isClarifyingQuestion ignores replies that are not questions", () => {
  assert.equal(respond.isClarifyingQuestion("yeah just export it as a PNG at native size"), false);
  assert.equal(respond.isClarifyingQuestion(""), false);
  assert.equal(respond.isClarifyingQuestion(undefined), false);
});

test("isClarifyingQuestion ignores a real answer that ends in a question", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "check your canvas size is small, 32x32 or 16x16, and that you're exporting as PNG at native size" +
        " without scaling it up. the file extension matters too, so make sure that's right. does that sort it?",
    ),
    false,
  );
});

test("gap recording is gated on engagement: chatter records nothing, an engaged miss records a gap", async () => {
  let escalateAdded = false;
  const mockClient = {
    chat: {
      postMessage: async () => ({ ts: "msg-1" }),
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: {
      add: async () => {
        escalateAdded = true;
      },
    },
  };

  const initialGaps = db.handle().query("SELECT COUNT(*) AS c FROM doc_gaps").get().c;

  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async (message: string) =>
    /sprite wont load/.test(message) ? intent.HELP_NEEDED : intent.CASUAL_CHAT;
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "hmm not sure on that one" }));
  const restoreCache = stubNoCache();

  try {
    await respond.respond({
      client: mockClient,
      channel: "C-help",
      threadTs: "t-1",
      userId: "U1",
      question: "thanks guys",
      mode: respond.HELP_ONLY,
    });

    assert.equal(db.handle().query("SELECT COUNT(*) AS c FROM doc_gaps").get().c, initialGaps);
    assert.equal(escalateAdded, false);

    const replied = await respond.respond({
      client: mockClient,
      channel: "C-help",
      threadTs: "t-2",
      userId: "U2",
      question: "my sprite wont load at all, what should i do?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    const after = db.handle().query("SELECT question FROM doc_gaps").all();
    assert.equal(after.length, initialGaps + 1);
    assert.ok(after.some((g: { question: string }) => g.question === "my sprite wont load at all, what should i do?"));
  } finally {
    intent.classifyIntent = originalIntent;
    restoreAnswers();
    restoreCache();
  }
});

test("respond refuses blocked local URLs with a friendly explanation", async () => {
  let postedText = "";
  const mockClient = {
    chat: {
      postMessage: async ({ text }: { text?: string }) => {
        postedText = text || "";
        return { ts: "msg-blocked" };
      },
    },
  };

  const handled = await respond.respond({
    client: mockClient,
    channel: "C1",
    threadTs: "t-blocked",
    userId: "U1",
    question: "pixie how does this website look to u? http://localhost:8000",
    mode: respond.ALWAYS,
  });

  assert.equal(handled, true);
  assert.match(postedText, /localhost on your machine isn't reachable from the bot/);
});

function fakeClient() {
  const calls: { posts: string[]; updates: string[]; deletes: number } = { posts: [], updates: [], deletes: 0 };
  return {
    calls,
    chat: {
      postMessage: async ({ text }: { text?: string }) => {
        calls.posts.push(text || "");
        return { ts: `msg-${calls.posts.length}` };
      },
      update: async ({ text }: { text?: string }) => {
        calls.updates.push(text || "");
        return {};
      },
      delete: async () => {
        calls.deletes += 1;
        return {};
      },
    },
    reactions: { add: async () => ({}) },
  };
}

async function withStreamedAnswer(chunks: string[], fn: () => Promise<unknown>) {
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q: string, _corpus: string, _ctx: string, { onText }: StreamOptions = {}) => {
    let seen = "";
    for (const chunk of chunks) {
      seen += chunk;
      if (onText) onText(seen);
    }
    return { source: "Acme FAQ", answer: seen };
  };
  try {
    return await fn();
  } finally {
    answer.getAnswerOrChatStream = original;
  }
}

function stubAnswers(impl: (...args: never[]) => unknown) {
  const origPlain = answer.getAnswerOrChat;
  const origStream = answer.getAnswerOrChatStream;
  answer.getAnswerOrChat = async (
    q: string,
    corpus: string,
    ctx: string,
    inHelp: boolean,
    prog: unknown,
    channel: string,
    opts: Record<string, unknown> = {},
  ) =>
    (impl as (...args: unknown[]) => unknown)(q, corpus, ctx, {
      onText: null,
      inHelpChannel: inHelp,
      program: prog,
      channel,
      ...(opts || {}),
    });
  answer.getAnswerOrChatStream = async (q: string, corpus: string, ctx: string, opts: StreamOptions = {}) =>
    (impl as (...args: unknown[]) => unknown)(q, corpus, ctx, opts);
  return () => {
    answer.getAnswerOrChat = origPlain;
    answer.getAnswerOrChatStream = origStream;
  };
}

function stubNoCache() {
  const orig = lookup.knownAnswer;
  lookup.knownAnswer = () => null;
  return () => {
    lookup.knownAnswer = orig;
  };
}

function verifiedAnswer(source: string, answerText: string, programId: string) {
  const evidence = [
    {
      id: "test-evidence",
      programId,
      sourceName: source,
      heading: null,
      text: answerText,
      authority: "source",
      kind: "source",
    },
  ];
  return {
    source,
    answer: answerText,
    evidence,
    verification: claimVerifier.verifyAnswerSync({ programId, answer: answerText, evidence }),
  };
}

test("respond streams the answer into the placeholder instead of waiting for all of it", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async (_q: string, _corpus: string, _ctx: string, { onText }: StreamOptions = {}) => {
    let seen = "";
    for (const chunk of ["Cream butter", "Cream butter and sugar, add chips, bake at 180C"]) {
      seen = chunk;
      if (onText) onText(seen);
    }
    return { source: null, answer: seen };
  };

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-stream",
      userId: "U-stream",
      question: "pixie, give me a chocolate chip cookie recipe",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    assert.equal(client.calls.posts.length, 1);
    assert.equal(client.calls.posts[0], reply.THINKING);
    assert.ok(client.calls.updates.length >= 1, "expected at least one streamed update");
    assert.match(client.calls.updates[client.calls.updates.length - 1], /chips/);
  } finally {
    answer.getAnswerOrChatStream = original;
    intent.classifyIntent = originalIntent;
  }
});

test("a fresh question is cacheable, and the repeat costs no model call", async () => {
  const client = fakeClient();
  const question = "how do i export a sprite";

  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Acme FAQ", answer: "export it as a PNG at native size" };
  });

  try {
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-cache-a",
      userId: "U-cache",
      question,
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1);
    const progId = require("./programs").forChannel("C1").id;
    assert.notEqual(cache.get(question, progId), null, "the answer should have been cached");
    assert.equal(cache.get(question, "__other_program__"), null, "another program must miss");

    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-cache-b",
      userId: "U-other",
      question: "  sprite   EXPORT?? ",
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1, "the repeat should have been served from cache");
  } finally {
    restoreAnswers();
  }
});

test("a poisoned cache hit is re-verified against fresh evidence before use", async () => {
  await withHelpProgram({ id: "cache-reverify" }, async (programId: string) => {
    const question = "what is the AI limit?";
    cache.put(question, { source: "Docs", answer: "The AI limit is 30%." }, programId);
    const known = await lookup.knownAnswer({
      question,
      contextPrompt: "",
      mode: respond.ALWAYS,
      program: programs.get(programId),
    });
    assert.equal(known, null);
  });
});

test("respond tells the model when the channel it's replying in is the help channel", async () => {
  const savedHelpChannel = config.slack.helpChannel;
  config.slack.helpChannel = "C0HELP";

  const seen: boolean[] = [];
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  const restoreAnswers = stubAnswers(async (_q: unknown, _c: unknown, _ctx: unknown, opts: AnswerOptions = {}) => {
    seen.push(opts.inHelpChannel === true);
    return { source: "Acme Docs", answer: "here is the launch status" };
  });

  try {
    await respond.respond({
      client: fakeClient(),
      channel: "C0HELP",
      threadTs: "t-help-aware",
      userId: "U-help",
      question: "is it launched yet",
      mode: respond.ALWAYS,
    });
    await respond.respond({
      client: fakeClient(),
      channel: "C0OTHER",
      threadTs: "t-help-unaware",
      userId: "U-other",
      question: "is it launched yet also",
      mode: respond.ALWAYS,
    });
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
    config.slack.helpChannel = savedHelpChannel;
  }

  assert.deepEqual(seen, [true, false]);
});

test("a follow-up in a live thread still bypasses the cache", async () => {
  const client = fakeClient();
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Acme FAQ", answer: "check your canvas size" };
  });

  try {
    const ask = (question: string) =>
      respond.respond({ client, channel: "C1", threadTs: "t-followup", userId: "U-f", question, mode: respond.ALWAYS });

    await ask("why is my tileset blurry");
    await ask("why is my tileset blurry");
    assert.equal(modelCalls, 2, "the second message has thread context, so it is not a cache hit");
  } finally {
    restoreAnswers();
  }
});

test("a message the gate rejects never reaches Slack, even mid-stream", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChat;
  const originalStream = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("well actually, the thing about rust is");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    return { source: null, answer: "well actually, the thing about rust is" };
  };
  answer.getAnswerOrChat = async () => ({ source: null, answer: "well actually, the thing about rust is" });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    context.addToThread("t-followup-structured", "user", "where do I submit?", "U-followup", "C-followup");
    context.addToThread("t-followup-structured", "assistant", "Submit it through the Acme portal.", null, "C-followup");
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate",
      userId: "U-gate",
      question: "does anyone know if this is even worth doing",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "no placeholder should have been posted");
    assert.deepEqual(client.calls.updates, [], "no text should have been written");
    assert.equal(client.calls.deletes, 0, "nothing to delete, because nothing was posted");
  } finally {
    answer.getAnswerOrChat = originalAnswer;
    answer.getAnswerOrChatStream = originalStream;
    intent.classifyIntent = originalIntent;
  }
});

test("off-topic chatter in an implicit addressed thread stays silent", async () => {
  const client = fakeClient();
  const originalContextIntent = intent.classifyIntentContext;
  intent.classifyIntentContext = async () => ({ directedAtHuman: true, verdict: intent.CASUAL_CHAT });

  try {
    const handled = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-thread-chatter",
      userId: "U-thread-chatter",
      question: "which has realtime data",
      mode: respond.ALWAYS,
      addressedHow: "thread",
    });

    assert.equal(handled, false);
    assert.deepEqual(client.calls.posts, []);
    assert.deepEqual(client.calls.updates, []);
    assert.equal(client.calls.deletes, 0);
  } finally {
    intent.classifyIntentContext = originalContextIntent;
  }
});

test("a message the gate accepts is answered normally", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(
    async (_q: unknown, _c: unknown, _ctx: unknown, { onText }: StreamOptions = {}) => {
      if (onText) onText("check your canvas size");
      return { source: "Acme Docs", answer: "check your canvas size" };
    },
  );
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-ok",
      userId: "U-gate-ok",
      question: "my exported sprite comes out blurry, what do i do?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, true);
    assert.equal(client.calls.posts.length, 1);
    assert.match(client.calls.posts.join(" "), /canvas size/);
    assert.deepEqual(client.calls.updates, [], "ambient answers are never streamed");
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
  }
});

test("program answers do not stream model text before claim verification", async () => {
  const originalPlain = answer.getAnswerOrChat;
  const originalStream = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  let streamCalls = 0;
  let plainOptions: Record<string, unknown> | undefined;
  answer.getAnswerOrChat = async (
    _question: string,
    _corpus: string,
    _context: string,
    _inHelp: boolean,
    _program: unknown,
    _channel: string,
    options: Record<string, unknown> = {},
  ) => {
    plainOptions = options;
    return { source: "Docs", answer: "you can use wokwi simulator" };
  };
  answer.getAnswerOrChatStream = async (
    _question: string,
    _corpus: string,
    _context: string,
    options: StreamOptions = {},
  ) => {
    streamCalls += 1;
    options.onText?.("this must not reach Slack");
    return { source: "Docs", answer: "this must not reach Slack" };
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    await withHelpProgram({ id: "stream-gated" }, async (programId: string, channel: string) => {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-stream-gated",
        userId: "U-stream-gated",
        question: "how do i test my firmware?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);
      assert.equal(streamCalls, 0);
      assert.equal(plainOptions?.onText, undefined);
      assert.match(answerText(client), /wokwi simulator/);
      assert.doesNotMatch(client.posts.map((post: SlackPost) => post.text || "").join(" "), /must not reach Slack/);
      void programId;
    });
  } finally {
    answer.getAnswerOrChat = originalPlain;
    answer.getAnswerOrChatStream = originalStream;
    intent.classifyIntent = originalIntent;
  }
});

test("grounding traces contain only verdict claims and selected evidence metadata", async () => {
  const originalIntent = intent.classifyIntent;
  const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "you can use wokwi simulator" }));
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await withHelpProgram({ id: "trace-gated" }, async (programId: string, channel: string) => {
      await respond.respond({
        client: richClient(),
        channel,
        threadTs: "t-trace-gated",
        userId: "U-trace-gated",
        question: "how do i test my firmware?",
        mode: respond.HELP_ONLY,
      });
      const rows = traceStore.forThread(programId, "t-trace-gated");
      const grounding = rows.find((row: { stage: string }) => row.stage === "grounding");
      const selected = rows.find((row: { stage: string }) => row.stage === "selected_evidence");
      assert.deepEqual(Object.keys(grounding?.payload || {}).sort(), ["claims", "errors", "sendable", "verdict"]);
      assert.ok((grounding?.payload.claims || []).length > 0);
      assert.deepEqual(Object.keys(selected?.payload || {}).sort(), ["evidence", "evidenceIds"]);
    });
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
  }
});

test("a normal source answer invokes claim verification before sending", async () => {
  const originalIntent = intent.classifyIntent;
  const originalVerify = claimVerifier.verifyAnswer;
  const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "you can use wokwi simulator" }));
  let verifyCalls = 0;
  claimVerifier.verifyAnswer = async (input: Parameters<typeof originalVerify>[0]) => {
    verifyCalls += 1;
    return originalVerify(input);
  };
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await withHelpProgram({ id: "verify-before-send" }, async (_programId: string, channel: string) => {
      const client = richClient();
      await respond.respond({
        client,
        channel,
        threadTs: "t-verify-before-send",
        userId: "U-verify-before-send",
        question: "how do i test my firmware?",
        mode: respond.HELP_ONLY,
      });
      assert.ok(verifyCalls > 0);
      assert.match(answerText(client), /wokwi simulator/);
    });
  } finally {
    claimVerifier.verifyAnswer = originalVerify;
    restoreAnswers();
    intent.classifyIntent = originalIntent;
  }
});

test("a gate that errors stays quiet rather than guessing", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("check your canvas size");
    return { source: "Acme Docs", answer: "check your canvas size" };
  };
  intent.classifyIntent = async () => null;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-null",
      userId: "U-gate-null",
      question: "how do i connect hackatime",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "no placeholder should have been posted");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("a gate outage cannot silence someone who addressed pixie directly", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: "Acme Docs", answer: "check your canvas size" }));
  intent.classifyIntent = async () => {
    throw new Error("every provider is rate limited");
  };

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-gate-always",
      userId: "U-gate-always",
      question: "where does the hackatime token go",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    assert.match(client.calls.posts.join(" "), /canvas size/);
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
  }
});

test("the gate is handed the asker and channel so it can read their recent messages", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  let seen: { userId?: string; channel?: string } | null = null;
  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("check the log");
    return { source: "Acme Docs", answer: "check the log" };
  };
  intent.classifyIntent = async (_msg: string, _prog: unknown, opts: { userId?: string; channel?: string }) => {
    seen = opts;
    return intent.HELP_NEEDED;
  };

  try {
    await respond.respond({
      client,
      channel: "C-ctx",
      threadTs: "t-gate-ctx",
      userId: "U-ctx",
      question: "still nothing",
      mode: respond.HELP_ONLY,
    });
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }

  const gateSeen = seen as { userId?: string; channel?: string } | null;
  assert.equal(gateSeen?.userId, "U-ctx");
  assert.equal(gateSeen?.channel, "C-ctx");
});

test("respond passes the latest question into context selection", async () => {
  let seen = "";
  const restoreAnswers = stubAnswers(async (_q: unknown, _c: unknown, contextPrompt: string) => {
    seen = contextPrompt;
    return { source: "Acme Docs", answer: "got it" };
  });
  context.addToThread("t-latest-question", "user", "old unrelated question", "U-latest", "C-latest");
  context.addToThread("t-latest-question", "assistant", "old answer", null, "C-latest");
  try {
    await respond.respond({
      client: fakeClient(),
      channel: "C-latest",
      threadTs: "t-latest-question",
      userId: "U-latest",
      question: "how do i submit this project?",
      mode: respond.ALWAYS,
    });
  } finally {
    restoreAnswers();
  }
  assert.match(seen, /how do i submit this project/);
});

test("HELP_ONLY consumes structured intent and preserves Pixie follow-up context", async () => {
  const client = fakeClient();
  const originalContextIntent = intent.classifyIntentContext;
  let seen = "";
  const restoreAnswers = stubAnswers(async (_q: unknown, _c: unknown, contextPrompt: string) => {
    seen = contextPrompt;
    return { source: "Acme Docs", answer: "yes, it should be public" };
  });
  intent.classifyIntentContext = async (
    _message: string,
    _program: unknown,
    options: { threadMessages?: unknown[] },
  ) => ({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: true,
    programRelevance: "relevant",
    needsHelp: true,
    shouldAttemptAnswer: true,
    threadMessages: options.threadMessages,
  });

  try {
    const replied = await respond.respond({
      client,
      channel: "C-followup",
      threadTs: "t-followup-structured",
      userId: "U-followup",
      question: "does it need to be public?",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, true);
    assert.match(seen || "", /Previous conversation/);
  } finally {
    restoreAnswers();
    intent.classifyIntentContext = originalContextIntent;
  }
});

test("an OFF_TOPIC verdict stays quiet and is not filed as a docs gap", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  const before = db.topGaps(50).length;

  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("flexbox has a few ways to do that");
    return { source: null, answer: "flexbox has a few ways to do that" };
  };
  intent.classifyIntent = async () => intent.OFF_TOPIC;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-offtopic",
      userId: "U-offtopic",
      question: "how do i center a div in css",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "nothing should have been posted");
    assert.equal(db.topGaps(50).length, before, "an off-topic question is not a hole in the docs");
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("addressed is passed to the gate so a direct ask escapes the scope", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  let seen: Record<string, unknown> | null = null;
  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("use flexbox");
    return { source: "Acme Docs", answer: "use flexbox" };
  };
  intent.classifyIntent = async (_msg: string, _prog: unknown, opts: Record<string, unknown>) => {
    seen = opts;
    return intent.HELP_NEEDED;
  };

  try {
    await respond.respond({
      client,
      channel: "C-scope",
      threadTs: "t-addressed",
      userId: "U-addressed",
      question: "pixie how do i center a div",
      mode: respond.HELP_ONLY,
      addressed: true,
    });
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }

  const addressedSeen = seen as Record<string, unknown> | null;
  assert.equal(addressedSeen?.addressed, true);
});

test("the answer call is handed the program record and the channel it is in", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  let seen: (AnswerOptions & { channel?: string; program?: { name?: string } }) | null = null;
  const restoreAnswers = stubAnswers(
    async (
      _q: unknown,
      _c: unknown,
      _ctx: unknown,
      opts: AnswerOptions & { channel?: string; program?: { name?: string } } = {},
    ) => {
      seen = opts;
      return { source: "Acme Docs", answer: "check the docs" };
    },
  );
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  try {
    await respond.respond({
      client,
      channel: "C-where",
      threadTs: "t-where",
      userId: "U-where",
      question: "how do i wire up the tileset exporter",
      mode: respond.HELP_ONLY,
    });
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
  }

  const answerSeen = seen as (AnswerOptions & { channel?: string; program?: { name?: string } }) | null;
  assert.equal(answerSeen?.channel, "C-where");
  assert.equal(typeof answerSeen?.program, "object", "a program record, not an id string");
  assert.ok(answerSeen?.program?.name, "with a display name the prompt can use");
});

test("a known answer is one Slack call, with no placeholder", async () => {
  const client = fakeClient();
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Acme FAQ", answer: "anyone can join, no team needed" };
  });

  try {
    const ask = (threadTs: string, question: string) =>
      respond.respond({ client, channel: "C1", threadTs, userId: `U-${threadTs}`, question, mode: respond.ALWAYS });

    await ask("t-instant-a", "who can join acme");
    assert.equal(modelCalls, 1);
    const afterFirst = { posts: client.calls.posts.length, updates: client.calls.updates.length };

    await ask("t-instant-b", "who can join acme?");
    assert.equal(modelCalls, 1, "the second ask must not reach the model");
    assert.equal(client.calls.posts.length, afterFirst.posts + 1, "exactly one new message");
    assert.equal(client.calls.updates.length, afterFirst.updates, "and no edit of it afterwards");
    assert.equal(client.calls.posts.at(-1), "anyone can join, no team needed");
  } finally {
    restoreAnswers();
  }
});

test("the instant path still respects the gate", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const progId = require("./programs").forChannel("C1").id;
    cache.put("how do i export a tileset", { source: "Acme Docs", answer: "export at native size" }, progId);

    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-instant-gate",
      userId: "U-ig",
      question: "how do i export a tileset",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
  } finally {
    intent.classifyIntent = originalIntent;
  }
});

test("a message with a link never takes the instant path", async () => {
  const client = fakeClient();
  let modelCalls = 0;
  const restoreAnswers = stubAnswers(async () => {
    modelCalls += 1;
    return { source: "Acme Docs", answer: "looks fine" };
  });

  const originalFetch = link.fetchUrlContent;
  link.fetchUrlContent = async () => ({ text: "a page", blocked: false });

  try {
    cache.put("how does this look", { source: "Acme Docs", answer: "cached opinion" });
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-link",
      userId: "U-link",
      question: "how does this look https://acme.rsvp",
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 1, "the link must be read, not answered from cache");
  } finally {
    restoreAnswers();
    link.fetchUrlContent = originalFetch;
  }
});

test("isClarifyingQuestion catches a hand-back that carries on past the question", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "do what? if you're asking about something acme-specific like submitting, setting up hackatime," +
        " git, or starting a project, just tell me what part you're stuck on and i can walk you through it :oke:",
    ),
    true,
  );
  assert.equal(
    respond.isClarifyingQuestion(
      "not sure what you're referring to there — drop a bit more context and i can help :oke:",
    ),
    true,
  );
  assert.equal(
    respond.isClarifyingQuestion("hey! could you clarify what you mean, then i'll have a proper go at it"),
    true,
  );
});

test("isClarifyingQuestion leaves real answers alone", () => {
  assert.equal(
    respond.isClarifyingQuestion(
      "depends what you're trying to do — if you just want a bigger canvas, set it before you start drawing," +
        " since resizing later rescales everything",
    ),
    false,
  );
  assert.equal(
    respond.isClarifyingQuestion(
      "the export part is under File > Export, and the scale option sits right under it — leave it at 1x",
    ),
    false,
  );
});

test("an unaddressed hand-back is deleted and not recorded as a docs gap", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const handBack =
    "do what? if you're asking about something acme-specific like submitting, setting up hackatime," +
    " git, or starting a project, just tell me what part you're stuck on and i can walk you through it :oke:";

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: handBack }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  const gapsBefore = db.topGaps(200).length;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-handback",
      userId: "U-handback",
      question: "eh how do i do tthis ?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.equal(db.topGaps(200).length, gapsBefore, "a hand-back is not a docs gap");
    assert.deepEqual(client.calls.posts, [], "an ungrounded ambient answer is never posted");
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
  }
});

test("an unclear verdict is silence, not the mention fallback", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  const gapsBefore = db.topGaps(200).length;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-unclear",
      userId: "U-unclear",
      question: "eh how do i do tthis ?",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, [], "nothing should have been posted");
    assert.equal(db.topGaps(200).length, gapsBefore, "an unanswerable message is not a docs gap");
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
  }
});

test("an unclear verdict still answers someone who addressed pixie directly", async () => {
  const client = fakeClient();

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-unclear-addressed",
      userId: "U-unclear-addressed",
      question: "pixie how do i do this",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    assert.match(client.calls.posts.concat(client.calls.updates).join(" "), /couldn't verify/);
  } finally {
    restoreAnswers();
    restoreCache();
  }
});

test("stfu pixie mutes the thread and leaves", async () => {
  const client = fakeClient();
  const threadTs = "t-stfu-test";

  const replied = await respond.respond({
    client,
    channel: "C1",
    threadTs,
    userId: "U1",
    question: "stfu pixie",
    mode: respond.ALWAYS,
  });

  assert.equal(replied, true);
  assert.equal(db.isThreadMuted(threadTs), true, "thread is marked as muted");
  assert.match(client.calls.posts.join(" "), /leaving the thread/);
});

test("an unaddressed deterministic answer still requires support intent", async () => {
  const client = fakeClient();
  const originalLookup = lookup.answerOrChat;
  const originalIntent = intent.classifyIntent;

  lookup.answerOrChat = async () => ({
    source: "Docs",
    direct: true,
    answer: "PS5 Digital, 825gb +wireless controller is 11,400 px.",
  });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-shop",
      userId: "U-shop",
      question: "how much hours needed for t4 for ps5",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
  } finally {
    lookup.answerOrChat = originalLookup;
    intent.classifyIntent = originalIntent;
  }
});

test("an ordinary ungrounded answer is still thrown away by the gate", async () => {
  const client = fakeClient();
  const originalLookup = lookup.answerOrChat;
  const originalIntent = intent.classifyIntent;

  lookup.answerOrChat = async () => ({ source: null, answer: "yeah man totally" });
  intent.classifyIntent = async () => intent.CASUAL_CHAT;

  try {
    const replied = await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-shop-2",
      userId: "U-shop",
      question: "lol",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, false);
  } finally {
    lookup.answerOrChat = originalLookup;
    intent.classifyIntent = originalIntent;
  }
});

function withBrand(vars: Record<string, string | undefined>, fn: () => unknown) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v as string;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v as string;
    }
  }
}

test("a mute request works by the bot's own name", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(respond.isMuteRequest("stfu sol"), true);
    assert.equal(respond.isMuteRequest("sol shut up"), true);
    assert.equal(respond.isMuteRequest("sol stfu"), true);
    assert.equal(respond.isMuteRequest("quiet sol"), true);
    assert.equal(respond.isMuteRequest("be quiet sol please"), false);
  });
});

test("an unrelated message is still not a mute request", () => {
  withBrand({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(respond.isMuteRequest("how do i submit my project"), false);
    assert.equal(respond.isMuteRequest("sol how do i start"), false);
  });
});

test("with no brand set, the pixie forms still match", () => {
  withBrand({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(respond.isMuteRequest("stfu pixie"), true);
    assert.equal(respond.isMuteRequest("pixie stfu"), true);
  });
});

test("a slug containing regex metacharacters is escaped, not executed", () => {
  withBrand({ PIXIE_BOT_NAME: "c++ bot", PIXIE_BOT_SLUG: undefined }, () => {
    assert.doesNotThrow(() => respond.isMuteRequest("stfu c++ bot"));
    assert.equal(respond.isMuteRequest("nonsense"), false);
  });
});

test("every documented stop/leave phrasing is recognized, and 'stop' alone is anchored, not bare", () => {
  assert.equal(respond.isMuteRequest("stop pixie"), true);
  assert.equal(respond.isMuteRequest("pixiestop"), true);
  assert.equal(respond.isMuteRequest("stoppixie"), true);
  assert.equal(respond.isMuteRequest("stop pinging him"), true);
  assert.equal(respond.isMuteRequest("stop pinging"), true);
  assert.equal(respond.isMuteRequest("pixie leave"), true);
  assert.equal(respond.isMuteRequest("shut up pixie"), true);

  assert.equal(respond.isMuteRequest("please stop, pixie already helped"), false);
  assert.equal(respond.isMuteRequest("stop the build please"), false);
  assert.equal(respond.isMuteRequest("can we stop for today"), false);
  assert.equal(respond.isMuteRequest("pixie is stopping by later"), false);
});

test("help channel hands an unclear question to a helper with the escalated uncertainty text", async () => {
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "help-unclear" }, async (programId: string, channel: string) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-unclear",
        userId: "U-user-help-1",
        question: "something totally unknown that model cannot answer",
        mode: respond.ALWAYS,
      });

      assert.equal(replied, true);
      const said = client.posts.map((p: SlackPost) => p.text || "").join(" ");
      assert.match(said, /couldn't verify/);
      assert.match(said, /flagged it for a helper/);
      const ticket = db.getTicketByThreadTs("t-help-unclear");
      assert.ok(ticket, "the support request still lands with humans");
      assert.equal(ticket.status, "waiting_for_helper");
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("an unsupported ping in the help channel stays fail-closed and goes to a helper", async () => {
  const originalIntent = intent.classifyIntent;

  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "you can use wokwi simulator" }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "help-firmware" }, async (programId: string, channel: string) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-firmware",
        userId: "U-user-help-2",
        question: "how do i test my firmware if i don't have hardware yet",
        mode: respond.ALWAYS,
      });

      assert.equal(replied, true);
      const said = client.posts.map((p: SlackPost) => p.text || "").join(" ");
      assert.doesNotMatch(said, /wokwi simulator/);
      assert.match(said, /couldn't verify/);
      const ticket = db.getTicketByThreadTs("t-help-firmware");
      assert.ok(ticket);
      assert.equal(ticket.status, "waiting_for_helper");
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("help channel stays quiet when gate returns OFF_TOPIC in thread", async () => {
  const client = fakeClient();
  const originalAnswer = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;

  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("here is some advice");
    return { source: null, answer: "here is some advice" };
  };
  intent.classifyIntent = async () => intent.OFF_TOPIC;

  try {
    const replied = await respond.respond({
      client,
      channel: "C0MAIN00001",
      threadTs: "t-help-offtopic",
      userId: "U-user-help-3",
      question: "how do i test my custom python script",
      mode: respond.HELP_ONLY,
    });

    assert.equal(replied, false);
    assert.deepEqual(client.calls.posts, []);
  } finally {
    answer.getAnswerOrChatStream = originalAnswer;
    intent.classifyIntent = originalIntent;
  }
});

test("an ungrounded answer in help hands off with uncertainty even when PIXIE_REQUIRE_GROUNDED_ANSWER is set", async () => {
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  const restoreAnswers = stubAnswers(async () => ({
    source: null,
    answer: "i am not sure about grant amounts",
  }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";

  await withHelpProgram({ id: "help-grounded-req" }, async (programId: string, channel: string) => {
    const client = richClient();
    try {
      const replied = await respond.respond({
        client,
        channel,
        threadTs: "t-help-ungrounded",
        userId: "U-user-help-4",
        question: "how much grant for laptop",
        mode: respond.ALWAYS,
      });

      assert.equal(replied, true);
      const said = client.posts.map((p: SlackPost) => p.text || "").join(" ");
      assert.doesNotMatch(said, /grant amounts/);
      assert.match(said, /couldn't verify/);
      assert.ok(db.getTicketByThreadTs("t-help-ungrounded"));
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
      if (origEnv === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
      else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = origEnv;
    }
  });
});

test("isGroundedAnswer correctly identifies grounded vs ungrounded answers", () => {
  const { isGroundedAnswer } = respond;
  assert.equal(isGroundedAnswer(null), false);
  assert.equal(isGroundedAnswer({ source: "NONE", answer: "UNCLEAR" }), false);
  assert.equal(
    isGroundedAnswer({
      source: "Questions the bot should NOT invent answers for",
      answer: "there is no confirmed answer",
    }),
    false,
  );
  assert.equal(isGroundedAnswer({ source: "Bot behavior rule", answer: "ask in the help channel" }), false);
  assert.equal(isGroundedAnswer({ source: "Program FAQ", answer: "i'm not sure about that item" }), false);
  assert.equal(isGroundedAnswer({ source: "Program catalog", answer: "you should check the site" }), false);
  assert.equal(isGroundedAnswer({ source: "Program FAQ", answer: "suggest asking in the help channel" }), false);
  assert.equal(
    isGroundedAnswer(
      verifiedAnswer("Live FAQ", "Every hour of work submitted adds 20 minutes to the livestream timer.", "live"),
    ),
    true,
  );
  assert.equal(
    isGroundedAnswer(verifiedAnswer("Live FAQ", "Projects started or recorded before Live began are allowed.", "live")),
    true,
  );
});

test("stripChannelMentions removes Slack channel tags and links", () => {
  const { stripChannelMentions } = respond;
  assert.equal(stripChannelMentions("ask in <#C0CHAN00002|pixie>"), "ask in");
  assert.equal(stripChannelMentions("check #help-channel for updates"), "check for updates");
  assert.equal(stripChannelMentions("regular text without channels"), "regular text without channels");
});

test("a meta source or channel redirect stays unposted in a DM, with uncertainty instead", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  const origEnv = process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;

  const restoreAnswers = stubAnswers(async () => ({
    source: "Questions the bot should NOT invent answers for",
    answer: "there is no confirmed answer, ask in #help-channel",
  }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = "1";

  try {
    const replied = await respond.respond({
      client,
      channel: "C0CHAN00006",
      threadTs: "t-help-ai-limit",
      userId: "U-user-ai",
      question: "What is the exact percentage limit of AI code allowed?",
      mode: respond.ALWAYS,
    });

    assert.equal(replied, true);
    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.doesNotMatch(said, /help-channel/);
    assert.match(said, /couldn't verify/);
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
    if (origEnv === undefined) delete process.env.PIXIE_REQUIRE_GROUNDED_ANSWER;
    else process.env.PIXIE_REQUIRE_GROUNDED_ANSWER = origEnv;
  }
});

test("sensitive-category questions escalate without any model call", async () => {
  const programs = require("./programs");
  const db = require("./db");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "sens", name: "Sens", helpChannel: "C-SENS", channels: ["C-SENS"], sensitiveCategories: ["reimbursement"] },
  ]);
  programs.invalidate();
  const client = fakeClient();
  let modelCalls = 0;
  const original = answer.getAnswerOrChatStream;
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "x", answer: "never" };
  };
  try {
    const handled = await respond.respond({
      client,
      channel: "C-SENS",
      threadTs: "t-sens-1",
      userId: "U-sens",
      question: "can I get a reimbursement exception for my flight",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(modelCalls, 0);
    const ticket = db.getTicketByThreadTs("t-sens-1");
    assert.ok(ticket);
    assert.equal(ticket.program_id, "sens");
  } finally {
    answer.getAnswerOrChatStream = original;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("a classifier outage in a help channel preserves the support path (ticket + helper)", async () => {
  const db = require("./db");
  const savedHelp = config.slack.helpChannel;
  config.slack.helpChannel = "C0OUTAGE";
  const client = fakeClient();
  try {
    const replied = await respond.respond({
      client,
      channel: "C0OUTAGE",
      threadTs: "t-outage-1",
      userId: "U-out",
      question: "my pcb never arrived",
      mode: respond.HELP_ONLY,
    });
    assert.equal(replied, true);
    const ticket = db.getTicketByThreadTs("t-outage-1");
    assert.ok(ticket, "the outage must not swallow the support request");
    assert.equal(ticket.status, "waiting_for_helper");
    assert.ok(client.calls.posts.every((t: string) => /Someone will be here to help you soon!/.test(t)));
  } finally {
    config.slack.helpChannel = savedHelp;
  }
});

test("shadow mode evaluates but sends nothing publicly", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "shdw", name: "Shadow", helpChannel: "C-SHDW", channels: ["C-SHDW"], shadowMode: true },
  ]);
  programs.invalidate();
  const client = fakeClient();
  const posted: SlackPost[] = [];
  client.chat.postMessage = async (p: SlackPost) => {
    posted.push(p);
    return { ts: "x" };
  };
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "hmm not sure" }));
  const restoreCache = stubNoCache();
  try {
    const handled = await respond.respond({
      client,
      channel: "C-SHDW",
      threadTs: "t-shdw-1",
      userId: "U-shdw",
      question: "when is the deadline",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(posted.length, 0, "shadow must not post");
    const ticket = db.getTicketByThreadTs("t-shdw-1");
    assert.ok(ticket, "shadow still files the ticket silently");
    assert.equal(ticket.program_id, "shdw");
  } finally {
    restoreAnswers();
    restoreCache();
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("a support question in an active help channel opens a ticket that stays OPEN when Pixie answers it", async () => {
  const db = require("./db");
  const originalIntent = intent.classifyIntent;
  const restoreAnswers = stubAnswers(async () => ({
    source: "Docs",
    answer: "here is how to get started with your project",
  }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;

  await withHelpProgram({ id: "one-terminal" }, async (programId: string, channel: string) => {
    const client = richClient();
    try {
      const threadTs = "t-help-open";
      const replied = await respond.respond({
        client,
        channel,
        threadTs,
        userId: "U-open",
        question: "how do I get started?",
        mode: respond.ALWAYS,
      });
      assert.equal(replied, true);

      const said = client.posts.map((p: SlackPost) => p.text || "").join(" ");
      assert.match(said, /here is how to get started/);
      assert.match(said, /Someone will be here to help you soon/);

      const ticket = db.getTicketByThreadTs(threadTs);
      assert.ok(ticket, "an eligible support question MUST create a ticket");
      assert.equal(ticket.status, "open", "a Pixie answer does not resolve or re-status the ticket");
      assert.equal(ticket.assignee_id, null);
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("rate limiting posts limit message but does not create tickets or leave stuck placeholders", async () => {
  const db = require("./db");
  const rateLimit = require("./rateLimit");
  const client = fakeClient();

  const userId = "U-rate-limit-test";
  for (let i = 0; i < 20; i++) {
    rateLimit.check(userId);
  }

  const threadTs = "t-rate-limit-thread";
  const replied = await respond.respond({
    client,
    channel: "C1",
    threadTs,
    userId,
    question: "pixie are you there?",
    mode: respond.ALWAYS,
  });

  assert.equal(replied, false);
  const ticket = db.getTicketByThreadTs(threadTs);
  assert.equal(ticket, null, "rate limiting must not open tickets");
  assert.match(client.calls.posts.join(" "), /slow down a sec/);
  assert.deepEqual(
    client.calls.posts.filter((t: string) => t === reply.THINKING),
    [],
    "no placeholder posted",
  );
});

test("rate-limit notice failure still records one metric and final trace", async () => {
  const rateLimit = require("./rateLimit");
  const slackMessages = require("./slackMessages");
  const originalCheck = rateLimit.check;
  const originalSend = slackMessages.sendProgramMessage;
  const originalRecordMetric = db.recordMetric;
  const metrics: unknown[][] = [];
  const threadTs = "t-rate-limit-failure";
  const program = programs.forChannel("C1");
  rateLimit.check = () => ({ allowed: false, reason: "limit" });
  slackMessages.sendProgramMessage = async () => {
    throw new Error("Slack unavailable");
  };
  db.recordMetric = (...args: unknown[]) => {
    metrics.push(args);
    return originalRecordMetric(...args);
  };
  try {
    const replied = await respond.respond({
      client: fakeClient(),
      channel: "C1",
      threadTs,
      userId: "U-rate-limit-failure",
      question: "pixie can you help?",
      mode: respond.ALWAYS,
    });
    assert.equal(replied, false);
  } finally {
    rateLimit.check = originalCheck;
    slackMessages.sendProgramMessage = originalSend;
    db.recordMetric = originalRecordMetric;
  }

  assert.equal(metrics.filter(([kind]) => kind === "rate_limited").length, 1);
  const finalAction = traceStore
    .forThread(program.id, threadTs)
    .find((row: { stage: string }) => row.stage === "final_action");
  assert.equal(finalAction?.payload.action, "silence");
  assert.equal(finalAction?.payload.reason, "rate_limited");
  assert.equal(finalAction?.payload.decision, "ignored");
  assert.equal(finalAction?.payload.sent, false);
});

test("same-thread turns serialize before the next provider call or placeholder", async () => {
  await withHelpProgram({ id: "thread-queue" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const originalKnown = lookup.knownAnswer;
    const originalAnswer = lookup.answerOrChat;
    const started = deferred();
    const release = deferred();
    let calls = 0;
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    lookup.knownAnswer = async () => null;
    lookup.answerOrChat = async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return verifiedAnswer("Docs", "the verified answer", programId);
    };

    try {
      const first = respond.respond({
        client,
        channel,
        threadTs: "thread-queue-root",
        messageTs: "thread-queue-message-1",
        userId: "U-thread-1",
        question: "first question",
        mode: respond.ALWAYS,
      });
      await started.promise;
      const second = respond.respond({
        client,
        channel,
        threadTs: "thread-queue-root",
        messageTs: "thread-queue-message-2",
        userId: "U-thread-2",
        question: "second question",
        mode: respond.ALWAYS,
      });
      await Promise.resolve();
      assert.equal(calls, 1);
      assert.equal(client.posts.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(client.posts.filter((post: SlackPost) => post.text === reply.THINKING).length, 1);
      release.resolve();
      await Promise.all([first, second]);
      assert.equal(calls, 2);
      assert.equal(client.posts.filter((post: SlackPost) => post.text === reply.THINKING).length, 1);
    } finally {
      intent.classifyIntent = originalIntent;
      lookup.knownAnswer = originalKnown;
      lookup.answerOrChat = originalAnswer;
    }
  });
});

test("late stream text after lookup failure cannot create another placeholder", async () => {
  await withHelpProgram({ id: "late-stream" }, async (_programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const originalKnown = lookup.knownAnswer;
    const originalAnswer = lookup.answerOrChat;
    let lateText: ((text: string) => void) | null = null;
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    lookup.knownAnswer = async () => null;
    lookup.answerOrChat = async (_question: string, _prompt: string, options: { onText?: (text: string) => void }) => {
      lateText = options.onText || null;
      throw new Error("provider failed");
    };

    try {
      await assert.doesNotReject(() =>
        respond.respond({
          client,
          channel,
          threadTs: "late-stream-root",
          userId: "U-late-stream",
          question: "my board is broken",
          mode: respond.ALWAYS,
        }),
      );
      const postCount = client.posts.length;
      lateText?.("late answer");
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(client.posts.length, postCount);
    } finally {
      intent.classifyIntent = originalIntent;
      lookup.knownAnswer = originalKnown;
      lookup.answerOrChat = originalAnswer;
    }
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("answer generation throwing still leaves an open, usable ticket in the thread", async () => {
  const db = require("./db");
  const originalStream = answer.getAnswerOrChatStream;
  const originalIntent = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  answer.getAnswerOrChatStream = async (_q: string, _c: string, _ctx: string, { onText }: StreamOptions = {}) => {
    if (onText) onText("something partial");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    throw new Error("provider error");
  };

  await withHelpProgram({ id: "esc-throw" }, async (programId: string, channel: string) => {
    const client = richClient();
    try {
      const threadTs = "t-esc-throw";
      await respond.respond({
        client,
        channel,
        threadTs,
        userId: "U-esc-throw",
        question: "my pcb won't power on",
        mode: respond.ALWAYS,
      });

      const ticket = db.getTicketByThreadTs(threadTs);
      assert.ok(ticket, "the ticket is the reliable baseline — it exists even when answer generation throws");
      assert.ok(["open", "waiting_for_helper", "assigned"].includes(ticket.status));
      assert.match(client.posts.map((p: SlackPost) => p.text || "").join(" "), /Someone will be here to help you soon/);
    } finally {
      answer.getAnswerOrChatStream = originalStream;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("prevent public reasoning and instruction leak in respond()", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;

  intent.classifyIntent = async () => intent.CASUAL_CHAT;
  const restoreAnswers = stubAnswers(async () => ({
    source: null,
    answer:
      "<think>internal hidden reasoning</think>Safety Assessment: Safe.\n**Thinking Process:**\nHere is the real answer.",
  }));
  const restoreCache = stubNoCache();

  try {
    await respond.respond({
      client,
      channel: "C1",
      threadTs: "t-reasoning-leak",
      userId: "U-reasoning",
      question: "pixie explain this",
      mode: respond.ALWAYS,
    });

    const said = [...client.calls.posts, ...client.calls.updates].join(" ");
    assert.match(said, /Here is the real answer\./);
    assert.doesNotMatch(said, /internal hidden reasoning/);
    assert.doesNotMatch(said, /Safety Assessment/);
    assert.doesNotMatch(said, /Thinking Process/);
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
  }
});

test("the mute acknowledgement is branded with the resolved program's support identity", async () => {
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    {
      id: "branded-prog",
      name: "Branded",
      supportName: "Branded Help",
      helpChannel: "C-BRANDED",
      channels: ["C-BRANDED"],
    },
  ]);
  programs.invalidate();

  const posted: SlackPost[] = [];
  const client = {
    chat: {
      postMessage: async (payload: SlackPost) => {
        posted.push(payload);
        return { ts: "b-1" };
      },
    },
  };

  try {
    const handled = await respond.respond({
      client,
      channel: "C-BRANDED",
      threadTs: "t-brand-mute",
      userId: "U-brand",
      question: "stfu pixie",
      mode: respond.ALWAYS,
    });
    assert.equal(handled, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].username, "Branded Help", "the mute ack must carry this program's own support identity");
  } finally {
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

function withHelpProgram(
  overrides: Record<string, unknown> & { id?: string },
  fn: (programId: string, channel: string) => Promise<unknown>,
) {
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  const id = overrides.id || "ticket-prog";
  const defaultSources = [{ name: "Docs", type: "text", content: SAFE_SOURCE_TEXT }];
  const programConfig = {
    id,
    name: id,
    helpChannel: `C-${id}`,
    channels: [`C-${id}`],
    sources: defaultSources,
    ...overrides,
  };
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([programConfig]);
  programs.invalidate();
  for (const source of (programConfig.sources || []) as Array<{ name?: string; content?: unknown }>) {
    if (source.name) {
      const content = typeof source.content === "string" ? source.content : SAFE_SOURCE_TEXT;
      db.saveSourceText(knowledge.sourceCacheKey(source) || source.name, content);
    }
  }
  knowledge.invalidate();
  return Promise.resolve()
    .then(() => fn(id, `C-${id}`))
    .finally(() => {
      if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
      else process.env.PIXIE_PROGRAMS_JSON = saved;
      programs.invalidate();
      knowledge.invalidate();
    });
}

function richClient() {
  const posts: SlackPost[] = [];
  return {
    posts,
    chat: {
      postMessage: async (payload: SlackPost) => {
        posts.push(payload);
        return { ts: `msg-${posts.length}` };
      },
      update: async (payload: SlackPost) => {
        posts.push({ ...payload, isUpdate: true });
        return {};
      },
    },
    reactions: { add: async () => ({}) },
  };
}

test("HELP_ONLY rejects intent before answer generation and ticket creation", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "intent-first" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    let answerCalls = 0;
    lookup.answerOrChat = async () => {
      answerCalls += 1;
      return { source: "Docs", answer: "must not be used" };
    };
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-intent-first",
        userId: "U-intent-first",
        question: "just chatting about the project",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false);
      assert.equal(answerCalls, 0, "rejected support intent must not call answer generation");
      assert.equal(db.getTicketByThreadTs("t-intent-first"), null, "rejected support intent must not create a ticket");
      assert.deepEqual(client.posts, []);
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("chatter that clears the noise filter still selects no helper and opens no ticket", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "chatter-no-select", helperPing: true }, async (programId: string, channel: string) => {
    for (const chatter of ["lol what do u think", "wtf is happening", "hii everyone"]) {
      const client = richClient();
      const originalLookup = lookup.answerOrChat;
      const originalIntent = intent.classifyIntent;
      lookup.answerOrChat = async () => ({ source: "Docs", answer: "must not be used" });
      intent.classifyIntent = async () => intent.CASUAL_CHAT;
      try {
        const handled = await respond.respond({
          client,
          channel,
          threadTs: `t-chatter-${chatter.length}`,
          userId: "U-chatter",
          question: chatter,
          mode: respond.HELP_ONLY,
        });
        assert.equal(handled, false, chatter);
        assert.equal(db.getTicketByThreadTs(`t-chatter-${chatter.length}`), null, chatter);
        assert.deepEqual(client.posts, [], chatter);
      } finally {
        lookup.answerOrChat = originalLookup;
        intent.classifyIntent = originalIntent;
      }
    }
  });
});

test("grounded HELP_ONLY support still answers when tickets are disabled", async () => {
  const lookup = require("./lookup");
  await withHelpProgram(
    { id: "answers-no-tickets", ticketsEnabled: false },
    async (programId: string, channel: string) => {
      const client = richClient();
      const originalLookup = lookup.answerOrChat;
      const originalIntent = intent.classifyIntent;
      lookup.answerOrChat = async () => verifiedAnswer("Docs", "export as PNG at native size", programId);
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      try {
        const handled = await respond.respond({
          client,
          channel,
          threadTs: "t-no-tickets-grounded",
          userId: "U-no-tickets",
          question: "how do I export my sprite?",
          mode: respond.HELP_ONLY,
        });
        assert.equal(handled, true);
        assert.match(client.posts.map((p: SlackPost) => p.text || "").join(" "), /export as PNG/);
        assert.equal(db.getTicketByThreadTs("t-no-tickets-grounded"), null);
      } finally {
        lookup.answerOrChat = originalLookup;
        intent.classifyIntent = originalIntent;
      }
    },
  );
});

test("an accepted support question with no grounded answer waits on its ticket", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "no-grounding" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    lookup.answerOrChat = async () => ({ source: null, answer: "I am not sure" });
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-no-grounding",
        userId: "U-no-grounding",
        question: "my board will not power on, what should I check?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);
      assert.equal(db.getTicketByThreadTs("t-no-grounding").status, "waiting_for_helper");
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("persisted aiAnswers=false skips answer generation without disabling tickets", async () => {
  const lookup = require("./lookup");
  await withHelpProgram({ id: "answers-off", aiAnswers: false }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    let answerCalls = 0;
    lookup.answerOrChat = async () => {
      answerCalls += 1;
      return { source: "Docs", answer: "must not be used" };
    };
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-answers-off",
        userId: "U-answers-off",
        question: "how do I fix my board?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false);
      assert.equal(answerCalls, 0);
      assert.ok(db.getTicketByThreadTs("t-answers-off"), "ticketing remains enabled independently");
    } finally {
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("a grounded answer opens a ticket that stays OPEN with a Mark as resolved button; resolve then reopen then resolve works", async () => {
  const db = require("./db");
  const tickets = require("./tickets");
  await withHelpProgram({ id: "grounded" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-grounded-1",
        userId: "U-grounded",
        question: "how do I export my sprite?",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);

      const ticket = db.getTicketByThreadTs("t-grounded-1");
      assert.ok(ticket);
      assert.equal(ticket.status, "open", "answering never resolves or re-statuses the ticket");

      const uiMsg = client.posts.find((p: SlackPost) => /Someone will be here to help you soon/.test(p.text || ""));
      assert.ok(uiMsg, "the thread carries the open ticket UI");
      const resolveBtn = uiMsg?.blocks
        ?.find((b: SlackBlock) => b.type === "actions")
        ?.elements?.find((e: SlackElement) => e.action_id === "st_resolve");
      assert.ok(resolveBtn, "open state has one Mark as resolved button");

      const r1 = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(r1.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "resolved");
      assert.equal(db.getTicket(ticket.id).resolved_by, "U-grounded");
      const afterResolve = client.posts.filter((p: SlackPost) => p.isUpdate).at(-1);
      assert.match(
        afterResolve?.blocks?.map((b: SlackBlock) => JSON.stringify(b)).join(""),
        /Resolved by <@U-grounded>/,
      );
      assert.ok(
        afterResolve?.blocks
          ?.find((b: SlackBlock) => b.type === "actions")
          ?.elements?.find((e: SlackElement) => e.action_id === "st_reopen"),
        "resolved state swaps in a Reopen button",
      );
      assert.ok(
        !afterResolve?.blocks?.some((b: SlackBlock) =>
          (b.elements || []).some((e: SlackElement) => e.action_id === "st_resolve"),
        ),
        "no stale Mark as resolved button after resolve",
      );

      const ro = await tickets.publicReopenTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(ro.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "reopened");
      assert.equal(db.getTicket(ticket.id).reopen_count, 1);
      assert.match(client.posts.map((p: SlackPost) => p.text || "").join(" "), /Ticket reopened by <@U-grounded>/);

      const r2 = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-grounded", client });
      assert.equal(r2.ok, true);
      assert.equal(db.getTicket(ticket.id).status, "resolved");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("resolving twice records one transition and posts one confirmation; an unauthorized user cannot resolve", async () => {
  const db = require("./db");
  const tickets = require("./tickets");
  await withHelpProgram({ id: "dblresolve" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "ok" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-dbl-1",
        userId: "U-owner",
        question: "how do rewards work?",
        mode: respond.HELP_ONLY,
      });
      const ticket = db.getTicketByThreadTs("t-dbl-1");

      const stranger = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-random-nobody", client });
      assert.equal(stranger.error, "not_authorized");

      const first = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
      const second = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
      assert.equal(first.ok, true);
      assert.equal(second.deduped, true);
      const resolvedEvents = db
        .listTicketEvents(ticket.id)
        .filter((e: { event_type: string }) => e.event_type === "resolved");
      assert.equal(resolvedEvents.length, 1, "exactly one persisted resolved transition");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("escalation reuses the SAME ticket created for the question — never a second one — and specialist routing runs only there", async () => {
  const db = require("./db");
  await withHelpProgram(
    { id: "escreuse", autoAssign: true, organizerChannel: "C-escreuse-org" },
    async (programId: string, channel: string) => {
      const client = richClient();
      const originalIntent = intent.classifyIntent;
      const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
      const restoreCache = stubNoCache();
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      require("./db").syncHelper({ programId, userId: "U-SPECIALIST", source: "manual" });
      try {
        const handled = await respond.respond({
          client,
          channel,
          threadTs: "t-escreuse-1",
          userId: "U-escreuse",
          question: "my board never powers on",
          mode: respond.HELP_ONLY,
        });
        assert.equal(handled, true);

        const allTickets = db.handle().query("SELECT * FROM tickets WHERE channel = ?").all(channel);
        assert.equal(allTickets.length, 1, "exactly one ticket for this thread, not two");
        assert.equal(
          allTickets[0].assignee_id,
          "U-SPECIALIST",
          "specialist routing runs once escalation actually happens",
        );
        assert.equal(allTickets[0].status, "assigned", "auto-assign advances waiting_for_helper straight to assigned");
      } finally {
        restoreAnswers();
        restoreCache();
        intent.classifyIntent = originalIntent;
      }
    },
  );
});

function answerText(client: { posts: SlackPost[] }) {
  const isTicketUI = (p: SlackPost) =>
    /Someone will be here to help you soon|Resolved by|Ticket reopened/i.test(p.text || "") ||
    (p.blocks || []).some((b: SlackBlock) =>
      (b.elements || []).some((e: SlackElement) => /^st_/.test(e.action_id || "")),
    );
  const real = client.posts.filter((p: SlackPost) => p.text !== "_thinking..._" && !isTicketUI(p));
  const post =
    real.find((p: SlackPost) => (p.blocks || []).some((b: SlackBlock) => b.type === "section")) || real[0] || {};
  const section = (post.blocks || []).find((b: SlackBlock) => b.type === "section");
  return (section && section.text && section.text.text) || post.text || "";
}

test("a program's reply signature ends its genuine answers (grounded and conversational)", async () => {
  const SIG = "stay helpful :signal:";

  await withHelpProgram({ id: "hw-sig-grounded", replySignature: SIG }, async (programId: string, channel: string) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "Tier 2 needs a testbench." }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-hwsig-1",
        userId: "U1",
        question: "does tier 2 need a testbench?",
        mode: respond.HELP_ONLY,
      });
      assert.ok(
        answerText(client).trimEnd().endsWith(SIG),
        `grounded answer must end with the signature: ${answerText(client)}`,
      );
    } finally {
      restoreAnswers();
      intent.classifyIntent = oi;
    }
  });

  await withHelpProgram({ id: "hw-sig-chat", replySignature: SIG }, async (programId: string, channel: string) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    const restoreAnswers = stubAnswers(async () => ({
      source: null,
      answer: "yeah the iCE40 board handles that fine",
    }));
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-hwsig-2",
        userId: "U2",
        question: "mr.wire can i use the ice40 board for this",
        mode: respond.ALWAYS,
      });
      assert.ok(
        answerText(client).trimEnd().endsWith(SIG),
        `conversational answer must end with the signature: ${answerText(client)}`,
      );
    } finally {
      restoreAnswers();
      intent.classifyIntent = oi;
    }
  });
});

test("the reply signature is never stapled to a fallback or an escalation acknowledgement", async () => {
  const SIG = "stay helpful :signal:";

  await withHelpProgram({ id: "hw-sig-fb", replySignature: SIG }, async (programId: string, channel: string) => {
    const client = richClient();
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
    const restoreCache = stubNoCache();
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-hwsig-3",
        userId: "U3",
        question: "mr.wire???",
        mode: respond.ALWAYS,
      });
      assert.ok(
        !answerText(client).includes("stay helpful"),
        "the human-defer fallback must not carry the catchphrase",
      );
    } finally {
      restoreAnswers();
      restoreCache();
    }
  });

  await withHelpProgram(
    { id: "hw-sig-esc", replySignature: SIG, organizerChannel: "C-hw-sig-esc-org" },
    async (programId: string, channel: string) => {
      const client = richClient();
      const oi = intent.classifyIntent;
      const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "", unclear: true }));
      const restoreCache = stubNoCache();
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      try {
        await respond.respond({
          client,
          channel,
          threadTs: "t-hwsig-4",
          userId: "U4",
          question: "my board is bricked and my deadline is tonight",
          mode: respond.HELP_ONLY,
        });
        const everything = client.posts
          .map(
            (p: SlackPost) =>
              (p.text || "") +
              " " +
              (p.blocks || [])
                .map(
                  (b: SlackBlock) =>
                    (b.text && b.text.text) || (b.elements || []).map((e: SlackElement) => e.text || "").join(" "),
                )
                .join(" "),
          )
          .join("\n");
        assert.ok(!everything.includes("stay helpful"), `escalation must stay serious, no catchphrase:\n${everything}`);
      } finally {
        restoreAnswers();
        restoreCache();
        intent.classifyIntent = oi;
      }
    },
  );
});

test("reply signature stays scoped to its program — an unsigned program never inherits it", async () => {
  await withHelpProgram({ id: "acme-unsigned" }, async (programId: string, channel: string) => {
    const client = richClient();
    const oi = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-acme-u1",
        userId: "U5",
        question: "how do I export my sprite?",
        mode: respond.HELP_ONLY,
      });
      const body = answerText(client);
      assert.ok(
        !body.includes("stay helpful") && !body.includes(":signal:"),
        `unsigned program must not inherit another program's catchphrase: ${body}`,
      );
    } finally {
      restoreAnswers();
      intent.classifyIntent = oi;
    }
  });
});

test("chatter addressed in a help channel gets a conversational reply but opens no ticket", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "chatter" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "haha yeah" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-chatter-1",
        userId: "U-chatter",
        question: "sam are you coming to the call?",
        mode: respond.ALWAYS,
      });
      assert.equal(handled, true);
      const ticket = db.getTicketByThreadTs("t-chatter-1");
      assert.equal(ticket, null, "chatter is not a support request, so no ticket");
      assert.match(client.posts.map((p: SlackPost) => p.text || "").join(" "), /haha yeah/);
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("an off-topic question in a program scoped to itself stays silent and creates no ticket", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "scoped", name: "Scoped", scope: "program", channels: ["C-scoped"] },
  ]);
  programs.invalidate();
  const client = richClient();
  const originalIntent = intent.classifyIntent;
  const originalAnswer = answer.getAnswerOrChatStream;
  intent.classifyIntent = async () => intent.OFF_TOPIC;
  answer.getAnswerOrChatStream = async () => ({ source: null, answer: "" });
  try {
    const handled = await respond.respond({
      client,
      channel: "C-scoped",
      threadTs: "t-offtopic-1",
      userId: "U-offtopic",
      question: "what's the capital of France",
      mode: respond.HELP_ONLY,
    });
    assert.equal(handled, false);
    assert.equal(db.getTicketByThreadTs("t-offtopic-1"), null);
  } finally {
    intent.classifyIntent = originalIntent;
    answer.getAnswerOrChatStream = originalAnswer;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("two tenants asking the identical question in their own help channels get separate, tenant-scoped tickets", async () => {
  const db = require("./db");
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "tenant-a", name: "TenantA", helpChannel: "C-tenant-a", channels: ["C-tenant-a"] },
    { id: "tenant-b", name: "TenantB", helpChannel: "C-tenant-b", channels: ["C-tenant-b"] },
  ]);
  programs.invalidate();
  const client = richClient();
  const originalIntent = intent.classifyIntent;
  const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "same answer for everyone" }));
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await respond.respond({
      client,
      channel: "C-tenant-a",
      threadTs: "t-tenant-a-1",
      userId: "U-a",
      question: "how do reimbursements work?",
      mode: respond.HELP_ONLY,
    });
    await respond.respond({
      client,
      channel: "C-tenant-b",
      threadTs: "t-tenant-b-1",
      userId: "U-b",
      question: "how do reimbursements work?",
      mode: respond.HELP_ONLY,
    });

    const ticketA = db.getTicketByThreadTs("t-tenant-a-1");
    const ticketB = db.getTicketByThreadTs("t-tenant-b-1");
    assert.ok(ticketA);
    assert.ok(ticketB);
    assert.notEqual(ticketA.id, ticketB.id);
    assert.equal(ticketA.program_id, "tenant-a");
    assert.equal(ticketB.program_id, "tenant-b");
  } finally {
    restoreAnswers();
    intent.classifyIntent = originalIntent;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("public_tickets_enabled=false: Pixie still answers, but no ticket is created", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "notix", publicTicketsEnabled: false }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "still answering" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-notix-1",
        userId: "U-notix",
        question: "how do I get started",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true);
      assert.equal(client.posts.length, 1, "pixie still replies");
      assert.equal(db.getTicketByThreadTs("t-notix-1"), null, "no ticket when public tickets are off");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("public_tickets_enabled=true (default): a same-thread follow-up reuses the existing ticket rather than opening a second one", async () => {
  const db = require("./db");
  await withHelpProgram({ id: "dedupe" }, async (programId: string, channel: string) => {
    const client = richClient();
    const originalIntent = intent.classifyIntent;
    let answerText = "first answer";
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: answerText }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      await respond.respond({
        client,
        channel,
        threadTs: "t-dedupe-1",
        userId: "U-dedupe",
        question: "my board won't boot up at all",
        mode: respond.HELP_ONLY,
      });
      const first = db.getTicketByThreadTs("t-dedupe-1");
      assert.ok(first);

      answerText = "a follow-up clarifying answer";
      await respond.respond({
        client,
        channel,
        threadTs: "t-dedupe-1",
        userId: "U-dedupe",
        question: "what if I'm on a team?",
        mode: respond.HELP_ONLY,
      });

      const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-dedupe-1");
      assert.equal(rows.length, 1, "the same thread must never produce a second ticket");
      assert.equal(rows[0].id, first.id);
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("HELP_ONLY answers HELP_NEEDED, drops on CASUAL_CHAT", async () => {
  await withHelpProgram({ id: "chargate" }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    try {
      let restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "held answer text" }));
      intent.classifyIntent = async () => intent.HELP_NEEDED;
      const clientOk = richClient();
      const handledOk = await respond.respond({
        client: clientOk,
        channel,
        threadTs: "t-char-hold-1",
        userId: "U-char-hold",
        question: "how do i submit my project",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handledOk, true);
      assert.ok(clientOk.posts.length >= 1);
      assert.ok(clientOk.posts.some((p: SlackPost) => /held answer text/.test(p.text || "")));
      assert.ok(db.getTicketByThreadTs("t-char-hold-1"), "an engaged help question opens a ticket");
      restoreAnswers();

      restoreAnswers = stubAnswers(async () => ({ source: null, answer: "should never surface" }));
      intent.classifyIntent = async () => intent.CASUAL_CHAT;
      const clientDrop = richClient();
      const handledDrop = await respond.respond({
        client: clientDrop,
        channel,
        threadTs: "t-char-drop-1",
        userId: "U-char-drop",
        question: "lol that game was wild",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handledDrop, false, "CASUAL_CHAT still suppresses Pixie's reply");
      assert.equal(db.getTicketByThreadTs("t-char-drop-1"), null, "casual chatter must not become a ticket");
      assert.ok(
        !clientDrop.posts.some((p: SlackPost) => /should never surface/.test(p.text || "")),
        "the dropped answer never surfaces",
      );
      restoreAnswers();
    } finally {
      intent.classifyIntent = originalIntent;
    }
  });
});

test("HELP_ONLY classifier failure still tickets, and answers when grounded", async () => {
  await withHelpProgram({ id: "charnull" }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "a docs answer" }));
    const restoreCache = stubNoCache();
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-char-null-1",
        userId: "U-char-null",
        question: "how do i submit",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true, "a classifier outage must not swallow a help support request");
      assert.ok(db.getTicketByThreadTs("t-char-null-1"), "the ticket path needs no AI");
      assert.ok(
        client.posts.some((p: SlackPost) => /a docs answer/.test(p.text || "")),
        "a grounded answer still posts",
      );
    } finally {
      restoreAnswers();
      restoreCache();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("a program help channel still attempts its owned answer when intent classification fails", async () => {
  await withHelpProgram(
    {
      id: "owned-program",
      name: "Owned Program",
      sources: [{ name: "Owned Program Docs", type: "text", content: "Owned program answer" }],
    },
    async (_programId: string, channel: string) => {
      const originalAnswer = answer.getAnswerOrChat;
      const originalIntent = intent.classifyIntent;
      let answerCalled = false;
      answer.getAnswerOrChat = async () => {
        answerCalled = true;
        return { source: "Owned Program Docs", answer: "Owned program answer" };
      };
      intent.classifyIntent = async () => null;
      try {
        const client = richClient();
        const handled = await respond.respond({
          client,
          channel,
          threadTs: "t-owned-null-1",
          userId: "U-owned-null",
          question: "what is this program",
          mode: respond.HELP_ONLY,
        });
        assert.equal(handled, true);
        assert.equal(answerCalled, true);
      } finally {
        answer.getAnswerOrChat = originalAnswer;
        intent.classifyIntent = originalIntent;
      }
    },
  );
});

test("OFF_TOPIC in a help channel stays silent", async () => {
  await withHelpProgram({ id: "charoff", scope: "program" }, async (programId: string, channel: string) => {
    const original = answer.getAnswerOrChatStream;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => ({
      source: null,
      answer: "that one belongs to another program, try their channel",
    });
    intent.classifyIntent = async () => intent.OFF_TOPIC;
    try {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-char-off-1",
        userId: "U-char-off",
        question: "what is the deadline for some other program",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false, "OFF_TOPIC must not become an unsolicited answer");
    } finally {
      answer.getAnswerOrChatStream = original;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("ALWAYS replies conversationally to chatter without opening a ticket", async () => {
  await withHelpProgram({ id: "charworthy" }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "haha yeah" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-char-worthy-1",
        userId: "U-char-worthy",
        question: "sam are you coming to the call?",
        mode: respond.ALWAYS,
      });
      assert.equal(handled, true, "ALWAYS mode always replies");
      assert.equal(
        db.getTicketByThreadTs("t-char-worthy-1"),
        null,
        "chatter is a general reply, not a support request",
      );
      assert.ok(client.posts.some((p: SlackPost) => /haha yeah/.test(p.text || "")));
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("chatter addressed at pixie opens no ticket; a real support question still does", async () => {
  await withHelpProgram({ id: "charground" }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "export as PNG at native size" }));
    intent.classifyIntent = async () => intent.CASUAL_CHAT;
    try {
      const client = richClient();
      await respond.respond({
        client,
        channel,
        threadTs: "t-char-ground-2",
        userId: "U-char-g2",
        question: "png export lol",
        mode: respond.ALWAYS,
      });
      assert.equal(db.getTicketByThreadTs("t-char-ground-2"), null, "addressed chatter is general chat, not a ticket");

      intent.classifyIntent = async () => intent.HELP_NEEDED;
      const client2 = richClient();
      await respond.respond({
        client: client2,
        channel,
        threadTs: "t-char-ground-3",
        userId: "U-char-g3",
        question: "how do i export my sprite",
        mode: respond.ALWAYS,
      });
      const ticket = db.getTicketByThreadTs("t-char-ground-3");
      assert.ok(ticket);
      assert.equal(ticket.status, "open");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("shadow program evaluates but posts nothing publicly", async () => {
  await withHelpProgram({ id: "charshadow", shadowMode: true }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    const restoreAnswers = stubAnswers(async () => ({ source: "Docs", answer: "a grounded answer" }));
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const client = richClient();
      await respond.respond({
        client,
        channel,
        threadTs: "t-char-shadow-1",
        userId: "U-char-shadow",
        question: "how do i submit",
        mode: respond.HELP_ONLY,
      });
      assert.equal(client.posts.length, 0, "shadow mode sends nothing publicly");
      assert.equal(db.getTicketByThreadTs("t-char-shadow-1"), null, "shadow mode files no ticket");
    } finally {
      restoreAnswers();
      intent.classifyIntent = originalIntent;
    }
  });
});

test("sensitive match escalates with zero model calls", async () => {
  const elig = require("./eligibility");
  const tickets = require("./tickets");
  const originalSensitive = elig.sensitiveHit;
  const originalEscalate = tickets.escalateTicket;
  const originalStream = answer.getAnswerOrChatStream;
  let modelCalls = 0;
  let escalated = false;
  elig.sensitiveHit = () => true;
  tickets.escalateTicket = async () => {
    escalated = true;
    return { id: 9999 };
  };
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Docs", answer: "must not happen" };
  };
  try {
    const client = richClient();
    await respond.respond({
      client,
      channel: "C-char-sens",
      threadTs: "t-char-sens-1",
      userId: "U-char-sens",
      question: "anything at all",
      mode: respond.ALWAYS,
    });
    assert.equal(modelCalls, 0, "defense-in-depth: no model call on sensitive");
    assert.equal(escalated, true, "sensitive files a ticket via escalateTicket");
  } finally {
    elig.sensitiveHit = originalSensitive;
    tickets.escalateTicket = originalEscalate;
    answer.getAnswerOrChatStream = originalStream;
  }
});

test("accepted support with model outage files a ticket and stays quiet", async () => {
  await withHelpProgram({ id: "charoutage" }, async (programId: string, channel: string) => {
    const original = answer.getAnswerOrChatStream;
    const originalLookup = lookup.answerOrChat;
    const originalIntent = intent.classifyIntent;
    answer.getAnswerOrChatStream = async () => {
      throw new Error("every provider is down");
    };
    lookup.answerOrChat = async () => {
      throw new Error("every provider is down");
    };
    intent.classifyIntent = async () => intent.HELP_NEEDED;
    try {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-char-outage-1",
        userId: "U-char-outage",
        question: "how do i submit my project",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, false, "outage in help: ticket filed, no AI reply");
      assert.ok(db.getTicketByThreadTs("t-char-outage-1"), "outage must not swallow the support request");
    } finally {
      answer.getAnswerOrChatStream = original;
      lookup.answerOrChat = originalLookup;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("HELP_ONLY suppresses hand-back clarification questions outside help", async () => {
  const originalIntent = intent.classifyIntent;
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([{ id: "charhand", name: "charhand", channels: ["C-charhand"] }]);
  programs.invalidate();
  const restoreAnswers = stubAnswers(async () => ({ source: null, answer: "sorry, what do you mean?" }));
  const restoreCache = stubNoCache();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    const client = richClient();
    const handled = await respond.respond({
      client,
      channel: "C-charhand",
      threadTs: "t-char-hand-1",
      userId: "U-char-hand",
      question: "eh how do i do this",
      mode: respond.HELP_ONLY,
    });
    assert.equal(handled, false, "hand-back clarification stays quiet when unaddressed");
    assert.deepEqual(client.posts, [], "an ungrounded ambient answer is never posted");
  } finally {
    restoreAnswers();
    restoreCache();
    intent.classifyIntent = originalIntent;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
});

test("ASKS_WHAT_THEY_MEAN regex stays as backstop + MAX_CLARIFY_WORDS bound", () => {
  assert.equal(respond.isClarifyingQuestion("what do you mean?"), true);
  assert.equal(respond.isClarifyingQuestion("could you clarify what you mean"), true);
  const longReal =
    "check your canvas size is small, 32x32 or 16x16, and that you are exporting as PNG at native size without scaling it up because the file extension matters too for the reviewer pipeline. does that sort it for your sprite workflow today?";
  assert.equal(respond.isClarifyingQuestion(longReal), false);
});

test("answerOrChat is the single call shared by the mention path and --ask", () => {
  assert.equal(respond.answerOrChat, lookup.answerOrChat, "--ask must print what Slack would get");
});

test("cache serves a grounded answer in help even when the classifier failed", async () => {
  await withHelpProgram({ id: "charcache" }, async (programId: string, channel: string) => {
    const originalIntent = intent.classifyIntent;
    const originalKnown = lookup.knownAnswer;
    lookup.knownAnswer = () => verifiedAnswer("Docs", "cached answer here", programId);
    intent.classifyIntent = async () => null;
    try {
      const client = richClient();
      const handled = await respond.respond({
        client,
        channel,
        threadTs: "t-char-cache-1",
        userId: "U-char-cache",
        question: "cached question here",
        mode: respond.HELP_ONLY,
      });
      assert.equal(handled, true, "a grounded cached answer still serves the help request");
      assert.ok(db.getTicketByThreadTs("t-char-cache-1"), "the ticket path needs no AI");
      assert.ok(client.posts.some((p: SlackPost) => /cached answer here/.test(p.text || "")));
    } finally {
      lookup.knownAnswer = originalKnown;
      intent.classifyIntent = originalIntent;
    }
  });
});

test("active incidents bypass cache and model work, stay tenant-scoped, and stop after resolution", async () => {
  const incidents = require("./incidents");
  const originalKnown = lookup.knownAnswer;
  const originalPlain = answer.getAnswerOrChat;
  const originalStream = answer.getAnswerOrChatStream;
  let cacheCalls = 0;
  let modelCalls = 0;
  lookup.knownAnswer = () => {
    cacheCalls += 1;
    return verifiedAnswer("Docs", "cached answer", "incident-respond");
  };
  answer.getAnswerOrChat = async () => {
    modelCalls += 1;
    return { source: "Docs", answer: "model answer" };
  };
  answer.getAnswerOrChatStream = async () => {
    modelCalls += 1;
    return { source: "Docs", answer: "model answer" };
  };
  try {
    await withHelpProgram({ id: "incident-respond" }, async (programId: string, channel: string) => {
      const created = incidents.createIncident({
        programId,
        title: "Acme site is currently down",
        description: "People cannot access the website",
        publicMessage: "Heads up — the Acme site is currently down; the team is on it.",
        actorId: "U-organizer",
      });
      const client = richClient();
      assert.equal(
        await respond.respond({
          client,
          channel,
          threadTs: "t-incident-1",
          userId: "U-1",
          question: "acme won't load",
          mode: respond.HELP_ONLY,
        }),
        true,
      );
      assert.equal(
        await respond.respond({
          client,
          channel,
          threadTs: "t-incident-2",
          userId: "U-2",
          question: "cant open the website",
          mode: respond.HELP_ONLY,
        }),
        true,
      );
      assert.equal(cacheCalls, 0);
      assert.equal(modelCalls, 0);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(
        client.posts.filter((post: SlackPost) => /Acme site is currently down/.test(post.text || "")).length,
        2,
      );

      await respond.respond({
        client,
        channel,
        threadTs: "t-incident-unrelated",
        userId: "U-3",
        question: "when does review finish?",
        mode: respond.HELP_ONLY,
      });
      const unrelatedPost = client.posts.at(-1);
      if (!unrelatedPost?.text) throw new Error("cached answer post was not created");
      assert.equal(unrelatedPost.text.includes("cached answer"), true);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(cacheCalls, 1);

      incidents.setIncidentStatus({ incidentId: created.incident.id, status: "resolved", actorId: "U-organizer" });
      await respond.respond({
        client,
        channel,
        threadTs: "t-incident-resolved",
        userId: "U-4",
        question: "is the site down?",
        mode: respond.HELP_ONLY,
      });
      const resolvedPost = client.posts.at(-1);
      if (!resolvedPost?.text) throw new Error("cached answer post was not created after resolution");
      assert.equal(resolvedPost.text.includes("cached answer"), true);
      assert.equal(incidents.affectedReports(created.incident.id).length, 2);
      assert.equal(cacheCalls, 2);
      assert.equal(modelCalls, 0);
    });
  } finally {
    lookup.knownAnswer = originalKnown;
    answer.getAnswerOrChat = originalPlain;
    answer.getAnswerOrChatStream = originalStream;
  }
});
export {};

test("a link fetch failing after the placeholder appears deletes it and stops the spinner", async () => {
  const client = fakeClient();
  const originalIntent = intent.classifyIntent;
  const originalFetch = link.fetchUrlContent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  link.fetchUrlContent = async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    throw new Error("fetch exploded");
  };
  try {
    await assert.doesNotReject(() =>
      respond.respond({
        client,
        channel: "C1",
        threadTs: "t-link-fail",
        userId: "U-link-fail",
        question: "pixie, what does https://example.com/page say about export?",
        mode: respond.ALWAYS,
      }),
    );
    assert.ok(client.calls.posts.includes(reply.THINKING), "the placeholder was posted");
    assert.equal(client.calls.deletes, 1, "the placeholder was deleted");
    const updates = client.calls.updates.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(client.calls.updates.length, updates, "no spinner updates after the failed turn");
  } finally {
    intent.classifyIntent = originalIntent;
    link.fetchUrlContent = originalFetch;
  }
});
