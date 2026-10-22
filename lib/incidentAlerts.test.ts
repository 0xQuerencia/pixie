process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db") as unknown as TestDb;
const programs = require("./programs") as typeof import("./programs");
const incidents = require("./incidents") as unknown as TestIncidentApi;
const alerts = require("./incidentAlerts");

const MIN = 60 * 1000;
const Q = "the portal is down for everyone, login redirects back";
type Rec = Record<string, any>;

let sent: Rec[];
let failWith: Error | null;
const client = {
  chat: {
    postMessage: async (payload: Rec) => {
      if (failWith) throw failWith;
      sent.push(payload);
      return { ok: true, ts: `s${sent.length}` };
    },
  },
};

before(() => {
  db.close();
  db.open(":memory:");
});
after(() => {
  delete process.env.PIXIE_MAINTENANCE;
  programs.invalidate();
});
beforeEach(() => {
  sent = [];
  failWith = null;
  delete process.env.PIXIE_MAINTENANCE;
});

let seq = 0;
function program(id: string, extra: Rec = {}) {
  const { organizerChannel = `C-org-${id}`, ...rest } = extra;
  db.saveProgram({
    id,
    name: `Prog ${id}`,
    lifecycle: "active",
    helpChannel: `C-help-${id}`,
    channels: [`C-main-${id}`],
    ...rest,
  });
  if (organizerChannel) db.claimProgramChannel({ channelId: organizerChannel, programId: id, kind: "organizer" });
  programs.invalidate();
  return id;
}
function tickets(programId: string, n: number, question = Q) {
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const id = db.createTicket({
      programId,
      channel: `C-help-${programId}`,
      threadTs: `al-${seq}`,
      requesterId: `U-priv-${seq}`,
      question,
    });
    db.handle()
      .query("UPDATE tickets SET created_at = ? WHERE id = ?")
      .run(Date.now() - 5 * MIN + i, id);
  }
}
function candidate(programId: string, question = Q) {
  tickets(programId, 4, question);
  return incidents.detectBursts({ programId }).candidates[0].incidentId;
}
const row = (id: number) => db.handle().query("SELECT * FROM program_incidents WHERE id = ?").get(id) as Rec;
const auditActions = (programId: string) =>
  db.listAuditEvents({ programId, limit: 500 }).map((a: Rec) => a.action as string);

test("a new candidate alerts the organizer channel once, across repeated sweeps", async () => {
  const p = program("al-once");
  const id = candidate(p);
  const first = await alerts.dispatch({ client, programId: p });
  assert.deepEqual(
    first.map((o: Rec) => [o.incidentId, o.result, o.kind]),
    [[id, "sent", "new"]],
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, `C-org-${p}`);
  for (let i = 0; i < 3; i += 1) await alerts.dispatch({ client, programId: p });
  incidents.detectBursts({ programId: p });
  await alerts.dispatch({ client, programId: p });
  assert.equal(sent.length, 1);
  assert.ok(row(id).alerted_at);
  assert.equal(auditActions(p).filter((a: string) => a === "incident.organizer_alerted").length, 1);
});

test("the alert carries program, issue, distinct ticket count, ticket refs and a next step", async () => {
  const p = program("al-content");
  candidate(p);
  await alerts.dispatch({ client, programId: p });
  const text = sent[0].text as string;
  assert.match(text, /Prog al-content/);
  assert.match(text, /portal is down/);
  assert.match(text, /4 distinct tickets from 4 people/);
  assert.match(text, /#\d+/);
  assert.match(text, /has not confirmed an outage/i);
  assert.match(text, /confirm or dismiss/i);
  assert.doesNotMatch(text, /U-priv|al-\d|thread/);
});

test("untrusted ticket text cannot mention anyone or leak contact details", async () => {
  const p = program("al-sanitize");
  const nasty = "<!channel> @here portal is down, mail bob@example.com or call +1 415 555 0100 https://x.test/secret";
  candidate(p, nasty);
  await alerts.dispatch({ client, programId: p });
  const text = sent[0].text as string;
  assert.doesNotMatch(text, /<!|<@|<#|@here|@channel|bob@|555|https?:/);
  assert.match(text, /portal is down/);
});

test("a missing organizer channel is recorded once and nothing is guessed", async () => {
  const p = program("al-nochannel", { organizerChannel: null });
  const id = candidate(p);
  const first = await alerts.dispatch({ client, programId: p });
  await alerts.dispatch({ client, programId: p });
  assert.equal(first[0].reason, "no_organizer_channel");
  assert.equal(sent.length, 0);
  assert.equal(row(id).alert_error, "no_organizer_channel");
  assert.equal(row(id).alerted_at, null);
  assert.equal(auditActions(p).filter((a: string) => a === "incident.alert_skipped").length, 1);
});

test("inactive, paused and shadow programs are never alerted", async () => {
  for (const [id, extra, reason] of [
    ["al-draft", { lifecycle: "draft" }, "program_inactive"],
    ["al-paused", { lifecycle: "paused" }, "program_inactive"],
    ["al-shadow", { shadowMode: true }, "shadow_mode"],
  ] as Array<[string, Rec, string]>) {
    const p = program(id, extra);
    const inc = candidate(p);
    const out = await alerts.dispatch({ client, programId: p });
    assert.equal(out[0].reason, reason, id);
    assert.equal(row(inc).alerted_at, null, id);
  }
  assert.equal(sent.length, 0);
});

test("maintenance mode sends nothing", async () => {
  const p = program("al-maint");
  const id = candidate(p);
  process.env.PIXIE_MAINTENANCE = "1";
  assert.deepEqual(await alerts.dispatch({ client, programId: p }), []);
  assert.equal(sent.length, 0);
  delete process.env.PIXIE_MAINTENANCE;
  await alerts.dispatch({ client, programId: p });
  assert.equal(sent.length, 1);
  assert.ok(row(id).alerted_at);
});

test("a send failure is recorded, backs off, then recovers without a duplicate", async () => {
  const p = program("al-fail");
  const id = candidate(p);
  failWith = Object.assign(new Error("channel_not_found"), { code: "channel_not_found" });
  const now = Date.now();
  const failed = await alerts.dispatch({ client, programId: p, now });
  assert.equal(failed[0].result, "failed");
  assert.equal(row(id).alert_attempts, 1);
  assert.equal(row(id).alert_error, "channel_not_found");
  assert.equal(row(id).alerted_at, null);
  assert.ok(auditActions(p).includes("incident.alert_failed"));

  failWith = null;
  assert.deepEqual(await alerts.dispatch({ client, programId: p, now: now + MIN }), [], "still backing off");
  assert.equal(sent.length, 0);

  const ok = await alerts.dispatch({ client, programId: p, now: now + 6 * MIN });
  assert.equal(ok[0].result, "sent");
  assert.equal(row(id).alert_error, null);
  await alerts.dispatch({ client, programId: p, now: now + 60 * MIN });
  assert.equal(sent.length, 1);
});

test("repeated failures give up instead of retrying forever", async () => {
  const p = program("al-giveup");
  const id = candidate(p);
  failWith = new Error("boom");
  let now = Date.now();
  let last = "";
  for (let i = 0; i < alerts.MAX_ATTEMPTS + 2; i += 1) {
    const out = await alerts.dispatch({ client, programId: p, now });
    if (out[0]) last = out[0].result;
    now += 40 * MIN;
  }
  assert.equal(last, "gave_up");
  assert.equal(row(id).alert_attempts, alerts.MAX_ATTEMPTS);
  assert.equal(auditActions(p).filter((a: string) => a === "incident.alert_failed").length, alerts.MAX_ATTEMPTS);
});

test("two workers racing send one alert", async () => {
  const p = program("al-race");
  candidate(p);
  await Promise.all([alerts.dispatch({ client, programId: p }), alerts.dispatch({ client, programId: p })]);
  assert.equal(sent.length, 1);
});

test("growth sends one rate-limited update, not one message per ticket", async () => {
  const p = program("al-update");
  const id = candidate(p);
  const now = Date.now();
  await alerts.dispatch({ client, programId: p, now });
  tickets(p, 1);
  incidents.detectBursts({ programId: p });
  assert.deepEqual(await alerts.dispatch({ client, programId: p, now: now + 40 * MIN }), []);
  tickets(p, alerts.UPDATE_MIN_GROWTH);
  incidents.detectBursts({ programId: p });
  assert.deepEqual(await alerts.dispatch({ client, programId: p, now: now + 5 * MIN }), [], "too soon");
  const update = await alerts.dispatch({ client, programId: p, now: now + 40 * MIN });
  assert.equal(update[0].kind, "update");
  assert.match(sent[1].text, /Incident update/);
  assert.equal(sent.length, 2);
  assert.deepEqual(await alerts.dispatch({ client, programId: p, now: now + 90 * MIN }), []);
  assert.equal(incidents.incidentTickets(id).length, 9);
});

test("a confirmed incident is not re-announced to the organizers", async () => {
  const p = program("al-confirmed");
  const id = candidate(p);
  incidents.declareIncident({ incidentId: id, actorId: "U-org" });
  assert.deepEqual(await alerts.dispatch({ client, programId: p }), []);
  assert.equal(sent.length, 0);
});

test("alerts go only to the owning program's channel and never mention another program", async () => {
  const a = program("al-iso-a");
  const b = program("al-iso-b");
  candidate(a, "checkout is down for everyone right now");
  candidate(b, "payments page is broken for everyone now");
  await alerts.dispatch({ client, programId: a });
  await alerts.dispatch({ client, programId: b });
  assert.equal(sent.length, 2);
  const forA = sent.find((s) => s.channel === `C-org-${a}`) as Rec;
  const forB = sent.find((s) => s.channel === `C-org-${b}`) as Rec;
  assert.match(forA.text, /checkout/);
  assert.doesNotMatch(forA.text, /payments/);
  assert.match(forB.text, /payments/);
  assert.doesNotMatch(forB.text, /checkout/);
});

test("a channel owned by another program is never used", async () => {
  const a = program("al-claim-a");
  const b = program("al-claim-b");
  db.handle().query("UPDATE program_channels SET program_id = ? WHERE channel_id = ?").run(a, `C-org-${b}`);
  programs.invalidate();
  candidate(b);
  const out = await alerts.dispatch({ client, programId: b });
  assert.equal(out[0].reason, "no_organizer_channel");
  assert.equal(sent.length, 0);
});

test("no client means no alert and no state change", async () => {
  const p = program("al-noclient");
  const id = candidate(p);
  assert.deepEqual(await alerts.dispatch({ client: null, programId: p }), []);
  assert.equal(row(id).alerted_at, null);
});

export {};
import type { TestDb, TestIncidentApi } from "./test.types";
