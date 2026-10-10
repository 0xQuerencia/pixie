process.env.PIXIE_DB_PATH = ":memory:";

const { test, expect, beforeEach, beforeAll, afterAll } = require("bun:test");

const ACME = {
  id: "acme",
  name: "Acme",
  scope: "program",
  helpChannel: "C_ACME_HELP",
  organizerChannel: "C_ACME_ORG",
  channels: ["C_ACME_HELP", "C_ACME_MAIN", "C_ACME_ORG"],
  ticketsEnabled: true,
  helperPing: true,
};
const BETA = {
  id: "beta",
  name: "Beta Program",
  scope: "program",
  helpChannel: "C_BETA_HELP",
  channels: ["C_BETA_HELP", "C_BETA_MAIN"],
};

const db = require("../db");
const programs = require("../programs");
const jevDecision = require("../jevDecision");
const lookup = require("../lookup");
const tickets = require("../tickets");
const context = require("../context");
const respond = require("../respond");
const claimVerifier = require("../claimVerifier");

type TestRecord = Record<string, unknown>;
type TestMessage = TestRecord & { text?: string; ts?: string };
type DecisionArgs = TestRecord & { message: string; conversationContext: string };
type ProgramOverride = { acme?: TestRecord; beta?: TestRecord };
type SendArgs = {
  channel: string;
  text: string;
  addressed?: boolean;
  threadTs?: string | null;
  messageTs?: string | null;
  seedClient?: unknown;
};
type MatrixWant = {
  spoke?: boolean;
  ticket?: number;
  handoff?: number;
  answer?: number;
  jev?: number;
  text?: RegExp;
};

let savedEnv: string | undefined;
const saved: Record<string, [Record<string, unknown>, unknown]> = {};
function stub(obj: object, key: string, value: unknown) {
  const target = obj as Record<string, unknown>;
  if (!(key in saved)) saved[key] = [target, target[key]];
  target[key] = value;
}

const JEV: Record<string, { action: string; intent: string }> = {
  "what is restoration energy?": { action: "engage", intent: "direct_program_question" },
  "what is acme?": { action: "engage", intent: "direct_program_question" },
  "lmao gg": { action: "silence", intent: "unrelated_chatter" },
  "did you finish your game?": { action: "silence", intent: "human_conversation" },
  "does the hardware grant cover shipping?": { action: "engage", intent: "direct_program_question" },
  "what is my exact payout amount right now?": { action: "engage", intent: "direct_program_question" },
  "what is the exact maximum percentage of ai code allowed?": { action: "engage", intent: "direct_program_question" },
  "how do i do this": { action: "silence", intent: "ambiguous_followup" },
  "give me a chocolate chip cookie recipe": { action: "engage", intent: "addressed_general_request" },
  "my submission got rejected, how do i resubmit?": { action: "engage", intent: "support_question" },
  "how do i get my personal grant code?": { action: "engage", intent: "support_question" },
  "@ricky if you had to save @pixie or @pixorpheus who would you save?": {
    action: "silence",
    intent: "human_conversation",
  },
};

const ACME_DOCS =
  "Restoration Energy is what you earn by restoring pixels. Acme is a YSWS for pixel art games. Fix the notes and resubmit from your dashboard.";

function verifiedAnswer(answer: string | null, source: string | null, programId: string) {
  if (!answer || !source) {
    return {
      answer,
      source,
      unclear: true,
      verification: claimVerifier.verifyAnswerSync({ programId, answer: answer || "", evidence: [] }),
    };
  }
  const evidence = [
    {
      id: "acme-docs",
      programId,
      sourceName: "Acme Docs",
      text: ACME_DOCS,
      authority: "source",
      kind: "source",
    },
  ];
  return {
    answer,
    source,
    evidence,
    verification: claimVerifier.verifyAnswerSync({ programId, answer, evidence }),
  };
}

function fakeAnswer(question: string, program: { id?: string } | null | undefined) {
  const q = question.toLowerCase();
  const programId = program?.id || "shared";
  if (q.includes("restoration energy") && program?.id === "acme") {
    return verifiedAnswer("Restoration Energy is what you earn by restoring pixels.", "Acme Docs", programId);
  }
  if (q === "what is acme?" && program?.id === "acme")
    return verifiedAnswer("Acme is a YSWS for pixel art games.", "Acme Docs", programId);
  if (q.includes("resubmit") && program?.id === "acme")
    return verifiedAnswer("Fix the notes and resubmit from your dashboard.", "Acme Docs", programId);
  if (q.includes("pixorpheus")) return verifiedAnswer("Me, obviously. Pixorpheus can swim.", "NONE", programId);
  if (q.includes("cookie"))
    return verifiedAnswer("Cream butter and sugar, add chips, bake at 180C.", "NONE", programId);
  return verifiedAnswer(null, null, programId);
}

let posts: TestMessage[];
let ticketCalls: TestRecord[];
let handOffs: TestRecord[];
let jevCalls: DecisionArgs[];
let answerCalls: TestRecord[];
let jevMode: string;

function client() {
  return {
    chat: {
      postMessage: async (msg: TestMessage) => {
        posts.push(msg);
        return { ok: true, ts: `p${posts.length}` };
      },
      update: async (msg: TestMessage) => {
        posts.push({ ...msg, updated: true });
        return { ok: true, ts: msg.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }) },
    conversations: {
      replies: async (_args?: TestRecord) => ({ messages: [] as TestMessage[] }),
      history: async (_args?: TestRecord) => ({ messages: [] as TestMessage[] }),
    },
  };
}

beforeAll(() => {
  savedEnv = process.env.PIXIE_PROGRAMS_JSON;
  db.open(":memory:");
});

afterAll(() => {
  for (const [key, [obj, value]] of Object.entries(saved)) obj[key] = value;
  if (savedEnv === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedEnv;
  programs.invalidate();
});

function configure(overrides: ProgramOverride = {}) {
  const acme = { ...ACME, ...(overrides.acme || {}) };
  const beta = { ...BETA, ...(overrides.beta || {}) };
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([acme, beta]);
  programs.invalidate();
}

beforeEach(() => {
  configure();
  posts = [];
  ticketCalls = [];
  handOffs = [];
  jevCalls = [];
  answerCalls = [];
  jevMode = "script";
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    if (jevMode === "error") return { action: "error", errorKind: "timeout" };
    const hit = JEV[String(args.message).toLowerCase()];
    return hit ? { ...hit } : { action: "silence", intent: "unrelated_chatter" };
  });
  stub(lookup, "knownAnswer", () => null);
  stub(
    lookup,
    "answerOrChat",
    async (question: string, _ctx: string, opts: { program?: { id?: string }; allowWebSearch?: boolean }) => {
      answerCalls.push({ question, program: opts.program?.id, allowWebSearch: opts.allowWebSearch });
      return fakeAnswer(question, opts.program);
    },
  );
  stub(tickets, "ensureSupportTicket", async (args: TestRecord) => {
    ticketCalls.push(args);
    return { id: ticketCalls.length, status: "open" };
  });
  stub(tickets, "handOffToHelper", async (args: TestRecord) => {
    handOffs.push(args);
  });
  stub(tickets, "escalateTicket", async (args: TestRecord) => {
    handOffs.push({ ...args, sensitive: true });
  });
  stub(context, "seedFromSlack", async () => {});
});

let seq = 0;
async function send({
  channel,
  text,
  addressed = false,
  threadTs = null,
  messageTs = null,
  seedClient = null,
}: SendArgs) {
  seq += 1;
  const ts = messageTs || `${1000 + seq}.000`;
  return respond.respond({
    client: client(),
    channel,
    threadTs: threadTs || ts,
    messageTs: ts,
    userId: `U_REQ_${seq}`,
    question: text,
    mode: addressed ? respond.ALWAYS : respond.HELP_ONLY,
    addressed,
    seedClient,
  });
}

const postedText = () => posts.map((p: TestMessage) => p.text || "").join("\n");

test("main ambient: a Acme program question is classified, retrieved and answered", async () => {
  const spoke = await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" });
  expect(spoke).toBe(true);
  expect(jevCalls).toHaveLength(1);
  expect(jevCalls[0].channelPosture).toBe("main");
  expect(answerCalls[0].program).toBe("acme");
  expect(postedText()).toContain("Restoration Energy");
  expect(ticketCalls).toHaveLength(0);
});

test("main ambient: 'what is acme?' answers from Acme knowledge", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is acme?" })).toBe(true);
  expect(postedText()).toContain("Acme is a YSWS");
});

test("main ambient: another program's channel never reaches Acme sources", async () => {
  const spoke = await send({ channel: "C_BETA_MAIN", text: "what is restoration energy?" });
  expect(answerCalls[0].program).toBe("beta");
  expect(spoke).toBe(false);
  expect(posts).toHaveLength(0);
});

for (const chatter of ["lmao gg", "did you finish your game?"]) {
  test(`main ambient: '${chatter}' stays silent with no retrieval, no ticket`, async () => {
    expect(await send({ channel: "C_ACME_MAIN", text: chatter })).toBe(false);
    expect(answerCalls).toHaveLength(0);
    expect(ticketCalls).toHaveLength(0);
    expect(handOffs).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
}

test("main ambient: unsupported shipping question stays silent", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "does the hardware grant cover shipping?" })).toBe(false);
  expect(answerCalls).toHaveLength(1);
  expect(posts).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
});

test("main ambient: exact payout is never fabricated — silence", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is my exact payout amount right now?" })).toBe(false);
  expect(posts).toHaveLength(0);
});

test("main ambient: exact AI-code percentage without evidence — silence, no number", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is the exact maximum percentage of AI code allowed?" })).toBe(
    false,
  );
  expect(postedText()).not.toMatch(/\d+\s*%/);
});

test("main ambient: 'how do i do this' with no referent stays silent", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "how do i do this" })).toBe(false);
  expect(answerCalls).toHaveLength(0);
});

test("main ambient: 'how do i do this' with a clear thread referent retrieves and answers", async () => {
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return /restoration energy/i.test(args.conversationContext)
      ? { action: "engage", intent: "ambiguous_followup" }
      : { action: "silence", intent: "ambiguous_followup" };
  });
  stub(lookup, "answerOrChat", async (question: string, ctx: string, opts: { program?: { id?: string } }) => {
    answerCalls.push({ question, program: opts.program?.id });
    return /restoration energy/i.test(ctx)
      ? verifiedAnswer("Restore pixels in the editor to earn it.", "Acme Docs", opts.program?.id || "acme")
      : { unclear: true };
  });
  context.addToThread("9000.000", "user", "what is restoration energy?", "U1", "C_ACME_MAIN");
  const spoke = await send({
    channel: "C_ACME_MAIN",
    text: "how do i do this",
    threadTs: "9000.000",
    messageTs: "9000.100",
  });
  expect(jevCalls[0].conversationContext).toMatch(/restoration energy/i);
  expect(spoke).toBe(true);
  expect(postedText()).toContain("Restore pixels");
});

test("main ambient: a top-level fragment is classified with the channel's last messages", async () => {
  const historyCalls: TestRecord[] = [];
  const slack = client();
  slack.conversations.history = async (args?: TestRecord) => {
    historyCalls.push(args || {});
    return {
      messages: [
        { user: "U_OTHER", text: "yo is your hackatime streak still going?", ts: "1.3" },
        { user: "U_OTHER", text: "mine's broken lol", ts: "1.2" },
        { user: "U_OLD", text: "gm", ts: "1.1" },
      ],
    };
  };
  stub(jevDecision, "evaluateSupportDecision", async (args: DecisionArgs) => {
    jevCalls.push(args);
    return /streak/i.test(args.conversationContext)
      ? { action: "silence", intent: "human_conversation" }
      : { action: "engage", intent: "direct_program_question" };
  });
  const spoke = await send({ channel: "C_ACME_MAIN", text: "it expires tomorrow", seedClient: slack });
  expect(historyCalls[0]).toMatchObject({ channel: "C_ACME_MAIN", limit: 5, inclusive: false });
  expect(jevCalls[0].conversationContext).toMatch(
    /other member: gm\nother member: mine's broken lol\nother member: yo is your hackatime streak/,
  );
  expect(spoke).toBe(false);
  expect(answerCalls).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("a threaded reply uses its thread, not the channel history", async () => {
  const slack = client();
  let historyCalled = false;
  slack.conversations.history = async () => {
    historyCalled = true;
    return { messages: [] };
  };
  context.addToThread("9100.000", "user", "what is restoration energy?", "U1", "C_ACME_MAIN");
  await send({
    channel: "C_ACME_MAIN",
    text: "how do i do this",
    threadTs: "9100.000",
    messageTs: "9100.100",
    seedClient: slack,
  });
  expect(historyCalled).toBe(false);
});

test("main ambient: classifier outage fails closed (silence)", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(false);
  expect(answerCalls).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("the classifier never receives documentation", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" });
  const keys = Object.keys(jevCalls[0]).sort();
  expect(keys).toEqual(["addressed", "channelPosture", "conversationContext", "message", "program"]);
});

test("addressed: program question gets the grounded answer", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
});

test("addressed: a cookie recipe gets a general-purpose answer", async () => {
  expect(await send({ channel: "C_ACME_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toContain("butter");
  expect(answerCalls[0].allowWebSearch).toBe(true);
});

test("addressed: banter that @mentions Pixie gets a conversational reply, not 'couldn't verify'", async () => {
  const text = "@ricky if you had to save @pixie or @pixorpheus who would you save?";
  expect(await send({ channel: "C_ACME_MAIN", text, addressed: true })).toBe(true);
  expect(postedText()).toContain("Pixorpheus can swim");
  expect(postedText()).not.toMatch(/couldn't verify/i);
  expect(handOffs).toHaveLength(0);
});

test("addressed: exact payout gets transparent uncertainty, never an amount", async () => {
  expect(
    await send({ channel: "C_ACME_MAIN", text: "what is my exact payout amount right now?", addressed: true }),
  ).toBe(true);
  expect(postedText()).toMatch(/couldn't verify/i);
  expect(postedText()).not.toMatch(/\$\s*\d|\d+\s*(?:usd|dollars)/i);
  expect(handOffs).toHaveLength(0);
});

test("addressed: program questions never use web search", async () => {
  await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true });
  expect(answerCalls[0].allowWebSearch).toBe(false);
});

test("addressed: classifier outage still answers, docs or not", async () => {
  jevMode = "error";
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
  posts = [];
  expect(await send({ channel: "C_ACME_MAIN", text: "give me a chocolate chip cookie recipe", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toContain("bake at 180C");
  expect(postedText()).not.toMatch(/couldn't verify/i);
});

test("addressed: 'who are you' needs no classifier call", async () => {
  stub(lookup, "answerOrChat", async () => verifiedAnswer("I'm Pixie!", "NONE", "acme"));
  expect(await send({ channel: "C_ACME_MAIN", text: "who are you?", addressed: true })).toBe(true);
  expect(jevCalls).toHaveLength(0);
});

test("help: a known question opens a ticket and gets the grounded reply; ticket stays open", async () => {
  expect(await send({ channel: "C_ACME_HELP", text: "my submission got rejected, how do i resubmit?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(ticketCalls[0].role).toBe("help");
  expect(postedText()).toContain("resubmit");
  expect(handOffs).toHaveLength(0);
});

test("help: an unknown personal question opens a ticket and hands to a helper without hallucinating", async () => {
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
  expect(handOffs[0].requesterId).toMatch(/^U_REQ_/);
  expect(posts).toHaveLength(0);
});

test("help: chatter creates no ticket and pings nobody", async () => {
  for (const t of ["lmao gg", "did you finish your game?"]) {
    await send({ channel: "C_ACME_HELP", text: t });
  }
  expect(ticketCalls).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
  expect(posts).toHaveLength(0);
});

test("help: classifier outage preserves the support path (ticket + helper)", async () => {
  jevMode = "error";
  await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" });
  expect(ticketCalls).toHaveLength(1);
  expect(handOffs).toHaveLength(1);
});

test("help: 'how do i do this' with no referent never fabricates", async () => {
  jevMode = "error";
  await send({ channel: "C_ACME_HELP", text: "how do i do this" });
  expect(posts).toHaveLength(0);
  expect(handOffs).toHaveLength(1);
});

test("help: a thread reply does not open a second ticket", async () => {
  await send({
    channel: "C_ACME_HELP",
    text: "how do i get my personal grant code?",
    threadTs: "7000.000",
    messageTs: "7000.500",
  });
  expect(ticketCalls).toHaveLength(0);
});

const MATRIX: Array<[string, TestRecord, string, string, boolean, MatrixWant]> = [
  [
    "main disabled: silent even when addressed",
    { main: { enabled: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "ambient off: ambient question silent, no classifier",
    { main: { ambientProgramReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    false,
    { spoke: false, answer: 0, jev: 0 },
  ],
  [
    "ambient off: addressed still answered",
    { main: { ambientProgramReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: true },
  ],
  [
    "mention replies off: addressed silent",
    { main: { mentionReplies: false } },
    "C_ACME_MAIN",
    "what is restoration energy?",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "general chat off: addressed chatter is silent",
    { main: { generalMentionChat: false } },
    "C_ACME_MAIN",
    "give me a chocolate chip cookie recipe",
    true,
    { spoke: false, answer: 0 },
  ],
  [
    "main escalation on: ambient unknown hands to helper",
    { main: { helperEscalationEnabled: true } },
    "C_ACME_MAIN",
    "does the hardware grant cover shipping?",
    false,
    { spoke: true, handoff: 1 },
  ],
  [
    "help disabled: silent",
    { help: { enabled: false } },
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { spoke: false, ticket: 0, handoff: 0 },
  ],
  [
    "help AI off: no model call, ticket + helper",
    { help: { aiReplies: false } },
    "C_ACME_HELP",
    "my submission got rejected, how do i resubmit?",
    false,
    { answer: 0, ticket: 1, handoff: 1 },
  ],
  [
    "help escalate off: unknown stays silent, ticket still recorded",
    { help: { escalateUnknown: false } },
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { spoke: false, ticket: 1, handoff: 0 },
  ],
  [
    "help escalate on: unknown handed off",
    {},
    "C_ACME_HELP",
    "how do i get my personal grant code?",
    false,
    { ticket: 1, handoff: 1 },
  ],
];

for (const [name, behavior, channel, text, addressed, want] of MATRIX) {
  test(`matrix: ${name}`, async () => {
    configure({ acme: { behavior } });
    const spoke = await send({ channel, text, addressed });
    if ("spoke" in want) expect(spoke).toBe(want.spoke);
    if ("ticket" in want) expect(ticketCalls).toHaveLength(want.ticket);
    if ("handoff" in want) expect(handOffs).toHaveLength(want.handoff);
    if ("answer" in want) expect(answerCalls).toHaveLength(want.answer);
    if ("jev" in want) expect(jevCalls).toHaveLength(want.jev);
    if (want.text) expect(postedText()).toMatch(want.text);
  });
}

test("paused program: silent in main and help, even when addressed", async () => {
  configure({ acme: { status: "paused" } });
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?", addressed: true })).toBe(false);
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(false);
  expect(ticketCalls).toHaveLength(0);
  expect(jevCalls).toHaveLength(0);
});

test("sandbox program runs the same pipeline as live", async () => {
  configure({ acme: { status: "sandbox" } });
  expect(await send({ channel: "C_ACME_MAIN", text: "what is restoration energy?" })).toBe(true);
  expect(await send({ channel: "C_ACME_HELP", text: "how do i get my personal grant code?" })).toBe(true);
  expect(handOffs).toHaveLength(1);
});

test("organizer channel: never volunteers, answers when addressed, files no tickets", async () => {
  expect(await send({ channel: "C_ACME_ORG", text: "what is restoration energy?" })).toBe(false);
  expect(jevCalls).toHaveLength(0);
  expect(await send({ channel: "C_ACME_ORG", text: "what is restoration energy?", addressed: true })).toBe(true);
  expect(postedText()).toContain("Restoration Energy");
  posts = [];
  expect(await send({ channel: "C_ACME_ORG", text: "how do i get my personal grant code?", addressed: true })).toBe(
    true,
  );
  expect(postedText()).toMatch(/couldn't verify/i);
  expect(ticketCalls).toHaveLength(0);
  expect(handOffs).toHaveLength(0);
});

test("ambient engage without a named intent never pulls a human in, even with escalation on", async () => {
  configure({ acme: { behavior: { main: { helperEscalationEnabled: true } } } });
  stub(jevDecision, "evaluateSupportDecision", async () => ({ action: "engage", intent: null }));
  expect(await send({ channel: "C_ACME_MAIN", text: "hmm is the thing broken" })).toBe(false);
  expect(handOffs).toHaveLength(0);
});

test("unclaimed channel: total silence even when addressed via message", async () => {
  expect(await send({ channel: "C_NOBODY", text: "what is restoration energy?" })).toBe(false);
  expect(jevCalls).toHaveLength(0);
});

test("conversationContextFor labels speakers, keeps order, and appends the thread", () => {
  const { conversationContextFor } = require("./engagement");
  const ctx = conversationContextFor({
    userId: "U_ME",
    recentMessages: [
      { speaker: "human", userId: "U_ME", text: "my code  came through" },
      { speaker: "pixie", userId: "U_BOT", text: "nice" },
      { speaker: "human", userId: "U_X", text: "x".repeat(500) },
    ],
    threadContext: "user: hi",
  });
  const lines = ctx.split("\n");
  expect(lines[0]).toBe("Recent channel messages:");
  expect(lines[1]).toBe("same sender: my code came through");
  expect(lines[2]).toBe("pixie: nice");
  expect(lines[3].length).toBeLessThanOrEqual("other member: ".length + 200);
  expect(ctx.endsWith("Thread:\nuser: hi")).toBe(true);
  expect(conversationContextFor({ recentMessages: [], threadContext: "" })).toBe("");
});
export {};
