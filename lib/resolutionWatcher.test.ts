const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const lease = require("./jobLease") as typeof import("./jobLease");
const watcher = require("./resolutionWatcher") as unknown as TestResolutionWatcher;

let sequence = 0;
const EVIDENCE = { ref: "m3", index: 2, role: "requester", userId: "U-REQUESTER", ts: "3" };

function setupProgram(extra = {}) {
  const id = `auto-${++sequence}`;
  const program = {
    id,
    name: id,
    helpChannel: `C-${id}`,
    channels: [`C-${id}`],
    organizerChannel: `O-${id}`,
    behavior: { help: { autoResolve: true } },
    ...extra,
  };
  db.saveProgram(program);
  programs.invalidate();
  return program;
}

function makeTicket(program, extra: { status?: string; updated_at?: number; created_at?: number } = {}) {
  const id = db.createTicket({
    programId: program.id,
    channel: program.helpChannel,
    threadTs: `thread-${program.id}`,
    requesterId: "U-REQUESTER",
    question: "The device is broken",
  });
  const ticket = db.getTicket(id);
  if (extra.status || extra.updated_at || extra.created_at) {
    db.handle()
      .query(
        "UPDATE tickets SET status = COALESCE(?, status), created_at = COALESCE(?, created_at), updated_at = COALESCE(?, updated_at) WHERE id = ?",
      )
      .run(extra.status || null, extra.created_at || null, extra.updated_at || null, id);
  }
  return db.getTicket(ticket.id);
}

function clientFor(messages, posts = [], updates = []) {
  return {
    conversations: { replies: async () => ({ messages }) },
    chat: {
      postMessage: async (payload) => {
        posts.push(payload);
        return { ts: `post-${posts.length}` };
      },
      update: async (payload) => {
        updates.push(payload);
        return { ok: true };
      },
    },
    reactions: { add: async () => {}, remove: async () => {} },
  };
}

beforeEach(() => watcher.stop());
afterEach(() => watcher.stop());

test("resolved judgement uses canonical resolve, credits the helper, and schedules pipeline work", async () => {
  const program = setupProgram();
  db.syncHelper({ programId: program.id, userId: "U-HELPER", source: "manual" });
  const ticket = makeTicket(program);
  db.addTicketEvent({
    ticketId: ticket.id,
    programId: program.id,
    actorId: "U-HELPER",
    eventType: "helper_reply",
    detail: { ts: "2", text: "Try restarting it." },
  });
  const client = clientFor([
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "2", user: "U-HELPER", text: "Try restarting it." },
    { ts: "3", user: "U-REQUESTER", text: "Thanks, that worked." },
  ]);
  const out = await watcher.judgeTicket(ticket.id, {
    client,
    program,
    judge: async () => ({
      verdict: "resolved",
      confidence: 0.91,
      reason: "requester confirmed the fix",
      reasonCode: "resolved:requester",
      evidence: EVIDENCE,
    }),
  });
  const resolved = db.getTicket(ticket.id);
  const event = db.listTicketEvents(ticket.id).find((row) => row.event_type === "resolved");
  assert.equal(out.result.ok, true);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_by, "U-HELPER");
  assert.match(resolved.resolution, /^auto-resolved:/);
  assert.deepEqual(JSON.parse(event.detail), {
    source: "auto",
    verdict: "resolved",
    confidence: 0.91,
    reason: "requester confirmed the fix",
    reasonCode: "resolved:requester",
    evidence: EVIDENCE,
  });
  assert.equal(event.actor_id, null);
  assert.equal(resolved.resolved_credit_id, "U-HELPER");
});

test("unresolved, low confidence, no answer, Jev errors, and disabled programs do not resolve", async () => {
  const cases = [
    [{ verdict: "still_open", confidence: 0.99 }, "decision"],
    [{ verdict: "resolved", confidence: 0.79 }, "decision"],
    [null, "no-answer"],
    [{ verdict: "unknown" }, "error"],
  ];
  for (const [decision, kind] of cases) {
    const program = setupProgram();
    const ticket = makeTicket(program);
    const messages =
      kind === "no-answer"
        ? [{ ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question }]
        : [
            { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
            { ts: "2", bot_id: "B-PIXIE", text: "An answer" },
            { ts: "3", user: "U-REQUESTER", text: "Still checking." },
          ];
    let calls = 0;
    const out = await watcher.judgeTicket(ticket.id, {
      client: clientFor(messages),
      program,
      judge: async () => {
        calls += 1;
        if (kind === "error") throw new Error("jev unavailable");
        return decision;
      },
    });
    assert.equal(db.getTicket(ticket.id).status, "open", kind);
    assert.equal(calls, kind === "no-answer" ? 0 : 1, kind);
    assert.ok(out);
  }
  const disabled = setupProgram({ behavior: { help: { autoResolve: false } } });
  const disabledTicket = makeTicket(disabled);
  let disabledCalls = 0;
  await watcher.judgeTicket(disabledTicket.id, {
    program: disabled,
    judge: async () => {
      disabledCalls += 1;
      return { verdict: "resolved", confidence: 1 };
    },
  });
  assert.equal(disabledCalls, 0);
  assert.equal(db.getTicket(disabledTicket.id).status, "open");
});

test("dashboard-only tickets stay silent and visible tickets only reconcile existing messages", async () => {
  const silentProgram = setupProgram({ publicTicketsEnabled: false, ticketVisibility: "dashboard" });
  const posts = [];
  const silentTicket = await require("./tickets").ensureSupportTicket({
    program: silentProgram,
    channel: silentProgram.helpChannel,
    threadTs: `silent-${silentProgram.id}`,
    requesterId: "U-REQUESTER",
    question: "silent question",
    client: clientFor([], posts),
  });
  assert.ok(silentTicket);
  assert.equal(posts.length, 0);
  await watcher.judgeTicket(silentTicket.id, {
    program: silentProgram,
    client: clientFor(
      [
        { ts: silentTicket.thread_ts, user: "U-REQUESTER", text: silentTicket.question },
        { ts: "2", bot_id: "B-PIXIE", text: "Solved." },
        { ts: "3", user: "U-REQUESTER", text: "Thanks." },
      ],
      posts,
    ),
    judge: async () => ({
      verdict: "resolved",
      confidence: 0.95,
      reason: "helper completed the fix",
      evidence: EVIDENCE,
    }),
  });
  assert.equal(db.getTicket(silentTicket.id).status, "resolved");
  assert.equal(posts.length, 0);

  const visible = setupProgram({ ticketVisibility: "thread" });
  const visibleTicket = makeTicket(visible);
  db.handle()
    .query("UPDATE tickets SET card_ts = ?, public_ack_ts = ? WHERE id = ?")
    .run("card", "ack", visibleTicket.id);
  const updates = [];
  await watcher.judgeTicket(visibleTicket.id, {
    program: visible,
    client: clientFor(
      [
        { ts: visibleTicket.thread_ts, user: "U-REQUESTER", text: visibleTicket.question },
        { ts: "2", bot_id: "B-PIXIE", text: "Solved." },
        { ts: "3", user: "U-REQUESTER", text: "Thanks." },
      ],
      [],
      updates,
    ),
    judge: async () => ({
      verdict: "resolved",
      confidence: 0.95,
      reason: "helper completed the fix",
      evidence: EVIDENCE,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(updates.some((update) => update.ts === "card"));
  assert.ok(updates.some((update) => update.ts === "ack"));
  assert.equal(
    updates.some((update) => update.method === "postMessage"),
    false,
  );
});

test("debounce judges one burst and stale sweep honors the job lease", async () => {
  const program = setupProgram();
  const ticket = makeTicket(program);
  const client = clientFor([
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "2", bot_id: "B-PIXIE", text: "Solved." },
    { ts: "3", user: "U-REQUESTER", text: "Thanks." },
  ]);
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { verdict: "unresolved", confidence: 0.9 };
  };
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  watcher.schedule({ ticketId: ticket.id, program, client, judge, delayMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);

  const old = makeTicket(program, {
    created_at: Date.now() - 7 * 60 * 60 * 1000,
    updated_at: Date.now() - 7 * 60 * 60 * 1000,
  });
  const holder = lease.acquire("ticket-resolution-sweep", 60 * 1000);
  const skipped = await watcher.sweepStale({ client, now: Date.now(), judge, useLease: true, examineSpacingMs: 0 });
  assert.equal(skipped.judged, 0);
  if (holder.held) lease.release("ticket-resolution-sweep", holder.owner);
  await watcher.sweepStale({ client, now: Date.now(), judge, useLease: false, examineSpacingMs: 0 });
  assert.equal(db.getTicket(old.id).status, "open");
});

test("a Jev rate limit pauses judging and leaves the ticket unjudged for a later retry", async () => {
  const program = setupProgram();
  const ticket = makeTicket(program);
  const other = makeTicket(program);
  const messages = [
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "2", bot_id: "B-PIXIE", text: "Try this." },
    { ts: "3", user: "U-REQUESTER", text: "Thanks, works." },
  ];
  let calls = 0;
  const limited = async () => {
    calls += 1;
    return { verdict: "unknown", errorKind: "rate_limit" };
  };
  try {
    const first = await watcher.judgeTicket(ticket.id, { client: clientFor(messages), program, judge: limited });
    assert.equal(first.reason, "backoff");
    const second = await watcher.judgeTicket(other.id, { client: clientFor(messages), program, judge: limited });
    assert.equal(second.reason, "backoff");
    assert.equal(calls, 1, "the second ticket never reached Jev");
    assert.equal(db.listTicketEvents(ticket.id).filter((e) => e.event_type === "resolution_judged").length, 0);
  } finally {
    watcher.stop();
  }
});

test("a stale sweep makes at most maxJudgements Jev calls", async () => {
  const program = setupProgram();
  const old = Date.now() - 7 * 60 * 60 * 1000;
  for (let i = 0; i < 4; i += 1) makeTicket(program, { created_at: old, updated_at: old });
  const client = clientFor([
    { ts: "1", user: "U-REQUESTER", text: "help" },
    { ts: "2", bot_id: "B-PIXIE", text: "Try this." },
    { ts: "3", user: "U-REQUESTER", text: "ok" },
  ]);
  let calls = 0;
  const judge = async () => {
    calls += 1;
    return { verdict: "waiting", confidence: 0.9 };
  };
  try {
    await watcher.sweepStale({ client, judge, useLease: false, maxJudgements: 2, spacingMs: 0, examineSpacingMs: 0 });
    assert.equal(calls, 2);
  } finally {
    watcher.stop();
  }
});

test("a historical (backlog) resolve is dated to the thread's last message and skips the pipeline", async () => {
  const program = setupProgram();
  const ticket = makeTicket(program);
  db.syncHelper({ programId: program.id, userId: "U-HELPER", source: "manual" });
  const lastTs = "1789000000.000100";
  const client = clientFor([
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "1788999000.000100", user: "U-HELPER", text: "try this" },
    { ts: lastTs, user: "U-REQUESTER", text: "works now" },
  ]);
  const pipeline = require("./resolutionPipeline");
  const original = pipeline.schedule;
  let scheduled = 0;
  pipeline.schedule = () => {
    scheduled += 1;
  };
  try {
    await watcher.judgeTicket(ticket.id, {
      client,
      program,
      historical: true,
      judge: async () => ({ verdict: "resolved", confidence: 0.95, reason: "confirmed", evidence: EVIDENCE }),
    });
  } finally {
    pipeline.schedule = original;
    watcher.stop();
  }
  const resolved = db.getTicket(ticket.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_at, 1789000000000);
  assert.equal(scheduled, 0);
});

test("auto-resolve still works and credits the helper after that helper has left the roster", async () => {
  const program = setupProgram();
  const ticket = makeTicket(program);
  db.syncHelper({ programId: program.id, userId: "U-FORMER", source: "manual" });
  db.syncHelper({ programId: program.id, userId: "U-STILL", source: "manual" });
  db.addTicketEvent({
    ticketId: ticket.id,
    programId: program.id,
    actorId: "U-FORMER",
    eventType: "helper_reply",
    detail: { ts: "2", text: "try this" },
  });
  db.handle()
    .query("UPDATE program_helpers SET active = 0 WHERE program_id = ? AND user_id = ?")
    .run(program.id, "U-FORMER");
  const client = clientFor([
    { ts: ticket.thread_ts, user: "U-REQUESTER", text: ticket.question },
    { ts: "2", user: "U-FORMER", text: "try this" },
    { ts: "3", user: "U-REQUESTER", text: "fixed, thanks" },
  ]);
  try {
    await watcher.judgeTicket(ticket.id, {
      client,
      program,
      judge: async () => ({ verdict: "resolved", confidence: 0.95, reason: "confirmed", evidence: EVIDENCE }),
    });
  } finally {
    watcher.stop();
  }
  const resolved = db.getTicket(ticket.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolved_credit_id, "U-FORMER");
});

test("last-word rule: a helper's last reply with the requester quiet 2+ days resolves without Jev and credits that helper", async () => {
  const program = setupProgram();
  db.syncHelper({ programId: program.id, userId: "U-FIRST", source: "manual" });
  db.syncHelper({ programId: program.id, userId: "U-LAST", source: "manual" });
  const day = 86400;
  const base = Math.floor(Date.now() / 1000) - 5 * day;
  const cases = [
    {
      name: "helper last, quiet 3d",
      rows: [
        ["U-REQUESTER", base],
        ["U-FIRST", base + 60],
        ["U-REQUESTER", base + 120],
        ["U-LAST", base + 2 * day],
      ],
      resolved: true,
    },
    {
      name: "requester last",
      rows: [
        ["U-REQUESTER", base],
        ["U-LAST", base + 60],
        ["U-REQUESTER", base + 2 * day],
      ],
      resolved: false,
    },
    {
      name: "helper last, only 1d quiet",
      rows: [
        ["U-REQUESTER", base],
        ["U-LAST", Math.floor(Date.now() / 1000) - day],
      ],
      resolved: false,
    },
  ];
  for (const c of cases) {
    const ticket = makeTicket(program);
    const messages = c.rows.map(([user, ts], i) => ({
      ts: i === 0 ? ticket.thread_ts : `${ts}.00010${i}`,
      user,
      text: `m${i}`,
    }));
    let jevCalls = 0;
    try {
      await watcher.judgeTicket(ticket.id, {
        client: clientFor(messages),
        program,
        judge: async () => {
          jevCalls += 1;
          return { verdict: "waiting", confidence: 0.9 };
        },
      });
    } finally {
      watcher.stop();
    }
    const after = db.getTicket(ticket.id);
    assert.equal(after.status === "resolved", c.resolved, c.name);
    if (c.resolved) {
      assert.equal(after.resolved_credit_id, "U-LAST", c.name);
      assert.equal(after.resolved_at, (base + 2 * day) * 1000 + 0, c.name);
      assert.equal(jevCalls, 0, `${c.name}: no Jev call needed`);
    }
  }
});
export {};
import type { TestDb, TestResolutionWatcher } from "./test.types";
