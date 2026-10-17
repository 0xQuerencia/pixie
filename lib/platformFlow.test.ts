process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token";

interface TestRow {
  program?: { id: string };
  username?: string;
  [key: string]: unknown;
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const lookup = require("./lookup");
const respond = require("./respond");
const api = require("./web/api");
const lifecycle = require("./lifecycle");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

test("hosted loop end to end for Highway and Acme", async () => {
  const hwy = api.internalProgramSync("e2e-hwy", {
    name: "Highway",
    workspaceId: "TE2E",
    supportName: "Highway Help",
    helpChannel: "C-E2E-HWY",
    channels: ["C-E2E-HWY"],
    organizerChannel: "C-E2E-HWY-ORG",
    sources: [{ name: "E2E Highway Docs", type: "text", content: "Highway ships October 31." }],
    claimedBy: "U-org",
    programChannels: [
      { id: "C-E2E-HWY", kind: "help" },
      { id: "C-E2E-HWY-ORG", kind: "organizer" },
    ],
  });
  assert.equal(hwy.ok, true);
  assert.equal(db.isHelper("e2e-hwy", "U-org"), true, "creator bootstrapped as organizer");
  db.handle().query("UPDATE programs SET lifecycle = 'approved' WHERE id = ?").run("e2e-hwy");
  assert.equal(lifecycle.transition("e2e-hwy", "active", "U-org").ok, true);

  const pxl = api.internalProgramSync("e2e-acme", {
    name: "Acme",
    workspaceId: "TE2E",
    helpChannel: "C-E2E-PXL",
    channels: ["C-E2E-PXL"],
    organizerChannel: "C-E2E-PXL-ORG",
    sources: [{ name: "E2E Acme Docs", type: "text", content: "Acme ships August 18." }],
    claimedBy: "U-org2",
    programChannels: [
      { id: "C-E2E-PXL", kind: "help" },
      { id: "C-E2E-PXL-ORG", kind: "organizer" },
    ],
  });
  assert.equal(pxl.ok, true);
  db.handle().query("UPDATE programs SET lifecycle = 'approved' WHERE id = ?").run("e2e-acme");
  assert.equal(lifecycle.transition("e2e-acme", "active", "U-org2").ok, true);

  assert.equal(programs.forChannel("C-E2E-HWY", "TE2E").id, "e2e-hwy");
  assert.equal(programs.forChannel("C-E2E-PXL", "TE2E").id, "e2e-acme");

  const realAnswer = lookup.answerOrChat;
  lookup.answerOrChat = async (question: string, contextPrompt: string, opts: TestRow = {}) => {
    const pid = opts.program ? opts.program.id : null;
    return pid === "e2e-hwy"
      ? { source: "E2E Highway Docs", answer: "October 31" }
      : { source: "E2E Acme Docs", answer: "August 18" };
  };
  const posts: TestRow[] = [];
  const client = {
    chat: {
      postMessage: async (p: TestRow) => {
        posts.push(p);
        return { ts: `ts-${posts.length}` };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}) },
  };
  try {
    await respond.respond({
      client,
      channel: "C-E2E-HWY",
      threadTs: "e2e-t1",
      userId: "U-asker",
      question: "when is the deadline",
      mode: respond.ALWAYS,
      workspaceId: "TE2E",
    });
  } finally {
    lookup.answerOrChat = realAnswer;
  }
  assert.ok(posts.length >= 1);
  assert.ok(
    posts.some((p: TestRow) => p.username === "Highway Help"),
    "answer carries program branding",
  );

  const realAnswer2 = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: null, answer: null });
  const posts2: TestRow[] = [];
  const client2 = {
    chat: {
      postMessage: async (p: TestRow) => {
        posts2.push(p);
        return { ts: "x" };
      },
      update: async () => ({}),
      delete: async () => ({}),
    },
    reactions: { add: async () => ({}) },
  };
  const intent = require("./intent");
  const realClassify = intent.classifyIntent;
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  try {
    await respond.respond({
      client: client2,
      channel: "C-E2E-HWY",
      threadTs: "e2e-t2",
      userId: "U-asker",
      question: "can I get a private extension on my grant",
      mode: respond.HELP_ONLY,
      workspaceId: "TE2E",
    });
  } finally {
    lookup.answerOrChat = realAnswer2;
    intent.classifyIntent = realClassify;
  }
  const ticket = db.getTicketByThreadTs("e2e-t2", "TE2E");
  assert.ok(ticket, "escalation filed a ticket");
  assert.equal(ticket.program_id, "e2e-hwy");

  db.syncHelper({ programId: "e2e-hwy", userId: "U-helper", source: "manual" });
  assert.equal(api.internalTicketAction(ticket.id, "claim", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  const tickets = require("./tickets");
  const replyRes = await tickets.replyToTicket({
    ticketId: ticket.id,
    authorId: "U-helper",
    text: "looking into it",
    client,
  });
  assert.equal(replyRes.ok, true);
  assert.equal(api.internalTicketAction(ticket.id, "resolve", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
  assert.equal(api.internalTicketAction(ticket.id, "reopen", { programId: "e2e-hwy", actorId: "U-helper" }).ok, true);
  assert.equal(db.getTicket(ticket.id).status, "reopened");

  assert.equal(db.searchTickets({ programId: "e2e-acme" }).total, 0);
});
export {};
