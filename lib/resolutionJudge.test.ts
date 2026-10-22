const { test } = require("node:test");
const assert = require("node:assert/strict");
const { judgeResolution, selectTranscript, MAX_CHARS, MAX_MESSAGES } = require("./resolutionJudge");

test("resolution judge sends a bounded typed resolution task and returns Jev confidence", async () => {
  let request;
  const result = await judgeResolution(
    {
      ticket: { id: 4, program_id: "p", question: "How do I fix this?" },
      transcript: [
        { role: "requester", text: "How do I fix this?" },
        { role: "helper", text: "Change the setting, then restart." },
        { role: "requester", text: "Thanks, that worked." },
      ],
    },
    {
      evaluateDecision: async (input) => {
        request = input;
        return {
          status: "ok",
          result: { answers: { resolution: { choice: "resolved", probabilities: { resolved: 0.93 } } } },
        };
      },
    },
  );
  assert.equal(result.verdict, "resolved");
  assert.equal(result.confidence, 0.93);
  assert.deepEqual(Object.keys(request.questions), ["resolution", "evidence"]);
  assert.match(request.state.transcript, /helper\]/);
});

test("resolution judge fails closed on Jev errors and malformed labels", async () => {
  const error = await judgeResolution(
    { ticket: { question: "q" }, transcript: [] },
    {
      evaluateDecision: async () => {
        throw new Error("timeout");
      },
    },
  );
  const malformed = await judgeResolution(
    { ticket: { question: "q" }, transcript: [] },
    { evaluateDecision: async () => ({ status: "ok", result: { answers: { resolution: { choice: "maybe" } } } }) },
  );
  assert.deepEqual(error, { verdict: "unknown" });
  assert.deepEqual(malformed, { verdict: "unknown" });
});
const messages = (count: number, size: number) =>
  Array.from({ length: count }, (_, i) => ({
    ts: String(i + 1),
    role: i === 0 ? "requester" : i % 3 === 1 ? "helper" : i % 3 === 2 ? "pixie" : "requester",
    text: `msg-${i + 1} ${"x".repeat(size)}`,
  }));

test("a long thread keeps the original question and the newest messages", () => {
  const rows = messages(60, 400);
  rows.push({ ts: "99", role: "requester", text: "NEWEST: yes that fixed it" });
  const picked = selectTranscript(rows);
  assert.ok(picked.text.length <= MAX_CHARS + 400, `bounded (${picked.text.length})`);
  assert.match(picked.text, /msg-1 /);
  assert.match(picked.text, /NEWEST: yes that fixed it/);
  assert.ok(picked.rows.length <= MAX_MESSAGES);
});

test("one enormous message cannot crowd out the rest of the thread", () => {
  const rows = [
    { ts: "1", role: "requester", text: "Original question" },
    { ts: "2", role: "helper", text: "H".repeat(50_000) },
    { ts: "3", role: "requester", text: "NEWEST: works now" },
  ];
  const picked = selectTranscript(rows);
  assert.match(picked.text, /Original question/);
  assert.match(picked.text, /NEWEST: works now/);
  assert.ok(picked.text.length < MAX_CHARS + 400);
});

test("when the budget is tight, requester and helper messages win over bot and bystander chatter", () => {
  const rows = [
    { ts: "1", role: "requester", text: "Original question" },
    ...Array.from({ length: 30 }, (_, i) => ({
      ts: String(10 + i),
      role: i % 2 ? "other" : "pixie",
      text: `chatter-${i} ${"c".repeat(600)}`,
    })),
    { ts: "50", role: "helper", text: "HELPER-ANSWER try the reset button" },
    { ts: "51", role: "requester", text: "REQUESTER-CONFIRM that fixed it" },
  ];
  const picked = selectTranscript(rows);
  assert.match(picked.text, /HELPER-ANSWER/);
  assert.match(picked.text, /REQUESTER-CONFIRM/);
});

test("omitted stretches are marked and the transcript stays in chronological order", () => {
  const picked = selectTranscript(messages(80, 300));
  assert.match(picked.text, /earlier messages omitted/);
  const order = [...picked.text.matchAll(/msg-(\d+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
});

const ok = (answers: Record<string, unknown>) => async () => ({ status: "ok", result: { answers } });
const thread = [
  { ts: "1", role: "requester", userId: "U1", text: "Device will not boot" },
  { ts: "2", role: "helper", userId: "H1", text: "Hold the power button for ten seconds" },
  { ts: "3", role: "requester", userId: "U1", text: "That worked, thanks" },
];

test("the judge returns a validated decision with the evidence message it relied on", async () => {
  const result = await judgeResolution(
    { ticket: { question: "Device will not boot", category: "site_bug" }, transcript: thread },
    {
      evaluateDecision: ok({
        resolution: { choice: "resolved", probabilities: { resolved: 0.95 } },
        evidence: { choice: "m3" },
      }),
    },
  );
  assert.equal(result.verdict, "resolved");
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(
    {
      index: result.evidence.index,
      role: result.evidence.role,
      userId: result.evidence.userId,
      ts: result.evidence.ts,
    },
    { index: 2, role: "requester", userId: "U1", ts: "3" },
  );
  assert.equal(result.reasonCode, "resolved:requester");
});

test("an evidence id the judge invented is dropped, not trusted", async () => {
  const result = await judgeResolution(
    { ticket: { question: "q" }, transcript: thread },
    {
      evaluateDecision: ok({
        resolution: { choice: "resolved", probabilities: { resolved: 0.99 } },
        evidence: { choice: "m42" },
      }),
    },
  );
  assert.equal(result.verdict, "resolved");
  assert.equal(result.evidence, null);
});

test("all five decisions are accepted and anything else is unknown", async () => {
  for (const verdict of ["resolved", "still_open", "needs_clarification", "escalate", "insufficient_evidence"]) {
    const result = await judgeResolution(
      { ticket: { question: "q" }, transcript: thread },
      {
        evaluateDecision: ok({
          resolution: { choice: verdict, probabilities: { [verdict]: 0.9 } },
          evidence: { choice: "none" },
        }),
      },
    );
    assert.equal(result.verdict, verdict);
    assert.equal(result.evidence, null);
  }
  for (const choice of ["unresolved", "waiting", "maybe", 7, null]) {
    const result = await judgeResolution(
      { ticket: { question: "q" }, transcript: thread },
      { evaluateDecision: ok({ resolution: { choice } }) },
    );
    assert.equal(result.verdict, "unknown");
  }
});

test("the judge reports the category so the model can weigh it", async () => {
  let state;
  await judgeResolution(
    { ticket: { question: "q", category: "fulfillment_shipping" }, transcript: thread },
    {
      evaluateDecision: async (input) => {
        state = input.state;
        return { status: "error", errorKind: "timeout" };
      },
    },
  );
  assert.equal(state.category, "fulfillment_shipping");
});
export {};
