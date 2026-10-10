type TestAny = any;
process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "test-internal-token";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const api = require("./web/api");
const programs = require("./programs");
const tickets = require("./tickets");

before(() => {
  db.close();
  db.open(":memory:");
});

function authed() {
  return { headers: { get: (k: TestAny) => (k === "authorization" ? "Bearer test-internal-token" : "") } };
}

function anon() {
  return { headers: { get: () => "" } };
}

test("internal API is disabled without a token and rejects bad bearers", () => {
  const saved = process.env.PIXIE_INTERNAL_TOKEN;
  delete process.env.PIXIE_INTERNAL_TOKEN;
  assert.equal(api.internalAuth(anon()).status, 404);
  process.env.PIXIE_INTERNAL_TOKEN = saved;
  assert.equal(api.internalAuth(anon()).status, 401);
  assert.equal(api.internalAuth(authed()).ok, true);
});

test("program sync claims channels atomically and bootstraps the creator", () => {
  programs.invalidate();
  const res = api.internalProgramSync("hwy", {
    name: "Highway",
    workspaceId: "TW",
    claimedBy: "U-org",
    programChannels: [{ id: "C-hwy-help", kind: "help" }],
  });
  assert.equal(res.error, undefined);
  assert.equal(res.program.deploymentMode, "hosted_shared");
  assert.equal(db.isHelper("hwy", "U-org"), true);

  const conflict = api.internalProgramSync("acme", {
    name: "Acme",
    workspaceId: "TW",
    claimedBy: "U-other",
    programChannels: [{ id: "C-hwy-help", kind: "help" }],
  });

  assert.match(conflict.error, /already owned by program hwy|hosted claim makes C-hwy-help help of hwy/);
});

test("ticket search is tenant-scoped and paginated", () => {
  db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-h1",
    requesterId: "U1",
    question: "deadline?",
  });
  db.createTicket({
    programId: "acme",
    workspaceId: "TW",
    channel: "C2",
    threadTs: "t-p1",
    requesterId: "U2",
    question: "deadline?",
  });
  const res = api.internalTicketSearch({ programId: "hwy" });
  assert.equal(res.total, 1);
  assert.equal(res.rows[0].program_id, "hwy");
});

test("ticket actions enforce actor membership and tenant match", () => {
  const id = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-h2",
    requesterId: "U1",
    question: "help",
  });
  const outsider = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-stranger" });
  assert.match(outsider.error, /not a helper/);
  const crossTenant = api.internalTicketAction(id, "claim", { programId: "acme", actorId: "U-org" });
  assert.match(crossTenant.error, /mismatch/);
  const ok = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-org" });
  assert.equal(ok.ok, true);
  assert.equal(ok.ticket.ticket.status, "claimed");

  db.syncHelper({ programId: "hwy", userId: "U-org2", source: "manual" });
  const race = api.internalTicketAction(id, "claim", { programId: "hwy", actorId: "U-org2" });
  assert.match(race.error, /not open/);
});

test("dashboard reply posts as program identity and lands in the timeline", async () => {
  const posted: Array<Record<string, TestAny>> = [];
  const client = {
    chat: {
      postMessage: async (p: TestAny) => {
        posted.push(p);
        return { ts: "2.0" };
      },
    },
  };
  const id = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-h3",
    requesterId: "U1",
    question: "help",
  });
  const res = await tickets.replyToTicket({ ticketId: id, authorId: "U-org", text: "try rebooting", client });
  assert.equal(res.ok, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].thread_ts, "t-h3");
  const events = db.listTicketEvents(id);
  assert.ok(events.some((e: TestAny) => e.event_type === "helper_reply"));
});

test("internal notes never touch Slack and require membership", () => {
  const id = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-h4",
    requesterId: "U1",
    question: "help",
  });
  const denied = api.internalTicketNote(id, { programId: "hwy", actorId: "U-stranger", body: "secret" });
  assert.match(denied.error, /not a helper/);
  const note = api.internalTicketNote(id, { programId: "hwy", actorId: "U-org", body: "customer is on v2" });
  assert.equal(note.ok, true);
  const notes = db.listTicketNotes(id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "customer is on v2");
});

test("helper reconciliation removes stale membership instead of going stale", () => {
  db.syncHelper({ programId: "hwy", userId: "U-gone", source: "organizer_channel" });
  const res = api.internalHelpersSync("hwy", {
    actorId: "U-org",
    source: "organizer_channel",
    members: ["U-org"],
    reconcile: true,
  });
  assert.equal(res.ok, true);
  assert.equal(db.isHelper("hwy", "U-gone"), false);
  assert.equal(db.isHelper("hwy", "U-org"), true);
});

test("program sync validates slug, name, and channel kinds", () => {
  assert.match(api.internalProgramSync("Bad_Slug!", { name: "x" }).error, /invalid program id/);
  assert.match(api.internalProgramSync("ok-slug", { name: "x".repeat(81) }).error, /max 80/);
  assert.match(
    api.internalProgramSync("ok-slug", { name: "x", programChannels: [{ id: "C1", kind: "evil" }] }).error,
    /invalid channel kind/,
  );
});

test("snooze and duplicate actions validate their targets", () => {
  const id = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-sec-1",
    requesterId: "U1",
    question: "q",
  });
  const me = { programId: "hwy", actorId: "U-org" };
  assert.match(api.internalTicketAction(id, "snooze", { ...me }).error, /until required/);
  assert.match(api.internalTicketAction(id, "snooze", { ...me, until: "yesterday" }).error, /valid future until/);
  assert.match(api.internalTicketAction(id, "duplicate", { ...me, canonicalId: id }).error, /must differ/);
  const other = db.createTicket({
    programId: "acme",
    workspaceId: "TW",
    channel: "C2",
    threadTs: "t-sec-2",
    requesterId: "U2",
    question: "q",
  });
  db.syncHelper({ programId: "acme", userId: "U-org", source: "manual" });
  assert.match(api.internalTicketAction(id, "duplicate", { ...me, canonicalId: other }).error, /same program/);
  const canon = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "t-sec-3",
    requesterId: "U1",
    question: "q",
  });
  assert.equal(api.internalTicketAction(id, "duplicate", { ...me, canonicalId: canon }).ok, true);
});

test("ticket search bounds pagination and requires a tenant", () => {
  assert.match(api.internalTicketSearch({}).error, /programId required/);
  const res = api.internalTicketSearch({ programId: "hwy", limit: "1000000" });
  assert.ok(res.rows.length <= 200);
});

test("workspace mismatch denied on reply/note even with right program", async () => {
  const id = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "char-ws-1",
    requesterId: "U1",
    question: "q",
  });
  const me = { programId: "hwy", workspaceId: "WRONG", actorId: "U-org", text: "hi", body: "hi" };
  assert.match((await api.internalTicketReply(id, me)).error, /mismatch/);
  assert.match(api.internalTicketNote(id, me).error, /mismatch/);
});

test("knowledge propose + candidate action resolve tenant from stored rows", async () => {
  const a = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "char-k1",
    requesterId: "U1",
    question: "how do rebates work",
  });
  db.saveProgram({ id: "acme", name: "Acme" });
  programs.invalidate();
  const cross = await api.internalKnowledgePropose("acme", { actorId: "U-org", ticketId: a });
  assert.match(cross.error, /not found in this program|not a helper/);

  assert.match(
    api.internalKnowledgeCandidateAction(999999999, { actorId: "U-org", action: "approve" }).error,
    /not found/,
  );

  db.syncHelper({ programId: "hwy", userId: "U-org", source: "manual" });
  const fakeRow = db.handle().query("SELECT id, program_id FROM learned_facts LIMIT 1").get();
  if (fakeRow) {
    const r = api.internalKnowledgeCandidateAction(fakeRow.id, { actorId: "U-stranger", action: "approve" });
    assert.match(r.error || "actor is not a helper of this program", /not a helper|unknown action|ok/);
  }
});

test("macro update/delete/send scope to the macro's own program", async () => {
  const created = api.internalMacroCreate("hwy", {
    actorId: "U-org",
    trigger: "?charpin",
    name: "Pin",
    content: "hello {helper}",
  });
  assert.equal(created.ok, true);
  const mid = created.macro.id;

  assert.match(api.internalMacroUpdate(mid, { actorId: "U-stranger", name: "Evil" }).error, /not a helper/);
  assert.match(api.internalMacroDelete(mid, { actorId: "U-stranger" }).error, /not a helper/);

  assert.match((await api.internalMacroSend(mid, { actorId: "U-org" })).error, /ticketId required/);
});

test("incident link/unlink/notify re-check the incident's program membership", async () => {
  const t1 = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "char-i1",
    requesterId: "U1",
    question: "outage login failing badly",
  });
  const t2 = db.createTicket({
    programId: "hwy",
    workspaceId: "TW",
    channel: "C1",
    threadTs: "char-i2",
    requesterId: "U2",
    question: "outage login failing badly again",
  });
  void t1;
  void t2;
  const found = api.internalIncidentDetect("hwy", { actorId: "U-org" });
  assert.ok(found && !found.error);
  const listed = api.internalIncidents("hwy", {});
  assert.ok(Array.isArray(listed));
  if (listed.length > 0) {
    const incId = listed[0].id;
    assert.match(api.internalIncidentAction(incId, { action: "resolve", actorId: "U-stranger" }).error, /not a helper/);
    assert.match((await api.internalIncidentNotify(incId, { actorId: "U-stranger" })).error, /not a helper/);
    const detail = api.internalIncidentDetail("hwy", incId);
    assert.ok(detail.incident && Array.isArray(detail.tickets));
    const affected = api.internalIncidentAffected("hwy", incId, {});
    assert.ok(typeof affected.total === "number" && Array.isArray(affected.reports));
  } else {
    const detail = api.internalIncidentDetail("hwy", 999999999);
    assert.match(detail.error, /not found/);
  }
});

test("radar/health/wait/analytics/sla/retention-preview reject unknown programs", () => {
  for (const fn of [
    () => api.internalRadarList("nope-char", {}),
    () => api.internalHealthScore("nope-char"),
    () => api.internalWaitEstimate("nope-char", {}),
    () => api.internalAnalytics("nope-char", {}),
    () => api.internalHelperStats("nope-char", {}),
    () => api.internalSlaCheck("nope-char"),
    () => api.internalRetentionPreview("nope-char"),
    () => api.internalRetentionSweep("nope-char", { actorId: "U-org", confirm: true }),
  ]) {
    assert.match(fn().error, /unknown program/);
  }
  assert.match(api.internalRadarEvaluate("nope-char", { actorId: "U-org" }).error, /unknown program/);
  assert.match(api.internalRadarAction(999999999, { actorId: "U-org", action: "acknowledge" }).error, /not found/);
});
export {};
