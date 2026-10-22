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
const health = require("../providerHealth");
const llm = require("../llm");
const answerModule = require("../answer");
const ANSWER_KEY = () => llm.healthKey(answerModule.selectAnswerTier({ isPing: false, inHelpChannel: true }));
const traceStore = require("./traceStore");
const realTraceAppend = traceStore.append;

type Rec = Record<string, unknown>;
const saved: Array<[Rec, string, unknown]> = [];
function stub(obj: object, key: string, value: unknown) {
  const target = obj as Rec;
  saved.push([target, key, target[key]]);
  target[key] = value;
}

let posts: Rec[];
let handoffs: Rec[];
let escalations: Rec[];
let ticketCalls: Rec[];
let providerCalls: number;
let answerImpl: () => unknown;
let savedPrograms: string | undefined;

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { response: { status } });

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
  health.reset();
  posts = [];
  handoffs = [];
  escalations = [];
  ticketCalls = [];
  providerCalls = 0;
  traceStore.append = realTraceAppend;
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async () => ({
    action: "engage",
    intent: "direct_program_question",
    reason: "jev_program_intent",
    shouldEngageP: 0.93,
    latencyMs: 4,
  }));
  stub(lookup, "knownAnswer", () => null);
  // Mirrors llm.complete: one guarded provider call per lookup
  answerImpl = () =>
    health.guard(ANSWER_KEY(), async () => {
      providerCalls += 1;
      throw httpError(403);
    });
  stub(lookup, "answerOrChat", async () => answerImpl());
  stub(tickets, "ensureSupportTicket", async (args: Rec) => {
    ticketCalls.push(args);
    return { id: ticketCalls.length, status: "open" };
  });
  stub(tickets, "handOffToHelper", async (args: Rec) => {
    handoffs.push(args);
  });
  stub(tickets, "escalateTicket", async (args: Rec) => {
    escalations.push(args);
  });
  stub(context, "seedFromSlack", async () => {});
});

let seq = 0;
async function ask(text: string, opts: { threadTs?: string; channel?: string } = {}) {
  seq += 1;
  const ts = `${3000 + seq}.000`;
  const threadTs = opts.threadTs || ts;
  const spoke = await respond.respond({
    client: client(),
    channel: opts.channel || "C_ACME_HELP",
    threadTs,
    messageTs: ts,
    userId: `U_REQ_${seq}`,
    question: text,
    mode: respond.HELP_ONLY,
    addressed: false,
    seedClient: null,
  });
  return { spoke, threadTs };
}

const stages = (threadTs: string) => traceStore.forThread("acme", threadTs).map((row: { stage: string }) => row.stage);
const stage = (threadTs: string, name: string) =>
  traceStore.forThread("acme", threadTs).find((row: { stage: string }) => row.stage === name)?.payload;
const noticeCount = () => posts.filter((p) => /answer service|try again/i.test(String(p.text || ""))).length;

test("ten questions in ten threads during an outage: no helper pings, one provider call, one notice per thread", async () => {
  const threads: string[] = [];
  for (let i = 0; i < 10; i += 1) threads.push((await ask(`how do I submit project ${i}`)).threadTs);
  expect(providerCalls).toBe(1);
  expect(handoffs.length).toBe(0);
  expect(escalations.length).toBe(0);
  expect(ticketCalls.length).toBeLessThanOrEqual(1);
  expect(noticeCount()).toBe(10);
  expect(posts.every((p) => !/<@U[A-Z0-9_]+>|<!subteam|<!here|<!channel/.test(String(p.text || "")))).toBe(true);
  for (const t of threads) expect(stages(t)).toContain("outage");
});

test("repeated messages in one thread get a single notice", async () => {
  const first = await ask("how do I submit?");
  for (let i = 0; i < 4; i += 1) await ask(`still waiting ${i}`, { threadTs: first.threadTs });
  expect(noticeCount()).toBe(1);
  expect(handoffs.length).toBe(0);
});

test("the outage decision is recorded in the trace before anything is sent", async () => {
  const { threadTs } = await ask("how do I submit?");
  const outage = stage(threadTs, "outage") as Rec;
  expect(outage.source).toBe("answer");
  expect(outage.noticeSent).toBe(true);
  expect(stages(threadTs).indexOf("outage")).toBeLessThan(stages(threadTs).indexOf("final_action"));
  expect((stage(threadTs, "final_action") as Rec).reason).toBe("provider_outage");
});

test("a failed trace write withholds the notice and still escalates nobody", async () => {
  traceStore.append = () => {
    throw new Error("disk full");
  };
  const { spoke } = await ask("how do I submit?");
  expect(spoke).toBe(false);
  expect(posts.length).toBe(0);
  expect(handoffs.length).toBe(0);
});

test("provider recovery: the next question is answered normally and a later outage notifies again", async () => {
  await ask("first");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + health.BASE_COOLDOWN_MS + 1000;
    answerImpl = () =>
      health.guard(ANSWER_KEY(), async () => ({
        source: "Docs",
        answer: "Grants can be returned before activation.",
        evidence: [
          {
            id: "d1",
            programId: "acme",
            sourceName: "Docs",
            text: "Grants can be returned before activation.",
            authority: "source",
            kind: "source",
          },
        ],
        verification: { verdict: "supported", sendable: true, claims: [], errors: [] },
      }));
    const ok = await ask("can I return a grant?");
    expect(ok.spoke).toBe(true);
    expect(posts.some((p) => /returned before activation/.test(String(p.text || "")))).toBe(true);
  } finally {
    Date.now = realNow;
  }
});

test("Jev/judge outage on a verified-looking answer: no answer text, no helper ping, one notice", async () => {
  answerImpl = () => ({
    source: "Docs",
    answer: "",
    evidence: [],
    verification: {
      verdict: "unsupported",
      sendable: false,
      claims: [],
      errors: ["jev_postcheck_error"],
      outage: true,
    },
  });
  const { threadTs } = await ask("how do I submit?");
  expect(handoffs.length).toBe(0);
  expect(noticeCount()).toBe(1);
  expect((stage(threadTs, "outage") as Rec).source).toBe("verification");
});

test("a Jev outage does not create a ticket for every question once the circuit is open", async () => {
  await health
    .guard(
      "jev",
      async () => Promise.reject(new Error("auth")),
      () => "hard",
    )
    .catch(() => {});
  expect(health.isOpen("jev")).toBe(true);
  for (let i = 0; i < 5; i += 1) await ask(`question ${i}`);
  expect(ticketCalls.length).toBe(0);
});

test("a genuine bug (not a provider failure) still escalates exactly as before", async () => {
  answerImpl = () => {
    throw new TypeError("boom");
  };
  await ask("how do I submit?");
  expect(handoffs.length).toBe(1);
  expect(noticeCount()).toBe(0);
});

test("an unverifiable answer with healthy providers still hands off once", async () => {
  answerImpl = () => null;
  await ask("what is the eligible hours cutoff?");
  expect(handoffs.length).toBe(1);
  expect(noticeCount()).toBe(0);
});

test("a zero-claim deferral escalates and is never posted as an answer", async () => {
  answerImpl = () => ({
    source: "FAQ",
    answer: "",
    unclear: true,
    evidence: [],
    verification: { verdict: "unsupported", sendable: false, claims: [], errors: ["deferral"] },
  });
  await ask("what is the eligible hours cutoff?");
  expect(handoffs.length).toBe(1);
  expect(posts.some((p) => /contact support/i.test(String(p.text || "")))).toBe(false);
});

export {};
