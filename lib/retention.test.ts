process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const retention = require("./retention");
const traceStore = require("./pipeline/traceStore");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
});

test("retention validatePolicy enforces the audit floor and knowledge keep", () => {
  assert.equal(retention.AUDIT_MIN_DAYS, 365);
  assert.match(retention.validatePolicy({ auditDays: 10 }), /platform minimum/);
  assert.match(retention.validatePolicy({ auditDays: 364 }), /platform minimum/);
  assert.equal(retention.validatePolicy({ auditDays: 365 }), null);
  assert.equal(retention.validatePolicy({ auditDays: 730 }), null);
  assert.equal(retention.validatePolicy({ ticketsDays: 30 }), null);
  assert.equal(retention.validatePolicy({ knowledge: "keep" }), null);
  assert.match(retention.validatePolicy({ knowledge: "drop" }), /only 'keep'/);
  assert.match(retention.validatePolicy({ ticketsDays: 0 }), /positive number/);
  assert.match(retention.validatePolicy({ ticketsDays: -5 }), /positive number/);
  assert.match(retention.validatePolicy({ contextDays: "nope" }), /positive number/);
});

test("retention policyFor floors auditDays and keeps knowledge", () => {
  db.saveProgram({
    id: "char-ret-floor",
    name: "R",
    helpChannel: "C-R",
    channels: ["C-R"],
    retention: { ticketsDays: 30, auditDays: 10 },
  });
  programs.invalidate();
  const p = retention.policyFor("char-ret-floor");
  assert.equal(p.auditDays, 365);
  assert.equal(p.ticketsDays, 30);
  assert.equal(p.knowledge, "keep");
  assert.equal(p.contextDays, 30);
  assert.equal(p.tracesDays, 30);
  assert.equal(p.analyticsDays, 365);
  const d = retention.policyFor("char-ret-missing");
  assert.deepEqual(d, retention.DEFAULTS);
});

test("retention preview shape is counts + policy, never row contents", () => {
  db.saveProgram({ id: "char-ret-shape", name: "S", helpChannel: "C-S", channels: ["C-S"] });
  programs.invalidate();
  const prev = retention.preview("char-ret-shape");
  assert.equal(prev.programId, "char-ret-shape");
  assert.ok(prev.policy && typeof prev.policy.ticketsDays === "number");
  assert.equal(typeof prev.tickets, "number");
  assert.equal(typeof prev.ticketEvents, "number");
  assert.equal(typeof prev.notes, "number");
  assert.equal(typeof prev.metrics, "number");
  assert.equal(typeof prev.gaps, "number");
  assert.equal(prev.auditEligible, 0);
  const blob = JSON.stringify(prev);
  assert.equal(/xoxb-/.test(blob), false);
  assert.equal(/"secret"\s*:/i.test(blob), false);
});

test("retention sweep confirm gate lives in the frozen api contract", () => {
  const api = require("./web/api");
  api.internalProgramSync("char-ret-gate", {
    name: "R",
    workspaceId: "T1",
    claimedBy: "U-char-ret-org",
    programChannels: [],
  });
  db.syncHelper({ programId: "char-ret-gate", userId: "U-char-ret-helper", source: "manual" });
  assert.match(
    api.internalRetentionSweep("char-ret-gate", { actorId: "U-char-ret-helper", confirm: true }).error,
    /organizer/,
  );
  assert.match(api.internalRetentionSweep("char-ret-gate", { actorId: "U-char-ret-org" }).error, /confirm required/);
  assert.equal(api.internalRetentionSweep("char-ret-gate", { actorId: "U-char-ret-org", confirm: true }).deleted, true);
});

test("retention sweep deletes per-table, tenant-scoped, spares open/audit/knowledge", () => {
  db.saveProgram({
    id: "char-ret-sweep",
    name: "R",
    helpChannel: "C-R",
    channels: ["C-R"],
    retention: { ticketsDays: 30, tracesDays: 30, analyticsDays: 365 },
  });
  programs.invalidate();
  const ancient = Date.now() - 60 * 86400000;
  const fresh = Date.now();

  const old = db.createTicket({
    programId: "char-ret-sweep",
    workspaceId: "T1",
    channel: "C-R",
    threadTs: "char-ret-old",
    requesterId: "U1",
    question: "old q",
  });
  db.resolveTicket(old, "done");
  db.addTicketEvent({ ticketId: old, programId: "char-ret-sweep", actorId: "U1", eventType: "resolved" });
  db.addTicketNote({ ticketId: old, programId: "char-ret-sweep", authorId: "U1", body: "old note" });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, old);

  const open = db.createTicket({
    programId: "char-ret-sweep",
    workspaceId: "T1",
    channel: "C-R",
    threadTs: "char-ret-open",
    requesterId: "U1",
    question: "open q",
  });
  db.addTicketNote({ ticketId: open, programId: "char-ret-sweep", authorId: "U1", body: "open note" });
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, open);

  const recent = db.createTicket({
    programId: "char-ret-sweep",
    workspaceId: "T1",
    channel: "C-R",
    threadTs: "char-ret-recent",
    requesterId: "U1",
    question: "recent q",
  });
  db.resolveTicket(recent, "done");
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(fresh, recent);

  const veryAncient = Date.now() - 400 * 86400000;
  db.recordMetric("answer", 10, null, "char-ret-sweep");
  db.handle().query("UPDATE metrics SET created_at = ? WHERE program_id = ?").run(veryAncient, "char-ret-sweep");
  db.recordGap("char old gap", "U1", "C-R", "char-gap-old", "char-ret-sweep");
  db.handle().query("UPDATE doc_gaps SET created_at = ? WHERE program_id = ?").run(ancient, "char-ret-sweep");
  db.handle()
    .query("INSERT OR REPLACE INTO sla_notifications (program_id, ticket_id, rule, sent_at) VALUES (?, ?, ?, ?)")
    .run("char-ret-sweep", old, "unassigned", veryAncient);
  const auditId = require("./audit").record({
    programId: "char-ret-sweep",
    actorId: "U1",
    action: "char.probe",
    entityType: "t",
    entityId: "1",
  });
  db.handle().query("UPDATE audit_events SET created_at = ? WHERE id = ?").run(ancient, auditId);
  const factId = db.addLearnedFact({
    question: "char keep q",
    answer: "char keep a",
    authorId: "U1",
    status: "approved",
    programId: "char-ret-sweep",
  });

  const other = db.createTicket({
    programId: "char-ret-other",
    workspaceId: "T1",
    channel: "CX",
    threadTs: "char-ret-other-t",
    requesterId: "U1",
    question: "other q",
  });
  db.resolveTicket(other, "done");
  db.handle().query("UPDATE tickets SET created_at = ? WHERE id = ?").run(ancient, other);

  const prev = retention.preview("char-ret-sweep");
  assert.equal(prev.tickets, 1);
  assert.equal(prev.ticketEvents >= 1, true);
  assert.equal(prev.notes >= 1, true);
  assert.equal(prev.metrics >= 1, true);
  assert.equal(prev.gaps >= 1, true);
  assert.equal(prev.auditEligible, 0);

  const dry = retention.sweepProgram("char-ret-sweep", { dryRun: true });
  assert.equal(dry.deleted, false);
  assert.ok(db.getTicket(old), "dry run deletes nothing");

  const swept = retention.sweepProgram("char-ret-sweep", { dryRun: false });
  assert.equal(swept.deleted, true);
  assert.equal(db.getTicket(old), null);
  assert.ok(db.getTicket(open), "open tickets survive regardless of age");
  assert.ok(db.getTicket(recent), "recent resolved tickets survive");
  assert.ok(db.getTicket(other), "other tenants untouched");
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?").get(old).n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id = ?").get(old).n, 0);
  assert.ok(
    db.handle().query("SELECT * FROM ticket_notes WHERE ticket_id = ?").all(open).length >= 1,
    "open ticket notes survive",
  );
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM metrics WHERE program_id = ?").get("char-ret-sweep").n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM doc_gaps WHERE program_id = ?").get("char-ret-sweep").n, 0);
  assert.equal(
    db.handle().query("SELECT COUNT(*) AS n FROM sla_notifications WHERE program_id = ?").get("char-ret-sweep").n,
    0,
  );

  assert.ok(db.handle().query("SELECT * FROM audit_events WHERE id = ?").get(auditId), "audit never deleted");
  assert.ok(db.getLearnedFactById(factId), "approved knowledge survives its source ticket");
});

test("retention sweep expires traces using their stored TTL and keeps other programs", () => {
  db.saveProgram({
    id: "char-ret-traces",
    name: "Trace retention",
    retention: { tracesDays: 2 },
  });
  db.saveProgram({ id: "char-ret-traces-other", name: "Other" });
  programs.invalidate();
  const expired = traceStore.append({
    programId: "char-ret-traces",
    stage: "final_action",
    payload: { action: "reply" },
  });
  const fresh = traceStore.append({
    programId: "char-ret-traces",
    stage: "final_action",
    payload: { action: "silence" },
  });
  const other = traceStore.append({
    programId: "char-ret-traces-other",
    stage: "final_action",
    payload: { action: "reply" },
  });
  db.handle()
    .query("UPDATE answer_traces SET expires_at = ? WHERE id = ?")
    .run(Date.now() - 1, expired);

  const swept = retention.sweepProgram("char-ret-traces", { dryRun: false });
  assert.equal(swept.deleted, true);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE id = ?").get(expired).n, 0);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE id = ?").get(fresh).n, 1);
  assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answer_traces WHERE id = ?").get(other).n, 1);
});
export {};
