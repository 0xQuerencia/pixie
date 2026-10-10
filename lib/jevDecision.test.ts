process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
const jev = require("./jevDecision");
const log = require("./log");
const { readSource } = require("./test-source");

const CFG = {
  enabled: true,
  experientialApiKeyPresent: true,
  model: "jev-latest:free",
  baseUrl: "https://api.experientiallabs.ai/v1/systemone",
  timeoutMs: 8000,
  engageThreshold: 0.7,
};
const PROGRAM = { id: "acme", name: "Acme" };
const input = (message: any, extra: any = {}) => ({
  message,
  conversationContext: "",
  program: PROGRAM,
  channelPosture: "main",
  ...extra,
});
const result = (intent: any, p: any) => ({
  answers: {
    intent: { type: "choice", choice: intent, probabilities: { [intent]: p } },
    shouldEngage: { type: "boolean", probability: p },
  },
});

beforeEach(() => jev.clearDecisionCache());

test("no Vercel AI SDK path remains in the decision module", () => {
  const src = readSource("jevDecision.js");
  assert.doesNotMatch(src, /require\(["']ai["']\)/);
  assert.doesNotMatch(src, /gateway/i);
  assert.doesNotMatch(src, /experimental_evaluate/);
  assert.doesNotMatch(src, /zeroDataRetention/);
});

test("Jev asks only for typed engagement intent, including addressed general requests", () => {
  const questions = jev.buildJevQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["intent", "shouldEngage"]);
  assert.deepEqual(Object.keys(questions.intent.criteria).sort(), Object.keys(jev.INTENT_CHOICES).sort());
  assert.ok(Object.hasOwn(jev.INTENT_CHOICES, "addressed_general_request"));
  assert.equal(Object.keys(jev.INTENT_CHOICES).length, 7);
  assert.doesNotMatch(JSON.stringify(questions), /documentationIsSufficient|answerRisk|needsHuman/);
});

test("state carries bounded message/context plus identity and posture only, never documentation", () => {
  const state = jev.buildJevState({
    message: "x".repeat(5000),
    conversationContext: "y".repeat(5000),
    program: { id: "acme", name: "Acme", posture: "passive", scope: "program", extra: "drop me" },
    channelPosture: "help",
    addressed: true,
  });
  assert.ok(state.message.length <= jev.MAX_MESSAGE_CHARS + 32);
  assert.ok(state.conversationContext.length <= jev.MAX_CONTEXT_CHARS + 32);
  assert.deepEqual(state.program, { id: "acme", name: "Acme" });
  assert.equal(state.channelPosture, "help");
  assert.equal(state.addressed, true);
  assert.doesNotMatch(JSON.stringify(state), /document|evidence|corpus|retriev/i);
});

test("channel posture normalizes to main|help|dm", () => {
  assert.equal(jev.buildJevState({ message: "hi", program: PROGRAM, channelPosture: "dm" }).channelPosture, "dm");
  assert.equal(
    jev.buildJevState({ message: "hi", program: PROGRAM, channelPosture: "program" }).channelPosture,
    "main",
  );
  assert.equal(jev.buildJevState({ message: "hi", program: PROGRAM, channelPosture: "bogus" }).channelPosture, "main");
});

test("clear program questions engage without retrieved documentation", async () => {
  const res = await jev.evaluateSupportDecision(input("what is restoration energy?"), {
    config: CFG,
    evaluateFn: async () => result("direct_program_question", 0.96),
  });
  assert.equal(res.action, "engage");
  assert.equal(res.intent, "direct_program_question");
  assert.ok(Math.abs(res.shouldEngageP - 0.96) < 1e-9);
  assert.equal(res.errorKind, null);
});

test("addressed general requests engage when addressed", async () => {
  const res = await jev.evaluateSupportDecision(input("pixie, tell me a joke", { addressed: true }), {
    config: CFG,
    evaluateFn: async () => result("addressed_general_request", 0.9),
  });
  assert.equal(res.action, "engage");
  assert.equal(res.intent, "addressed_general_request");
});

test("chatter and human conversation stay silent", async () => {
  for (const [message, intent] of [
    ["lmao gg", "unrelated_chatter"],
    ["did you finish your game?", "human_conversation"],
  ]) {
    const res = await jev.evaluateSupportDecision(input(message), {
      config: CFG,
      evaluateFn: async () => result(intent, 0.02),
    });
    assert.equal(res.action, "silence", message);
    assert.equal(res.intent, intent);
    assert.equal(res.errorKind, null);
  }
});

test("provider failures return action error in every channel posture, never escalate/silence", async () => {
  const fail = async () => {
    throw new Error("fetch failed");
  };
  for (const channelPosture of ["main", "help", "dm"]) {
    const res = await jev.evaluateSupportDecision(input("what is acme?", { channelPosture }), {
      config: CFG,
      evaluateFn: fail,
    });
    assert.equal(res.action, "error", channelPosture);
    assert.ok(res.errorKind, channelPosture);
    assert.match(res.reason, /^jev_error_/);
  }
});

test("non-free models are refused before any I/O with errorKind config", async () => {
  let calls = 0;
  const countingPost = async () => {
    calls += 1;
    return { status: 200, data: {} };
  };
  for (const model of ["typesafe-ai/jev", "jev-latest", "some-paid-model", "jev-latest:paid", " free "]) {
    const res = await jev.evaluateSupportDecision(input("hello?"), {
      config: { ...CFG, model },
      httpPost: countingPost,
    });
    assert.equal(res.action, "error", model);
    assert.equal(res.errorKind, "config", model);
    assert.equal(res.reason, "jev_error_config", model);
  }
  assert.equal(calls, 0);
});

test("timeout maps to error/timeout", async () => {
  const timeoutErr = Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED" });
  const res = await jev.evaluateSupportDecision(input("what is acme?"), {
    config: CFG,
    httpPost: async () => {
      throw timeoutErr;
    },
  });
  assert.equal(res.action, "error");
  assert.equal(res.errorKind, "timeout");
});

test("401 maps to error/auth", async () => {
  const res = await jev.evaluateSupportDecision(input("what is acme?"), {
    config: CFG,
    httpPost: async () => ({ status: 401, data: { error: "unauthorized" } }),
  });
  assert.equal(res.action, "error");
  assert.equal(res.errorKind, "auth");
});

test("quota failure makes exactly one request and returns error/quota", async () => {
  let calls = 0;
  const res = await jev.evaluateSupportDecision(input("what is acme?"), {
    config: CFG,
    httpPost: async () => {
      calls += 1;
      return { status: 429, data: { error: { code: "free_limit_reached" } } };
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.action, "error");
  assert.equal(res.errorKind, "quota");
});

test("request body carries no documentation fields", async () => {
  const calls: any[] = [];
  const ok = (intent: any = "support_question", p: any = 0.95) => ({
    model: "jev-latest:free",
    answers: {
      intent: { type: "choice", choice: intent, probabilities: { [intent]: p } },
      shouldEngage: { type: "noul", noul: p },
    },
  });
  await jev.evaluateSupportDecision(input("what is restoration energy?"), {
    config: CFG,
    httpPost: async (url: any, body: any) => {
      calls.push({ url, body });
      return { status: 200, data: ok() };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.experientiallabs.ai/v1/systemone");
  assert.equal(calls[0].body.model, "jev-latest:free");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(Object.keys(calls[0].body.state).sort(), [
    "addressed",
    "channelPosture",
    "conversationContext",
    "message",
    "program",
  ]);
  assert.deepEqual(Object.keys(calls[0].body.state.program).sort(), ["id", "name"]);
  assert.doesNotMatch(JSON.stringify(calls[0].body.state), /document|evidence|corpus/i);
});

test("structured log line never contains message or context text", async () => {
  const marker = "zzq-canary-marker-9f31";
  const lines: any[] = [];
  const original = log.info;
  log.info = (...args: any[]) => {
    lines.push(args.join(" "));
  };
  try {
    await jev.evaluateSupportDecision(input(`what is acme ${marker}?`, { conversationContext: `ctx ${marker} here` }), {
      config: CFG,
      evaluateFn: async () => result("support_question", 0.95),
    });
  } finally {
    log.info = original;
  }
  assert.ok(lines.length > 0);
  for (const line of lines) assert.doesNotMatch(line, new RegExp(marker));
});

test("noTelemetry suppresses JEV decision metrics", async () => {
  const baseline = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'jev_decision'").get().c;
  await jev.evaluateSupportDecision(input("what is acme?"), {
    config: CFG,
    noTelemetry: true,
    evaluateFn: async () => result("support_question", 0.95),
  });
  const after = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'jev_decision'").get().c;
  assert.equal(after, baseline);
});

test("disabled Jev returns existing without evaluating", async () => {
  let calls = 0;
  const res = await jev.evaluateSupportDecision(input("what is acme?"), {
    config: { ...CFG, enabled: false },
    httpPost: async () => {
      calls += 1;
      return { status: 200, data: {} };
    },
  });
  assert.equal(res.action, "existing");
  assert.equal(res.reason, "jev_disabled");
  assert.equal(calls, 0);
});

test("JEV_API_KEY is read first, EXPERIENTIAL_API_KEY still works", () => {
  const jev = require("./jevDecision");
  const saved = { a: process.env.JEV_API_KEY, b: process.env.EXPERIENTIAL_API_KEY };
  try {
    process.env.JEV_API_KEY = "k-new";
    process.env.EXPERIENTIAL_API_KEY = "k-old";
    assert.equal(jev.experientialApiKey(), "k-new");
    delete process.env.JEV_API_KEY;
    assert.equal(jev.experientialApiKey(), "k-old");
  } finally {
    if (saved.a === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = saved.a;
    if (saved.b === undefined) delete process.env.EXPERIENTIAL_API_KEY;
    else process.env.EXPERIENTIAL_API_KEY = saved.b;
  }
});

test("decideAction follows the intent; probability only settles follow-ups", () => {
  const jev = require("./jevDecision");
  const d = (intent: any, p: any) => ({
    intent,
    shouldEngage: p >= 0.5,
    probabilities: { shouldEngage: p },
    source: "jev",
  });
  const act = (intent: any, p: any, state: any = {}) =>
    jev.decideAction(d(intent, p), { engageThreshold: 0.7 }, state).action;
  assert.equal(act("direct_program_question", 0.45), "engage");
  assert.equal(act("support_question", 0.2), "engage");
  assert.equal(act("unrelated_chatter", 0.9), "silence");
  assert.equal(act("human_conversation", 0.8), "silence");
  assert.equal(act("addressed_general_request", 0.1, { addressed: true }), "engage");
  assert.equal(act("addressed_general_request", 0.9, { addressed: false }), "silence");
  assert.equal(
    act("ambiguous_followup", 0.7, { conversationContext: "user: how do i earn restoration energy?" }),
    "engage",
  );
  assert.equal(act("ambiguous_followup", 0.7, { conversationContext: "" }), "silence");
  assert.equal(act("ambiguous_followup", 0.3, { conversationContext: "user: earlier" }), "silence");
  assert.equal(act(null, 0.8), "engage");
  assert.equal(act(null, 0.6), "silence");
});
export {};
