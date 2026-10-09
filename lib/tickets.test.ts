process.env.PIXIE_DB_PATH = ":memory:";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const tickets = require("./tickets") as unknown as TestTickets;

before(() => {
  db.close();
  db.open(":memory:");
});

test("escalateTicket creates a ticket in DB and builds card blocks", async () => {
  const posted = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: "card-ts-123" };
      },
    },
  };

  const activeProg = {
    id: "sprig",
    name: "Sprig",
    posture: "active",
    helpChannel: "C-sprig",
    organizerChannel: "C-sprig-organizers",
  };

  const ticket = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
    client,
  });

  assert.ok(ticket);
  assert.equal(ticket.program_id, "sprig");
  assert.equal(ticket.question, "how do i solder the screen");
  assert.equal(posted.length, 2);
  assert.match(posted[0].text, /Someone will be here to help you soon/);
  assert.equal(posted[0].channel, "C-sprig");
  assert.equal(posted[0].thread_ts, "thread-100");
  assert.equal(posted[1].channel, "C-sprig-organizers");

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, "card-ts-123");
});

test("escalateTicket returns existing ticket if thread already escalated", async () => {
  const activeProg = { id: "sprig", name: "Sprig", posture: "active", helpChannel: "C-sprig" };

  const first = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
  });

  const second = await tickets.escalateTicket({
    program: activeProg,
    channel: "C-sprig",
    threadTs: "thread-100",
    requesterId: "U-requester",
    question: "how do i solder the screen",
  });

  assert.equal(first.id, second.id);
});

test("escalateTicket skips passive programs for unprompted tickets", async () => {
  const passiveProg = { id: "acme", name: "Acme", posture: "passive", helpChannel: "C-acme" };

  const result = await tickets.escalateTicket({
    program: passiveProg,
    channel: "C-acme",
    threadTs: "thread-passive-1",
    requesterId: "U-requester",
    question: "whats acme",
  });

  assert.equal(result, null);
});

test("buildTicketCardBlocks reflects status changes, unclaiming, and reopening", () => {
  const ticket = {
    id: 5,
    program_id: "sprig",
    requester_id: "U1",
    channel: "C1",
    question: "help",
    status: "open",
    assignee_id: null,
  };
  let blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.ok(blocks.length >= 3);
  assert.equal(blocks[0].text.text, "[Sprig] Ticket #5");

  ticket.status = "claimed";
  ticket.assignee_id = "U-helper";
  blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.match(blocks[2].text.text, /Claimed by <@U-helper>/);
  assert.ok(blocks[3].elements.some((e) => e.action_id === "unclaim_ticket"));

  ticket.status = "resolved";
  blocks = tickets.buildTicketCardBlocks(ticket, { name: "Sprig" });
  assert.ok(blocks[3].elements.some((e) => e.action_id === "reopen_ticket"));
});

test("escalation acknowledgement never names the program support identity", async () => {
  for (const supportName of ["Sandbox Pixie", "Acme Help"]) {
    const posted = [];
    const client = {
      chat: {
        postMessage: async (p) => {
          posted.push(p);
          return { ts: `t-${posted.length}` };
        },
      },
    };
    const prog = {
      id: `p-${supportName}`,
      name: supportName,
      supportName,
      posture: "active",
      helpChannel: `C-${supportName}`,
      organizerChannel: `C-org-${supportName}`,
      autoEscalate: true,
    };
    await tickets.escalateTicket({
      program: prog,
      channel: `C-${supportName}`,
      threadTs: `thread-${supportName}`,
      requesterId: "U-req",
      question: "I need a human to handle this",
      client,
    });
    assert.match(posted[0].text, /Someone will be here to help you soon/);

    assert.ok(!posted[0].text.includes(supportName));
  }
});

test("ticket cards neutralize channel-wide mentions in questions", () => {
  const blocks = require("./tickets").buildTicketCardBlocks(
    {
      id: 9,
      program_id: "sprig",
      requester_id: "U1",
      channel: "C1",
      question: "hello <!channel> check <http://evil|x>",
      status: "open",
    },
    { name: "Sprig" },
  );
  const body = JSON.stringify(blocks);
  assert.ok(!body.includes("<!channel>"));
  assert.ok(body.includes("&lt;!channel&gt;"));
});

test("cross-program routing: Program A and Program B cards route strictly to their respective organizer channels", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `card-${posts.length}` };
      },
    },
  };

  const progA = {
    id: "prog-a",
    name: "Program A",
    posture: "active",
    helpChannel: "C-help-a",
    organizerChannel: "C-org-a",
  };
  const progB = {
    id: "prog-b",
    name: "Program B",
    posture: "active",
    helpChannel: "C-help-b",
    organizerChannel: "C-org-b",
  };

  const ticketA = await tickets.escalateTicket({
    program: progA,
    channel: "C-help-a",
    threadTs: "t-a-1",
    requesterId: "U-asker-a",
    question: "how to do A",
    client,
  });

  assert.ok(ticketA);
  assert.equal(ticketA.program_id, "prog-a");

  const ticketB = await tickets.escalateTicket({
    program: progB,
    channel: "C-help-b",
    threadTs: "t-b-1",
    requesterId: "U-asker-b",
    question: "how to do B",
    client,
  });

  assert.ok(ticketB);
  assert.equal(ticketB.program_id, "prog-b");

  assert.equal(posts.length, 4);

  assert.equal(posts[0].channel, "C-help-a");
  assert.equal(posts[0].thread_ts, "t-a-1");
  assert.match(posts[0].text, /Someone will be here to help you soon/);

  assert.equal(posts[1].channel, "C-org-a");
  assert.notEqual(posts[1].channel, "C-help-a");
  assert.notEqual(posts[1].channel, "C-org-b");
  assert.match(posts[1].text, /\[Ticket #\d+\]/);

  assert.equal(posts[2].channel, "C-help-b");
  assert.equal(posts[2].thread_ts, "t-b-1");
  assert.match(posts[2].text, /Someone will be here to help you soon/);

  assert.equal(posts[3].channel, "C-org-b");
  assert.notEqual(posts[3].channel, "C-help-b");
  assert.notEqual(posts[3].channel, "C-org-a");
  assert.match(posts[3].text, /\[Ticket #\d+\]/);
});

test("never fall back to public help channel if no organizer channel is configured", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `card-${posts.length}` };
      },
    },
  };

  const progNoOrg = {
    id: "prog-no-org",
    name: "No Org Prog",
    posture: "active",
    helpChannel: "C-public-help",
    organizerChannel: null,
  };

  const ticket = await tickets.escalateTicket({
    program: progNoOrg,
    channel: "C-public-help",
    threadTs: "t-no-org",
    requesterId: "U-asker",
    question: "no organizer channel test",
    client,
  });

  assert.ok(ticket);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-public-help");
  assert.equal(posts[0].thread_ts, "t-no-org");
  assert.match(posts[0].text, /Someone will be here to help you soon/);

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, null);
});

test("never fall back to public help channel if delivery to organizer channel fails", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        if (payload.channel === "C-failing-org") {
          throw new Error("channel_not_found");
        }
        posts.push(payload);
        return { ts: "ack-ts-1" };
      },
    },
  };

  const progFailingOrg = {
    id: "prog-fail",
    name: "Failing Org Prog",
    posture: "active",
    helpChannel: "C-public-help-2",
    organizerChannel: "C-failing-org",
  };

  const ticket = await tickets.escalateTicket({
    program: progFailingOrg,
    channel: "C-public-help-2",
    threadTs: "t-fail-org",
    requesterId: "U-asker",
    question: "fail org test",
    client,
  });

  assert.ok(ticket);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-public-help-2");
  assert.equal(posts[0].thread_ts, "t-fail-org");

  const fetched = db.getTicket(ticket.id);
  assert.equal(fetched.card_ts, null);
});

test("multi-tenant routing contract: incoming help channel resolves program from DB claims", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "claim-card-ts" };
      },
    },
  };

  const prog1 = {
    id: "hosted-p1",
    name: "Hosted 1",
    posture: "active",
    workspaceId: "WS-H1",
    helpChannel: "C-H1-HELP",
    organizerChannel: "C-H1-ORG",
  };
  const prog2 = {
    id: "hosted-p2",
    name: "Hosted 2",
    posture: "active",
    workspaceId: "WS-H2",
    helpChannel: "C-H2-HELP",
    organizerChannel: "C-H2-ORG",
  };
  db.saveProgram(prog1);
  db.saveProgram(prog2);
  db.claimProgramChannel({ workspaceId: "WS-H1", channelId: "C-H1-HELP", programId: "hosted-p1", kind: "help" });
  db.claimProgramChannel({ workspaceId: "WS-H1", channelId: "C-H1-ORG", programId: "hosted-p1", kind: "organizer" });
  db.claimProgramChannel({ workspaceId: "WS-H2", channelId: "C-H2-HELP", programId: "hosted-p2", kind: "help" });
  db.claimProgramChannel({ workspaceId: "WS-H2", channelId: "C-H2-ORG", programId: "hosted-p2", kind: "organizer" });
  require("./programs").invalidate();

  const ticket1 = await tickets.escalateTicket({
    channel: "C-H1-HELP",
    threadTs: "t-h1",
    requesterId: "U-asker-h1",
    question: "question for h1",
    client,
    workspaceId: "WS-H1",
  });

  assert.ok(ticket1);
  assert.equal(ticket1.program_id, "hosted-p1");
  assert.equal(ticket1.workspace_id, "WS-H1");

  const ticket2 = await tickets.escalateTicket({
    channel: "C-H2-HELP",
    threadTs: "t-h2",
    requesterId: "U-asker-h2",
    question: "question for h2",
    client,
    workspaceId: "WS-H2",
  });

  assert.ok(ticket2);
  assert.equal(ticket2.program_id, "hosted-p2");
  assert.equal(ticket2.workspace_id, "WS-H2");

  assert.equal(posts[0].channel, "C-H1-HELP");
  assert.equal(posts[1].channel, "C-H1-ORG");
  assert.equal(posts[2].channel, "C-H2-HELP");
  assert.equal(posts[3].channel, "C-H2-ORG");
});

test("tenant isolation on claim, assign, snooze, resolve, and unclaim", async () => {
  const progAlpha = {
    id: "alpha",
    name: "Alpha",
    workspaceId: "WS-ALPHA",
    helpChannel: "C-alpha-help",
    organizerChannel: "C-alpha-org",
  };
  const progBeta = {
    id: "beta",
    name: "Beta",
    workspaceId: "WS-BETA",
    helpChannel: "C-beta-help",
    organizerChannel: "C-beta-org",
  };
  db.saveProgram(progAlpha);
  db.saveProgram(progBeta);
  db.claimProgramChannel({ workspaceId: "WS-ALPHA", channelId: "C-alpha-org", programId: "alpha", kind: "organizer" });
  db.claimProgramChannel({ workspaceId: "WS-BETA", channelId: "C-beta-org", programId: "beta", kind: "organizer" });
  require("./programs").invalidate();
  db.syncHelper({ programId: "alpha", userId: "U-helper-alpha", source: "manual" });
  db.syncHelper({ programId: "beta", userId: "U-helper-beta", source: "manual" });

  const ticketAlphaId = db.createTicket({
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    channel: "C-alpha-help",
    threadTs: "thread-alpha",
    requesterId: "U-req-alpha",
    question: "alpha issue",
  });

  const progMismatchClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "beta",
  });
  assert.equal(progMismatchClaim.error, "program mismatch");

  const wsMismatchClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    workspaceId: "WS-BETA",
  });
  assert.equal(wsMismatchClaim.error, "workspace mismatch");

  const foreignActorClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-beta",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
  });
  assert.equal(foreignActorClaim.error, "actor is not a helper of this program");

  const updates = [];
  const client = {
    chat: {
      update: async (payload) => {
        updates.push(payload);
        return { ok: true };
      },
    },
  };
  db.updateTicketCardTs(ticketAlphaId, "card-alpha-ts");

  const goodClaim = await tickets.claimTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    client,
  });
  assert.equal(goodClaim.ok, true);
  assert.equal(goodClaim.ticket.status, "claimed");
  assert.equal(goodClaim.ticket.assignee_id, "U-helper-alpha");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].channel, "C-alpha-org");

  const badSnooze = tickets.snoozeTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    until: Date.now() + 60000,
    programId: "beta",
  });
  assert.equal(badSnooze.error, "program mismatch");

  const goodSnooze = tickets.snoozeTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    until: Date.now() + 60000,
    programId: "alpha",
    workspaceId: "WS-ALPHA",
  });
  assert.equal(goodSnooze.ok, true);
  assert.equal(goodSnooze.ticket.status, "snoozed");

  const badAssign = await tickets.assignTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    assigneeId: "U-helper-beta",
    programId: "alpha",
  });
  assert.equal(badAssign.error, "assignee is not a helper of this program");

  const badResolve = await tickets.resolveTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-beta",
    programId: "alpha",
  });
  assert.equal(badResolve.error, "actor is not a helper of this program");

  const goodResolve = await tickets.resolveTicket({
    ticketId: ticketAlphaId,
    actorId: "U-helper-alpha",
    programId: "alpha",
    workspaceId: "WS-ALPHA",
    client,
  });
  assert.equal(goodResolve.ok, true);
  assert.equal(goodResolve.ticket.status, "resolved");
});

test("replyToTicket and addInternalNote: tenant isolation, in-thread replies, and zero notes leakage", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "reply-ts-1" };
      },
    },
  };

  const progA = {
    id: "sec-a",
    name: "Security A",
    supportName: "SecA Support",
    workspaceId: "WS-A",
    helpChannel: "C-sec-help",
    organizerChannel: "C-sec-org",
  };
  db.saveProgram(progA);
  require("./programs").invalidate();
  db.syncHelper({ programId: "sec-a", userId: "U-helper-sec", source: "manual" });

  const ticketId = db.createTicket({
    programId: "sec-a",
    workspaceId: "WS-A",
    channel: "C-sec-help",
    threadTs: "thread-user-1",
    requesterId: "U-asker-sec",
    question: "secret issue",
  });

  const noteMismatch = tickets.addInternalNote({
    ticketId,
    authorId: "U-helper-sec",
    body: "Confidential investigative note",
    programId: "sec-b",
  });
  assert.equal(noteMismatch.error, "program mismatch");

  const noteSuccess = tickets.addInternalNote({
    ticketId,
    authorId: "U-helper-sec",
    body: "Confidential investigative note",
    programId: "sec-a",
    workspaceId: "WS-A",
  });
  assert.equal(noteSuccess.ok, true);
  assert.ok(noteSuccess.noteId);

  assert.equal(posts.length, 0);

  const replyMismatch = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "Public response to user",
    client,
    programId: "sec-b",
  });
  assert.equal(replyMismatch.error, "program mismatch");

  const replyWsMismatch = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "Public response to user",
    client,
    workspaceId: "WS-OTHER",
  });
  assert.equal(replyWsMismatch.error, "workspace mismatch");

  const replyOk = await tickets.replyToTicket({
    ticketId,
    authorId: "U-helper-sec",
    text: "We have fixed your issue!",
    client,
    programId: "sec-a",
    workspaceId: "WS-A",
  });
  assert.equal(replyOk.ok, true);

  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-sec-help");
  assert.equal(posts[0].thread_ts, "thread-user-1");
  assert.equal(posts[0].text, "We have fixed your issue!");
  assert.equal(posts[0].username, "SecA Support");

  assert.ok(!posts[0].text.includes("Confidential"));
  assert.ok(!JSON.stringify(replyOk).includes("Confidential"));

  const notes = db.listTicketNotes(ticketId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "Confidential investigative note");
});

test("incident-aware answering: a question matching an ACTIVE incident gets the known-issue reply instead of a ticket, and is tracked", async () => {
  const incidents = require("./incidents");
  db.saveProgram({ id: "inc-a", name: "IncA", helpChannel: "C-inc-a", channels: ["C-inc-a"] });
  const detected = incidents.detectBursts({ programId: "inc-a" });
  assert.deepEqual(detected.candidates, []);
  db.handle()
    .query(
      "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
    )
    .run("inc-a", "checkout is failing for everyone", Date.now(), Date.now());

  const posted = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: "1.0" };
      },
    },
  };
  const prog = {
    id: "inc-a",
    name: "IncA",
    posture: "active",
    helpChannel: "C-inc-a",
    organizerChannel: "C-inc-a-org",
  };

  const result = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-a",
    threadTs: "thread-inc-1",
    requesterId: "U-affected",
    question: "checkout keeps failing for me too",
    client,
  });

  assert.equal(result, null);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /aware of an issue/);
  assert.equal(db.getTicketByThreadTs("thread-inc-1"), null);

  const inc = incidents.listIncidents("inc-a", "confirmed")[0];
  const reports = incidents.affectedReports(inc.id);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].requester_id, "U-affected");
});

test("incident-aware answering never applies to bypassIncidentMatch (sensitive) escalations", async () => {
  const incidents = require("./incidents");
  db.saveProgram({ id: "inc-b", name: "IncB", helpChannel: "C-inc-b", channels: ["C-inc-b"] });
  db.handle()
    .query(
      "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
    )
    .run("inc-b", "payment processing is down", Date.now(), Date.now());

  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  const prog = {
    id: "inc-b",
    name: "IncB",
    posture: "active",
    helpChannel: "C-inc-b",
    organizerChannel: "C-inc-b-org",
  };

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-b",
    threadTs: "thread-inc-2",
    requesterId: "U-sensitive",
    question: "my payment processing account got locked, need help",
    client,
    bypassIncidentMatch: true,
  });

  assert.ok(ticket);
  assert.equal(ticket.program_id, "inc-b");
});

test("incident_mode = NORMAL_TICKET opts a program out of incident-aware answering entirely", async () => {
  const incidents = require("./incidents");
  db.saveProgram({
    id: "inc-c",
    name: "IncC",
    helpChannel: "C-inc-c",
    channels: ["C-inc-c"],
    incidentMode: "NORMAL_TICKET",
  });
  require("./programs").invalidate();
  db.handle()
    .query(
      "INSERT INTO program_incidents (program_id, title, status, started_at, created_at) VALUES (?, ?, 'confirmed', ?, ?)",
    )
    .run("inc-c", "login is broken for everyone", Date.now(), Date.now());

  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  const prog = require("./programs").get("inc-c");

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-inc-c",
    threadTs: "thread-inc-3",
    requesterId: "U-normal",
    question: "login is broken for me too",
    client,
  });

  assert.ok(ticket);
});

test("the public acknowledgement carries a Resolve button and its ts is stored on the ticket", async () => {
  const posted = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posted.push(payload);
        return { ts: "ack-ts-1" };
      },
    },
  };
  const prog = {
    id: "pub-a",
    name: "PubA",
    posture: "active",
    helpChannel: "C-pub-a",
    organizerChannel: "C-pub-a-org",
  };

  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-pub-a",
    threadTs: "thread-pub-1",
    requesterId: "U-req",
    question: "my board won't boot",
    client,
  });

  const ackMessage = posted.find((p) => p.channel === "C-pub-a");
  assert.ok(
    ackMessage.blocks.some((b) => b.type === "actions" && b.elements.some((e) => e.action_id === "st_resolve")),
  );
  assert.equal(db.getTicket(ticket.id).public_ack_ts, "ack-ts-1");
});

test("publicResolveTicket: the requester can resolve their own ticket, a random channel member cannot", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = {
    id: "pub-b",
    name: "PubB",
    posture: "active",
    helpChannel: "C-pub-b",
    organizerChannel: "C-pub-b-org",
  };
  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-pub-b",
    threadTs: "thread-pub-2",
    requesterId: "U-owner",
    question: "help",
    client,
  });

  const denied = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-stranger", client });
  assert.equal(denied.error, "not_authorized");
  assert.equal(db.getTicket(ticket.id).status, "waiting_for_helper");

  const allowed = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner", client });
  assert.equal(allowed.ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
});

test("publicResolveTicket: a helper of the program (not the requester) can also resolve it", async () => {
  db.saveProgram({ id: "pub-c", name: "PubC", helpChannel: "C-pub-c", channels: ["C-pub-c"] });
  db.syncHelper({ programId: "pub-c", userId: "U-HELPER-C", source: "manual" });
  require("./programs").invalidate();
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = require("./programs").get("pub-c");
  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-pub-c",
    threadTs: "thread-pub-3",
    requesterId: "U-owner-c",
    question: "help",
    client,
  });

  const res = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-HELPER-C", client });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(ticket.id).status, "resolved");
});

test("publicResolveTicket is idempotent on an already-resolved ticket", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }), update: async () => ({}) } };
  const prog = {
    id: "pub-d",
    name: "PubD",
    posture: "active",
    helpChannel: "C-pub-d",
    organizerChannel: "C-pub-d-org",
  };
  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-pub-d",
    threadTs: "thread-pub-4",
    requesterId: "U-owner-d",
    question: "help",
    client,
  });
  await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner-d", client });

  const again = await tickets.publicResolveTicket({ ticketId: ticket.id, actorId: "U-owner-d", client });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
});

test("publicTicketsEnabled = false skips ticket creation from the help channel but Pixie still answers (returns null, no throw)", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "1.0" }) } };
  db.saveProgram({
    id: "notix",
    name: "NoTix",
    helpChannel: "C-notix",
    channels: ["C-notix"],
    publicTicketsEnabled: false,
  });
  require("./programs").invalidate();
  const prog = require("./programs").get("notix");

  const result = await tickets.escalateTicket({
    program: prog,
    channel: "C-notix",
    threadTs: "thread-notix-1",
    requesterId: "U1",
    question: "help",
    client,
  });
  assert.equal(result, null);
  assert.equal(db.getTicketByThreadTs("thread-notix-1"), null);
});

test("buildTicketCardBlocks includes a Reply button and a Reassign select populated from recommend(), excluding the current assignee", () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({ id: "card-a", name: "CardA", helpChannel: "C-card-a", channels: ["C-card-a"] });
  db.syncHelper({ programId: "card-a", userId: "U-CARD-1", source: "manual" });
  db.syncHelper({ programId: "card-a", userId: "U-CARD-2", source: "manual" });
  helperRoute.setExpertise({ programId: "card-a", userId: "U-CARD-1", tags: ["pcb"] });
  helperRoute.recordResolution({ programId: "card-a", userId: "U-CARD-1", category: "pcb" });

  const ticketId = db.createTicket({
    programId: "card-a",
    channel: "C-card-a",
    threadTs: "t-card-a",
    requesterId: "U-req",
    question: "pcb issue",
    category: "pcb",
  });
  db.assignTicket(ticketId, "U-CARD-1");
  const ticket = db.getTicket(ticketId);

  const blocks = tickets.buildTicketCardBlocks(ticket, { id: "card-a", name: "CardA" });
  const replyBlock = blocks.find(
    (b) => b.type === "actions" && b.elements.some((e) => e.action_id === "reply_ticket_button"),
  );
  assert.ok(replyBlock, "expected a Reply button on the claimed-ticket card");

  const reassignBlock = blocks.find(
    (b) => b.type === "actions" && b.elements.some((e) => e.action_id === "reassign_select"),
  );
  assert.ok(reassignBlock, "expected a Reassign select");
  const options = reassignBlock.elements[0].options;
  assert.ok(
    options.every((o) => !o.value.endsWith(":U-CARD-1")),
    "the current assignee must not be offered as a reassign target",
  );
  assert.ok(options.some((o) => o.value.endsWith(":U-CARD-2")));
});

test("ticket cards offer every active program helper when expertise ranking has no recommendations", () => {
  const programId = "card-fallback-helpers";
  db.saveProgram({
    id: programId,
    name: "Fallback Helpers",
    helpChannel: "C-card-fallback",
    channels: ["C-card-fallback"],
  });
  db.syncHelper({ programId, userId: "U-FALLBACK-1", source: "manual" });
  db.syncHelper({ programId, userId: "U-FALLBACK-2", source: "manual" });
  const ticketId = db.createTicket({
    programId,
    channel: "C-card-fallback",
    threadTs: "t-card-fallback",
    requesterId: "U-req",
    question: "general help",
  });
  db.assignTicket(ticketId, "U-FALLBACK-1");

  const blocks = tickets.buildTicketCardBlocks(db.getTicket(ticketId), { id: programId, name: "Fallback Helpers" });
  const reassignBlock = blocks.find(
    (block) => block.type === "actions" && block.elements.some((element) => element.action_id === "reassign_select"),
  );
  assert.ok(reassignBlock, "expected a fallback Reassign select");
  assert.deepEqual(
    reassignBlock.elements[0].options.map((option) => option.value),
    [`${ticketId}:U-FALLBACK-2`],
  );
});

test("unclaim demotes to open (not waiting_for_helper)", async () => {
  const id = db.createTicket({
    programId: "char-unclaim",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-unclaim-1",
    requesterId: "U-req",
    question: "q",
  });
  db.markTicketWaitingForHelper(id);
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
  db.syncHelper({ programId: "char-unclaim", userId: "U-char-h", source: "manual" });
  const claimed = await tickets.claimTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(claimed.ok, true);
  const unclaimed = await tickets.unclaimTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(unclaimed.ok, true);
  assert.equal(db.getTicket(id).status, "open");
  assert.equal(db.getTicket(id).assignee_id, null);
});

test("reopen from open succeeds and bumps reopen_count", async () => {
  db.syncHelper({ programId: "char-reopen", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({
    programId: "char-reopen",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-reopen-1",
    requesterId: "U-req",
    question: "q",
  });
  assert.equal(db.getTicket(id).reopen_count, 0);
  const res = await tickets.reopenTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
});

test("snooze from resolved succeeds", () => {
  db.syncHelper({ programId: "char-snooze", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({
    programId: "char-snooze",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-snooze-1",
    requesterId: "U-req",
    question: "q",
  });
  db.resolveTicket(id, "done");
  assert.equal(db.getTicket(id).status, "resolved");
  const res = tickets.snoozeTicket({ ticketId: id, actorId: "U-char-h", until: Date.now() + 60000 });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "snoozed");
});

test("close from open succeeds", async () => {
  db.syncHelper({ programId: "char-close", userId: "U-char-h", source: "manual" });
  const id = db.createTicket({
    programId: "char-close",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-close-1",
    requesterId: "U-req",
    question: "q",
  });
  const res = await tickets.closeTicket({ ticketId: id, actorId: "U-char-h" });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).status, "closed");
});

test("concurrent claim race has exactly one winner", async () => {
  db.syncHelper({ programId: "char-race", userId: "U-race-1", source: "manual" });
  db.syncHelper({ programId: "char-race", userId: "U-race-2", source: "manual" });
  const id = db.createTicket({
    programId: "char-race",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-race-1",
    requesterId: "U-req",
    question: "q",
  });
  const r1 = await tickets.claimTicket({ ticketId: id, actorId: "U-race-1" });
  const r2 = await tickets.claimTicket({ ticketId: id, actorId: "U-race-2" });
  assert.equal(r1.ok, true);
  assert.equal(r2.error, "ticket is not open");
  assert.equal(db.getTicket(id).assignee_id, "U-race-1");
});

test("getOrCreate sequential race returns one row, no throw", () => {
  db.saveProgram({ id: "char-goc", name: "Goc", helpChannel: "C-char-goc", channels: ["C-char-goc"] });
  require("./programs").invalidate();
  const prog = {
    id: "char-goc",
    name: "Goc",
    posture: "active",
    helpChannel: "C-char-goc",
    organizerChannel: "C-char-goc-org",
  };
  const a = tickets.getOrCreateOpenTicket({
    program: prog,
    channel: "C-char-goc",
    threadTs: "char-goc-1",
    requesterId: "U-req",
    question: "q",
    workspaceId: "WS-CHAR",
  });
  const b = tickets.getOrCreateOpenTicket({
    program: prog,
    channel: "C-char-goc",
    threadTs: "char-goc-1",
    requesterId: "U-req",
    question: "q",
    workspaceId: "WS-CHAR",
  });
  assert.ok(a && b);
  assert.equal(a.id, b.id);
  const n = db.handle().query("SELECT COUNT(*) AS n FROM tickets WHERE thread_ts = ?").get("char-goc-1").n;
  assert.equal(n, 1);
});

test("requester chatter on resolved reopens and bumps reopen_count", () => {
  const id = db.createTicket({
    programId: "char-req-re",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-req-re-1",
    requesterId: "U-req-char",
    question: "q",
  });
  db.resolveTicket(id, "done");
  assert.equal(db.getTicket(id).reopen_count, 0);
  const out = tickets.noteThreadActivity({
    channel: "C-char",
    threadTs: "char-req-re-1",
    userId: "U-req-char",
    workspaceId: "WS-CHAR",
  });
  assert.equal(out.status, "reopened");
  assert.equal(db.getTicket(id).reopen_count, 1);
});

test("helper chatter never reopens", () => {
  const id = db.createTicket({
    programId: "char-help-no",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-help-no-1",
    requesterId: "U-req-char",
    question: "q",
  });
  db.resolveTicket(id, "done");
  const out = tickets.noteThreadActivity({
    channel: "C-char",
    threadTs: "char-help-no-1",
    userId: "U-helper-other",
    workspaceId: "WS-CHAR",
  });
  assert.equal(out.status, "resolved");
  assert.equal(db.getTicket(id).reopen_count, 0);
});

test("ticketCreationAllowed (via getOrCreate) vs escalateTicket combos", async () => {
  db.saveProgram({ id: "char-combo", name: "Combo", helpChannel: "C-char-help", channels: ["C-char-help"] });
  require("./programs").invalidate();
  const CASES = [
    {
      name: "passive-help",
      prog: {
        id: "char-combo",
        name: "Combo",
        posture: "passive",
        helpChannel: "C-char-help",
        organizerChannel: "C-char-org",
        publicTicketsEnabled: true,
      },
      channel: "C-char-help",
      expectGoc: true,
      expectEsc: false,
    },
    {
      name: "active-nonhelp",
      prog: {
        id: "char-combo",
        name: "Combo",
        posture: "active",
        helpChannel: "C-char-help",
        organizerChannel: "C-char-org",
        publicTicketsEnabled: true,
      },
      channel: "C-other",
      expectGoc: false,
      expectEsc: true,
    },
    {
      name: "nopub-help",
      prog: {
        id: "char-combo",
        name: "Combo",
        posture: "active",
        helpChannel: "C-char-help",
        organizerChannel: "C-char-org",
        publicTicketsEnabled: false,
      },
      channel: "C-char-help",
      expectGoc: false,
      expectEsc: false,
    },
    {
      name: "nopub-nonhelp",
      prog: {
        id: "char-combo",
        name: "Combo",
        posture: "active",
        helpChannel: "C-char-help",
        organizerChannel: "C-char-org",
        publicTicketsEnabled: false,
      },
      channel: "C-other",
      expectGoc: false,
      expectEsc: true,
    },
  ];
  for (const c of CASES) {
    const g = tickets.getOrCreateOpenTicket({
      program: c.prog,
      channel: c.channel,
      threadTs: `char-combo-${c.name}-g`,
      requesterId: "U-req",
      question: "q",
      workspaceId: "WS-CHAR",
    });
    assert.equal(!!g, c.expectGoc, `getOrCreate ${c.name}`);
    const e = await tickets.escalateTicket({
      program: c.prog,
      channel: c.channel,
      threadTs: `char-combo-${c.name}-e`,
      requesterId: "U-req",
      question: "q",
      workspaceId: "WS-CHAR",
    });
    assert.equal(!!e, c.expectEsc, `escalate ${c.name}`);
  }
});

test("snooze performs no card sync (currently none)", () => {
  const id = db.createTicket({
    programId: "char-snoozecard",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-snoozecard-1",
    requesterId: "U-req",
    question: "q",
  });
  db.updateTicketCardTs(id, "card-char-1");
  db.syncHelper({ programId: "char-snoozecard", userId: "U-h", source: "manual" });
  const updates = [];
  const fakeClient = {
    chat: {
      update: async (p) => {
        updates.push(p);
        return { ok: true };
      },
    },
  };
  const before = db.getTicket(id).card_ts;
  const res = tickets.snoozeTicket({ ticketId: id, actorId: "U-h", until: Date.now() + 60000, client: fakeClient });
  assert.equal(res.ok, true);
  assert.equal(db.getTicket(id).card_ts, before);
  assert.equal(updates.length, 0);
});

test("every transition writes one ticket_event and one audit_event", async () => {
  db.syncHelper({ programId: "char-audit", userId: "U-audit-h", source: "manual" });
  const id = db.createTicket({
    programId: "char-audit",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-audit-1",
    requesterId: "U-req",
    question: "q",
  });
  const baseEvents = db.listTicketEvents(id).length;
  const baseAudit = db.listAuditEvents({ programId: "char-audit" }).length;
  await tickets.claimTicket({ ticketId: id, actorId: "U-audit-h" });
  assert.equal(db.listTicketEvents(id).length, baseEvents + 1);
  assert.equal(db.listTicketEvents(id).at(-1).event_type, "claimed");
  await tickets.resolveTicket({ ticketId: id, actorId: "U-audit-h" });
  assert.equal(db.listTicketEvents(id).length, baseEvents + 2);
  assert.ok(db.listAuditEvents({ programId: "char-audit" }).length >= baseAudit + 2);
});

test("resolve records helperRoute resolution", async () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({ id: "char-resmem", name: "R", helpChannel: "C-char", channels: ["C-char"] });
  db.syncHelper({ programId: "char-resmem", userId: "U-res-h", source: "manual" });
  const id = db.createTicket({
    programId: "char-resmem",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-resmem-1",
    requesterId: "U-req",
    question: "q",
    category: "pcb",
  });
  await tickets.claimTicket({ ticketId: id, actorId: "U-res-h" });
  await tickets.resolveTicket({ ticketId: id, actorId: "U-res-h" });
  const exp = helperRoute.getExpertise("char-resmem", "U-res-h");
  assert.ok(exp.some((e) => e.tag === "pcb" || e.tag === "general"));
});

test("Slack fail-open vs Wizard fail-closed on empty helper list", async () => {
  const api = require("./web/api");
  const id1 = db.createTicket({
    programId: "char-empty-slack",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-empty-1",
    requesterId: "U-req",
    question: "q",
  });
  assert.equal(db.listHelpers("char-empty-slack").length, 0);
  const slackRes = await tickets.claimTicket({ ticketId: id1, actorId: "U-stranger" });
  assert.equal(slackRes.ok, true);
  const id2 = db.createTicket({
    programId: "char-empty-wiz",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-empty-2",
    requesterId: "U-req",
    question: "q",
  });
  assert.equal(db.listHelpers("char-empty-wiz").length, 0);
  const wizRes = api.internalTicketAction(id2, "claim", { programId: "char-empty-wiz", actorId: "U-stranger" });
  assert.match(wizRes.error, /not a helper/);
});

test("escalate on snoozed returns early with no wake", async () => {
  const prog = {
    id: "char-snooze-early",
    name: "S",
    posture: "active",
    helpChannel: "C-char",
    organizerChannel: "C-char-org",
  };
  const id = db.createTicket({
    programId: "char-snooze-early",
    workspaceId: "WS-CHAR",
    channel: "C-char",
    threadTs: "char-snooze-early-1",
    requesterId: "U-req",
    question: "q",
  });
  db.snoozeTicket(id, Date.now() + 60000);
  assert.equal(db.getTicket(id).status, "snoozed");
  const out = await tickets.escalateTicket({
    program: prog,
    channel: "C-char",
    threadTs: "char-snooze-early-1",
    requesterId: "U-req",
    question: "q",
    workspaceId: "WS-CHAR",
  });
  assert.equal(out.id, id);
  assert.equal(out.status, "snoozed");
});

test("fix(a): getOrganizerChannel never falls back to helperChannel", () => {
  assert.equal(tickets.getOrganizerChannel({ id: "fix-a", helperChannel: "C-public-help" }), null);
  assert.equal(
    tickets.getOrganizerChannel({ id: "fix-a", organizerChannel: "C-org", helperChannel: "C-public-help" }),
    "C-org",
  );
});

test("fix(b): getTicketByThreadTs strict scoped lookup drops IS NULL fallback", () => {
  const id = db.createTicket({
    programId: "fix-b",
    workspaceId: null,
    channel: "C-fix",
    threadTs: "fix-b-thread",
    requesterId: "U-req",
    question: "q",
  });
  assert.ok(id);
  assert.equal(db.getTicketByThreadTs("fix-b-thread", "WS-FIX"), null);
  assert.ok(db.getTicketByThreadTs("fix-b-thread", null));
});

test("fix(b): get-or-create never falls back across workspace or program", () => {
  const foreignWorkspace = db.createTicket({
    programId: "foreign-program",
    workspaceId: "WS-FOREIGN",
    channel: "C-foreign",
    threadTs: "tenant-boundary-thread",
    requesterId: "U-foreign",
    question: "foreign question",
  });
  assert.ok(foreignWorkspace);

  const local = tickets.getOrCreateOpenTicket({
    program: { id: "local-program", posture: "active", helpChannel: "C-local" },
    channel: "C-local",
    threadTs: "tenant-boundary-thread",
    requesterId: "U-local",
    question: "local question",
    workspaceId: "WS-LOCAL",
  });

  assert.ok(local);
  assert.notEqual(local.id, foreignWorkspace);
  assert.equal(local.program_id, "local-program");
  assert.equal(local.workspace_id, "WS-LOCAL");
});

test("fix(c): createTicket returns existing on conflict, never throws", () => {
  const id1 = db.createTicket({
    programId: "fix-c",
    workspaceId: "WS-FIX",
    channel: "C-fix",
    threadTs: "fix-c-thread",
    requesterId: "U-req",
    question: "q",
  });
  assert.ok(id1);
  let id2 = null;
  assert.doesNotThrow(() => {
    id2 = db.createTicket({
      programId: "fix-c",
      workspaceId: "WS-FIX",
      channel: "C-fix",
      threadTs: "fix-c-thread",
      requesterId: "U-req",
      question: "q",
    });
  });
  assert.equal(id2, id1);
  const n = db
    .handle()
    .query("SELECT COUNT(*) AS n FROM tickets WHERE thread_ts = ? AND workspace_id = ?")
    .get("fix-c-thread", "WS-FIX").n;
  assert.equal(n, 1);
});

test("fix(c): getOrCreate race returns one row, no throw", () => {
  db.saveProgram({ id: "fix-c-goc", name: "G", helpChannel: "C-fix-c", channels: ["C-fix-c"] });
  require("./programs").invalidate();
  const prog = {
    id: "fix-c-goc",
    name: "G",
    posture: "active",
    helpChannel: "C-fix-c",
    organizerChannel: "C-fix-c-org",
  };
  const a = tickets.getOrCreateOpenTicket({
    program: prog,
    channel: "C-fix-c",
    threadTs: "fix-c-goc-1",
    requesterId: "U-req",
    question: "q",
    workspaceId: "WS-FIX",
  });
  const b = tickets.getOrCreateOpenTicket({
    program: prog,
    channel: "C-fix-c",
    threadTs: "fix-c-goc-1",
    requesterId: "U-req",
    question: "q",
    workspaceId: "WS-FIX",
  });
  assert.equal(a.id, b.id);
});

test("fix(d): markTicketWaitingForHelper is a no-op once past open", () => {
  const id = db.createTicket({
    programId: "fix-d",
    workspaceId: "WS-FIX",
    channel: "C-fix",
    threadTs: "fix-d-1",
    requesterId: "U-req",
    question: "q",
  });
  db.markTicketWaitingForHelper(id);
  assert.equal(db.getTicket(id).status, "waiting_for_helper");
  db.handle().query("UPDATE tickets SET updated_at = ? WHERE id = ?").run(1000, id);
  assert.equal(db.markTicketWaitingForHelper(id), false);
  assert.equal(db.getTicket(id).updated_at, 1000);
});

test("fix(e): replyToTicket records helper_reply against refreshed row", async () => {
  db.saveProgram({ id: "fix-e", name: "E", helpChannel: "C-fix-e", channels: ["C-fix-e"] });
  require("./programs").invalidate();
  db.syncHelper({ programId: "fix-e", userId: "U-h", source: "manual" });
  const id = db.createTicket({
    programId: "fix-e",
    workspaceId: "WS-FIX",
    channel: "C-fix-e",
    threadTs: "fix-e-1",
    requesterId: "U-req",
    question: "q",
  });
  const order = [];
  const origAdd = db.addTicketEvent;
  const origGet = db.getTicket;
  const origRec = db.recordFirstResponse;
  const slackMessages = require("./slackMessages");
  const origSend = slackMessages.sendProgramMessage;
  try {
    let firstDone = false;
    db.recordFirstResponse = (...a) => {
      const r = origRec(...a);
      firstDone = true;
      order.push("firstResponse");
      return r;
    };
    db.getTicket = (i) => {
      if (firstDone && !order.includes("secondGet")) order.push("secondGet");
      return origGet(i);
    };
    db.addTicketEvent = (a) => {
      order.push("addEvent");
      return origAdd(a);
    };
    slackMessages.sendProgramMessage = async () => ({ ts: "x" });
    const fakeClient = { chat: { postMessage: async () => ({ ts: "x" }) } };
    await tickets.replyToTicket({ ticketId: id, authorId: "U-h", text: "hi", client: fakeClient });
  } finally {
    slackMessages.sendProgramMessage = origSend;
    db.addTicketEvent = origAdd;
    db.getTicket = origGet;
    db.recordFirstResponse = origRec;
  }
  assert.ok(order.includes("secondGet") && order.includes("addEvent"));
  assert.ok(order.indexOf("secondGet") < order.indexOf("addEvent"), `order was ${order.join(",")}`);
});

test("fix(f): internalTicketAction syncs card via canonical", () => {
  const api = require("./web/api");
  db.saveProgram({ id: "fix-f", name: "F", helpChannel: "C-fix-f", channels: ["C-fix-f"] });
  require("./programs").invalidate();
  db.syncHelper({ programId: "fix-f", userId: "U-h", source: "manual" });
  const id = db.createTicket({
    programId: "fix-f",
    workspaceId: "WS-FIX",
    channel: "C-fix-f",
    threadTs: "fix-f-1",
    requesterId: "U-req",
    question: "q",
  });
  db.updateTicketCardTs(id, "card-fix-f");
  db.claimProgramChannel({ workspaceId: "WS-FIX", channelId: "C-fix-f-org", programId: "fix-f", kind: "organizer" });
  const updates = [];
  const fakeClient = {
    chat: {
      update: async (p) => {
        updates.push(p);
        return { ok: true };
      },
    },
  };
  api.setSlackClient(fakeClient);
  try {
    const baseEvents = db.listTicketEvents(id).length;
    const res = api.internalTicketAction(id, "claim", { programId: "fix-f", actorId: "U-h" });
    assert.equal(res.ok, true);
    assert.equal(db.getTicket(id).status, "claimed");
    assert.ok(db.listTicketEvents(id).length >= baseEvents + 1);
    assert.ok(updates.length >= 1, "dashboard claim must sync card");
  } finally {
    api.setSlackClient(null);
  }
});

test("fix(g): ticketUpdate routes through internalTicketAction, no silent ok", () => {
  const api = require("./web/api");
  db.syncHelper({ programId: "fix-g", userId: "U-h", source: "manual" });
  const id = db.createTicket({
    programId: "fix-g",
    workspaceId: "WS-FIX",
    channel: "C-fix",
    threadTs: "fix-g-1",
    requesterId: "U-req",
    question: "q",
  });
  const badId = api.ticketUpdate(999999, "claimed", null, "U-h");
  assert.ok(badId.error, "bad id must not be silent ok");
  const badStatus = api.ticketUpdate(id, "bogus", null, "U-h");
  assert.ok(badStatus.error, "unknown status must not be silent ok");
  const ok = api.ticketUpdate(id, "claimed", "U-h", "U-h");
  assert.equal(ok.ok, true);
});

test("fix(h): registerActions guards private_metadata JSON.parse", async () => {
  const handlers = {};
  const fakeApp = {
    action: (n, fn) => {
      handlers[n] = fn;
    },
    view: (n, fn) => {
      handlers[n] = fn;
    },
  };
  tickets.registerActions(fakeApp);
  const viewHandler = handlers["ticket_reply_modal_submit"];
  assert.ok(viewHandler);
  let acked = null;
  const ack = async (a) => {
    acked = a || true;
  };
  await viewHandler({
    ack,
    body: { user: { id: "U-h" }, team: { id: "WS-FIX" } },
    view: { private_metadata: "{{{bad", state: { values: {} } },
    client: {},
  });
  assert.ok(acked && acked.response_action === "errors", `acked was ${JSON.stringify(acked)}`);
});

test("fix(i): recordTransition logs audit failure instead of swallowing silently", () => {
  const audit = require("./audit");
  const log = require("./log");
  const origRecord = audit.record;
  const origDebug = log.debug;
  const logged = [];
  try {
    log.debug = (...a) => {
      logged.push(a.join(" "));
    };
    audit.record = () => {
      throw new Error("audit down");
    };
    const id = db.createTicket({
      programId: "fix-i",
      workspaceId: "WS-FIX",
      channel: "C-fix",
      threadTs: "fix-i-1",
      requesterId: "U-req",
      question: "q",
    });
    assert.doesNotThrow(() => tickets.claimTicket({ ticketId: id, actorId: "U-x" }));
  } finally {
    audit.record = origRecord;
    log.debug = origDebug;
  }
  assert.ok(
    logged.some((m) => m.includes("audit")),
    `logs were ${JSON.stringify(logged)}`,
  );
});

test("fix(j): recordFirstResponse no-op touches nothing when already set", () => {
  const id = db.createTicket({
    programId: "fix-j",
    workspaceId: "WS-FIX",
    channel: "C-fix",
    threadTs: "fix-j-1",
    requesterId: "U-req",
    question: "q",
  });
  db.recordFirstResponse(id, false);
  const before = db.getTicket(id);
  db.handle().query("UPDATE tickets SET updated_at = ? WHERE id = ?").run(1000, id);
  const mid = db.getTicket(id);
  assert.equal(mid.first_response_at, before.first_response_at);
  assert.equal(mid.updated_at, 1000);
  db.recordFirstResponse(id, false);
  const after = db.getTicket(id);
  assert.equal(after.first_response_at, before.first_response_at);
  assert.equal(after.updated_at, 1000);
});

test("a failed Slack card sync records ticket_slack_sync_failure and never blocks the transition", async () => {
  const client = {
    chat: {
      postMessage: async () => ({ ts: "sync-card-ts" }),
      update: async () => {
        const err = new Error("message_not_found");
        (err as Error & { data?: { error: string } }).data = { error: "message_not_found" };
        throw err;
      },
    },
  };
  const prog = {
    id: "sync-fail",
    name: "SyncFail",
    posture: "active",
    helpChannel: "C-sf",
    organizerChannel: "C-sf-org",
    autoEscalate: true,
  };
  db.syncHelper({ programId: "sync-fail", userId: "U-sf-helper", source: "manual" });
  const t = await tickets.escalateTicket({
    program: prog,
    channel: "C-sf",
    threadTs: "sf-thread-1",
    requesterId: "U-req",
    question: "help",
    client,
  });

  const before = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'ticket_slack_sync_failure'").get().c;
  const res = await tickets.resolveTicket({ ticketId: t.id, actorId: "U-sf-helper", client, program: prog });
  assert.equal(res.ok, true, "the resolve still succeeds despite the Slack update failing");
  assert.equal(db.getTicket(t.id).status, "resolved");

  const after = db
    .handle()
    .query(
      "SELECT kind, detail, program_id FROM metrics WHERE kind = 'ticket_slack_sync_failure' ORDER BY id DESC LIMIT 1",
    )
    .get();
  assert.equal(
    db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'ticket_slack_sync_failure'").get().c > before,
    true,
  );
  assert.match(after.detail, /^(card|thread):message_not_found$/);
  assert.equal(after.program_id, "sync-fail");
  assert.equal(after.detail.includes("help"), false);
});

test("resolve then reopen reconciles card, requester thread, and reaction controls", async () => {
  const updates = [];
  const reactions = [];
  const client = {
    chat: {
      postMessage: async () => ({ ts: "posted" }),
      update: async (payload) => {
        updates.push(payload);
        return { ok: true };
      },
    },
    reactions: {
      add: async (payload) => {
        reactions.push(["add", payload.name]);
      },
      remove: async (payload) => {
        reactions.push(["remove", payload.name]);
      },
    },
  };
  const prog = {
    id: "reconcile-cycle",
    name: "Cycle",
    posture: "active",
    helpChannel: "C-cycle",
    organizerChannel: "C-cycle-org",
  };
  const ticket = await tickets.escalateTicket({
    program: prog,
    channel: "C-cycle",
    threadTs: "cycle-thread",
    requesterId: "U-cycle",
    question: "help",
    client,
  });

  const resolved = await tickets.publicResolveTicket({
    ticketId: ticket.id,
    actorId: "U-cycle",
    client,
    program: prog,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved.ticket.status, "resolved");
  assert.ok(updates.some((p) => p.blocks.some((b) => JSON.stringify(b).includes("st_reopen"))));

  const reopened = await tickets.publicReopenTicket({ ticketId: ticket.id, actorId: "U-cycle", client, program: prog });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reopened.ticket.status, "reopened");
  assert.ok(updates.some((p) => p.blocks.some((b) => JSON.stringify(b).includes("st_resolve"))));
  assert.ok(reactions.length >= 2, "reopen must restore the open reaction path");
});

test("reconcileTicketUI is idempotent for the same ticket projection", async () => {
  const updates = [];
  const client = {
    chat: {
      update: async (payload) => {
        updates.push(payload);
      },
    },
  };
  const ticket = {
    id: 991,
    program_id: "reconcile-idempotent",
    status: "open",
    channel: "C-idem",
    thread_ts: "idem-thread",
    public_ack_ts: "ack-idem",
    card_ts: "card-idem",
    requester_id: "U-req",
    question: "q",
  };
  await tickets.reconcileTicketUI({
    client,
    ticket,
    program: { id: ticket.program_id, name: "Idem", organizerChannel: "C-idem-org" },
  });
  await tickets.reconcileTicketUI({
    client,
    ticket,
    program: { id: ticket.program_id, name: "Idem", organizerChannel: "C-idem-org" },
  });
  assert.equal(updates.length, 2, "repeated reconciliation must not update Slack twice per surface");
});

test("concurrent escalation keeps one canonical organizer card", async () => {
  const posts = [];
  const deletes = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        await new Promise((resolve) => setImmediate(resolve));
        return { ts: `race-${posts.length}` };
      },
      delete: async (payload) => {
        deletes.push(payload);
      },
    },
  };
  const program = {
    id: "reconcile-race",
    name: "Race",
    posture: "active",
    helpChannel: "C-race",
    organizerChannel: "C-race-org",
  };
  const results = await Promise.all([
    tickets.escalateTicket({
      program,
      channel: "C-race",
      threadTs: "race-thread",
      requesterId: "U-race",
      question: "help",
      client,
    }),
    tickets.escalateTicket({
      program,
      channel: "C-race",
      threadTs: "race-thread",
      requesterId: "U-race",
      question: "help",
      client,
    }),
  ]);

  assert.equal(results[0].id, results[1].id);
  const stored = db.getTicket(results[0].id);
  assert.ok(stored.card_ts);
  assert.ok(
    deletes.some((payload) => payload.channel === "C-race-org"),
    "losing card post must be deleted",
  );
});

test("pingRecommendedHelper @-mentions the best-matched helper, once, and only when the program opts in", async () => {
  const helperRoute = require("./helperRoute");
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `ping-${posts.length}` };
      },
    },
  };

  db.saveProgram({ id: "ping-a", name: "PingA", helpChannel: "C-ping-a", channels: ["C-ping-a"] });
  db.syncHelper({ programId: "ping-a", userId: "U-REVIEWS", source: "manual" });
  db.syncHelper({ programId: "ping-a", userId: "U-OTHER", source: "manual" });
  helperRoute.recordResolution({ programId: "ping-a", userId: "U-REVIEWS", category: "reviews" });
  helperRoute.recordReply({ programId: "ping-a", userId: "U-REVIEWS", category: "reviews" });

  const ticketId = db.createTicket({
    programId: "ping-a",
    channel: "C-ping-a",
    threadTs: "t-ping-a",
    requesterId: "U-req",
    question: "review question",
    category: "reviews",
  });
  const ticket = db.getTicket(ticketId);

  assert.equal(await tickets.pingRecommendedHelper({ client, ticket, program: { id: "ping-a", name: "PingA" } }), null);
  assert.equal(posts.length, 0);

  const program = { id: "ping-a", name: "PingA", helperPing: true };
  assert.equal(await tickets.pingRecommendedHelper({ client, ticket, program }), "U-REVIEWS");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C-ping-a");
  assert.equal(posts[0].thread_ts, "t-ping-a");
  assert.match(posts[0].text, /<@U-REVIEWS>/);
  assert.match(posts[0].text, /\*Question:\*/);
  assert.doesNotMatch(posts[0].text, /chain of thought/i, "the packet contains bounded handoff context only");

  assert.equal(await tickets.pingRecommendedHelper({ client, ticket, program }), null);
  assert.equal(posts.length, 1);
});

test("pingRecommendedHelper tells the auto-assigned helper rather than picking a second one", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: "ping-assigned" };
      },
    },
  };

  db.saveProgram({ id: "ping-b", name: "PingB", helpChannel: "C-ping-b", channels: ["C-ping-b"] });
  db.syncHelper({ programId: "ping-b", userId: "U-ASSIGNED", source: "manual" });
  db.syncHelper({ programId: "ping-b", userId: "U-EXPERT", source: "manual" });
  require("./helperRoute").recordResolution({ programId: "ping-b", userId: "U-EXPERT", category: "pcb" });

  const ticketId = db.createTicket({
    programId: "ping-b",
    channel: "C-ping-b",
    threadTs: "t-ping-b",
    requesterId: "U-req",
    question: "pcb",
    category: "pcb",
  });
  db.assignTicket(ticketId, "U-ASSIGNED");

  const who = await tickets.pingRecommendedHelper({
    client,
    ticket: db.getTicket(ticketId),
    program: { id: "ping-b", name: "PingB", helperPing: true },
  });
  assert.equal(who, "U-ASSIGNED");
  assert.match(posts[0].text, /<@U-ASSIGNED>/);
});

test("a ticket is classified on creation when its program has rules, and routing then matches a specialist", async () => {
  const helperRoute = require("./helperRoute");
  const client = { chat: { postMessage: async () => ({ ts: "cat-ts" }) } };
  const prog = {
    id: "cat-a",
    name: "CatA",
    posture: "active",
    helpChannel: "C-cat-a",
    channels: ["C-cat-a"],
    categories: {
      byKeyword: [{ category: "review", match: ["review", "resubmit"] }],
      fallback: "support",
    },
  };
  db.saveProgram(prog);
  db.syncHelper({ programId: "cat-a", userId: "U-REVIEWER", source: "manual" });
  db.syncHelper({ programId: "cat-a", userId: "U-GENERALIST", source: "manual" });
  helperRoute.recordResolution({ programId: "cat-a", userId: "U-REVIEWER", category: "review" });

  await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-cat-a",
    threadTs: "t-cat-1",
    requesterId: "U-req",
    question: "can I resubmit my project for review?",
    client,
  });
  const reviewTicket = db.getTicketByThreadTs("t-cat-1", null, "cat-a");
  assert.equal(reviewTicket.category, "review");

  await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-cat-a",
    threadTs: "t-cat-2",
    requesterId: "U-req",
    question: "where do I find the schedule?",
    client,
  });
  assert.equal(db.getTicketByThreadTs("t-cat-2", null, "cat-a").category, "support");

  const [top] = helperRoute.recommend({ programId: "cat-a", category: reviewTicket.category, limit: 1 });
  assert.equal(top.userId, "U-REVIEWER");
  assert.ok(top.reasons.some((r) => r.includes("verified review resolution")));
});

test("a ticket-enabled program without category rules uses the default taxonomy", async () => {
  const client = { chat: { postMessage: async () => ({ ts: "nocat-ts" }) } };
  const prog = {
    id: "cat-none",
    name: "NoCat",
    posture: "active",
    helpChannel: "C-cat-none",
    channels: ["C-cat-none"],
  };
  db.saveProgram(prog);
  await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-cat-none",
    threadTs: "t-nocat",
    requesterId: "U-req",
    question: "can I resubmit my project for review?",
    client,
  });
  assert.equal(db.getTicketByThreadTs("t-nocat", null, "cat-none").category, "review");
});

test("handOffToHelper mentions a helper with no ticket at all, once per thread", async () => {
  const helperRoute = require("./helperRoute");
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `thr-${posts.length}` };
      },
    },
  };
  const program = {
    id: "thr-a",
    name: "ThrA",
    helpChannel: "C-thr",
    helperPing: true,
    categories: { byKeyword: [{ category: "review", match: ["review"] }], fallback: "support" },
  };
  db.saveProgram(program);
  db.syncHelper({ programId: "thr-a", userId: "U-THR-REVIEW", source: "manual" });
  helperRoute.recordResolution({ programId: "thr-a", userId: "U-THR-REVIEW", category: "review" });

  const who = await tickets.handOffToHelper({
    client,
    program,
    channel: "C-thr",
    threadTs: "thr-1",
    question: "how long is the review queue?",
    ticket: null,
  });
  assert.equal(who, "U-THR-REVIEW");
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /<@U-THR-REVIEW>/);
  assert.equal(posts[0].thread_ts, "thr-1");
  assert.equal(db.getTicketByThreadTs("thr-1", null, "thr-a"), null);

  assert.equal(
    await tickets.handOffToHelper({
      client,
      program,
      channel: "C-thr",
      threadTs: "thr-1",
      question: "still waiting on review",
      ticket: null,
    }),
    null,
  );
  assert.equal(posts.length, 1);
});

function pingHelper(id, helpers) {
  const program = { id, name: id, helpChannel: `C-${id}`, channels: [`C-${id}`], helperPing: true };
  db.saveProgram(program);
  require("./programs").invalidate();
  for (const h of helpers) db.syncHelper({ programId: id, userId: h, source: "manual" });
  return program;
}

test("[epoch] 5 ordinary follow-ups on the same ticket produce exactly one ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e1-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-5x", ["U-HELPER"]);

  for (let i = 0; i < 5; i += 1) {
    await tickets.escalateTicket({
      program,
      channel: "C-epoch-5x",
      threadTs: "t-epoch-5x",
      requesterId: "U-req",
      question: `follow up ${i}`,
      client,
    });
  }

  const pings = posts.filter((p) => /could you take a look/.test(p.text));
  assert.equal(pings.length, 1, "exactly one ping across 5 escalation retries");
  assert.match(pings[0].text, /<@U-HELPER>/);
});

test("[epoch] two near-simultaneous ungrounded messages produce exactly one ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e2-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-concurrent", ["U-HELPER"]);

  await Promise.all([
    tickets.escalateTicket({
      program,
      channel: "C-epoch-concurrent",
      threadTs: "t-epoch-concurrent",
      requesterId: "U-req",
      question: "help 1",
      client,
    }),
    tickets.escalateTicket({
      program,
      channel: "C-epoch-concurrent",
      threadTs: "t-epoch-concurrent",
      requesterId: "U-req",
      question: "help 2",
      client,
    }),
  ]);

  const pings = posts.filter((p) => /could you take a look/.test(p.text));
  assert.equal(pings.length, 1, "concurrent escalations must still dedupe to one ping");
});

test("[epoch] resolved then a normal follow-up reopens the ticket but does not auto-ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e3-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-resolved", ["U-HELPER"]);

  const ticket = await tickets.escalateTicket({
    program,
    channel: "C-epoch-resolved",
    threadTs: "t-epoch-resolved",
    requesterId: "U-req",
    question: "help",
    client,
  });
  assert.equal(posts.filter((p) => /could you take a look/.test(p.text)).length, 1);

  tickets.resolveTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "epoch-resolved" });
  tickets.noteThreadActivity({ channel: "C-epoch-resolved", threadTs: "t-epoch-resolved", userId: "U-req", client });

  assert.equal(db.getTicket(ticket.id).status, "reopened");
  assert.equal(
    posts.filter((p) => /could you take a look/.test(p.text)).length,
    1,
    "reopening via ordinary activity must not add a second ping",
  );
});

test("[epoch] an explicit reopen does not ping until the routing lifecycle actually requires reassignment", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e4-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-reopen", ["U-HELPER"]);

  const ticket = await tickets.escalateTicket({
    program,
    channel: "C-epoch-reopen",
    threadTs: "t-epoch-reopen",
    requesterId: "U-req",
    question: "help",
    client,
  });
  tickets.resolveTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "epoch-reopen" });
  const beforeReopen = posts.filter((p) => /could you take a look/.test(p.text)).length;

  tickets.reopenTicket({ ticketId: ticket.id, actorId: "U-HELPER", programId: "epoch-reopen" });

  assert.equal(
    posts.filter((p) => /could you take a look/.test(p.text)).length,
    beforeReopen,
    "reopenTicket itself is a status change, not a routing decision — it must not ping on its own",
  );
});

test("[epoch] a declined helper hands off to exactly one next eligible helper", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e5-${posts.length}` };
      },
    },
  };
  const helperRoute = require("./helperRoute");
  const program = pingHelper("epoch-decline", ["U-FIRST", "U-SECOND"]);
  helperRoute.recordResolution({ programId: "epoch-decline", userId: "U-FIRST", category: "general_support" });
  helperRoute.recordResolution({ programId: "epoch-decline", userId: "U-SECOND", category: "general_support" });

  const ticket = await tickets.escalateTicket({
    program,
    channel: "C-epoch-decline",
    threadTs: "t-epoch-decline",
    requesterId: "U-req",
    question: "help",
    client,
  });
  const firstPing = posts.find((p) => /could you take a look/.test(p.text));
  assert.match(firstPing.text, /<@U-FIRST>/);

  const declined = tickets.declineAssignment({
    ticketId: ticket.id,
    actorId: "U-FIRST",
    programId: "epoch-decline",
    client,
    program,
  });
  assert.equal(declined.ok, true);

  const pings = posts.filter((p) => /could you take a look/.test(p.text));
  assert.equal(pings.length, 2, "exactly one new ping goes out after the decline");
  assert.match(pings[1].text, /<@U-SECOND>/);

  assert.ok(!pings.slice(1).some((p) => p.text.includes("U-FIRST")));
});

test("[epoch] a helper already replying in the thread gets zero new automated pings", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e6-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-replied", ["U-HELPER", "U-OTHER"]);

  const ticket = await tickets.escalateTicket({
    program,
    channel: "C-epoch-replied",
    threadTs: "t-epoch-replied",
    requesterId: "U-req",
    question: "help",
    client,
  });
  assert.equal(posts.filter((p) => /could you take a look/.test(p.text)).length, 1);

  tickets.noteThreadActivity({ channel: "C-epoch-replied", threadTs: "t-epoch-replied", userId: "U-OTHER", client });

  await tickets.escalateTicket({
    program,
    channel: "C-epoch-replied",
    threadTs: "t-epoch-replied",
    requesterId: "U-req",
    question: "still stuck",
    client,
  });

  assert.equal(
    posts.filter((p) => /could you take a look/.test(p.text)).length,
    1,
    "a helper already replying must suppress every further automated ping",
  );
});

test("[epoch] the Slack handler firing twice for one event still yields one ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e7-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-dup-event", ["U-HELPER"]);

  const eventTs = "1234567890.000100";
  const runHandlerOnce = async () => {
    if (!db.claimMessage(eventTs, "C-epoch-dup-event")) return;
    await tickets.escalateTicket({
      program,
      channel: "C-epoch-dup-event",
      threadTs: "t-epoch-dup-event",
      requesterId: "U-req",
      question: "help",
      client,
    });
  };

  await runHandlerOnce();
  await runHandlerOnce();

  assert.equal(posts.filter((p) => /could you take a look/.test(p.text)).length, 1);
});

test("[epoch] the requester's own explicit @mention of a roster helper suppresses the automated ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e8-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-explicit-mention", ["UHELPER1"]);

  await tickets.escalateTicket({
    program,
    channel: "C-epoch-explicit-mention",
    threadTs: "t-epoch-explicit-mention",
    requesterId: "U-req",
    question: "hey <@UHELPER1> can you check this out",
    client,
  });

  assert.equal(
    posts.filter((p) => /could you take a look/.test(p.text)).length,
    0,
    "the requester already paged a real helper themselves",
  );
});

test("[epoch] a muted thread never pings, even across repeated escalation retries", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e9-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-muted", ["U-HELPER"]);

  db.muteThread("t-epoch-muted", "C-epoch-muted");
  for (let i = 0; i < 3; i += 1) {
    await tickets.escalateTicket({
      program,
      channel: "C-epoch-muted",
      threadTs: "t-epoch-muted",
      requesterId: "U-req",
      question: `still stuck ${i}`,
      client,
    });
  }

  assert.equal(
    posts.filter((p) => /could you take a look/.test(p.text)).length,
    0,
    "mute must durably suppress every automated ping, not just the eligibility gate",
  );
});

test("handOffToHelper stays silent for a program that has not opted into mentions", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: "x" };
      },
    },
  };
  const program = { id: "thr-off", name: "ThrOff", helpChannel: "C-off", categories: { fallback: "support" } };
  db.saveProgram(program);
  db.syncHelper({ programId: "thr-off", userId: "U-OFF", source: "manual" });

  assert.equal(
    await tickets.handOffToHelper({
      client,
      program,
      channel: "C-off",
      threadTs: "thr-off-1",
      question: "anything",
      ticket: null,
    }),
    null,
  );
  assert.equal(posts.length, 0);
});

test("ticketVisibility dashboard creates the ticket but posts nothing in Slack", async () => {
  const posts = [];
  const reactions = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `v-${posts.length}` };
      },
    },
    reactions: {
      add: async (r) => {
        reactions.push(r);
      },
      remove: async () => {},
    },
  };
  const prog = {
    id: "vis-dash",
    name: "VisDash",
    posture: "active",
    helpChannel: "C-vis-dash",
    channels: ["C-vis-dash"],
    organizerChannel: "C-vis-dash-org",
    ticketVisibility: "dashboard",
  };
  db.saveProgram(prog);

  const ticket = await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-vis-dash",
    threadTs: "t-vis-dash",
    requesterId: "U-req",
    question: "anything at all",
    client,
  });
  assert.ok(ticket, "the ticket itself is still created — it feeds the dashboard and the stats");
  assert.equal(posts.length, 0, "nothing is posted to Slack at all");
  assert.equal(reactions.length, 0, "not even a reaction on the requester's message");
  assert.equal(ticket.public_ack_ts, null);
  assert.equal(ticket.card_ts, null);
});

test("ticketVisibility organizer keeps the requester's thread clean but still cards the organizers", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `o-${posts.length}` };
      },
    },
  };
  const prog = {
    id: "vis-org",
    name: "VisOrg",
    posture: "active",
    helpChannel: "C-vis-org",
    channels: ["C-vis-org"],
    organizerChannel: "C-vis-org-admin",
    ticketVisibility: "organizer",
  };
  db.saveProgram(prog);

  await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-vis-org",
    threadTs: "t-vis-org",
    requesterId: "U-req",
    question: "anything at all",
    client,
  });
  assert.equal(posts.length, 1, "exactly one post: the organizer card");
  assert.equal(posts[0].channel, "C-vis-org-admin");
  assert.ok(!posts.some((p) => p.thread_ts === "t-vis-org"), "nothing lands in the requester's thread");
});

test("a program with no visibility set still posts in the thread, as it always did", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `d-${posts.length}` };
      },
    },
  };
  const prog = {
    id: "vis-default",
    name: "VisDefault",
    posture: "active",
    helpChannel: "C-vis-def",
    channels: ["C-vis-def"],
  };
  db.saveProgram(prog);

  await tickets.ensureSupportTicket({
    program: prog,
    channel: "C-vis-def",
    threadTs: "t-vis-def",
    requesterId: "U-req",
    question: "anything at all",
    client,
  });
  assert.ok(
    posts.some((p) => p.thread_ts === "t-vis-def"),
    "the requester still gets their card",
  );
});

test("a helper answering in the thread is credited once, and the requester never is", () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({
    id: "credit-a",
    name: "CreditA",
    helpChannel: "C-credit",
    channels: ["C-credit"],
    categories: { byKeyword: [{ category: "review", match: ["review"] }], fallback: "support" },
  });
  db.syncHelper({ programId: "credit-a", userId: "U-HELPER", source: "manual" });

  const id = db.createTicket({
    programId: "credit-a",
    channel: "C-credit",
    threadTs: "t-credit",
    requesterId: "U-ASKER",
    question: "review question",
    category: "review",
  });

  tickets.noteThreadActivity({ channel: "C-credit", threadTs: "t-credit", userId: "U-ASKER" });
  assert.equal(helperRoute.getExpertise("credit-a", "U-ASKER").length, 0);

  tickets.noteThreadActivity({ channel: "C-credit", threadTs: "t-credit", userId: "U-HELPER" });
  const after = helperRoute.getExpertise("credit-a", "U-HELPER").find((r) => r.tag === "review");
  assert.equal(after.reply_count, 1);
  assert.ok(db.getTicket(id).first_human_response_at, "the reply counts as the first human response");

  tickets.noteThreadActivity({ channel: "C-credit", threadTs: "t-credit", userId: "U-HELPER" });
  tickets.noteThreadActivity({ channel: "C-credit", threadTs: "t-credit", userId: "U-HELPER" });
  assert.equal(helperRoute.getExpertise("credit-a", "U-HELPER").find((r) => r.tag === "review").reply_count, 1);

  const events = db.listTicketEvents(id).filter((e) => e.event_type === "helper_reply");
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_id, "U-HELPER");
});

test("someone who is not on the helper roster is never credited", () => {
  const helperRoute = require("./helperRoute");
  db.saveProgram({ id: "credit-b", name: "CreditB", helpChannel: "C-credit-b", channels: ["C-credit-b"] });
  db.syncHelper({ programId: "credit-b", userId: "U-REAL-HELPER", source: "manual" });
  db.createTicket({
    programId: "credit-b",
    channel: "C-credit-b",
    threadTs: "t-credit-b",
    requesterId: "U-ASKER",
    question: "q",
  });

  tickets.noteThreadActivity({ channel: "C-credit-b", threadTs: "t-credit-b", userId: "U-RANDOM-BYSTANDER" });
  assert.equal(helperRoute.getExpertise("credit-b", "U-RANDOM-BYSTANDER").length, 0);
});

test("a passive program still records a dashboard-only ticket, but never a visible one", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: "p" };
      },
    },
  };

  const silent = {
    id: "pas-dash",
    name: "PasDash",
    posture: "passive",
    helpChannel: "C-pas-dash",
    channels: ["C-pas-dash"],
    ticketVisibility: "dashboard",
  };
  db.saveProgram(silent);
  const recorded = await tickets.ensureSupportTicket({
    program: silent,
    channel: "C-pas-dash",
    threadTs: "t-pas-dash",
    requesterId: "U-req",
    question: "q",
    client,
  });
  assert.ok(recorded, "a silent ticket is a record, not participation");
  assert.equal(posts.length, 0);

  const visible = {
    id: "pas-thread",
    name: "PasThread",
    posture: "passive",
    helpChannel: "C-pas-thread",
    channels: ["C-pas-thread"],
  };
  db.saveProgram(visible);
  assert.equal(
    await tickets.ensureSupportTicket({
      program: visible,
      channel: "C-pas-thread",
      threadTs: "t-pas-thread",
      requesterId: "U-req",
      question: "q",
      client,
    }),
    null,
  );
  assert.equal(posts.length, 0);
});

test("[epoch] ticketless: a roster helper replying in the thread stops every later ping", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e10-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-ticketless", ["UHELPER2", "UHELPER3"]);
  const ask = (q, ts) =>
    tickets.handOffToHelper({
      client,
      program,
      channel: "C-epoch-ticketless",
      threadTs: ts,
      question: q,
      ticket: null,
    });

  tickets.noteThreadActivity({
    channel: "C-epoch-ticketless",
    threadTs: "t-tl-a",
    userId: "UHELPER2",
    parentUserId: "UREQ1",
  });
  assert.equal(await ask("how long is review?", "t-tl-a"), null);
  assert.equal(posts.length, 0, "a human is already on the thread, so no page");

  assert.ok(await ask("how long is review?", "t-tl-b"));
  assert.equal(posts.length, 1);
});

test("[epoch] a helper replying in their own thread does not silence Pixie there", () => {
  const program = pingHelper("epoch-self-thread", ["UHELPER4"]);
  tickets.noteThreadActivity({
    channel: "C-epoch-self-thread",
    threadTs: "t-self",
    userId: "UHELPER4",
    parentUserId: "UHELPER4",
  });
  assert.equal(db.isTakeover("t-self"), false);
  assert.ok(program);
});

test("[epoch] a taken-over thread with a ticket never pings on escalation retries", async () => {
  const posts = [];
  const client = {
    chat: {
      postMessage: async (p) => {
        posts.push(p);
        return { ts: `e11-${posts.length}` };
      },
    },
  };
  const program = pingHelper("epoch-takeover-ticket", ["UHELPER5"]);
  db.markTakeover("t-epoch-takeover-ticket", "C-epoch-takeover-ticket", "UHELPER5");
  for (let i = 0; i < 3; i += 1) {
    await tickets.escalateTicket({
      program,
      channel: "C-epoch-takeover-ticket",
      threadTs: "t-epoch-takeover-ticket",
      requesterId: "U-req",
      question: `q${i}`,
      client,
    });
  }
  assert.equal(posts.filter((p) => /could you take a look/.test(p.text)).length, 0);
});

test("ticketless program with helper pings on pages the category's best helper, once per thread", async () => {
  const prog = {
    id: "ticketless-ping",
    name: "Ticketless",
    posture: "passive",
    ticketsEnabled: false,
    helperPing: true,
    helpChannel: "C-TLP-HELP",
    channels: ["C-TLP-HELP"],
    categories: {
      byChannel: {},
      byKeyword: [{ category: "shop_orders", match: ["shop", "my order"] }],
      fallback: "general_support",
    },
  };
  for (const u of ["U-TLP-OTHER", "U-TLP-SHOP"]) db.syncHelper({ programId: prog.id, userId: u, source: "manual" });
  require("./helperRoute").setExpertise({ programId: prog.id, userId: "U-TLP-SHOP", tags: ["shop_orders"] });
  const posted = [];
  const client = {
    chat: {
      postMessage: async (m) => {
        posted.push(m);
        return { ok: true, ts: "tlp" };
      },
    },
  };
  const first = await tickets.handOffToHelper({
    client,
    program: prog,
    channel: "C-TLP-HELP",
    threadTs: "tlp.1",
    question: "my shop order never arrived",
    requesterId: "U-TLP-ASKER",
    role: "help",
  });
  const second = await tickets.handOffToHelper({
    client,
    program: prog,
    channel: "C-TLP-HELP",
    threadTs: "tlp.1",
    question: "hello??",
    requesterId: "U-TLP-ASKER",
    role: "help",
  });
  assert.equal(first, "U-TLP-SHOP");
  assert.equal(second, null);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /<@U-TLP-SHOP>/);
});
export {};
import type { TestDb, TestTickets } from "./test.types";
