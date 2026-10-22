process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const incidents = require("./incidents") as unknown as TestIncidentApi;

const MIN = 60 * 1000;
const Q = "the portal is down for everyone, login redirects back";

before(() => {
  db.close();
  db.open(":memory:");
});
after(() => programs.invalidate());

let seq = 0;
function tickets(programId: string, n: number, opts: { ageMin?: number; question?: string; same?: boolean } = {}) {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const id = db.createTicket({
      programId,
      channel: "C-h",
      threadTs: `dd-${seq}`,
      requesterId: opts.same ? "U-same" : `U-${seq}`,
      question: opts.question || Q,
    });
    db.handle()
      .query("UPDATE tickets SET created_at = ? WHERE id = ?")
      .run(Date.now() - (opts.ageMin ?? 5) * MIN + i, id);
    ids.push(id);
  }
  return ids;
}
const prog = (id: string) => {
  db.saveProgram({ id, name: id });
  programs.invalidate();
  return id;
};
const closeAt = (incidentId: number, column: string, ageMin: number) =>
  db
    .handle()
    .query(`UPDATE program_incidents SET ${column} = ? WHERE id = ?`)
    .run(Date.now() - ageMin * MIN, incidentId);

test("dismissing a candidate stops the same four tickets from recreating it", () => {
  const p = prog("dd-dismiss");
  tickets(p, 4);
  const first = incidents.detectBursts({ programId: p }).candidates[0];
  incidents.setIncidentStatus({ incidentId: first.incidentId, status: "dismissed", actorId: "U-org" });

  for (let sweep = 0; sweep < 3; sweep += 1) {
    const again = incidents.detectBursts({ programId: p });
    assert.deepEqual(again.candidates, []);
    assert.equal(again.suppressed.length, 1);
  }
  assert.equal(incidents.listIncidents(p).length, 1);
});

test("a resolved incident does not come back from its own tickets", () => {
  const p = prog("dd-resolved");
  tickets(p, 4);
  const first = incidents.detectBursts({ programId: p }).candidates[0];
  incidents.declareIncident({ incidentId: first.incidentId, actorId: "U-org" });
  incidents.setIncidentStatus({ incidentId: first.incidentId, status: "resolved", actorId: "U-org" });
  assert.deepEqual(incidents.detectBursts({ programId: p }).candidates, []);
  assert.equal(incidents.listIncidents(p).length, 1);
});

test("fresh independent reports after a dismissal open a genuinely new candidate", () => {
  const p = prog("dd-recur");
  tickets(p, 4, { ageMin: 40 });
  const first = incidents.detectBursts({ programId: p }).candidates[0];
  incidents.setIncidentStatus({ incidentId: first.incidentId, status: "dismissed", actorId: "U-org" });
  closeAt(first.incidentId, "dismissed_at", 20);

  tickets(p, 2, { ageMin: 5 });
  assert.deepEqual(incidents.detectBursts({ programId: p }).candidates, [], "two new reports are not enough");

  tickets(p, 2, { ageMin: 4 });
  const out = incidents.detectBursts({ programId: p }).candidates;
  assert.equal(out.length, 1);
  assert.notEqual(out[0].incidentId, first.incidentId);
  assert.equal(out[0].linked, 4, "only the post-dismissal reports are evidence");
  assert.equal(incidents.incidentTickets(out[0].incidentId).length, 4);
});

test("recurrence after a resolved incident works the same way", () => {
  const p = prog("dd-recur-resolved");
  tickets(p, 4, { ageMin: 50 });
  const first = incidents.detectBursts({ programId: p }).candidates[0];
  incidents.declareIncident({ incidentId: first.incidentId, actorId: "U-org" });
  incidents.setIncidentStatus({ incidentId: first.incidentId, status: "resolved", actorId: "U-org" });
  closeAt(first.incidentId, "resolved_at", 30);
  tickets(p, 4, { ageMin: 5 });
  const out = incidents.detectBursts({ programId: p }).candidates;
  assert.equal(out.length, 1);
  assert.notEqual(out[0].incidentId, first.incidentId);
});

test("an old closed incident does not permanently suppress a new outage", () => {
  const p = prog("dd-old-closed");
  const old = tickets(p, 4, { ageMin: 3000 });
  const id = incidents.detectBursts({ programId: p, windowMs: 3 * 24 * 60 * MIN }).candidates[0].incidentId;
  incidents.setIncidentStatus({ incidentId: id, status: "dismissed", actorId: "U-org" });
  closeAt(id, "dismissed_at", 2900);
  assert.equal(old.length, 4);
  tickets(p, 4, { ageMin: 5 });
  assert.equal(incidents.detectBursts({ programId: p }).candidates.length, 1);
});

test("a confirmed incident older than the cooldown still absorbs new related reports", () => {
  const p = prog("dd-long-confirmed");
  const created = incidents.createIncident({ programId: p, title: Q, actorId: "U-org" }).incident;
  closeAt(created.id, "created_at", 8 * 60);
  tickets(p, 4);
  const out = incidents.detectBursts({ programId: p }).candidates;
  assert.equal(out.length, 1);
  assert.equal(out[0].incidentId, created.id);
  assert.equal(out[0].deduped, true);
  assert.equal(incidents.listIncidents(p).length, 1);
  assert.equal(incidents.incidentTickets(created.id).length, 4);
});

test("a cluster is matched to its incident by shared tickets even when wording drifts", () => {
  const p = prog("dd-overlap");
  const ids = tickets(p, 4);
  const first = incidents.detectBursts({ programId: p }).candidates[0];
  db.handle().query("UPDATE program_incidents SET title = ? WHERE id = ?").run("unrelated old title", first.incidentId);
  tickets(p, 1);
  const out = incidents.detectBursts({ programId: p }).candidates;
  assert.equal(out.length, 1);
  assert.equal(out[0].incidentId, first.incidentId);
  assert.equal(incidents.incidentTickets(first.incidentId).length, 5);
  assert.equal(incidents.listIncidents(p).length, 1);
  assert.equal(ids.length, 4);
});

test("a ticket is linked to one incident at most once and never to another program's", () => {
  const a = prog("dd-iso-a");
  const b = prog("dd-iso-b");
  tickets(a, 4);
  tickets(b, 3);
  incidents.detectBursts({ programId: a });
  incidents.detectBursts({ programId: a });
  assert.equal(incidents.detectBursts({ programId: b }).candidates.length, 0);
  const rows = db
    .handle()
    .query("SELECT incident_id, ticket_id, COUNT(*) AS n FROM incident_tickets GROUP BY 1, 2")
    .all() as unknown as Array<{ n: number }>;
  assert.ok(rows.length > 0 && rows.every((r) => r.n === 1));
  assert.equal(incidents.listIncidents(b).length, 0);
});

test("ordinary repeated questions are not an outage", () => {
  const p = prog("dd-faq");
  tickets(p, 6, { question: "how do I submit my project to the hackathon?" });
  assert.deepEqual(incidents.detectBursts({ programId: p }).candidates, []);
});

test("one person filing many tickets is not an outage", () => {
  const p = prog("dd-one-user");
  tickets(p, 6, { same: true });
  assert.deepEqual(incidents.detectBursts({ programId: p }).candidates, []);
});

test("a large cluster becomes one candidate with every ticket linked once", () => {
  const p = prog("dd-large");
  tickets(p, 120);
  const out = incidents.detectBursts({ programId: p }).candidates;
  assert.equal(out.length, 1);
  assert.equal(out[0].linked, 120);
  assert.equal(incidents.detectBursts({ programId: p }).candidates[0].linked, 0);
  assert.equal(incidents.incidentTickets(out[0].incidentId).length, 120);
});

export {};
import type { TestDb, TestIncidentApi } from "./test.types";
