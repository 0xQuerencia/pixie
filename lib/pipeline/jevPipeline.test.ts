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
};

const db = require("../db");
const programs = require("../programs");
const jevDecision = require("../jevDecision");
const lookup = require("../lookup");
const tickets = require("../tickets");
const context = require("../context");
const respond = require("../respond");
const claimVerifier = require("../claimVerifier");
const traceStore = require("./traceStore");

type Rec = Record<string, unknown>;
const saved: Array<[Rec, string, unknown]> = [];
function stub(obj: object, key: string, value: unknown) {
  const target = obj as Rec;
  saved.push([target, key, target[key]]);
  target[key] = value;
}

const DOCS = "Grants can be returned before activation.";
function good(answer = "Grants can be returned before activation.") {
  const evidence = [
    { id: "d1", programId: "acme", sourceName: "Docs", text: DOCS, authority: "source", kind: "source" },
  ];
  return {
    answer,
    source: "Docs",
    evidence,
    verification: claimVerifier.verifyAnswerSync({ programId: "acme", answer, evidence }),
  };
}

let posts: Rec[];
let jevCalls: Rec[];
let answerCalls: number;
let historyCalls: Rec[];
let answerImpl: () => unknown;
let jevResult: Rec;
let savedPrograms: string | undefined;

function client() {
  return {
    chat: {
      postMessage: async (msg: Rec) => {
        posts.push(msg);
        return { ok: true, ts: `p${posts.length}` };
      },
      update: async (msg: Rec) => {
        posts.push({ ...msg, updated: true });
        return { ok: true, ts: msg.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: { add: async () => ({ ok: true }) },
    conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
  };
}

function seedClient(count: number) {
  return {
    ...client(),
    conversations: {
      replies: async () => ({ messages: [] }),
      history: async (args: Rec) => {
        historyCalls.push(args);
        const limit = Number(args.limit) || 0;
        return {
          messages: Array.from({ length: Math.min(count, limit) }, (_, i) => ({
            text: `chatter ${i}`,
            user: `U_OTHER_${i}`,
            ts: `${900 - i}.000`,
          })),
        };
      },
    },
  };
}

beforeAll(() => {
  savedPrograms = process.env.PIXIE_PROGRAMS_JSON;
  db.open(":memory:");
});
afterAll(() => {
  for (const [obj, key, value] of saved.reverse()) obj[key] = value;
  if (savedPrograms === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedPrograms;
  programs.invalidate();
});

beforeEach(() => {
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([ACME]);
  programs.invalidate();
  posts = [];
  jevCalls = [];
  historyCalls = [];
  answerCalls = 0;
  answerImpl = () => good();
  jevResult = {
    action: "engage",
    intent: "direct_program_question",
    reason: "jev_program_intent",
    shouldEngageP: 0.93,
    latencyMs: 41,
  };
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async (args: Rec) => {
    jevCalls.push(args);
    return { ...jevResult };
  });
  stub(lookup, "knownAnswer", () => null);
  stub(lookup, "answerOrChat", async () => {
    answerCalls += 1;
    return answerImpl();
  });
  stub(tickets, "ensureSupportTicket", async () => ({ id: 1, status: "open" }));
  stub(tickets, "handOffToHelper", async () => {});
  stub(tickets, "escalateTicket", async () => {});
  stub(context, "seedFromSlack", async () => {});
});

let seq = 0;
async function send(opts: {
  text: string;
  addressed?: boolean;
  threadTs?: string;
  messageTs?: string;
  seed?: unknown;
  channel?: string;
}) {
  seq += 1;
  const ts = opts.messageTs || `${2000 + seq}.000`;
  const threadTs = opts.threadTs || ts;
  const spoke = await respond.respond({
    client: client(),
    channel: opts.channel || "C_ACME_MAIN",
    threadTs,
    messageTs: ts,
    userId: `U_REQ_${seq}`,
    question: opts.text,
    mode: opts.addressed ? respond.ALWAYS : respond.HELP_ONLY,
    addressed: Boolean(opts.addressed),
    seedClient: opts.seed || null,
  });
  return { spoke, threadTs };
}

const texts = () => posts.map((p) => String(p.text || "")).join("\n");
const stages = (threadTs: string) => traceStore.forThread("acme", threadTs).map((row: { stage: string }) => row.stage);
const stage = (threadTs: string, name: string) =>
  traceStore.forThread("acme", threadTs).find((row: { stage: string }) => row.stage === name)?.payload;

test("irrelevant message: Jev silences it, nothing is generated or sent, and the trace says so", async () => {
  jevResult = {
    action: "silence",
    intent: "unrelated_chatter",
    reason: "jev_chatter",
    shouldEngageP: 0.1,
    latencyMs: 30,
  };
  const { spoke, threadTs } = await send({ text: "lmao gg" });
  expect(spoke).toBe(false);
  expect(answerCalls).toBe(0);
  expect(posts).toHaveLength(0);
  const final = stage(threadTs, "final_action");
  expect(final.decision).toBe("ignored");
  expect(final.sent).toBe(false);
  expect(stage(threadTs, "engagement").jev.reason).toBe("jev_chatter");
});

test("relevant message: one reply, and the trace holds every stage with sent=true", async () => {
  const { spoke, threadTs } = await send({ text: "can i return my grant?" });
  expect(spoke).toBe(true);
  expect(answerCalls).toBe(1);
  expect(posts).toHaveLength(1);
  expect(texts()).toContain("returned before activation");
  const seen = stages(threadTs);
  for (const name of [
    "context",
    "engagement",
    "retrieval",
    "generation",
    "selected_evidence",
    "grounding",
    "decision",
    "final_action",
  ]) {
    expect(seen).toContain(name);
  }
  expect(stage(threadTs, "engagement").jev.probability).toBe(0.93);
  expect(stage(threadTs, "generation").latencyMs).toBeGreaterThanOrEqual(0);
  expect(stage(threadTs, "grounding").sendable).toBe(true);
  const final = stage(threadTs, "final_action");
  expect(final.decision).toBe("answer");
  expect(final.sent).toBe(true);
});

test("the program comes from the channel, so another program's question never reaches Acme evidence", async () => {
  await send({ text: "can i return my grant?", channel: "C_NOT_A_PROGRAM" });
  expect(answerCalls).toBe(0);
  expect(posts).toHaveLength(0);
});

test("verifier rejection on a ping sends no model text and says it could not verify", async () => {
  answerImpl = () => ({
    answer: "Grants can be returned within 90 days.",
    source: "Docs",
    evidence: [],
    verification: { verdict: "unsupported", sendable: false, claims: [], errors: ["jev_escalate"] },
  });
  const { threadTs } = await send({ text: "can i return my grant?", addressed: true });
  expect(texts()).not.toContain("90 days");
  expect(stage(threadTs, "grounding").errors).toContain("jev_escalate");
  expect(stage(threadTs, "final_action").decision).not.toBe("reply");
});

test("model error: no answer text is sent and the trace records the failure", async () => {
  answerImpl = () => {
    throw new Error("router down");
  };
  const { threadTs } = await send({ text: "can i return my grant?", addressed: true });
  expect(texts()).not.toContain("returned before activation");
  expect(stage(threadTs, "final_action").reason).toBe("lookup_error");
});

test("no usable retrieval: abstains instead of answering from model knowledge", async () => {
  answerImpl = () => ({
    answer: "",
    source: null,
    unclear: true,
    verification: { verdict: "unsupported", sendable: false, claims: [], errors: ["source_required"] },
  });
  const { spoke, threadTs } = await send({ text: "can i return my grant?" });
  expect(spoke).toBe(false);
  expect(posts.map((p) => String(p.text || "")).filter((t) => t.includes("returned"))).toHaveLength(0);
  expect(stage(threadTs, "final_action").sent).toBe(false);
});

test("no complete trace, no send: a failed decision trace withholds the reply", async () => {
  const original = traceStore.append;
  stub(traceStore, "append", (input: { stage: string }) => {
    if (input.stage === "decision") throw new Error("trace db down");
    return original(input);
  });
  const { threadTs } = await send({ text: "can i return my grant?" });
  expect(texts()).not.toContain("returned before activation");
  expect(stage(threadTs, "final_action").sent).toBe(false);
});

test("a channel message gets at most 5 recent channel messages as classifier context", async () => {
  await send({ text: "can i return my grant?", seed: seedClient(20) });
  expect(historyCalls).toHaveLength(1);
  expect(historyCalls[0].limit).toBe(5);
  const ctx = String(jevCalls[0].conversationContext);
  expect(ctx.match(/other member:/g)?.length ?? 0).toBeLessThanOrEqual(5);
});

test("a thread reply uses thread context and never pulls channel history", async () => {
  await send({ text: "what is the deadline for grants?", messageTs: "3000.000" });
  jevCalls = [];
  historyCalls = [];
  await send({ text: "and can i return it?", threadTs: "3000.000", messageTs: "3001.000", seed: seedClient(20) });
  expect(historyCalls).toHaveLength(0);
  expect(String(jevCalls[0].conversationContext)).toContain("deadline for grants");
});

test("a duplicate delivery is claimed once, so the second event is dropped before any work", () => {
  expect(db.claimMessage("dup-ts-1", "C_ACME_MAIN")).toBe(true);
  expect(db.claimMessage("dup-ts-1", "C_ACME_MAIN")).toBe(false);
});

test("cache reply: the decision trace is written before the Slack post", async () => {
  const events: string[] = [];
  const original = traceStore.append;
  stub(traceStore, "append", (input: { stage: string }) => {
    events.push(`trace:${input.stage}`);
    return original(input);
  });
  const orig = client;
  stub(lookup, "knownAnswer", async () => ({ ...good(), direct: false }));
  const spokeClient = () => {
    const c = orig();
    const post = c.chat.postMessage;
    c.chat.postMessage = async (msg: Rec) => {
      events.push("post");
      return post(msg);
    };
    return c;
  };
  seq += 1;
  const ts = `${2000 + seq}.000`;
  await respond.respond({
    client: spokeClient(),
    channel: "C_ACME_MAIN",
    threadTs: ts,
    messageTs: ts,
    userId: "U_CACHE",
    question: "can i return my grant?",
    mode: respond.HELP_ONLY,
    addressed: false,
    seedClient: null,
  });
  expect(events.indexOf("trace:decision")).toBeGreaterThanOrEqual(0);
  if (events.includes("post")) expect(events.indexOf("trace:decision")).toBeLessThan(events.indexOf("post"));
});

test("cache reply: a failed decision trace withholds the cached answer too", async () => {
  const original = traceStore.append;
  stub(traceStore, "append", (input: { stage: string }) => {
    if (input.stage === "decision") throw new Error("trace db down");
    return original(input);
  });
  stub(lookup, "knownAnswer", async () => good());
  const { threadTs } = await send({ text: "can i return my grant?" });
  expect(texts()).not.toContain("returned before activation");
  expect(answerCalls).toBe(0);
  expect(stage(threadTs, "final_action").sent).toBe(false);
});

test("a message with no program still gets a persisted trace", async () => {
  jevResult = {
    action: "silence",
    intent: "unrelated_chatter",
    reason: "jev_chatter",
    shouldEngageP: 0.1,
    latencyMs: 5,
  };
  seq += 1;
  const ts = `${2000 + seq}.000`;
  await respond.respond({
    client: client(),
    channel: "D_PRIVATE",
    threadTs: ts,
    messageTs: ts,
    userId: "U_DM",
    question: "hello there",
    mode: respond.ALWAYS,
    addressed: true,
    isDm: true,
    seedClient: null,
  });
  const rows = traceStore.forThread("shared", ts);
  expect(rows.some((row: { stage: string }) => row.stage === "final_action")).toBe(true);
});

export {};
