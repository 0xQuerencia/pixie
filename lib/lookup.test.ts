const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const lookup = require("./lookup");
const programs = require("./programs");

db.open(":memory:");

const PROG = {
  id: "t-timeline",
  name: "Timeline Test",
  milestones: [{ name: "Timeline Test launch", date: "2020-01-15" }],
};

test("dateFallback answers a timing question from the program's milestones", () => {
  const result = lookup.dateFallback("is timeline test out yet", "", PROG);
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
  assert.match(result.answer, /January 15, 2020/);
});

test("dateFallback accepts a bare program id as well as a record", () => {
  programs.saveProgram(PROG);
  programs.invalidate();
  const result = lookup.dateFallback("has timeline test launched", "", "t-timeline");
  assert.equal(result?.source, "Program timeline");
  assert.match(result.answer, /Timeline Test launch/);
});

test("dateFallback returns null for a question that isn't about timing", () => {
  assert.equal(lookup.dateFallback("how do i center a div", "", PROG), null);
});

test("dateFallback falls back to the shared timeline with no program", () => {
  assert.doesNotThrow(() => lookup.dateFallback("when does it drop", "", null));
});

test("idOf accepts a record, an id, or nothing", () => {
  assert.equal(lookup.idOf({ id: "acme", name: "Acme" }), "acme");
  assert.equal(lookup.idOf("acme"), "acme");
  assert.equal(lookup.idOf(null), null);
  assert.equal(lookup.idOf({ name: "no id" }), null);
});

test("retrievalQuery augments follow-up questions with program name and thread context", () => {
  const context = "User: what is acme and how does it work\nAssistant: acme is a configured program.";
  const augmented = lookup.retrievalQuery("how does it work", context, { id: "acme", name: "Acme" });
  assert.match(augmented, /Acme/);
  assert.match(augmented, /what is acme and how does it work/);
});

test("retrievalQuery leaves standalone non-follow-up questions intact", () => {
  const standalone = "how do I configure a controller?";
  const result = lookup.retrievalQuery(standalone, "", { id: "acme", name: "Acme" });
  assert.equal(result, standalone);
});

test("stale dynamic sources cannot authorize an exact answer", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: false });
  try {
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Current policy", answer: "18%" },
        { id: "acme", sources: [{ name: "Current policy", type: "dynamic" }] },
      ),
      null,
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("grounding rejects related policy evidence and malformed fenced verdicts", () => {
  assert.equal(
    lookup.exactClaimAllowed(
      {
        source: "Policy",
        groundingVerdict: {
          verdict: "supported",
          claims: [{ claim: "18% is allowed", supported: true, evidenceIds: ["policy"] }],
        },
        evidence: [{ id: "policy", programId: "acme", supportsClaims: ["18% is allowed for another case"] }],
      },
      { id: "acme", sources: [] },
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: "Policy", groundingVerdict: "```json\n{ malformed\n```" },
      { id: "acme", sources: [] },
    ),
    false,
  );
});

test("isAuthoritativeOnlyTopic flags review, hours, AI, and money/fulfillment questions", () => {
  const yes = [
    "will learning Java count in the hours of making an MC mod?",
    "can I journal hand-drawn art?",
    "how long will second review take?",
    "what exactly is first pass?",
    "is my project in the fraud review queue?",
    "why is my project still waiting on review?",
    "how much AI can I use?",
    "when is the exact payout amount going to land?",
    "what's my order status",
  ];
  for (const q of yes) assert.equal(lookup.isAuthoritativeOnlyTopic(q), true, q);

  const no = [
    "what is Acme?",
    "how do I connect hackatime?",
    "where are the docs?",
    "is Acme open to people aged 13-18?",
  ];
  for (const q of no) assert.equal(lookup.isAuthoritativeOnlyTopic(q), false, q);
});

test("fixture B/D: an authoritative-only question with no matched source is rejected, never answered from prior knowledge", () => {
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "yeah learning Java definitely counts toward your project hours" },
      prog,
      "will learning Java count in the hours of making an MC mod?",
    ),
    false,
  );
  assert.equal(
    lookup.exactClaimAllowed(
      { source: null, answer: "second review usually takes about 3 to 5 days" },
      prog,
      "how long will second review take?",
    ),
    false,
  );
});

test("fixture E: a matched source authorizes only the exact number it contains, never an invented one alongside it", () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  const corpus =
    "Acme Docs\nReview: no fixed SLA is published; review can take anywhere from a few days to about two weeks.";
  try {
    assert.equal(
      lookup.exactClaimAllowed(
        { source: "Acme Docs", answer: "second review usually takes exactly 5 days" },
        prog,
        "how long will second review take?",
        corpus,
      ),
      false,
      "an invented digit-count SLA must be rejected even with a matched source",
    );
    assert.equal(
      lookup.exactClaimAllowed(
        {
          source: "Acme Docs",
          answer: "there's no fixed SLA — it can take anywhere from a few days to about two weeks",
        },
        prog,
        "how long will second review take?",
        corpus,
      ),
      true,
      "restating exactly what the source says (with no invented digit claim) must be allowed",
    );
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("an unknown source is rejected even for a non-regex program question", () => {
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  assert.equal(
    lookup.exactClaimAllowed(
      { source: "Foreign Docs", answer: "Acme is open to everyone." },
      prog,
      "what is Acme?",
      "Foreign Docs\nAcme is open to everyone.",
    ),
    false,
  );
});

test("fixture claims cannot bypass the production grounding boundary", () => {
  const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
  assert.equal(
    lookup.exactClaimAllowed(
      {
        source: "Acme Docs",
        answer: "The grant pays five hundred dollars.",
        fixtureClaims: ["The grant pays five hundred dollars."],
      },
      prog,
      "what is the grant amount?",
      "Acme Docs\nGrant amounts vary by tier.",
    ),
    false,
  );
});

test("policy answers with no selected evidence are rejected", async () => {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  try {
    const result = await lookup.applyGroundingBoundaryAsync(
      { source: "Acme Docs", answer: "I don't know." },
      { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] },
      "is AI allowed?",
      "",
      [],
    );
    assert.equal(result, null);
  } finally {
    knowledge.sourceEligibility = original;
  }
});

test("numericClaimsGrounded rejects invented digit-bearing claims and allows ones the corpus actually states", () => {
  assert.equal(
    lookup.numericClaimsGrounded("your project has an 80% chance of passing", "nothing here about odds"),
    false,
  );
  assert.equal(
    lookup.numericClaimsGrounded("software is capped at 30% AI", "the AI policy caps software code at 30% AI usage"),
    true,
  );
  assert.equal(
    lookup.numericClaimsGrounded("that sounds right to me", "irrelevant corpus text"),
    true,
    "no numeric claim at all is always fine",
  );
  assert.equal(lookup.numericClaimsGrounded("80% chance", ""), true, "no corpus supplied is a no-op, not a reject");
});

function ownedFresh() {
  const knowledge = require("./knowledge");
  const original = knowledge.sourceEligibility;
  knowledge.sourceEligibility = () => ({ exactClaimsAllowed: true, authority: "static" });
  return original;
}

test("an exact percentage with no percentage in the corpus is rejected", () => {
  const original = ownedFresh();
  try {
    const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
    const corpus = "Acme Docs\nAI policy is documented qualitatively; ask a helper for the current numbers.";
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "The exact maximum is 30%." },
        prog,
        "what is the exact maximum percentage of AI code allowed?",
        corpus,
      ),
      null,
    );
  } finally {
    require("./knowledge").sourceEligibility = original;
  }
});

test("an unknown payout amount is never fabricated, a documented one passes", () => {
  const original = ownedFresh();
  try {
    const prog = { id: "acme", sources: [{ name: "Acme Docs", type: "text" }] };
    const thinCorpus = "Acme Docs\nPayouts are calculated from approved hours; amounts vary by tier.";
    assert.equal(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "Your payout is $50." },
        prog,
        "what is my exact payout amount?",
        thinCorpus,
      ),
      null,
      "a $50 figure from nowhere must be rejected",
    );
    const richCorpus = "Acme Docs\nPayouts are calculated from approved hours; the base tier pays out $50.";
    assert.ok(
      lookup.applyGroundingBoundary(
        { source: "Acme Docs", answer: "The base tier pays out $50." },
        prog,
        "what is my exact payout amount?",
        richCorpus,
      ),
      "the same figure stated in the corpus must be allowed",
    );
  } finally {
    require("./knowledge").sourceEligibility = original;
  }
});

test("deterministic dispatch reaches validator before retrieval", async () => {
  const order: string[] = [];
  const validator = require("./validator");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const orig = {
    val: validator.validateRepository,
    ctx: knowledge.getContext,
    ans: answer.getAnswerOrChat,
  };
  validator.validateRepository = async (..._a: unknown[]) => {
    order.push("validator");
    return null;
  };
  knowledge.getContext = () => {
    order.push("retrieval");
    return "";
  };
  answer.getAnswerOrChat = async () => {
    order.push("answer");
    return null;
  };
  try {
    await lookup.answerOrChat("can you check https://github.com/u/r for submission readiness", "", {
      program: { id: "acme", name: "Acme" },
    });
    assert.deepEqual(order, ["validator", "retrieval", "answer"]);
  } finally {
    validator.validateRepository = orig.val;
    knowledge.getContext = orig.ctx;
    answer.getAnswerOrChat = orig.ans;
  }
});

test("Firecrawl web fires only inside answerOrChat with allowWebSearch", async () => {
  const firecrawl = require("./firecrawl");
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  let webCalls = 0;
  const origSearch = firecrawl.searchWeb;
  const origCtx = knowledge.getContext;
  const origChat = answer.getAnswerOrChat;
  const origGrounded = answer.getGroundedAnswer;
  firecrawl.searchWeb = async () => {
    webCalls += 1;
    return [];
  };
  knowledge.getContext = () => "";
  answer.getAnswerOrChat = async () => ({ source: null, answer: "" });
  answer.getGroundedAnswer = async () => null;
  try {
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: false });
    assert.equal(webCalls, 0, "no web without explicit allowWebSearch");
    await lookup.answerOrChat("obscure question xyzzy", "", { allowWebSearch: true });
    assert.equal(webCalls, 1, "answerOrChat-only web fallback");
    await lookup.lookupAnswer("obscure question xyzzy", "");
    assert.equal(webCalls, 1, "lookupAnswer (docs-only path) never touches the web");
  } finally {
    firecrawl.searchWeb = origSearch;
    knowledge.getContext = origCtx;
    answer.getAnswerOrChat = origChat;
    answer.getGroundedAnswer = origGrounded;
  }
});

test("cache key includes the program (no cross-program leakage)", () => {
  const cache = require("./cache");
  cache.put("same question everywhere", { source: "Docs", answer: "prog-a answer" }, "prog-a");
  try {
    assert.equal(cache.get("same question everywhere", "prog-b"), null);
    assert.ok(cache.get("same question everywhere", "prog-a"));
  } finally {
    cache.clear?.();
  }
});

test("an end-date question reaches retrieval and rejects an unconfigured answer source", async () => {
  const knowledge = require("./knowledge");
  const answer = require("./answer");
  const orig = { ctx: knowledge.getContext, ans: answer.getAnswerOrChat };
  const prog = { id: "enddate-prog", name: "EndDate", milestones: [], sharedSources: false };
  const seen: string[] = [];
  knowledge.getContext = (_q: string) => {
    seen.push("retrieval");
    return "Acme's current stated final end date is January 1, 2027.";
  };
  answer.getAnswerOrChat = async () => {
    seen.push("answer");
    return { answer: "January 1, 2027.", source: "Acme Pixie Knowledge Base" };
  };
  try {
    const result = await lookup.answerOrChat("when does it end?", "", { program: prog, skipCache: true });
    assert.deepEqual(seen, ["retrieval", "answer"]);
    assert.equal(result, null);
  } finally {
    knowledge.getContext = orig.ctx;
    answer.getAnswerOrChat = orig.ans;
  }
});
export {};
