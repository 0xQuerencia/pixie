process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const api = require("./web/api");
const incidents = require("./incidents");
const pipeline = require("./resolutionPipeline");
const activeLearning = require("./activeLearning");
const llm = require("./llm");
const macros = require("./macros");
const tickets = require("./tickets");
const helperRoute = require("./helperRoute");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  api.setSlackClient(null);
  programs.invalidate();
});

test("macro selector routes require actorId and authorize the program helper", async () => {
  const programId = "review-auth";
  const helperId = "U-review-helper";
  db.saveProgram({ id: programId, name: "Review auth", helpChannel: "C-review-auth", channels: ["C-review-auth"] });
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  programs.invalidate();

  const serve = require("./web/serve");
  const token = "review-auth-token";
  const previousToken = process.env.PIXIE_INTERNAL_TOKEN;
  process.env.PIXIE_INTERNAL_TOKEN = token;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const waiting = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/programs/${programId}/macros/waiting?actorId=${helperId}`, { headers }),
    );
    assert.equal(waiting.status, 200);
    const templates = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/programs/${programId}/macros/templates?actorId=${helperId}`, {
        headers,
      }),
    );
    assert.equal(templates.status, 200);

    const unauthWaiting = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/programs/${programId}/macros/waiting`, { headers }),
    );
    assert.equal(unauthWaiting.status, 403);
    const unauthTemplates = await serve.handleRequest(
      new Request(`http://localhost/internal/v1/programs/${programId}/macros/templates`, { headers }),
    );
    assert.equal(unauthTemplates.status, 403);
  } finally {
    if (previousToken === undefined) delete process.env.PIXIE_INTERNAL_TOKEN;
    else process.env.PIXIE_INTERNAL_TOKEN = previousToken;
  }
});

test("active incident matching requires an affected service and outage language", () => {
  const programId = "review-incident";
  db.saveProgram({
    id: programId,
    name: "Incident",
    helpChannel: "C-review-incident",
    channels: ["C-review-incident"],
  });
  programs.invalidate();
  const created = incidents.createIncident({
    programId,
    title: "Acme site is currently down",
    description: "People cannot access the website",
    publicMessage: "The Acme site is currently down.",
    actorId: "U-incident-helper",
  });
  assert.equal(created.ok, true);
  for (const question of [
    "Can I access the site to submit my project?",
    "Where do I submit my YSWS project?",
    "How do I submit a project on Acme?",
    "Can I log in before submitting my project?",
    "Where is the login button for my YSWS account?",
    "How do I navigate to the submission page?",
    "What is the deadline for submitting my project?",
    "When will my project review be finished?",
    "Can I edit my submission before the deadline?",
    "What happens after I submit my project for review?",
    "Where can I read the project requirements?",
  ]) {
    assert.equal(incidents.matchActiveIncident({ programId, question }), null, question);
  }
  for (const question of ["is the site down?", "acme won't load", "cant open the website"]) {
    assert.ok(incidents.matchActiveIncident({ programId, question }), question);
  }
});

test("resolution transcripts stop at message and character caps", async () => {
  const ticketId = db.createTicket({
    programId: "review-resolution-cap",
    channel: "C-resolution-cap",
    threadTs: "review-resolution-cap-thread",
    requesterId: "U-requester",
    question: "How do I submit my project?",
  });
  db.resolveTicket(ticketId, "Use the form.", "U-helper");
  const ticket = db.getTicket(ticketId);
  let calls = 0;
  const transcriptPage = Array.from({ length: 100 }, (_: unknown, i: number) => ({
    user: "U-requester",
    text: `${i} ${"x".repeat(300)}`,
  }));
  const client = {
    conversations: {
      replies: async () => {
        calls += 1;
        return { messages: transcriptPage, response_metadata: { next_cursor: calls < 4 ? `page-${calls}` : "" } };
      },
    },
  };
  const transcript = await pipeline.loadThread({ ticket, client });
  assert.ok(transcript.length <= 200);
  assert.ok(transcript.join("\n").length <= 24000);
  assert.equal(calls, 2);

  const originalComplete = llm.complete;
  let request: { messages: Array<{ content: string }> } | null = null;
  llm.complete = async (options: { messages: Array<{ content: string }> }) => {
    request = options;
    throw new Error("provider unavailable");
  };
  try {
    const summary = await pipeline.summarizeResolution({ ticket, client });
    assert.ok(summary.length <= 24000);
    if (!request) throw new Error("completion request was not captured");
    const completionRequest = request as { messages: Array<{ content: string }> };
    assert.ok(completionRequest.messages[1].content.length <= 24000);
  } finally {
    llm.complete = originalComplete;
  }
});

test("active learning supersedes only questions with matching intent or informative overlap", async () => {
  const programId = "review-learning-intent";
  db.saveProgram({ id: programId, name: "Learning intent", learning: "auto" });
  programs.invalidate();
  const extractions = [
    { problem: "Where is my YSWS submission?", solution: "Check the submissions page.", category: "review" },
    { problem: "Can I edit my YSWS submission?", solution: "No, contact a helper.", category: "review" },
    {
      problem: "When do payouts arrive?",
      solution: "Payouts arrive after approval.",
      category: "fulfillment_shipping",
    },
    {
      problem: "Am I eligible for a payout?",
      solution: "Check the eligibility rules.",
      category: "fulfillment_shipping",
    },
    { problem: "How long does review take?", solution: "Reviews usually take a few days.", category: "review" },
    {
      problem: "How long does the review take right now?",
      solution: "The current review queue is moving today.",
      category: "review",
    },
  ];
  const originalComplete = llm.complete;
  let index = 0;
  llm.complete = async () => ({ text: JSON.stringify(extractions[index++]) });
  try {
    const results: Array<{ fact: { id: number } }> = [];
    for (let i = 0; i < extractions.length; i += 1) {
      const id = db.createTicket({
        programId,
        channel: "C-learning-intent",
        threadTs: `review-learning-intent-${i}`,
        requesterId: "U-requester",
        question: extractions[i].problem,
        category: extractions[i].category,
      });
      db.resolveTicket(id, "Resolved by helper.", "U-helper");
      results.push(await activeLearning.learnFromResolution({ ticket: db.getTicket(id), workerId: "U-helper" }));
    }
    assert.equal(db.getLearnedFactById(results[0].fact.id).status, "candidate");
    assert.equal(db.getLearnedFactById(results[0].fact.id).superseded_by, null);
    assert.equal(db.getLearnedFactById(results[2].fact.id).superseded_by, null);
    assert.equal(db.getLearnedFactById(results[4].fact.id).status, "superseded");
  } finally {
    llm.complete = originalComplete;
  }
});

test("requester follow-up reclassifies by its own signal but preserves human category", () => {
  const programId = "review-reclassify";
  const program = {
    id: programId,
    name: "Reclassify",
    helpChannel: "C-review-reclassify",
    channels: ["C-review-reclassify"],
    categories: require("./ticketCategory").defaultTaxonomy(),
  };
  db.saveProgram(program);
  programs.invalidate();
  const ticketId = db.createTicket({
    programId,
    channel: program.helpChannel,
    threadTs: "review-reclassify-thread",
    requesterId: "U-requester",
    question: "Can I submit my project for review?",
  });
  db.setTicketTriage(ticketId, { category: "review", categorySource: "classifier" });
  tickets.noteThreadActivity({
    channel: program.helpChannel,
    threadTs: "review-reclassify-thread",
    userId: "U-requester",
    text: "Where is my payout for the project?",
  });
  assert.equal(db.getTicket(ticketId).category, "fulfillment_shipping");

  const humanId = db.createTicket({
    programId,
    channel: program.helpChannel,
    threadTs: "review-reclassify-human",
    requesterId: "U-requester",
    question: "Can I submit my project for review?",
  });
  db.setTicketTriage(humanId, { category: "review" });
  tickets.noteThreadActivity({
    channel: program.helpChannel,
    threadTs: "review-reclassify-human",
    userId: "U-requester",
    text: "Where is my payout for the project?",
  });
  assert.equal(db.getTicket(humanId).category, "review");
  const resolvedId = db.createTicket({
    programId,
    channel: program.helpChannel,
    threadTs: "review-reclassify-resolved",
    requesterId: "U-requester",
    question: "Can I submit my project for review?",
  });
  db.resolveTicket(resolvedId, "done", "U-helper");
  tickets.noteThreadActivity({
    channel: program.helpChannel,
    threadTs: "review-reclassify-resolved",
    userId: "U-requester",
    text: "Where is my payout for the project?",
  });
  assert.equal(db.getTicket(resolvedId).category, null);
});

test("resolved macro uses canonical resolution attribution and schedules learning", async () => {
  const programId = "review-macro-resolve";
  const helperId = "U-macro-worker";
  db.saveProgram({
    id: programId,
    name: "Macro resolve",
    helpChannel: "C-macro-resolve",
    channels: ["C-macro-resolve"],
  });
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  programs.invalidate();
  const macro = macros.create({
    programId,
    trigger: "?resolve-review",
    name: "Resolve",
    content: "Done.",
    onSendTransition: "resolved",
    createdBy: helperId,
  });
  const ticketId = db.createTicket({
    programId,
    channel: "C-macro-resolve",
    threadTs: "review-macro-resolve-thread",
    requesterId: "U-requester",
    question: "help",
  });
  const scheduled: Array<{ workerId: string }> = [];
  const originalSchedule = pipeline.schedule;
  pipeline.schedule = ((args: { workerId: string }) => scheduled.push(args)) as typeof pipeline.schedule;
  try {
    const result = await macros.send({
      id: macro.macro.id,
      ticketId,
      actorId: helperId,
      client: { chat: { postMessage: async () => ({ ts: "macro-ts" }) } },
    });
    assert.equal(result.ok, true);
  } finally {
    pipeline.schedule = originalSchedule;
  }
  assert.equal(db.getTicket(ticketId).status, "resolved");
  assert.equal(
    helperRoute.getExpertise(programId, helperId).find((row: { tag: string }) => row.tag === "general")?.solved_count,
    1,
  );
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].workerId, helperId);
  assert.equal(
    db.listTicketEvents(ticketId).some((event: { event_type: string }) => event.event_type === "macro_sent"),
    true,
  );
});

test("reply final open guard reports a close race before posting", async () => {
  const programId = "review-bulk-race";
  const helperId = "U-bulk-helper";
  db.saveProgram({ id: programId, name: "Bulk race", helpChannel: "C-bulk-race", channels: ["C-bulk-race"] });
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  programs.invalidate();
  const ticketId = db.createTicket({
    programId,
    channel: "C-bulk-race",
    threadTs: "review-bulk-race-thread",
    requesterId: "U-requester",
    question: "help",
  });
  db.markTicketWaitingForHelper(ticketId);
  db.resolveTicket(ticketId, "closed by another helper", "U-other");
  let posted = false;
  const result = await tickets.replyToTicket({
    ticketId,
    authorId: helperId,
    text: "not sent",
    client: {
      chat: {
        postMessage: async () => {
          posted = true;
          return { ts: "race" };
        },
      },
    },
    programId,
    requireOpen: true,
  });
  assert.match(result.error, /not open/);
  assert.equal(posted, false);
});
export {};
