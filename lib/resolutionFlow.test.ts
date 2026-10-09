process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const tickets = require("./tickets") as unknown as TestTickets;
const helperRoute = require("./helperRoute") as typeof import("./helperRoute");
const resolutionPipeline = require("./resolutionPipeline") as unknown as TestResolutionPipeline;
const llm = require("./llm") as unknown as TestLlm;

before(() => {
  db.close();
  db.open(":memory:");
});

function setup(id) {
  db.saveProgram({ id, name: id, posture: "active", helpChannel: `C-${id}`, channels: [`C-${id}`], learning: "auto" });
  for (const userId of ["U-alice", "U-bob"]) {
    db.syncHelper({ programId: id, userId, source: "test", role: "helper" });
  }
  helperRoute.setExpertise({ programId: id, userId: "U-alice", tags: ["review"] });
  helperRoute.setExpertise({ programId: id, userId: "U-bob", tags: [] });
}

function openTicket(programId, suffix, question) {
  const id = db.createTicket({
    programId,
    channel: `C-${programId}`,
    threadTs: `${programId}-${suffix}`,
    requesterId: "U-requester",
    question,
    category: "review",
  });
  return db.getTicket(id);
}

function stubModel(extraction) {
  const original = llm.complete;
  llm.complete = async (_opts, label) =>
    label === "resolution-summary"
      ? { text: "Requester asked about review timing; Bob explained the queue." }
      : { text: JSON.stringify(extraction) };
  return () => {
    llm.complete = original;
  };
}

async function resolveAndSettle(ticket, actorId, resolution) {
  const result = tickets.resolveTicket({ ticketId: ticket.id, actorId, programId: ticket.program_id, resolution });
  assert.equal(result.ok, true);
  await resolutionPipeline.onResolved({
    ticket: db.getTicket(ticket.id),
    actorId,
    workerId: tickets.resolveTicketWorker(db.getTicket(ticket.id), actorId),
  });
  return db.getTicket(ticket.id);
}

test("a handoff resolution credits, summarizes and teaches as the helper who answered", async () => {
  const programId = "flow-handoff";
  setup(programId);
  const restore = stubModel({
    problem: "how long does review take",
    solution: "Reviews take about 7 days right now.",
    category: "review",
  });
  try {
    const ticket = openTicket(programId, "one", "How long does review take?");
    assert.equal(db.assignTicket(ticket.id, "U-alice"), true);
    tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: ticket.thread_ts, userId: "U-bob" });

    await resolveAndSettle(ticket, "U-bob", "Reviews take about 7 days right now.");

    assert.equal(helperRoute.recommend({ programId, category: "review", limit: 1 })[0].userId, "U-bob");
    assert.match(db.getResolutionSummary(ticket.id).resolution_summary, /queue/);
    const fact = db.learnedFactForTicket(ticket.id);
    assert.equal(fact.status, "candidate");
    assert.equal(fact.resolver_id, "U-bob");
  } finally {
    restore();
  }
});

test("a newer overlapping answer supersedes the older learned fact", async () => {
  const programId = "flow-recency";
  setup(programId);
  let restore = stubModel({
    problem: "how long does review take",
    solution: "Reviews take about 7 days.",
    category: "review",
  });
  let first;
  try {
    first = openTicket(programId, "old", "How long does review take?");
    tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: first.thread_ts, userId: "U-bob" });
    await resolveAndSettle(first, "U-bob", "Reviews take about 7 days.");
  } finally {
    restore();
  }

  restore = stubModel({
    problem: "how long does review take",
    solution: "Reviews take about 14 days because the queue is backed up.",
    category: "review",
  });
  try {
    const second = openTicket(programId, "new", "How long does the review take?");
    tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: second.thread_ts, userId: "U-alice" });
    await resolveAndSettle(second, "U-alice", "Reviews take about 14 days because the queue is backed up.");

    assert.equal(db.learnedFactForTicket(first.id).status, "superseded");
    const candidates = db.listReviewableLearnedFacts(programId);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0].answer, /14 days/);
  } finally {
    restore();
  }
});

test("a reopened ticket resolved again still reaches the learning step", async () => {
  const programId = "flow-reopen";
  setup(programId);
  const restore = stubModel({
    problem: "can I resubmit",
    solution: "Yes, resubmit from the project page.",
    category: "review",
  });
  try {
    const ticket = openTicket(programId, "reopen", "Can I resubmit my project?");
    db.setResolutionSummary(ticket.id, "An earlier summary from a first resolution.");
    tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: ticket.thread_ts, userId: "U-bob" });

    await resolveAndSettle(ticket, "U-bob", "Yes, resubmit from the project page.");

    assert.equal(db.getResolutionSummary(ticket.id).resolution_summary, "An earlier summary from a first resolution.");
    assert.equal(db.learnedFactForTicket(ticket.id).status, "candidate");
  } finally {
    restore();
  }
});
export {};
import type { TestDb, TestLlm, TestResolutionPipeline, TestTickets } from "./test.types";
