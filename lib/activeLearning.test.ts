process.env.PIXIE_DB_PATH = ":memory:";

interface TicketOptions {
  requesterId?: string;
  question?: string;
  category?: string;
  resolution?: string;
  resolvedBy?: string;
}
interface FactRow {
  id: number;
  answer: string;
  status: string;
  auto_learned: number;
  ticket_id: number;
  resolver_id: string;
  verified_at: number;
  superseded_by: number | null;
  support_count: number;
}
interface LearningResult {
  ok?: boolean;
  autoLearned?: boolean;
  refreshed?: boolean;
  skipped?: boolean;
  fact: FactRow;
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const tickets = require("./tickets");
const activeLearning = require("./activeLearning");
const ticketCategory = require("./ticketCategory");
const llm = require("./llm");
const learn = require("./learn");
const resolutionMemory = require("./resolutionMemory");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

function resolvedTicket(programId: string, suffix: string, options: TicketOptions = {}): Record<string, unknown> {
  const id = db.createTicket({
    programId,
    channel: "C-" + programId,
    threadTs: "al-" + programId + "-" + suffix,
    requesterId: options.requesterId || "U-requester",
    question: options.question || "How do I reset my account access?",
    category: options.category || "account_access",
  });
  db.resolveTicket(
    id,
    options.resolution === undefined ? "Reset the account password and sign in again." : options.resolution,
    options.resolvedBy || "U-helper",
  );
  return db.getTicket(id);
}

function stubExtraction(results: Array<Record<string, string>>) {
  const original = llm.complete;
  let index = 0;
  llm.complete = async () => ({ text: JSON.stringify(results[Math.min(index++, results.length - 1)]) });
  return () => {
    llm.complete = original;
  };
}

test("helper-verified resolutions remain reviewable candidates with provenance", async () => {
  programs.saveProgram({ id: "al-auto", name: "Auto", learning: "auto" });
  const restore = stubExtraction([
    { problem: "account access reset", solution: "Reset the password.", category: "account_access" },
  ]);
  try {
    const result = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-auto", "one"),
    })) as LearningResult;
    assert.equal(result.ok, true);
    assert.equal(result.autoLearned, false);
    assert.equal(result.fact.status, "candidate");
    assert.equal(result.fact.auto_learned, 0);
    assert.equal(result.fact.ticket_id > 0, true);
    assert.equal(result.fact.resolver_id, "U-helper");
    assert.equal(result.fact.verified_at, null);
    assert.equal(db.approvedFacts(20, "al-auto").length, 0);
    assert.equal(resolutionMemory.listCandidates("al-auto")[0].auto_learned, 0);
  } finally {
    restore();
  }
});

test("review mode keeps the learned resolution in the review list", async () => {
  programs.saveProgram({ id: "al-review", name: "Review", learning: "review" });
  const restore = stubExtraction([
    { problem: "account access reset", solution: "Reset the password.", category: "account_access" },
  ]);
  try {
    const result = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-review", "one"),
    })) as LearningResult;
    assert.equal(result.fact.status, "candidate");
    assert.equal(result.fact.auto_learned, 0);
    assert.ok(db.listReviewableLearnedFacts("al-review").some((row: FactRow) => row.id === result.fact.id));
  } finally {
    restore();
  }
});

test("overlapping newer answers supersede older facts", async () => {
  programs.saveProgram({ id: "al-overlap", name: "Overlap", learning: "auto" });
  const restore = stubExtraction([
    { problem: "reset account access", solution: "Use the old reset page.", category: "account_access" },
    { problem: "reset account access", solution: "Use the new reset page.", category: "account_access" },
  ]);
  try {
    const first = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-overlap", "one"),
    })) as LearningResult;
    const second = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-overlap", "two"),
    })) as LearningResult;
    const old = db.getLearnedFactById(first.fact.id);
    assert.equal(old.status, "superseded");
    assert.equal(old.superseded_by, second.fact.id);
    assert.equal(second.fact.status, "candidate");
    assert.equal(
      db.approvedFacts(20, "al-overlap").some((row: FactRow) => row.answer.includes("old reset")),
      false,
    );
    assert.equal(
      learn
        .relevantFacts("reset account access", "al-overlap")
        .some((row: FactRow) => row.answer.includes("old reset")),
      false,
    );
  } finally {
    restore();
  }
});

test("same overlapping answer refreshes support count instead of duplicating", async () => {
  programs.saveProgram({ id: "al-refresh", name: "Refresh", learning: "auto" });
  const restore = stubExtraction([
    { problem: "reset account access", solution: "Use the reset page.", category: "account_access" },
    { problem: "reset account access", solution: "Use the reset page.", category: "account_access" },
  ]);
  try {
    const first = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-refresh", "one"),
    })) as LearningResult;
    const second = (await activeLearning.learnFromResolution({
      ticket: resolvedTicket("al-refresh", "two"),
    })) as LearningResult;
    assert.equal(second.refreshed, true);
    assert.equal(second.fact.id, first.fact.id);
    assert.equal(second.fact.support_count, 2);
    assert.equal(db.learnedFactsForOverlap("al-refresh", "account_access").length, 1);
  } finally {
    restore();
  }
});

test("requester-only resolutions and empty answers never enter learned facts", async () => {
  programs.saveProgram({ id: "al-safety", name: "Safety", learning: "auto" });
  const requester = resolvedTicket("al-safety", "requester", { resolvedBy: "U-requester" });
  const empty = resolvedTicket("al-safety", "empty", { resolution: "" });
  const before = db.handle().query("SELECT COUNT(*) AS n FROM learned_facts WHERE program_id = ?").get("al-safety").n;
  assert.equal((await activeLearning.learnFromResolution({ ticket: requester })).skipped, true);
  assert.equal((await activeLearning.learnFromResolution({ ticket: empty })).skipped, true);
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS n FROM learned_facts WHERE program_id = ?").get("al-safety").n,
    before,
  );
});

test("default taxonomy classifies and requester follow-ups reclassify open tickets", async () => {
  const program = {
    id: "al-category",
    name: "Category",
    posture: "active",
    helpChannel: "C-al-category",
    channels: ["C-al-category"],
  };
  assert.deepEqual(ticketCategory.configuredCategories(ticketCategory.defaultTaxonomy()), [
    "account_access",
    "advice_how_to",
    "fulfillment_shipping",
    "other",
    "review",
    "site_bug",
  ]);
  const first = await tickets.ensureSupportTicket({
    program,
    channel: program.helpChannel,
    threadTs: "al-category-thread",
    requesterId: "U-requester",
    question: "Please help me set this up",
    client: null,
  });
  assert.equal(first.category, "advice_how_to");
  const followed = await tickets.ensureSupportTicket({
    program,
    channel: program.helpChannel,
    threadTs: "al-category-thread",
    requesterId: "U-requester",
    question: "Where is the tracking for my order?",
    client: null,
  });
  assert.equal(followed.category, "fulfillment_shipping");
});
export {};
