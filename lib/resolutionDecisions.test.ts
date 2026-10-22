const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const tickets = require("./tickets");
const watcher = require("./resolutionWatcher");

db.open(":memory:");

let seq = 0;
type Msg = { ts: string; user?: string; bot_id?: string; text: string };

function setup(
  { category = "advice_how_to", question = "How do I reset the device?", autoResolve = true, extra = {} } = {} as {
    category?: string | null;
    question?: string;
    autoResolve?: boolean;
    extra?: Record<string, unknown>;
  },
) {
  seq += 1;
  const id = `dec-${seq}`;
  const program = {
    id,
    name: id,
    helpChannel: `C-${id}`,
    channels: [`C-${id}`],
    behavior: { help: { autoResolve } },
    ...extra,
  };
  db.saveProgram(program);
  programs.invalidate();
  db.syncHelper({ programId: id, userId: "U-HELPER", source: "manual" });
  const ticketId = db.createTicket({
    programId: id,
    channel: program.helpChannel,
    threadTs: `thread-${id}`,
    requesterId: "U-REQ",
    question,
  });
  if (category) db.setTicketTriage(ticketId, { category, categorySource: "human" });
  return { program, ticket: db.getTicket(ticketId) };
}

function thread(ticket: { thread_ts: string; question: string }, ...rest: Array<[string, string]>): Msg[] {
  const who: Record<string, Partial<Msg>> = {
    req: { user: "U-REQ" },
    helper: { user: "U-HELPER" },
    bot: { bot_id: "B-PIXIE" },
    other: { user: "U-BYSTANDER" },
  };
  return [
    { ts: ticket.thread_ts, user: "U-REQ", text: ticket.question },
    ...(rest.map(([role, text], i) => ({ ts: String(i + 2), text, ...who[role] })) as Msg[]),
  ];
}

function client(messages: Msg[], pages?: Msg[][]) {
  return {
    conversations: {
      replies: async (args: { cursor?: string }) => {
        if (!pages) return { messages };
        const page = Number(args.cursor || 0);
        return {
          messages: pages[page],
          has_more: page < pages.length - 1,
          response_metadata: { next_cursor: String(page + 1) },
        };
      },
    },
    chat: { postMessage: async () => ({ ts: "x" }), update: async () => ({ ok: true }) },
    reactions: { add: async () => {}, remove: async () => {} },
  };
}

const evidenceAt = (index: number, role = "requester", userId = "U-REQ") => ({
  ref: `m${index + 1}`,
  index,
  role,
  userId,
  ts: String(index + 1),
});
const decide = (verdict: string, confidence: number, evidence: ReturnType<typeof evidenceAt> | null) => async () => ({
  verdict,
  confidence,
  reason: `test ${verdict}`,
  reasonCode: `${verdict}:${evidence?.role || "none"}`,
  evidence,
});
const status = (id: number) => db.getTicket(id).status;
const judged = (id: number) =>
  db.listTicketEvents(id).filter((e: { event_type: string }) => e.event_type === "resolution_judged");

beforeEach(() => watcher.stop());
afterEach(() => watcher.stop());

async function run(
  s: ReturnType<typeof setup>,
  messages: Msg[],
  judge: (...args: unknown[]) => unknown,
  opts: Record<string, unknown> = {},
) {
  return watcher.judgeTicket(s.ticket.id, { client: client(messages), program: s.program, judge, ...opts });
}

test("informational: a verified answer plus the requester's confirmation resolves", async () => {
  const s = setup();
  await run(
    s,
    thread(s.ticket, ["bot", "Hold the reset button for 5 seconds."], ["req", "That worked, thanks"]),
    decide("resolved", 0.9, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "resolved");
  const event = db.listTicketEvents(s.ticket.id).find((e: { event_type: string }) => e.event_type === "resolved");
  const detail = JSON.parse(event.detail);
  assert.equal(detail.source, "auto");
  assert.equal(detail.reasonCode, "resolved:requester");
  assert.equal(detail.evidence.ref, "m3");
});

test("informational: a bare thank-you after the answer is enough", async () => {
  const s = setup();
  await run(
    s,
    thread(s.ticket, ["bot", "Hold the reset button."], ["req", "thanks!"]),
    decide("resolved", 0.85, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "resolved");
});

test("troubleshooting: a thank-you without confirming success stays open", async () => {
  const s = setup({ category: "site_bug", question: "The site shows an error" });
  await run(
    s,
    thread(s.ticket, ["helper", "Try clearing your cache."], ["req", "thanks"]),
    decide("resolved", 0.97, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "needs_explicit_confirmation");
});

test("troubleshooting: explicit confirmation from the requester resolves", async () => {
  const s = setup({ category: "site_bug", question: "The site shows an error" });
  await run(
    s,
    thread(s.ticket, ["helper", "Try clearing your cache."], ["req", "that fixed it, works now"]),
    decide("resolved", 0.93, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "resolved");
});

test("troubleshooting needs 0.9, not 0.8", async () => {
  const s = setup({ category: "site_bug", question: "The site shows an error" });
  await run(
    s,
    thread(s.ticket, ["helper", "Try clearing your cache."], ["req", "that fixed it"]),
    decide("resolved", 0.85, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "low_confidence");
});

test("the requester reporting the issue persists keeps it open", async () => {
  const s = setup();
  await run(
    s,
    thread(s.ticket, ["bot", "Hold the reset button."], ["req", "still broken"]),
    decide("still_open", 0.95, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
});

test("a helper's resolution is accepted as evidence for an informational question only", async () => {
  const s = setup();
  await run(
    s,
    thread(s.ticket, ["helper", "All fixed on our side, you can retry."]),
    decide("resolved", 0.9, evidenceAt(1, "helper", "U-HELPER")),
  );
  assert.equal(status(s.ticket.id), "resolved");

  const t = setup({ category: "site_bug", question: "The site shows an error" });
  await run(
    t,
    thread(t.ticket, ["helper", "All fixed on our side, you can retry."]),
    decide("resolved", 0.99, evidenceAt(1, "helper", "U-HELPER")),
  );
  assert.equal(status(t.ticket.id), "open");
  assert.equal(JSON.parse(judged(t.ticket.id)[0].detail).gate, "evidence_role");
});

test("a bystander or Pixie itself can never be the evidence that closes a ticket", async () => {
  for (const [role, who, line] of [
    ["other", "U-BYSTANDER", "yep that fixed it for me too"],
    ["pixie", "B-PIXIE", "Marking this resolved."],
  ]) {
    const s = setup();
    await run(
      s,
      thread(s.ticket, ["bot", "Hold the reset button."], [role === "other" ? "other" : "bot", line]),
      decide("resolved", 0.99, evidenceAt(2, role, who)),
    );
    assert.equal(status(s.ticket.id), "open", role);
  }
});

test("evidence from before the first answer cannot resolve a ticket", async () => {
  const s = setup();
  await run(
    s,
    thread(s.ticket, ["req", "never mind, works"], ["helper", "Hold the reset button."], ["req", "ok"]),
    decide("resolved", 0.99, evidenceAt(1)),
  );
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "evidence_before_answer");
});

test("a resolution with no evidence message is not applied", async () => {
  const s = setup();
  await run(s, thread(s.ticket, ["bot", "Hold the reset button."], ["req", "thanks"]), decide("resolved", 0.99, null));
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "no_evidence");
});

test("conflicting messages: a later 'still broken' overrides an earlier confirmation", async () => {
  const s = setup({ category: "site_bug", question: "The site shows an error" });
  await run(
    s,
    thread(s.ticket, ["helper", "Clear your cache."], ["req", "works now, fixed"], ["req", "wait, it's broken again"]),
    decide("resolved", 0.95, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "contradicted");
});

test("ambiguous threads stay open", async () => {
  for (const verdict of ["insufficient_evidence", "needs_clarification"]) {
    const s = setup();
    await run(s, thread(s.ticket, ["bot", "Hold the reset button."], ["req", "hmm"]), decide(verdict, 0.9, null));
    assert.equal(status(s.ticket.id), "open", verdict);
  }
});

test("fulfilment: no resolution without a human having taken part, even with a confirmation", async () => {
  const s = setup({ category: "fulfillment_shipping", question: "Where is my package?" });
  const messages = thread(s.ticket, ["bot", "Shipping takes 3 weeks."], ["req", "ok it arrived, all good"]);
  await run(s, messages, decide("resolved", 0.97, evidenceAt(2)));
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "needs_human_involvement");
});

test("fulfilment: a helper replied and the requester confirmed with high confidence resolves", async () => {
  const s = setup({ category: "fulfillment_shipping", question: "Where is my package?" });
  db.addTicketEvent({
    ticketId: s.ticket.id,
    programId: s.program.id,
    actorId: "U-HELPER",
    eventType: "helper_reply",
    detail: { ts: "2", text: "Tracking sent" },
  });
  const messages = thread(s.ticket, ["helper", "Tracking sent"], ["req", "it arrived, thank you, all good"]);
  await run(s, messages, decide("resolved", 0.95, evidenceAt(2)));
  assert.equal(status(s.ticket.id), "resolved");
});

test("account access issues use the same high-impact standard", async () => {
  const s = setup({ category: "account_access", question: "I cannot sign in" });
  await run(
    s,
    thread(s.ticket, ["bot", "Try resetting your password."], ["req", "it works now"]),
    decide("resolved", 0.97, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
});

test("sensitive or disputed tickets are never closed automatically", async () => {
  const s = setup({
    category: "advice_how_to",
    question: "Please can I talk to a human about my account suspension",
    extra: { sensitiveCategories: ["suspension"] },
  });
  await run(
    s,
    thread(s.ticket, ["helper", "We reviewed it."], ["req", "ok thanks, fixed"]),
    decide("resolved", 0.99, evidenceAt(2)),
  );
  assert.equal(status(s.ticket.id), "open");
  assert.equal(JSON.parse(judged(s.ticket.id)[0].detail).gate, "policy_manual");
});

test("the last-word rule does not close high-impact tickets", async () => {
  const s = setup({ category: "fulfillment_shipping", question: "Where is my package?" });
  const old = String(Math.floor(Date.now() / 1000) - 5 * 24 * 3600);
  const messages: Msg[] = [
    { ts: String(Number(old) - 100), user: "U-REQ", text: s.ticket.question },
    { ts: old, user: "U-HELPER", text: "Sent tracking." },
  ];
  let calls = 0;
  await run(s, messages, async () => {
    calls += 1;
    return { verdict: "insufficient_evidence", confidence: 0.5, evidence: null };
  });
  assert.equal(calls, 1, "the judge was asked instead of the quiet-helper shortcut closing it");
  assert.equal(status(s.ticket.id), "open");
});

test("duplicate events: the same last message is judged once and resolves once", async () => {
  const s = setup();
  const messages = thread(s.ticket, ["bot", "Hold the reset button."], ["req", "that worked"]);
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return decide("resolved", 0.9, evidenceAt(2))();
  };
  await Promise.all([run(s, messages, judge), run(s, messages, judge), run(s, messages, judge)]);
  await run(s, messages, judge);
  assert.equal(calls, 1);
  const resolved = db.listTicketEvents(s.ticket.id).filter((e: { event_type: string }) => e.event_type === "resolved");
  assert.equal(resolved.length, 1);
});

test("concurrent update: a human resolving while the judge is thinking wins cleanly", async () => {
  const s = setup();
  const messages = thread(s.ticket, ["bot", "Hold the reset button."], ["req", "that worked"]);
  await run(s, messages, async () => {
    db.resolveTicket(s.ticket.id, "resolved by hand", "U-HELPER");
    return decide("resolved", 0.95, evidenceAt(2))();
  });
  const row = db.getTicket(s.ticket.id);
  assert.equal(row.status, "resolved");
  assert.equal(row.resolution, "resolved by hand");
  const resolved = db.listTicketEvents(s.ticket.id).filter((e: { event_type: string }) => e.event_type === "resolved");
  assert.ok(resolved.length <= 1);
});

test("Jev unavailable or malformed: the ticket stays open and the message is retried later", async () => {
  const s = setup();
  const messages = thread(s.ticket, ["bot", "Hold the reset button."], ["req", "that worked"]);
  await run(s, messages, async () => {
    throw new Error("jev down");
  });
  await run(s, messages, async () => ({ verdict: "unknown" }));
  await run(s, messages, async () => ({ verdict: "unknown", errorKind: "timeout" }));
  assert.equal(status(s.ticket.id), "open");
  assert.equal(judged(s.ticket.id).length, 0, "an unavailable judge must not mark the message as judged");
  await run(s, messages, decide("resolved", 0.9, evidenceAt(2)));
  assert.equal(status(s.ticket.id), "resolved");
});

test("an already-closed ticket is not judged again for a thank-you", async () => {
  const s = setup();
  db.resolveTicket(s.ticket.id, "done", "U-HELPER");
  let calls = 0;
  await run(s, thread(s.ticket, ["helper", "Fixed."], ["req", "thanks!"]), async () => {
    calls += 1;
    return decide("still_open", 0.99, evidenceAt(2))();
  });
  assert.equal(calls, 0);
  assert.equal(status(s.ticket.id), "resolved");
});

test("an ambiguous follow-up on a resolved ticket is reassessed, and reopens only with the requester's own message as evidence", async () => {
  const s = setup();
  db.resolveTicket(s.ticket.id, "done", "U-HELPER");
  const later = String(Math.floor(Date.now() / 1000) + 60);
  const messages: Msg[] = [
    { ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question },
    { ts: "2", user: "U-HELPER", text: "Fixed." },
    { ts: later, user: "U-REQ", text: "the light is blinking orange now" },
  ];
  await run(s, messages, decide("still_open", 0.9, evidenceAt(2)), {});
  assert.equal(status(s.ticket.id), "reopened");
  assert.equal(db.getTicket(s.ticket.id).reopen_count, 1);
});

test("reassessment cannot reopen on a bystander's message or on an unrelated question", async () => {
  const s = setup();
  db.resolveTicket(s.ticket.id, "done", "U-HELPER");
  const later = String(Math.floor(Date.now() / 1000) + 60);
  const bystander: Msg[] = [
    { ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question },
    { ts: "2", user: "U-HELPER", text: "Fixed." },
    { ts: later, user: "U-BYSTANDER", text: "mine is broken too" },
  ];
  await run(s, bystander, decide("still_open", 0.99, evidenceAt(2, "other", "U-BYSTANDER")));
  assert.equal(status(s.ticket.id), "resolved");

  const unrelated: Msg[] = [
    { ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question },
    { ts: "2", user: "U-HELPER", text: "Fixed." },
    { ts: String(Number(later) + 1), user: "U-REQ", text: "totally different: when is the next jam?" },
  ];
  await run(s, unrelated, decide("insufficient_evidence", 0.9, null));
  assert.equal(status(s.ticket.id), "resolved");
});

test("reopen, then a later confirmation resolves it again", async () => {
  const s = setup();
  db.resolveTicket(s.ticket.id, "done", "U-HELPER");
  tickets.noteThreadActivity({
    channel: s.program.helpChannel,
    threadTs: s.ticket.thread_ts,
    userId: "U-REQ",
    text: "it's still broken",
  });
  assert.equal(status(s.ticket.id), "reopened");
  const messages = thread(s.ticket, ["helper", "Try the other cable."], ["req", "that fixed it, thanks"]);
  await run(s, messages, decide("resolved", 0.92, evidenceAt(2)));
  assert.equal(status(s.ticket.id), "resolved");
  assert.equal(db.getTicket(s.ticket.id).reopen_count, 1);
});

test("escalate hands off to a helper once and does not loop", async () => {
  const s = setup();
  const calls: unknown[] = [];
  const real = tickets.handOffToHelper;
  tickets.handOffToHelper = async (args: unknown) => {
    calls.push(args);
    return null;
  };
  try {
    const first = thread(s.ticket, ["bot", "Try this."], ["req", "I need someone to look at my account"]);
    await run(s, first, decide("escalate", 0.9, evidenceAt(2)));
    await run(s, first, decide("escalate", 0.9, evidenceAt(2)));
    assert.equal(calls.length, 1);
    assert.equal(status(s.ticket.id), "open");
  } finally {
    tickets.handOffToHelper = real;
  }
});

test("with auto-resolve off nothing is resolved, but a clear 'still broken' still reopens", async () => {
  const s = setup({ autoResolve: false });
  db.resolveTicket(s.ticket.id, "done", "U-HELPER");
  tickets.noteThreadActivity({
    channel: s.program.helpChannel,
    threadTs: s.ticket.thread_ts,
    userId: "U-REQ",
    text: "thanks",
  });
  assert.equal(status(s.ticket.id), "resolved");
  tickets.noteThreadActivity({
    channel: s.program.helpChannel,
    threadTs: s.ticket.thread_ts,
    userId: "U-REQ",
    text: "still not working",
  });
  assert.equal(status(s.ticket.id), "reopened");
});

test("a long thread: the judge is given the newest messages across Slack pages", async () => {
  const s = setup();
  const page = (from: number, count: number): Msg[] =>
    Array.from({ length: count }, (_, i) => ({
      ts: String(from + i),
      user: i % 2 ? "U-HELPER" : "U-REQ",
      text: `m${from + i}`,
    }));
  const first = [{ ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question }, ...page(2, 99)];
  const pages = [first, page(101, 100), [...page(201, 20), { ts: "999", user: "U-REQ", text: "NEWEST works now" }]];
  let seen: Array<{ text: string }> = [];
  await watcher.judgeTicket(s.ticket.id, {
    client: client([], pages),
    program: s.program,
    judge: async ({ transcript }: { transcript: Array<{ text: string }> }) => {
      seen = transcript;
      return { verdict: "insufficient_evidence", confidence: 0.5, evidence: null };
    },
  });
  assert.equal(seen.at(-1)?.text, "NEWEST works now");
});
const incomplete = (id: number) =>
  judged(id).some((e: { detail: string }) => JSON.parse(e.detail).gate === "incomplete_history");

test("history longer than the page limit fails closed: an old confirmation cannot close past a later 'still broken'", async () => {
  const s = setup({ category: "site_bug", question: "The site shows an error" });
  const page = (from: number, count: number): Msg[] =>
    Array.from({ length: count }, (_, i) => ({
      ts: String(from + i),
      user: i % 2 ? "U-HELPER" : "U-REQ",
      text: `chat ${from + i}`,
    }));
  const first: Msg[] = [
    { ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question },
    { ts: "2", user: "U-HELPER", text: "Clear your cache." },
    { ts: "3", user: "U-REQ", text: "that fixed it, works now" },
    ...page(4, 97),
  ];
  const pages = [
    first,
    page(101, 100),
    page(201, 100),
    page(301, 100),
    page(401, 100),
    page(501, 100),
    [{ ts: "999", user: "U-REQ", text: "wait, still broken" }],
  ];
  let calls = 0;
  await watcher.judgeTicket(s.ticket.id, {
    client: client([], pages),
    program: s.program,
    judge: async () => {
      calls += 1;
      return decide("resolved", 0.99, evidenceAt(2))();
    },
  });
  assert.equal(status(s.ticket.id), "open");
  assert.equal(calls, 0, "no judgement is spent on a history known to be partial");
  assert.ok(incomplete(s.ticket.id));
});

test("a Slack fetch failure falls back to a partial record and never closes on it", async () => {
  const s = setup({ category: "advice_how_to" });
  db.addTicketEvent({
    ticketId: s.ticket.id,
    programId: s.program.id,
    actorId: "U-HELPER",
    eventType: "helper_reply",
    detail: { ts: "2", text: "Hold reset." },
  });
  db.addTicketEvent({
    ticketId: s.ticket.id,
    programId: s.program.id,
    actorId: "U-REQ",
    eventType: "requester_followup",
    detail: { text: "that worked, thanks" },
  });
  const broken = {
    conversations: {
      replies: async () => {
        throw new Error("slack is down");
      },
    },
  };
  let calls = 0;
  await watcher.judgeTicket(s.ticket.id, {
    client: broken,
    program: s.program,
    judge: async () => {
      calls += 1;
      return decide("resolved", 0.99, evidenceAt(2))();
    },
  });
  assert.equal(status(s.ticket.id), "open");
  assert.equal(calls, 0);
  assert.ok(incomplete(s.ticket.id));
});

test("exactly five full pages that end the thread are complete and can still resolve", async () => {
  const s = setup();
  const page = (from: number, count: number): Msg[] =>
    Array.from({ length: count }, (_, i) => ({ ts: String(from + i), user: "U-HELPER", text: `h${from + i}` }));
  const first: Msg[] = [{ ts: s.ticket.thread_ts, user: "U-REQ", text: s.ticket.question }, ...page(2, 99)];
  const pages = [
    first,
    page(101, 100),
    page(201, 100),
    page(301, 100),
    [...page(401, 99), { ts: "999", user: "U-REQ", text: "that worked" }],
  ];
  let seen = 0;
  await watcher.judgeTicket(s.ticket.id, {
    client: client([], pages),
    program: s.program,
    judge: async ({ transcript }: { transcript: unknown[] }) => {
      seen = transcript.length;
      return { verdict: "insufficient_evidence", confidence: 0.5, evidence: null };
    },
  });
  assert.equal(seen, 500);
  assert.equal(incomplete(s.ticket.id), false);
});
export {};
