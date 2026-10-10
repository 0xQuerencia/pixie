process.env.PIXIE_DB_PATH = ":memory:";

interface TestRow {
  createdAt?: number;
  updatedAt?: number;
  firstResponseAt?: number;
  firstHumanResponseAt?: number;
  resolvedAt?: number;
  resolvedBy?: string;
  requesterId?: string;
  question?: string;
  summary?: string;
  status?: string;
  assigneeId?: string;
  category?: string;
  [key: string]: unknown;
}
interface VolumeRow {
  questions: number;
}

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const programs = require("../programs");
const traceStore = require("../pipeline/traceStore");
const dash = require("./dashboardApi");

before(() => {
  db.close();
  db.open(":memory:");
});

function seedProgram(id: string, sources: TestRow[] | null = null) {
  programs.saveProgram({ id, name: id, sources, sharedSources: false });
}

function seedTicket(programId: string, overrides: TestRow = {}) {
  const t = overrides.createdAt !== undefined ? overrides.createdAt : Date.now();
  const res = db
    .handle()
    .query(
      `INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, summary, status, assignee_id, category,
      created_at, updated_at, first_response_at, first_human_response_at, resolved_at, resolved_by)
     VALUES (?, 'C', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      programId,
      `${programId}-${t}-${Math.random()}`,
      overrides.requesterId || "U-asker",
      overrides.question || "how do i join?",
      overrides.summary || null,
      overrides.status || "open",
      overrides.assigneeId || null,
      overrides.category || "support",
      t,
      overrides.updatedAt !== undefined ? overrides.updatedAt : t,
      overrides.firstResponseAt || null,
      overrides.firstHumanResponseAt || null,
      overrides.resolvedAt || null,
      overrides.resolvedBy || null,
    );
  return { id: Number(res.lastInsertRowid), createdAt: t };
}

test("scoped search refuses unknown programs and isolates tenants", () => {
  seedProgram("dash-tenant-a");
  seedProgram("dash-tenant-b");
  seedTicket("dash-tenant-b", { question: "other program secret" });
  assert.equal(dash.ticketSearchScoped("no-such-program", {}).error, "unknown program");
  const res = dash.ticketSearchScoped("dash-tenant-a", {});
  assert.equal(res.total, 0);
  assert.deepEqual(res.rows, []);
});

test("scoped search filters by status group, category, assignee and text", () => {
  seedProgram("dash-filter");
  const base = Date.now() - 50000;
  seedTicket("dash-filter", { status: "open", category: "pcb", createdAt: base });
  seedTicket("dash-filter", {
    status: "waiting_for_helper",
    category: "pcb",
    assigneeId: "U-1",
    createdAt: base + 1000,
  });
  seedTicket("dash-filter", { status: "resolved", category: "pcb", createdAt: base + 2000 });
  seedTicket("dash-filter", {
    status: "open",
    category: "ordering",
    question: "where is my package",
    createdAt: base + 3000,
  });

  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "open" }).total, 3);
  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "resolved" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { statusGroup: "all" }).total, 4);
  assert.equal(dash.ticketSearchScoped("dash-filter", { status: "open" }).total, 2);
  assert.equal(dash.ticketSearchScoped("dash-filter", { category: "ordering" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { assigneeId: "U-1" }).total, 1);
  assert.equal(dash.ticketSearchScoped("dash-filter", { q: "package" }).total, 1);
});

test("scoped search sorts longest-waiting first and paginates", () => {
  seedProgram("dash-sort");
  const base = Date.now() - 90000;
  const first = seedTicket("dash-sort", { createdAt: base });
  seedTicket("dash-sort", { createdAt: base + 1000 });
  seedTicket("dash-sort", { createdAt: base + 2000 });
  const waiting = dash.ticketSearchScoped("dash-sort", { sort: "waiting" });
  assert.equal(waiting.rows[0].id, first.id);
  const newest = dash.ticketSearchScoped("dash-sort", { sort: "created", limit: 1 });
  assert.equal(newest.rows.length, 1);
  assert.equal(newest.total, 3);
  const page2 = dash.ticketSearchScoped("dash-sort", { sort: "created", limit: 2, offset: 2 });
  assert.equal(page2.rows.length, 1);
});

test("scoped search attributes the first responder and counts notes", () => {
  seedProgram("dash-attr");
  const { id } = seedTicket("dash-attr", { status: "assigned", assigneeId: "U-helper" });
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'dash-attr', 'U-second', 'helper_reply', ?)",
    )
    .run(id, Date.now());
  db.handle()
    .query(
      "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, created_at) VALUES (?, 'dash-attr', 'U-first', 'helper_reply', ?)",
    )
    .run(id, Date.now() - 5000);
  db.handle()
    .query(
      "INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, 'dash-attr', 'U-helper', 'context', ?)",
    )
    .run(id, Date.now());
  const res = dash.ticketSearchScoped("dash-attr", {});
  assert.equal(res.rows[0].first_responder_id, "U-first");
  assert.equal(res.rows[0].notes_count, 1);
});

test("scoped detail returns the thread and 404s cross-program", () => {
  seedProgram("dash-detail-a");
  seedProgram("dash-detail-b");
  const { id } = seedTicket("dash-detail-a", {});
  const hit = dash.ticketDetailScoped("dash-detail-a", id);
  assert.ok(hit.ticket);
  assert.ok(Array.isArray(hit.events));
  assert.ok(Array.isArray(hit.notes));
  assert.equal(dash.ticketDetailScoped("dash-detail-b", id).error, "ticket not found");
  assert.equal(dash.ticketDetailScoped("dash-detail-a", 999999).error, "ticket not found");
  assert.equal(dash.ticketDetailScoped("no-such-program", id).error, "unknown program");
});

test("scoped detail includes ticket and thread-only history without crossing programs", () => {
  seedProgram("dash-trace-a");
  seedProgram("dash-trace-b");
  const { id } = seedTicket("dash-trace-a", {});
  const ticket = db.getTicket(id);
  const ticketTrace = traceStore.append({
    programId: "dash-trace-a",
    ticketId: id,
    threadTs: ticket.thread_ts,
    stage: "decision",
    payload: { expectedAction: "reply" },
  });
  const threadTrace = traceStore.append({
    programId: "dash-trace-a",
    threadTs: ticket.thread_ts,
    stage: "retrieval",
    payload: { sources: [] },
  });
  traceStore.append({
    programId: "dash-trace-b",
    threadTs: ticket.thread_ts,
    stage: "decision",
    payload: { expectedAction: "leak" },
  });

  const detail = dash.ticketDetailScoped("dash-trace-a", id);
  assert.equal(detail.tracesError, undefined);
  assert.deepEqual(
    detail.traces.map((row: { id: number }) => row.id),
    [threadTrace, ticketTrace].sort((a, b) => a - b),
  );
  assert.equal(JSON.stringify(detail.traces).includes("leak"), false);
});

test("scoped detail reports trace read failures instead of returning a false empty history", () => {
  seedProgram("dash-trace-error");
  const { id } = seedTicket("dash-trace-error", {});
  const original = traceStore.forTicket;
  traceStore.forTicket = () => {
    throw new Error("trace store unavailable");
  };
  try {
    const detail = dash.ticketDetailScoped("dash-trace-error", id);
    assert.equal(detail.tracesError, true);
    assert.deepEqual(detail.traces, []);
  } finally {
    traceStore.forTicket = original;
  }
});

test("metrics overview counts ops figures from stored rows only", () => {
  seedProgram("dash-metrics");
  const base = Date.now() - 20 * 86400000;
  seedTicket("dash-metrics", {
    status: "resolved",
    createdAt: base,
    firstResponseAt: base + 1000,
    resolvedAt: base + 5000,
  });
  seedTicket("dash-metrics", {
    status: "resolved",
    createdAt: base + 1000,
    firstResponseAt: base + 2000,
    firstHumanResponseAt: base + 3000,
    resolvedAt: base + 10000,
    resolvedBy: "U-H",
    assigneeId: "U-H",
  });
  seedTicket("dash-metrics", { status: "waiting_for_helper", createdAt: base + 2000, assigneeId: "U-H" });
  db.recordMetric("answer_docs", 10, null, "dash-metrics");
  db.recordMetric("silent", 5, "ungrounded", "dash-metrics");
  db.recordMetric("jev_downstream_block", 7, "gap_escalated", "dash-metrics");
  seedProgram("dash-metrics-other");
  seedTicket("dash-metrics-other", { status: "open", createdAt: base });
  db.recordMetric("silent", 5, "ungrounded", "dash-metrics-other");

  const m = dash.metricsOverview("dash-metrics", { days: 30 });
  assert.equal(m.created, 3);
  assert.equal(m.openTickets, 1);
  assert.equal(m.waitingForHelper, 1);
  assert.equal(m.firstResponse.medianMs, 1000);
  assert.equal(m.firstResponse.averageMs, 1000);
  assert.equal(m.firstResponse.n, 2);
  assert.equal(m.resolution.medianMs, 9000);
  assert.equal(m.resolution.averageMs, 7000);
  assert.equal(m.resolution.n, 2);
  assert.equal(m.answers.pixieAnswered, 1);
  assert.equal(m.answers.humanHandled, 1);
  assert.equal(m.grounding.blocked, 2);
  assert.equal(m.grounding.byReason.ungrounded, 1);
  assert.equal(m.grounding.byReason["jev_downstream_block:gap_escalated"], 1);
  assert.equal(m.grounding.answered, 1);
  assert.equal(m.grounding.blockRate, 0.667);
  assert.ok(Array.isArray(m.volumeByDay) && m.volumeByDay.length >= 30);
  assert.equal(
    m.volumeByDay.reduce((sum: number, d: VolumeRow) => sum + d.questions, 0),
    3,
  );
  const helper = m.helpers.find((h: TestRow) => h.userId === "U-H");
  assert.equal(helper.openAssigned, 1);
  assert.equal(helper.resolved, 1);
  assert.equal(dash.metricsOverview("no-such-program", {}).error, "unknown program");
});

test("knowledge status degrades gracefully and never leaks secrets", () => {
  const knowledge = require("../knowledge");
  const realStatus = knowledge.sourceStatus;
  const realRefresh = knowledge.refreshProgramSources;
  delete knowledge.sourceStatus;
  delete knowledge.refreshProgramSources;
  try {
    seedProgram("dash-know", [{ name: "Docs", type: "url", url: "https://docs.example/guide?token=secret#frag" }]);
    const res = dash.knowledgeStatus("dash-know");
    assert.equal(res.programId, "dash-know");
    assert.equal(res.sources.length, 1);
    assert.equal(res.sources[0].status, "Pending");
    assert.equal(res.sources[0].url, "https://docs.example/guide");
    assert.equal(JSON.stringify(res).includes("token=secret"), false);
    assert.equal(dash.knowledgeStatus("no-such-program").error, "unknown program");
    assert.equal(dash.knowledgeRefresh("no-such-program").error, "unknown program");
    assert.equal(dash.knowledgeRefresh("dash-know").error, "knowledge refresh is not available");
  } finally {
    knowledge.sourceStatus = realStatus;
    knowledge.refreshProgramSources = realRefresh;
  }
});

test("real knowledge status values render as dashboard labels", () => {
  seedProgram("dash-know-real", [{ name: "Inline", type: "text", content: "Acme FAQ text" }]);
  const res = dash.knowledgeStatus("dash-know-real");
  assert.equal(res.sources.length, 1);
  assert.ok(["Pending", "Ready", "Stale", "Error", "Fetching"].includes(res.sources[0].status));
});

test("knowledge status and refresh honor the sourceStatus contract when present", async () => {
  const knowledge = require("../knowledge");
  seedProgram("dash-know-live");
  knowledge.sourceStatus = () => [
    {
      name: "Docs",
      type: "url",
      url: "https://docs.example/a?x=1",
      status: "Ready",
      lastSyncedAt: 100,
      lastSuccessAt: 90,
      error: null,
      chunks: 12,
    },
    { name: "Bad", type: "url", url: "not a url", status: "Exploding", lastSyncedAt: "n/a", error: "boom", chunks: -1 },
  ];
  let calledWith = null;
  knowledge.refreshProgramSources = ((programId: string, opts: TestRow) => {
    calledWith = [programId, opts];
    return Promise.resolve({ ok: true });
  }) as unknown as typeof knowledge.refreshProgramSources;
  try {
    const res = dash.knowledgeStatus("dash-know-live");
    assert.equal(res.sources[0].status, "Ready");
    assert.equal(res.sources[0].chunks, 12);
    assert.equal(res.sources[0].url, "https://docs.example/a");
    assert.equal(res.sources[1].status, "Pending");
    assert.equal(res.sources[1].chunks, null);
    const refresh = dash.knowledgeRefresh("dash-know-live");
    assert.deepEqual(refresh, { started: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calledWith, ["dash-know-live", { force: true }]);
  } finally {
    delete knowledge.sourceStatus;
    delete knowledge.refreshProgramSources;
  }
});

test("helper roster and availability toggle are program-scoped", () => {
  seedProgram("dash-roster");
  seedProgram("dash-roster-other");
  db.syncHelper({ programId: "dash-roster", userId: "U-R1", role: "helper" });
  db.syncHelper({ programId: "dash-roster", userId: "U-R2", role: "organizer" });
  db.syncHelper({ programId: "dash-roster-other", userId: "U-X", role: "helper" });
  const { id: tid } = seedTicket("dash-roster", {
    status: "assigned",
    assigneeId: "U-R1",
    createdAt: Date.now() - 1000,
  });
  void tid;

  const roster = dash.helperRoster("dash-roster");
  assert.equal(roster.programId, "dash-roster");
  assert.equal(roster.helpers.length, 2);
  assert.ok(roster.helpers.every((h: TestRow) => h.active));
  assert.equal(roster.helpers.find((h: TestRow) => h.userId === "U-R2").role, "organizer");
  assert.equal(roster.helpers.find((h: TestRow) => h.userId === "U-R1").openAssigned, 1);
  assert.equal(dash.helperRoster("no-such-program").error, "unknown program");

  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-stranger", userId: "U-R1", active: false }).error,
    "actor is not a helper of this program",
  );
  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-X", userId: "U-R1", active: false }).error,
    "actor is not a helper of this program",
  );
  assert.equal(
    dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-ghost", active: false }).error,
    "helper not found",
  );

  assert.equal(dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-R1", active: false }).ok, true);
  assert.equal(dash.helperRoster("dash-roster").helpers.find((h: TestRow) => h.userId === "U-R1").active, false);
  assert.equal(dash.helperSetActive("dash-roster", { actorId: "U-R2", userId: "U-R1", active: true }).ok, true);
  assert.equal(dash.helperRoster("dash-roster").helpers.find((h: TestRow) => h.userId === "U-R1").active, true);
});
export {};
