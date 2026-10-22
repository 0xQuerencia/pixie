process.env.PIXIE_DB_PATH = ":memory:";

const { test, expect, beforeEach, beforeAll, afterAll } = require("bun:test");

const ACME = {
  id: "outage-int",
  name: "Outage Int",
  scope: "program",
  helpChannel: "C_OUTINT_HELP",
  organizerChannel: "C_OUTINT_ORG",
  channels: ["C_OUTINT_HELP", "C_OUTINT_MAIN", "C_OUTINT_ORG"],
  ticketsEnabled: true,
  sources: [{ name: "Outage Int Docs", type: "text", content: "Hardware grants can be returned before activation." }],
};

const axios = require("axios");
const { config } = require("../config");
const db = require("../db");
const programs = require("../programs");
const knowledge = require("../knowledge");
const jevDecision = require("../jevDecision");
const tickets = require("../tickets");
const context = require("../context");
const respond = require("../respond");
const llm = require("../llm");
const health = require("../providerHealth");
const traceStore = require("./traceStore");

type Rec = Record<string, unknown>;
const saved: Array<[Rec, string, unknown]> = [];
function stub(obj: object, key: string, value: unknown) {
  const target = obj as Rec;
  saved.push([target, key, target[key]]);
  target[key] = value;
}

// Mocked HTTP endpoints: nothing here leaves the machine
let server: { port: number; stop: (force?: boolean) => void };
let status: Record<string, number>;
let hits: Record<string, number>;
let posts: Rec[];
let handoffs: Rec[];
let ticketCalls: Rec[];
let offset = 0;
const realNow = Date.now;
let savedPrograms: string | undefined;
let savedJudge: string | undefined;
let realGet: unknown;

const base = (name: string) => `http://127.0.0.1:${server.port}/${name}`;

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

beforeAll(async () => {
  savedPrograms = process.env.PIXIE_PROGRAMS_JSON;
  savedJudge = process.env.PIXIE_CLAIM_JUDGE;
  process.env.PIXIE_CLAIM_JUDGE = "off";
  db.open(":memory:");
  server = Bun.serve({
    port: 0,
    fetch(req: Request) {
      const name = new URL(req.url).pathname.split("/")[1];
      hits[name] = (hits[name] || 0) + 1;
      const code = status[name] ?? 500;
      const body =
        code === 200
          ? { choices: [{ message: { content: "SOURCE: NONE\nANSWER: UNCLEAR" }, finish_reason: "stop" }] }
          : { error: "mock" };
      return Response.json(body, { status: code });
    },
  });
  realGet = axios.get;
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([ACME]);
  programs.invalidate();
  knowledge.invalidate();
  await knowledge.refreshCorpus();
});

afterAll(() => {
  server.stop(true);
  axios.get = realGet;
  Date.now = realNow;
  for (const [obj, key, value] of saved.reverse()) obj[key] = value;
  if (savedPrograms === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedPrograms;
  if (savedJudge === undefined) delete process.env.PIXIE_CLAIM_JUDGE;
  else process.env.PIXIE_CLAIM_JUDGE = savedJudge;
  programs.invalidate();
  knowledge.invalidate();
});

beforeEach(() => {
  health.reset();
  offset = 0;
  Date.now = () => realNow() + offset;
  status = { primary: 403, secondary: 404, other: 403 };
  hits = {};
  posts = [];
  handoffs = [];
  ticketCalls = [];
  stub(config, "helpAnswer", {
    apiKey: "k",
    baseUrl: base("primary"),
    model: "primary-model",
    fallback: { apiKey: "k", baseUrl: base("secondary"), model: "secondary-model" },
  });
  stub(jevDecision, "isEnabled", () => true);
  stub(jevDecision, "evaluateSupportDecision", async () => ({
    action: "engage",
    intent: "direct_program_question",
    reason: "jev_program_intent",
    shouldEngageP: 0.93,
    latencyMs: 4,
  }));
  stub(tickets, "ensureSupportTicket", async (args: Rec) => {
    ticketCalls.push(args);
    return { id: ticketCalls.length, status: "open" };
  });
  stub(tickets, "handOffToHelper", async (args: Rec) => {
    handoffs.push(args);
  });
  stub(tickets, "escalateTicket", async (args: Rec) => {
    handoffs.push(args);
  });
  stub(context, "seedFromSlack", async () => {});
});

let seq = 0;
async function ask(text: string, threadTs?: string) {
  seq += 1;
  const ts = `${7000 + seq}.000`;
  const thread = threadTs || ts;
  await respond.respond({
    client: client(),
    channel: "C_OUTINT_HELP",
    threadTs: thread,
    messageTs: ts,
    userId: `U_REQ_${seq}`,
    question: text,
    mode: respond.HELP_ONLY,
    addressed: false,
    seedClient: null,
  });
  return thread;
}

const notices = () => posts.filter((p) => /answer service/i.test(String(p.text || "")));
const stageRows = (threadTs: string, name: string) =>
  traceStore.forThread("outage-int", threadTs).filter((row: { stage: string }) => row.stage === name);

test("primary and secondary down: no answer, one bounded attempt per model, one notice per thread, outage traced", async () => {
  const threads: string[] = [];
  for (let i = 0; i < 6; i += 1) threads.push(await ask(`can I return my hardware grant ${i}?`));

  expect(hits.primary).toBe(1);
  expect(hits.secondary).toBe(1);
  expect(handoffs.length).toBe(0);
  expect(ticketCalls.length).toBeLessThanOrEqual(1);
  expect(notices().length).toBe(6);
  expect(posts.every((p) => !/returned before activation/i.test(String(p.text || "")))).toBe(true);
  for (const thread of threads) {
    const outage = stageRows(thread, "outage");
    expect(outage.length).toBe(1);
    expect(outage[0].payload.source).toBe("answer");
    expect(outage[0].payload.noticeSent).toBe(true);
    expect(stageRows(thread, "final_action")[0].payload.reason).toBe("provider_outage");
  }
});

test("follow-ups in a noticed thread stay quiet and make no provider calls", async () => {
  const thread = await ask("can I return my hardware grant?");
  const before = { ...hits };
  await ask("hello?", thread);
  await ask("anyone?", thread);
  expect(hits).toEqual(before);
  expect(notices().length).toBe(1);
  expect(handoffs.length).toBe(0);
});

test("an unrelated provider recovering does not re-arm the notice for the still-broken ones", async () => {
  const otherCall = () =>
    llm.complete(
      {
        baseUrl: base("other"),
        apiKey: "k",
        model: "other-model",
        maxTokens: 5,
        messages: [{ role: "user", content: "x" }],
      },
      "other",
    );
  await expect(otherCall()).rejects.toBeTruthy();
  expect(health.isOpen(llm.healthKey({ baseUrl: base("other"), model: "other-model" }))).toBe(true);

  offset += 20_000;
  const thread = await ask("can I return my hardware grant?");
  expect(notices().length).toBe(1);

  // other's cooldown has elapsed, the answer models' has not
  offset += health.BASE_COOLDOWN_MS - 15_000;
  status.other = 200;
  await otherCall();
  expect(health.isOpen(llm.healthKey({ baseUrl: base("other"), model: "other-model" }))).toBe(false);

  const before = { ...hits };
  await ask("still there?", thread);
  expect(notices().length).toBe(1);
  expect(hits.primary).toBe(before.primary);
  expect(hits.secondary).toBe(before.secondary);
  expect(handoffs.length).toBe(0);
});

export {};
