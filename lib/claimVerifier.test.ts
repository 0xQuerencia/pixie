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
    answer: "hey, thanks for asking!",
    evidence: [],
  });

  assert.equal(result.sendable, true);
  assert.equal(result.verdict, "supported");
  assert.deepEqual(result.claims, []);
});

test("handing the question to a person is a deferral, never a verified answer", async () => {
  const result = await claimVerifier.verifyAnswer({
    programId: "program-a",
    answer: "hey, sorry — ask a helper and I can take a look.",
    evidence: [],
  });

  assert.equal(result.sendable, false);
  assert.deepEqual(result.errors, ["deferral"]);
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

function sendable(answer: string, evidenceText: string) {
  return claimVerifier.verifyAnswerSync({
    programId: "program-a",
    answer,
    evidence: [sourceEvidence(evidenceText)],
  }).sendable;
}

test("a bare declarative fact needs evidence even without policy keywords", () => {
  assert.equal(sendable("The portal is called Nimbus.", "The docs explain submission steps."), false);
  assert.equal(sendable("The portal is called Nimbus.", "The portal is called Nimbus."), true);
});

test("markdown tables, quotes and code blocks do not hide an unsupported claim", () => {
  const answer = [
    "| Topic | Answer |",
    "| --- | --- |",
    "| portal | The portal is called Nimbus. |",
    "",
    "```text",
    "ok",
    "```",
  ].join("\n");
  assert.equal(sendable(answer, "The grant can be returned before activation."), false);
  assert.equal(sendable("> The portal is called Nimbus.", "The grant can be returned before activation."), false);
});

test("numbers normalize across width, units, decimals and vague quantities", () => {
  assert.equal(sendable("The AI limit is ３０％.", "The AI limit is 10%."), false);
  assert.equal(sendable("The AI limit is ３０％.", "The AI limit is 30%."), true);
  assert.equal(sendable("The AI limit is 1.5%.", "The AI limit is 1.5%."), true);
  assert.equal(sendable("The AI limit is 1.5%.", "The AI limit is 15%."), false);
  assert.equal(
    sendable("The payout arrives a couple of days after review.", "The payout arrives three days after review."),
    false,
  );
  assert.equal(sendable("The payout is V dollars after review.", "The payout is three dollars after review."), false);
  assert.equal(sendable("The payout is 50 dollars after review.", "The payout is 50 days after review."), false);
  assert.equal(sendable("The payout is 50 dollars after review.", "The payout is 50 dollars after review."), true);
});

test("double negatives and conditional operators cannot flip a rule", () => {
  assert.equal(sendable("AI is not prohibited for projects.", "AI is prohibited for projects."), false);
  assert.equal(
    sendable(
      "You can submit your project through the portal unless it is private.",
      "You can submit your project through the portal if it is private.",
    ),
    false,
  );
  assert.equal(
    sendable("You can submit your project through the portal.", "You can submit your project through the portal."),
    true,
  );
});

test("pleasantries, questions and generic troubleshooting are not claims", () => {
  assert.equal(sendable("Hope this helps! Let me know if you need anything else.", "unrelated text"), true);
  assert.equal(sendable("Try restarting the app and refreshing the page.", "unrelated text"), true);
  assert.equal(sendable("Which project are you asking about?", "unrelated text"), true);
});

test("hasPolicyClaims flags policy talk but not casual numbers", () => {
  assert.equal(claimVerifier.hasPolicyClaims("Refunds are prohibited."), true);
  assert.equal(claimVerifier.hasPolicyClaims("Bake the cookies at 180C for ten minutes."), false);
});

const RULES_DOC =
  "Unused grants may be returned before activation. Refund requests must be sent to the helper channel within 14 days. Projects must be public on GitHub. AI tools may generate at most 30% of project code. Payouts are processed within 5 business days after approval. Submissions that copy tutorials without changes are rejected. Teams of up to 4 people can apply. You can resubmit after fixing the reviewer notes.";

test("small wording swaps and added details cannot slip past the verifier", () => {
  const blocked = [
    "Payouts are processed within 5 business days after approval. Also, late payouts get a $50 bonus.",
    "Teams of up to 6 people can apply.",
    "Teams of up to 4 people cannot apply.",
    "Payouts are processed within 5 business days before approval.",
    "Projects must not be public on GitHub.",
    "Refund requests must be sent to the helper channel within 41 days.",
    "You can resubmit once, after fixing the reviewer notes.",
    "AI tools may generate at most 30% of project code, and 100% of the README.",
    "Projects must be public on GitHub or GitLab.",
    "Submissions that copy tutorials without changes are approved.",
    "Payouts are processed within 5 calendar days after approval.",
    "Payouts are processed within 5 business days after rejection.",
    "Projects can be public on GitHub.",
    "Everyone gets a refund automatically.",
    "The deadline is June 30.",
  ];
  for (const answer of blocked) assert.equal(sendable(answer, RULES_DOC), false, answer);
});

test("answers that restate the docs are still sendable", () => {
  const allowed = [
    "Unused grants may be returned before activation.",
    "Send refund requests to the helper channel within 14 days.",
    "Your project has to be public on GitHub.",
    "Up to 4 people can be on a team.",
    "Yes, you can resubmit after fixing the reviewer notes.",
    "Hey! Projects must be public on GitHub. Let me know if you need anything else!",
    "- Projects must be public on GitHub\n- AI tools may generate at most 30% of project code",
  ];
  for (const answer of allowed) assert.equal(sendable(answer, RULES_DOC), true, answer);
});

const jevAnswer = "The grant can be returned before activation.";
const jevBase = (extra: object) => ({
  programId: "program-a",
  answer: jevAnswer,
  evidence: [sourceEvidence(jevAnswer)],
  judge: (input: { claims: Array<{ claim: string }> }) => supportedJudge(input.claims),
  ...extra,
});

const jevOk = (extra: object = {}) => ({
  status: "ok",
  decision: "answer",
  risk: 1,
  reason: "jev_supported",
  errorKind: null,
  latencyMs: 12,
  ...extra,
});

test("jev post-check approving keeps the answer sendable and records its result", async () => {
  const result = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk() }));
  assert.equal(result.sendable, true);
  assert.equal(result.jev.decision, "answer");
  assert.equal(result.jev.risk, 1);
});

test("jev post-check blocks clarify, escalate and ignore decisions", async () => {
  for (const decision of ["clarify", "escalate", "ignore"]) {
    const result = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk({ decision, risk: 1 }) }));
    assert.equal(result.sendable, false, decision);
    assert.ok(result.errors.includes(`jev_${decision}`), decision);
  }
});

test("jev post-check blocks a high-risk support score even when it says answer", async () => {
  const result = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk({ risk: 4 }) }));
  assert.equal(result.sendable, false);
  assert.ok(result.errors.includes("jev_unsupported"));
});

test("jev post-check errors fail closed", async () => {
  const errored = await claimVerifier.verifyAnswer(
    jevBase({ jevCheck: async () => jevOk({ status: "error", decision: null, risk: null, errorKind: "timeout" }) }),
  );
  assert.equal(errored.sendable, false);
  assert.ok(errored.errors.includes("jev_postcheck_error"));
  const thrown = await claimVerifier.verifyAnswer(
    jevBase({
      jevCheck: async () => {
        throw new Error("boom");
      },
    }),
  );
  assert.equal(thrown.sendable, false);
  assert.ok(thrown.errors.includes("jev_postcheck_error"));
});

test("jev post-check disabled status does not block", async () => {
  const result = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk({ status: "disabled" }) }));
  assert.equal(result.sendable, true);
});

test("jev post-check never rescues an answer the judge rejected", async () => {
  const result = await claimVerifier.verifyAnswer(
    jevBase({ judge: async () => ({ verdict: "unsupported", claims: [] }), jevCheck: async () => jevOk() }),
  );
  assert.equal(result.sendable, false);
});

test("PIXIE_JEV_POSTCHECK=required blocks when Jev is unavailable, off skips the check", async () => {
  const saved = process.env.PIXIE_JEV_POSTCHECK;
  try {
    process.env.PIXIE_JEV_POSTCHECK = "required";
    const blocked = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk({ status: "disabled" }) }));
    assert.equal(blocked.sendable, false);
    assert.ok(blocked.errors.includes("jev_postcheck_unavailable"));
    const approved = await claimVerifier.verifyAnswer(jevBase({ jevCheck: async () => jevOk() }));
    assert.equal(approved.sendable, true);
    process.env.PIXIE_JEV_POSTCHECK = "off";
    const skipped = await claimVerifier.verifyAnswer(
      jevBase({ jevCheck: async () => jevOk({ decision: "escalate" }) }),
    );
    assert.equal(skipped.sendable, true);
  } finally {
    if (saved === undefined) delete process.env.PIXIE_JEV_POSTCHECK;
    else process.env.PIXIE_JEV_POSTCHECK = saved;
  }
});

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("claim judge off + Jev required: Jev still runs and can block", async () => {
  await withEnv({ PIXIE_CLAIM_JUDGE: "off", PIXIE_JEV_POSTCHECK: "required" }, async () => {
    let calls = 0;
    const blocked = await claimVerifier.verifyAnswer(
      jevBase({
        jevCheck: async () => {
          calls += 1;
          return jevOk({ decision: "escalate" });
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(blocked.sendable, false);
    assert.ok(blocked.errors.includes("jev_escalate"));
  });
});

test("claim judge off + Jev enabled by default: Jev runs through the default path", async () => {
  const jevDecision = require("./jevDecision");
  const jevAnswerCheck = require("./jevAnswerCheck");
  const originalEnabled = jevDecision.isEnabled;
  const originalCheck = jevAnswerCheck.checkAnswer;
  let calls = 0;
  jevDecision.isEnabled = () => true;
  jevAnswerCheck.checkAnswer = async () => {
    calls += 1;
    return jevOk({ decision: "clarify" });
  };
  try {
    await withEnv({ PIXIE_CLAIM_JUDGE: "off", PIXIE_JEV_POSTCHECK: undefined }, async () => {
      const result = await claimVerifier.verifyAnswer({
        programId: "program-a",
        answer: jevAnswer,
        evidence: [sourceEvidence(jevAnswer)],
      });
      assert.equal(calls, 1);
      assert.equal(result.sendable, false);
      assert.ok(result.errors.includes("jev_clarify"));
    });
  } finally {
    jevDecision.isEnabled = originalEnabled;
    jevAnswerCheck.checkAnswer = originalCheck;
  }
});

test("Jev post-check off disables only the Jev layer; the claim judge still applies", async () => {
  await withEnv({ PIXIE_CLAIM_JUDGE: undefined, PIXIE_JEV_POSTCHECK: "off" }, async () => {
    let jevCalls = 0;
    const jevCheck = async () => {
      jevCalls += 1;
      return jevOk({ decision: "escalate" });
    };
    const approved = await claimVerifier.verifyAnswer(jevBase({ jevCheck }));
    assert.equal(approved.sendable, true);
    assert.equal(jevCalls, 0);
    const rejected = await claimVerifier.verifyAnswer(
      jevBase({ jevCheck, judge: async () => ({ verdict: "unsupported", claims: [] }) }),
    );
    assert.equal(rejected.sendable, false);
    assert.equal(jevCalls, 0);
  });
});

test("Jev required with Jev disabled or without a key blocks, even when the claim judge is off", async () => {
  const jevDecision = require("./jevDecision");
  const original = jevDecision.isEnabled;
  jevDecision.isEnabled = () => false;
  try {
    await withEnv({ PIXIE_CLAIM_JUDGE: "off", PIXIE_JEV_POSTCHECK: "required" }, async () => {
      const result = await claimVerifier.verifyAnswer({
        programId: "program-a",
        answer: jevAnswer,
        evidence: [sourceEvidence(jevAnswer)],
      });
      assert.equal(result.sendable, false);
      assert.ok(result.errors.includes("jev_postcheck_unavailable"));
      const withInjectedJudge = await claimVerifier.verifyAnswer(jevBase({}));
      assert.equal(withInjectedJudge.sendable, false, "an injected judge does not bypass required");
    });
    await withEnv({ PIXIE_CLAIM_JUDGE: undefined, PIXIE_JEV_POSTCHECK: undefined }, async () => {
      const result = await claimVerifier.verifyAnswer(jevBase({}));
      assert.equal(result.sendable, true, "default keeps the current behavior when Jev is not configured");
    });
  } finally {
    jevDecision.isEnabled = original;
  }
});

test("only turning both layers off explicitly disables model verification", async () => {
  const rejectJudge = async () => ({ verdict: "unsupported", claims: [] });
  const rejectJev = async () => jevOk({ decision: "escalate" });
  const cases: Array<[string, string | undefined, string | undefined, boolean]> = [
    ["judge on, jev default", undefined, undefined, false],
    ["judge off, jev default", "off", undefined, false],
    ["judge on, jev off", undefined, "off", false],
    ["judge off, jev required", "off", "required", false],
    ["judge on, jev required", undefined, "required", false],
    ["judge off, jev off (explicit)", "off", "off", true],
  ];
  for (const [label, claimJudge, jevMode, expected] of cases) {
    await withEnv({ PIXIE_CLAIM_JUDGE: claimJudge, PIXIE_JEV_POSTCHECK: jevMode }, async () => {
      const result = await claimVerifier.verifyAnswer(jevBase({ judge: rejectJudge, jevCheck: rejectJev }));
      assert.equal(result.sendable, expected, label);
    });
  }
});
