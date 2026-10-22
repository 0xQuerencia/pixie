process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const incidents = require("./incidents") as unknown as TestIncidentApi;
const radar = require("./radar");
const jevDecision = require("./jevDecision");
const api = require("./web/api");

const MIN = 60 * 1000;
const Q = "the portal is down for everyone, login redirects back";
type Rec = Record<string, any>;

before(() => {
  db.close();
  db.open(":memory:");
});
after(() => programs.invalidate());

const prog = (id: string, extra: Rec = {}) => {
  db.saveProgram({ id, name: id, lifecycle: "active", ...extra });
  db.claimProgramChannel({ channelId: `C-help-${id}`, programId: id, kind: "help" });
  programs.invalidate();
  return id;
};
let seq = 0;
function tickets(programId: string, n: number, question = Q) {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const id = db.createTicket({
      programId,
      channel: `C-help-${programId}`,
      threadTs: `lc-${seq}`,
      requesterId: `U-${seq}`,
      question,
    });
    db.handle()
      .query("UPDATE tickets SET created_at = ? WHERE id = ?")
      .run(Date.now() - 5 * MIN + i, id);
    ids.push(id);
  }
  return ids;
}
const candidate = (p: string) => {
  tickets(p, 4);
  return incidents.detectBursts({ programId: p }).candidates[0].incidentId;
};
const actions = (p: string, id: number) => incidents.timeline(id, p).map((e) => e.action);

test("a candidate cannot be resolved; recovery needs a confirmed incident and a named actor", () => {
  const p = prog("lc-resolve");
  const id = candidate(p);
  assert.match(
    incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org" }).error,
    /invalid transition/,
  );
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  assert.match(incidents.setIncidentStatus({ incidentId: id, status: "resolved" }).error, /named actor/);
  assert.equal(incidents.getIncident(id).status, "confirmed");
  const ok = incidents.setIncidentStatus({
    incidentId: id,
    status: "resolved",
    actorId: "U-org",
    evidence: "status page green",
  });
  assert.equal(ok.incident.status, "resolved");
  const event = incidents.timeline(id, p).find((e) => e.action === "incident.resolved");
  assert.deepEqual(event?.metadata, { from: "confirmed", evidence: "status page green" });
});

test("a quiet period never closes an incident", () => {
  const p = prog("lc-quiet");
  const id = candidate(p);
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  db.handle()
    .query("UPDATE tickets SET created_at = created_at - ?")
    .run(3 * 60 * MIN);
  for (let i = 0; i < 3; i += 1) incidents.detectBursts({ programId: p });
  radar.evaluateProgram(p);
  assert.equal(incidents.getIncident(id).status, "confirmed");
  assert.equal(incidents.getIncident(id).resolved_at, null);
});

test("repeating a status change is a no-op and stale transitions are rejected", () => {
  const p = prog("lc-race");
  const id = candidate(p);
  assert.equal(incidents.setIncidentStatus({ incidentId: id, status: "dismissed", actorId: "U1" }).ok, true);
  const again = incidents.setIncidentStatus({ incidentId: id, status: "dismissed", actorId: "U2" }) as Rec;
  assert.equal(again.unchanged, true);
  assert.equal(actions(p, id).filter((a) => a === "incident.dismissed").length, 1);
  assert.match(
    incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U1" }).error,
    /invalid transition/,
  );
  assert.equal(incidents.getIncident(id).status, "dismissed");
  // a helper acting on a stale view: the row moved on between read and write
  const real = db.handle();
  const original = real.query.bind(real);
  let flipped = false;
  real.query = (sql: string) => {
    const q = original(sql);
    if (!flipped && /^UPDATE program_incidents SET status/.test(sql)) {
      flipped = true;
      original("UPDATE program_incidents SET status = 'confirmed' WHERE id = ?").run(id);
    }
    return q;
  };
  try {
    assert.match(incidents.setIncidentStatus({ incidentId: id, status: "candidate", actorId: "U1" }).error, /changed/);
  } finally {
    real.query = original;
  }
  assert.equal(incidents.getIncident(id).status, "confirmed");
});

test("resolution notices go out only for a resolved incident, once, and never from a shadow program", async () => {
  const p = prog("lc-notify");
  const id = candidate(p);
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  incidents.recordAffectedReport({
    incidentId: id,
    programId: p,
    requesterId: "U-a",
    channel: `C-help-${p}`,
    threadTs: "n1",
  });
  const sent: Rec[] = [];
  const client = { chat: { postMessage: async (m: Rec) => (sent.push(m), { ok: true, ts: "1" }) } };
  assert.equal((await incidents.notifyAffectedUsers({ incidentId: id, client })).error, "incident is not resolved");
  assert.equal(sent.length, 0);

  incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org" });
  const [a, b] = await Promise.all([
    incidents.notifyAffectedUsers({ incidentId: id, client }),
    incidents.notifyAffectedUsers({ incidentId: id, client }),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(a.notified + b.notified, 1);

  const sp = prog("lc-shadow", { shadowMode: true });
  const sid = candidate(sp);
  incidents.declareIncident({ incidentId: sid, actorId: "U-org" });
  incidents.setIncidentStatus({ incidentId: sid, status: "resolved", actorId: "U-org" });
  incidents.recordAffectedReport({
    incidentId: sid,
    programId: sp,
    requesterId: "U-a",
    channel: `C-help-${sp}`,
    threadTs: "s1",
  });
  const shadow = await incidents.notifyAffectedUsers({ incidentId: sid, client });
  assert.equal(shadow.notified, 0);
  assert.equal(incidents.affectedReports(sid, true).length, 1, "left unnotified for a real send later");
});

test("a failed notice stays recoverable and its reason is on the timeline", async () => {
  const p = prog("lc-notify-fail");
  const id = candidate(p);
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org" });
  incidents.recordAffectedReport({
    incidentId: id,
    programId: p,
    requesterId: "U-a",
    channel: `C-help-${p}`,
    threadTs: "f1",
  });
  const broken = {
    chat: {
      postMessage: async () =>
        Promise.reject(Object.assign(new Error("channel_not_found"), { code: "channel_not_found" })),
    },
  };
  const res = await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U-org", client: broken });
  assert.equal(res.failed, 1);
  assert.equal(incidents.affectedReports(id, true).length, 1);
  const event = incidents.timeline(id, p).find((e) => e.action === "incident.notified_affected");
  assert.deepEqual(event?.metadata?.reasons, ["channel_not_found"]);
});

test("the timeline tells the whole story in order", async () => {
  const p = prog("lc-timeline");
  const id = candidate(p);
  tickets(p, 1);
  incidents.detectBursts({ programId: p });
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org", evidence: "fixed" });
  const client = { chat: { postMessage: async () => ({ ok: true, ts: "1" }) } };
  incidents.recordAffectedReport({
    incidentId: id,
    programId: p,
    requesterId: "U-a",
    channel: `C-help-${p}`,
    threadTs: "t1",
  });
  await incidents.notifyAffectedUsers({ incidentId: id, actorId: "U-org", client });
  assert.deepEqual(actions(p, id), [
    "incident.detected",
    "incident.tickets_linked",
    "incident.declared",
    "incident.resolved",
    "incident.notified_affected",
  ]);
  const detail = api.internalIncidentDetail(p, id);
  assert.equal(detail.timeline.length, 5);
  assert.deepEqual(incidents.timeline(id, "someone-else"), []);
});

test("a report attached to an active incident links only same-program tickets", () => {
  const a = prog("lc-link-a");
  const b = prog("lc-link-b");
  const id = incidents.createIncident({ programId: a, title: Q, actorId: "U-org" }).incident.id;
  const [own] = tickets(a, 1);
  const [foreign] = tickets(b, 1);
  incidents.recordAffectedReport({
    incidentId: id,
    programId: a,
    ticketId: own,
    requesterId: "U1",
    channel: "C1",
    threadTs: "l1",
  });
  incidents.recordAffectedReport({
    incidentId: id,
    programId: a,
    ticketId: foreign,
    requesterId: "U2",
    channel: "C1",
    threadTs: "l2",
  });
  incidents.recordAffectedReport({
    incidentId: id,
    programId: a,
    ticketId: own,
    requesterId: "U1",
    channel: "C2",
    threadTs: "l3",
  });
  assert.deepEqual(
    incidents.incidentTickets(id).map((t) => t.id),
    [own],
  );
});

test("a resolved ticket does not resolve its incident, nor a resolved incident its tickets", () => {
  const p = prog("lc-status");
  const id = candidate(p);
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  const [first] = incidents.incidentTickets(id);
  db.handle().query("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(first.id);
  assert.equal(incidents.getIncident(id).status, "confirmed");
  incidents.setIncidentStatus({ incidentId: id, status: "resolved", actorId: "U-org" });
  const open = db
    .handle()
    .query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND status = 'open'")
    .get(p) as Rec;
  assert.equal(open.n, 3);
});

test("only a helper can change or notify; strangers are refused before anything moves", async () => {
  const p = prog("lc-perm");
  db.handle()
    .query(
      "INSERT OR IGNORE INTO program_helpers (program_id, user_id, helper_source, role, active, added_at) VALUES (?, 'U-helper', 'manual', 'helper', 1, ?)",
    )
    .run(p, Date.now());
  const id = candidate(p);
  assert.match(api.internalIncidentAction(id, { action: "confirmed", actorId: "U-stranger" }).error, /not a helper/);
  assert.match(api.internalIncidentAction(id, { action: "dismissed" }).error, /not a helper/);
  assert.equal(incidents.getIncident(id).status, "candidate");
  assert.match((await api.internalIncidentNotify(id, { actorId: "U-stranger" })).error, /not a helper/);
  assert.equal(api.internalIncidentAction(id, { action: "confirmed", actorId: "U-helper" }).ok, true);
});

test("Jev being down does not stop detection or the radar signal", () => {
  const original = jevDecision.evaluateSupportDecision;
  jevDecision.evaluateSupportDecision = async () => {
    throw new Error("jev down");
  };
  try {
    const p = prog("lc-jev");
    tickets(p, 4);
    const out = radar.evaluateProgram(p);
    const types = out.signals.map((s: Rec) => s.type);
    assert.ok(types.includes("INCIDENT_CANDIDATE"));
  } finally {
    jevDecision.evaluateSupportDecision = original;
  }
});

export {};
import type { TestDb, TestIncidentApi } from "./test.types";
