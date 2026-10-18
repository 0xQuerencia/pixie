const { test, expect } = require("bun:test");
const jevCheck = require("./jevAnswerCheck");
const jevDecision = require("./jevDecision");

const input = {
  question: "how long do I have to return the grant?",
  context: "earlier: user asked about grants",
  programId: "acme",
  programName: "Acme",
  answer: "You can return it before activation.",
  evidence: [
    { sourceName: "Docs", heading: "Grants", text: "Grants can be returned before activation.", programId: "acme" },
  ],
};

const ok = (choice: string, score: number) => async () => ({
  status: "ok",
  latencyMs: 9,
  result: { answers: { decision: { choice }, support: { score } } },
});

test("a supported answer decision with low risk is sendable", async () => {
  const check = await jevCheck.checkAnswer(input, { evaluateDecision: ok("answer", 0) });
  expect(check.status).toBe("ok");
  expect(check.decision).toBe("answer");
  expect(check.risk).toBe(1);
  expect(jevCheck.sendable(check)).toBe(true);
});

test("risk above the limit is not sendable even when the decision says answer", async () => {
  const check = await jevCheck.checkAnswer(input, { evaluateDecision: ok("answer", 3) });
  expect(check.risk).toBe(4);
  expect(jevCheck.sendable(check)).toBe(false);
});

test("clarify, escalate and ignore are surfaced and never sendable", async () => {
  for (const choice of ["clarify", "escalate", "ignore"]) {
    const check = await jevCheck.checkAnswer(input, { evaluateDecision: ok(choice, 0) });
    expect(check.decision).toBe(choice);
    expect(jevCheck.sendable(check)).toBe(false);
  }
});

test("provider errors, malformed answers and thrown errors are errors, never approvals", async () => {
  const errored = await jevCheck.checkAnswer(input, {
    evaluateDecision: async () => ({ status: "error", errorKind: "quota" }),
  });
  expect(errored.status).toBe("error");
  expect(errored.errorKind).toBe("quota");
  expect(jevCheck.sendable(errored)).toBe(false);
  const malformed = await jevCheck.checkAnswer(input, { evaluateDecision: ok("maybe", 0) });
  expect(malformed.status).toBe("error");
  const thrown = await jevCheck.checkAnswer(input, {
    evaluateDecision: async () => {
      throw new Error("down");
    },
  });
  expect(thrown.status).toBe("error");
  expect(jevCheck.sendable(thrown)).toBe(false);
});

test("a disabled Jev is reported as disabled, not as an approval", async () => {
  const check = await jevCheck.checkAnswer(input, { evaluateDecision: async () => ({ status: "disabled" }) });
  expect(check.status).toBe("disabled");
  expect(jevCheck.sendable(check)).toBe(false);
});

test("the Jev state carries the program, question, answer and bounded evidence only", () => {
  const long = {
    ...input,
    evidence: Array.from({ length: 20 }, (_, i) => ({ sourceName: `s${i}`, text: "x".repeat(5000) })),
  };
  const state = jevCheck.stateFor(long);
  expect(state.program.id).toBe("acme");
  expect(state.evidence).toHaveLength(6);
  expect(state.evidence[0].text.length).toBeLessThanOrEqual(701);
  expect(state.proposedAnswer).toBe(input.answer);
});

test("conversation context keeps the newest turns when truncated", () => {
  const old = "OLDEST ".repeat(400);
  const state = jevDecision.buildJevState({
    message: "what about that?",
    conversationContext: `${old}\nlatest: the grant deadline question`,
  });
  expect(state.conversationContext.length).toBeLessThan(jevDecision.MAX_CONTEXT_CHARS + 60);
  expect(state.conversationContext).toContain("latest: the grant deadline question");
  expect(state.conversationContext.startsWith("[truncated")).toBe(true);
});

export {};
