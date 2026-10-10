process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const knowledge = require("./knowledge");
const tickets = require("./tickets") as unknown as TestTickets;
const respond = require("./respond") as unknown as {
  ALWAYS: string;
  HELP_ONLY: string;
  respond(...args: unknown[]): Promise<unknown>;
};
const answer = require("./answer") as unknown as {
  getAnswerOrChatStream: (...args: unknown[]) => Promise<unknown>;
  getAnswerOrChat: (...args: unknown[]) => Promise<unknown>;
};
const intent = require("./intent") as unknown as {
  HELP_NEEDED: string;
  CASUAL_CHAT: string;
  classifyIntent: (...args: unknown[]) => Promise<string>;
};

const HELP = "C-st-help";
const ORG = "C-st-org";

function clientSpy() {
  const posts = [];
  const reactionsAdded = [];
  const reactionsRemoved = [];
  return {
    posts,
    reactionsAdded,
    reactionsRemoved,
    chat: {
      postMessage: async (p) => {
        posts.push({ ...p });
        return { ts: `ts-${posts.length}` };
      },
      update: async (p) => {
        posts.push({ ...p, isUpdate: true });
        return { ts: p.ts };
      },
      delete: async () => ({ ok: true }),
      postEphemeral: async () => ({ ok: true }),
    },
    reactions: {
      add: async (p) => {
        reactionsAdded.push(p);
        return { ok: true };
      },
      remove: async (p) => {
        reactionsRemoved.push(p);
        return { ok: true };
      },
    },
  };
}

const FLEET = JSON.stringify([
  {
    id: "st-prog",
    name: "Support Prog",
    posture: "active",
    scope: "program",
    helpChannel: HELP,
    channels: [HELP],
    organizerChannel: ORG,
    sources: [
      {
        name: "Docs",
        type: "text",
        content:
          "Repositories should be public for review. Support questions can be answered in this channel. Yes, as long as it's public.",
      },
    ],
    links: { docs: "https://example.test/docs" },
  },
  {
    id: "st-acme",
    name: "Acme",
    posture: "passive",
    helpChannel: "C-st-acme-help",
    channels: ["C-st-acme-help"],
  },
]);

let savedBlob;
const realStream = answer.getAnswerOrChatStream;
const realAnswer = answer.getAnswerOrChat;
const realIntent = intent.classifyIntent;

before(() => {
  db.close();
  db.open(":memory:");
  savedBlob = process.env.PIXIE_PROGRAMS_JSON;
});

beforeEach(() => {
  process.env.PIXIE_PROGRAMS_JSON = FLEET;
  programs.invalidate();
  const docs = programs.get("st-prog").sources[0];
  (db as unknown as { saveSourceText(name: string, text: string): void }).saveSourceText(
    knowledge.sourceCacheKey(docs),
    String(docs.content || ""),
  );
  knowledge.invalidate();
  intent.classifyIntent = async () => intent.HELP_NEEDED;
});

afterEach(() => {
  answer.getAnswerOrChatStream = realStream;
  answer.getAnswerOrChat = realAnswer;
  intent.classifyIntent = realIntent;
  if (savedBlob === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
  else process.env.PIXIE_PROGRAMS_JSON = savedBlob;
  programs.invalidate();
  knowledge.invalidate();
});

let askN = 0;
async function ask(
  client,
  threadTs,
  question,
  { messageTs, mode = respond.ALWAYS, userId }: { messageTs?: string; mode?: string; userId?: string } = {},
) {
  return respond.respond({
    client,
    channel: HELP,
    threadTs,
    messageTs: messageTs || threadTs,
    userId: userId || `U-asker-${(askN += 1)}`,
    question,
    mode,
  });
}

test("knows the answer: ticket opens, answer posts in the same thread, ticket stays OPEN", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({
    source: "Docs",
    answer: "yes, as long as it's public",
  });
  const client = clientSpy();
  await ask(client, "t-knows", "does my repo need to be public?");

  const ticket = db.getTicketByThreadTs("t-knows");
  assert.ok(ticket, "a ticket exists even though Pixie answered");
  assert.equal(ticket.status, "open");

  const texts = client.posts.map((p) => p.text || "");
  assert.ok(
    texts.some((t) => /Someone will be here to help you soon/.test(t)),
    "open ticket UI in the thread",
  );
  assert.ok(
    texts.some((t) => /public/.test(t)),
    "Pixie's answer in the same thread",
  );
  const uiMsg = client.posts.find((p) => /Someone will be here/.test(p.text || ""));
  assert.ok(uiMsg.blocks.find((b) => b.type === "actions")?.elements.some((e) => e.action_id === "st_resolve"));
  assert.match(JSON.stringify(uiMsg.blocks), /example\.test\/docs/);
});

test("doesn't know the answer: the ticket opens identically and moves to waiting_for_helper", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  const client = clientSpy();
  await ask(client, "t-unknown", "what is error 0x88?", { mode: respond.HELP_ONLY });

  const ticket = db.getTicketByThreadTs("t-unknown");
  assert.ok(ticket);
  assert.ok(["open", "waiting_for_helper", "assigned"].includes(ticket.status));
  assert.ok(client.posts.some((p) => /Someone will be here to help you soon/.test(p.text || "")));
  assert.ok(
    client.posts.some((p) => p.channel === ORG),
    "organizer card posted",
  );
});

test("the same root event delivered twice yields exactly one ticket and one ticket UI", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-dupe", "how are journals graded?");
  await ask(client, "t-dupe", "how are journals graded?");

  const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-dupe");
  assert.equal(rows.length, 1);
  const uiMsgs = client.posts.filter((p) => /Someone will be here to help you soon/.test(p.text || "") && !p.isUpdate);
  assert.equal(uiMsgs.length, 1, "the open ticket UI is posted once");
});

test("a reply inside an existing ticket thread does not open a second ticket", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-thread", "root question about demos");
  const before = db.getTicketByThreadTs("t-thread").id;

  await ask(client, "t-thread", "and what about a CLI?", { messageTs: "t-thread-reply-1", mode: respond.HELP_ONLY });

  const rows = db.handle().query("SELECT id FROM tickets WHERE thread_ts = ?").all("t-thread");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, before);
});

test("resolve is idempotent: two clicks, one transition, one confirmation, no stale button", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-res", "a real question", { userId: "U-res" });
  const ticket = db.getTicketByThreadTs("t-res");

  const a = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-res", client });
  const b = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-res", client });
  assert.equal(a.ok, true);
  assert.equal(b.deduped, true);
  assert.equal(db.listTicketEvents(ticket.id).filter((e) => e.event_type === "resolved").length, 1);

  const updates = client.posts.filter((p) => p.isUpdate);
  assert.ok(updates.length > 0);
  assert.ok(client.posts.some((ui) => /Resolved|resolved/i.test(ui.text || "")));
  assert.ok(
    updates.every((ui) => !JSON.stringify(ui.blocks).includes("st_resolve")),
    "no stale Mark as resolved button",
  );
  assert.ok(updates.some((ui) => JSON.stringify(ui.blocks).includes("st_reopen")));
});

test("resolve -> reopen -> resolve repeats without corrupting state", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-cycle", "a real question", { userId: "U-cyc" });
  const id = db.getTicketByThreadTs("t-cycle").id;

  await tickets.publicResolveTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "resolved");
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).reopen_count, 1, "double reopen click doesn't bump the count");
  await tickets.publicResolveTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).status, "resolved");
  await tickets.publicReopenTicket({ ticketId: id, actorId: "U-cyc", client });
  assert.equal(db.getTicket(id).reopen_count, 2);
  assert.match(client.posts.map((p) => p.text || "").join(" "), /Ticket reopened by <@U-cyc>/);
});

test("a ticket puts a marker reaction on the requester's message, swapped for a check on resolve", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-react", "a real question", { userId: "U-react" });

  const opened = client.reactionsAdded.find((r) => r.timestamp === "t-react");
  assert.ok(opened, "a reaction lands on the root message");
  assert.equal(opened.name, "ticket");

  await tickets.publicResolveTicket({ ticketId: db.getTicketByThreadTs("t-react").id, actorId: "U-react", client });
  await new Promise((r) => setImmediate(r));
  assert.ok(
    client.reactionsAdded.some((r) => r.timestamp === "t-react" && r.name === "white_check_mark"),
    "resolve adds the check",
  );
  assert.ok(
    client.reactionsRemoved.some((r) => r.timestamp === "t-react" && r.name === "ticket"),
    "resolve drops the open marker",
  );
});

test("help channel chatter opens no ticket; the engagement classifier filters it (spec §20)", async () => {
  intent.classifyIntent = async () => intent.CASUAL_CHAT;
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: null, answer: "haha" });
  const client = clientSpy();
  await ask(client, "t-chat", "lmao nice", { mode: respond.HELP_ONLY });
  assert.equal(db.getTicketByThreadTs("t-chat"), null, "chatter opens no ticket");
  assert.equal(client.posts.length, 0, "and nothing is posted");
});

test("a passive program (Acme) opens no ticket; the active program does", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });

  const c1 = clientSpy();
  await respond.respond({
    client: c1,
    channel: "C-st-acme-help",
    threadTs: "t-acme",
    messageTs: "t-acme",
    userId: "U1",
    question: "how do i submit?",
    mode: respond.ALWAYS,
  });
  assert.equal(db.getTicketByThreadTs("t-acme"), null, "Acme is passive — answer only, no ticket");

  const c2 = clientSpy();
  await ask(c2, "t-active", "how do i submit?");
  const t = db.getTicketByThreadTs("t-active");
  assert.ok(t);
  assert.equal(t.program_id, "st-prog");
});

test("tickets and their organizer channel belong to the question's own program", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  const client = clientSpy();
  await ask(client, "t-scope", "unanswerable thing", { mode: respond.HELP_ONLY });

  const ticket = db.getTicketByThreadTs("t-scope");
  assert.equal(ticket.program_id, "st-prog");
  assert.equal(tickets.getOrganizerChannel(programs.get("st-prog")), ORG);
  const card = client.posts.find((p) => p.channel === ORG);
  assert.ok(card, "card goes to this program's organizer channel, not another's");
});

test("a classified support message Pixie can't answer still opens a ticket", async () => {
  intent.classifyIntent = async () => intent.HELP_NEEDED;
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: null, answer: "", unclear: true });
  const client = clientSpy();
  await ask(client, "t-chatter-noans", "anyone else here rn lol", { mode: respond.HELP_ONLY });

  const t = db.getTicketByThreadTs("t-chatter-noans");
  assert.ok(t, "the message is a ticket");
  assert.ok(["open", "waiting_for_helper", "assigned"].includes(t.status));
  assert.ok(
    client.posts.some((p) => /Someone will be here to help you soon/.test(p.text || "")),
    "ticket UI is posted",
  );
});

test("escalateTicket (sensitive, no AI answer) opens the Pixorpheus ticket UI and never an ai_answered footer", async () => {
  const client = clientSpy();
  const ticket = await tickets.escalateTicket({
    program: programs.get("st-prog"),
    channel: HELP,
    threadTs: "t-sensitive",
    requesterId: "U-sens",
    question: "someone leaked my address",
    client,
  });

  assert.ok(ticket);
  assert.notEqual(ticket.status, "ai_answered");
  assert.ok(["waiting_for_helper", "assigned"].includes(ticket.status), "paged straight to a human");

  const ui = client.posts.find((p) => /Someone will be here to help you soon/.test(p.text || ""));
  assert.ok(ui, "the standard open-ticket UI, not a status footer");
  assert.ok(ui.blocks.find((b) => b.type === "actions")?.elements.some((e) => e.action_id === "st_resolve"));
  const blob = JSON.stringify(client.posts.map((p) => p.blocks || p.text));
  assert.ok(!/Answered by/.test(blob), "no legacy 'Answered by' label anywhere");
  assert.ok(!/public_resolve_ticket/.test(blob), "no legacy footer button");
});

test("the requester writing back in a resolved thread reopens it and re-shows the open UI", async () => {
  answer.getAnswerOrChat = answer.getAnswerOrChatStream = async () => ({ source: "Docs", answer: "ok" });
  const client = clientSpy();
  await ask(client, "t-reopen-chat", "a real question", { userId: "U-rc" });
  const id = db.getTicketByThreadTs("t-reopen-chat").id;
  await tickets.publicResolveTicket({ ticketId: id, actorId: "U-rc", client });
  assert.equal(db.getTicket(id).status, "resolved");

  const c2 = clientSpy();
  const out = tickets.noteThreadActivity({ channel: HELP, threadTs: "t-reopen-chat", userId: "U-rc", client: c2 });
  await new Promise((r) => setImmediate(r));

  assert.equal(out.status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
  assert.match(c2.posts.map((p) => p.text || "").join(" "), /Ticket reopened by <@U-rc>/);
  const updates = c2.posts.filter((p) => p.isUpdate);
  assert.ok(updates.length > 0, "the ticket UI was updated back to the open state");
  assert.ok(updates.some((ui) => /Someone will be here to help you soon/.test(JSON.stringify(ui.blocks))));
});
export {};
import type { TestDb, TestTickets } from "./test.types";
