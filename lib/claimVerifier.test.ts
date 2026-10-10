const { test } = require("node:test");
const assert = require("node:assert/strict");
const claimVerifier = require("./claimVerifier");

const sourceEvidence = (text: string, id = "e1", programId = "program-a") => ({
  id,
  programId,
  kind: "source",
  authority: "source",
  sourceName: "Policy",
  text,
});

const supportedJudge = async (claims: Array<{ claim: string }>) => ({
  verdict: "supported",
  claims: claims.map(({ claim }) => ({ claim, supported: true, evidenceIds: ["e1"], reason: "matched" })),
});

test("non-material chatter is sendable without inventing claims", async () => {
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "hey, sorry — ask a helper and I can take a look.",
    evidence: [],
  });

  assert.equal(result.sendable, true);
  assert.equal(result.verdict, "supported");
  assert.deepEqual(result.claims, []);
});

test("a material answer needs one selected same-program evidence record", async () => {
  const answer = "The grant can be returned before activation.";
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [sourceEvidence(answer)],
    judge: (input: { claims: Array<{ claim: string }> }) => supportedJudge(input.claims),
  });

  assert.equal(result.sendable, true);
  assert.deepEqual(result.claims[0].evidenceIds, ["e1"]);
});

test("unsupported prose and mixed claims fail closed", async () => {
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "The grant can be returned before activation. Your refund arrives tomorrow.",
    evidence: [sourceEvidence("The grant can be returned before activation.")],
    judge: async () => ({ verdict: "supported", claims: [] }),
  });

  assert.equal(result.sendable, false);
  assert.equal(result.verdict, "unsupported");
  assert.equal(result.claims.length, 2);
  assert.equal(
    result.claims.some((claim: { supported: boolean }) => claim.supported === false),
    true,
  );
});

test("polarity conflicts are rejected even when the source name is valid", async () => {
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "AI is allowed for hardware projects.",
    evidence: [sourceEvidence("AI is not allowed for hardware projects.")],
  });

  assert.equal(result.sendable, false);
  assert.equal(result.claims[0].supported, false);
});

test("selected evidence is tenant-scoped and rejects memory or pending facts", async () => {
  const answer = "Submit the application by Friday.";
  const foreign = sourceEvidence(answer, "foreign", "program-b");
  const memory = { ...sourceEvidence(answer, "memory"), kind: "memory", authority: "memory" };
  const pending = { ...sourceEvidence(answer, "pending"), status: "candidate" };
  const nonSelected = { ...sourceEvidence(answer, "non-selected"), selected: false };

  for (const evidence of [foreign, memory, pending, nonSelected]) {
    const result = await claimVerifier.verifyAnswer({
      programId: "program-a",
      answer,
      evidence: [evidence],
    });
    assert.equal(result.sendable, false, JSON.stringify(evidence));
  }
});

test("learned evidence requires explicit approval and cannot override source authority", async () => {
  const answer = "AI is allowed for hardware projects.";
  const unapproved = {
    ...sourceEvidence(answer, "learned-unapproved"),
    kind: "learned",
    authority: "learned",
    status: "approved",
    approved: false,
  };
  const rejected = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [unapproved],
  });
  assert.equal(rejected.sendable, false);

  const approved = {
    ...unapproved,
    id: "learned-approved",
    approved: true,
  };
  const accepted = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [approved],
  });
  assert.equal(accepted.sendable, true);

  const source = sourceEvidence("AI is allowed for hardware projects.", "source");
  const conflict = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [source, { ...approved, id: "learned-conflict", text: "AI is not allowed for hardware projects." }],
  });
  assert.equal(conflict.sendable, false);
});

test("numeric claims use boundaries and the same evidence record", async () => {
  const answer = "The AI limit is 30%.";
  const partial = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [sourceEvidence("The AI limit is 130%.")],
  });
  assert.equal(partial.sendable, false);

  const foreignNumber = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "The AI limit is 30%.",
    evidence: [
      sourceEvidence("The AI limit is documented without a number.", "e1"),
      sourceEvidence("The software limit is 30%.", "e2"),
    ],
  });
  assert.equal(foreignNumber.sendable, false);
});

test("spelled-out amounts and unrelated deadlines are not corpus-wide support", async () => {
  const amount = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "The grant pays five hundred dollars.",
    evidence: [sourceEvidence("Grant amounts vary by tier.")],
  });
  assert.equal(amount.sendable, false);

  const statedAmount = "The grant pays one hundred and twenty dollars.";
  const stated = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: statedAmount,
    evidence: [sourceEvidence(statedAmount)],
  });
  assert.equal(stated.sendable, true);

  const deadline = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "The refund deadline is 48 hours.",
    evidence: [sourceEvidence("Referral codes expire in 48 hours.")],
  });
  assert.equal(deadline.sendable, false);
});

test("fixture claims require an explicit test-only opt-in", async () => {
  const answer = "The grant can be returned before activation.";
  const disabled = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [],
    fixtureClaims: [answer],
  });
  assert.equal(disabled.sendable, false);

  const enabled = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [],
    fixtureClaims: [answer],
    allowFixtures: true,
  });
  assert.equal(enabled.sendable, true);
});

test("judge needs_review, malformed output, unknown evidence, and throws fail closed", async () => {
  const answer = "The grant can be returned before activation.";
  const evidence = [sourceEvidence(answer)];
  const cases = [
    { verdict: "needs_review", claims: [{ claim: answer, supported: true, evidenceIds: ["e1"] }] },
    { verdict: "supported", claims: [{ claim: answer, supported: true, evidenceIds: ["missing"] }] },
    { verdict: "supported", claims: [{ claim: answer, supported: true, evidenceIds: ["e1"], extra: "nope" }] },
    "not json",
  ];

  for (const judged of cases) {
    const result = await claimVerifier.verifyAnswer({
      programId: "program-a",
      answer,
      evidence,
      judge: async () => judged,
    });
    assert.equal(result.sendable, false, JSON.stringify(judged));
  }

  const thrown = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence,
    judge: async () => {
      throw new Error("judge unavailable");
    },
  });
  assert.equal(thrown.sendable, false);
  assert.ok(thrown.errors.includes("judge_error"));
});

test("a timed-out judge fails closed", { timeout: 8000 }, async () => {
  const answer = "The grant can be returned before activation.";
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [sourceEvidence(answer)],
    judge: () => new Promise(() => {}),
  });

  assert.equal(result.sendable, false);
  assert.ok(result.errors.includes("judge_timeout"));
});

test("a judge can only downgrade a deterministic support result", async () => {
  const answer = "The grant can be returned before activation.";
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer,
    evidence: [sourceEvidence(answer)],
    judge: async () => ({
      verdict: "supported",
      claims: [{ claim: answer, supported: false, evidenceIds: ["e1"], reason: "uncertain" }],
    }),
  });

  assert.equal(result.sendable, false);
  assert.equal(result.claims[0].supported, false);
});

export {};
