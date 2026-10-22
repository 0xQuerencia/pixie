const { test } = require("node:test");
const assert = require("node:assert/strict");
const claimVerifier = require("./claimVerifier");
const lookup = require("./lookup");
const answer = require("./answer");
const db = require("./db");

db.open(":memory:");

const evidence = [
  {
    id: "faq#1",
    programId: "acme",
    sourceName: "FAQ",
    text: "Hardware grants are reviewed weekly. The cutoff for eligible hours is not yet decided.",
    authority: "source",
    kind: "source",
  },
];
const approve = async () => ({
  status: "ok",
  decision: "answer",
  risk: 1,
  reason: "jev_supported",
  errorKind: null,
  latencyMs: 3,
});
const verify = (text: string, extra: Record<string, unknown> = {}) =>
  claimVerifier.verifyAnswer({
    programId: "acme",
    answer: text,
    evidence,
    question: "Does the eligible hours cutoff apply to me?",
    programAnswer: true,
    judge: null,
    ...extra,
  });

const DEFERRALS = [
  "Ask a helper about this.",
  "Please contact support, they will tell you.",
  "A helper can confirm that.",
  "I'm not sure, reach out to an organizer.",
  "DM the team and they'll let you know.",
];

for (const text of DEFERRALS) {
  test(`deferral is never sendable and Jev is not asked to bless it: ${text}`, async () => {
    let jevCalls = 0;
    const result = await verify(text, {
      jevCheck: async () => {
        jevCalls += 1;
        return approve();
      },
    });
    assert.equal(result.sendable, false);
    assert.equal(result.verdict, "unsupported");
    assert.ok(result.errors.includes("deferral"));
    assert.equal(jevCalls, 0);
  });
}

test("a zero-claim program answer is reviewed by Jev before it can be sent", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const result = await verify("Yes.", {
    jevCheck: async (payload: Record<string, unknown>) => {
      seen.push(payload);
      return approve();
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].answer, "Yes.");
  assert.equal(result.sendable, true);
  assert.equal(result.jev?.decision, "answer");
});

test("Jev rejecting a zero-claim answer blocks it", async () => {
  const result = await verify("Yes.", {
    jevCheck: async () => ({ ...(await approve()), decision: "escalate", reason: "jev_escalate_risk4", risk: 4 }),
  });
  assert.equal(result.sendable, false);
});

test("a zero-claim program answer with no evidence is not sendable", async () => {
  let jevCalls = 0;
  const result = await verify("Yes.", {
    evidence: [],
    jevCheck: async () => {
      jevCalls += 1;
      return approve();
    },
  });
  assert.equal(result.sendable, false);
  assert.ok(result.errors.includes("no_evidence"));
  assert.equal(jevCalls, 0);
});

test("ordinary conversation is unchanged when the answer is not a program answer", async () => {
  const result = await claimVerifier.verifyAnswer({
    programId: "acme",
    answer: "You're welcome!",
    evidence: [],
    judge: null,
  });
  assert.equal(result.sendable, true);
  const deferral = await claimVerifier.verifyAnswer({
    programId: "acme",
    answer: "Ask a helper about this.",
    evidence: [],
    judge: null,
  });
  assert.equal(deferral.sendable, false, "a deferral never counts as a verified answer");
});

test("a supported answer with real claims still passes and still reaches Jev", async () => {
  let jevCalls = 0;
  const result = await verify("Hardware grants are reviewed weekly.", {
    jevCheck: async () => {
      jevCalls += 1;
      return approve();
    },
  });
  assert.equal(result.sendable, true);
  assert.equal(jevCalls, 1);
});

test("lookup turns a model deferral into an escalation signal, not an answer", async () => {
  const original = answer.getAnswerOrChat;
  answer.getAnswerOrChat = async () => ({ source: "FAQ", answer: "Please contact support, they will tell you." });
  try {
    const result = await lookup.answerOrChat("Does the eligible hours cutoff apply to me?", "", {
      program: { id: "acme", name: "Acme", sources: [{ name: "FAQ", type: "doc" }] },
      inHelpChannel: true,
      skipCache: true,
    });
    assert.equal(result?.answer || "", "");
    assert.equal(result?.unclear, true);
    assert.notEqual(result?.verification?.sendable, true);
  } finally {
    answer.getAnswerOrChat = original;
  }
});

test("unresolved documentation: the model abstains and nothing is sent", async () => {
  const original = answer.getAnswerOrChat;
  answer.getAnswerOrChat = async () => ({ source: "NONE", answer: "UNCLEAR", unclear: true });
  try {
    const result = await lookup.answerOrChat("What is the exact eligible hours cutoff?", "", {
      program: { id: "acme", name: "Acme", sources: [{ name: "FAQ", type: "doc" }] },
      inHelpChannel: true,
      skipCache: true,
    });
    assert.notEqual(result?.verification?.sendable, true);
  } finally {
    answer.getAnswerOrChat = original;
  }
});

for (const [label, check] of [
  [
    "timeout",
    async () => ({
      status: "error",
      decision: null,
      risk: null,
      reason: "jev_timeout",
      errorKind: "timeout",
      latencyMs: 8000,
    }),
  ],
  [
    "malformed output",
    async () => ({
      status: "error",
      decision: null,
      risk: null,
      reason: "jev_bad_response",
      errorKind: "bad_response",
      latencyMs: 9,
    }),
  ],
  ["thrown error", async () => Promise.reject(new Error("socket"))],
] as const) {
  test(`Jev ${label}: the answer is withheld and flagged as an outage, not as unsupported`, async () => {
    const result = await verify("Hardware grants are reviewed weekly.", { jevCheck: check });
    assert.equal(result.sendable, false);
    assert.equal(result.outage, true);
  });
}

test("a Jev decision of escalate is a real rejection, not an outage", async () => {
  const result = await verify("Hardware grants are reviewed weekly.", {
    jevCheck: async () => ({ ...(await approve()), decision: "escalate", risk: 4 }),
  });
  assert.equal(result.sendable, false);
  assert.notEqual(result.outage, true);
});

test("required Jev with no provider credentials blocks the send and reports an outage", async () => {
  const previous = process.env.PIXIE_JEV_POSTCHECK;
  process.env.PIXIE_JEV_POSTCHECK = "required";
  try {
    const result = await claimVerifier.verifyAnswer({
      programId: "acme",
      answer: "Hardware grants are reviewed weekly.",
      evidence,
      question: "q",
      programAnswer: true,
      judge: null,
    });
    assert.equal(result.sendable, false);
    assert.equal(result.outage, true);
  } finally {
    if (previous === undefined) delete process.env.PIXIE_JEV_POSTCHECK;
    else process.env.PIXIE_JEV_POSTCHECK = previous;
  }
});

export {};
