const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const tickets = require("./tickets");
const watcher = require("./resolutionWatcher");

db.open(":memory:");

let n = 0;
function resolvedTicket() {
  n += 1;
  const programId = `reopen-${n}`;
  db.saveProgram({ id: programId, name: programId, helpChannel: `C-${programId}`, channels: [`C-${programId}`] });
  require("./programs").invalidate();
  const id = db.createTicket({
    programId,
    channel: `C-${programId}`,
    threadTs: `t-${programId}`,
    requesterId: "U-REQ",
    question: "my device is not booting",
  });
  db.resolveTicket(id, "done", "U-HELPER");
  return { id, programId, channel: `C-${programId}`, threadTs: `t-${programId}` };
}
const say = (t: ReturnType<typeof resolvedTicket>, text: string | null, userId = "U-REQ") =>
  tickets.noteThreadActivity({ channel: t.channel, threadTs: t.threadTs, userId, text });

beforeEach(() => watcher.stop());
afterEach(() => watcher.stop());

test("a thank-you does not reopen a resolved ticket", () => {
  const t = resolvedTicket();
  for (const text of ["Thanks!", "thx :pray:", "ok cool, appreciate it", "That worked, thanks"]) say(t, text);
  assert.equal(db.getTicket(t.id).status, "resolved");
  assert.equal(db.getTicket(t.id).reopen_count, 0);
});

test("a message with no text cannot reopen a ticket", () => {
  const t = resolvedTicket();
  say(t, null);
  say(t, "");
  assert.equal(db.getTicket(t.id).status, "resolved");
});

test("the requester reporting the problem persists reopens it once, however many times Slack repeats the event", () => {
  const t = resolvedTicket();
  for (let i = 0; i < 4; i += 1) say(t, "it's still broken");
  const row = db.getTicket(t.id);
  assert.equal(row.status, "reopened");
  assert.equal(row.reopen_count, 1);
  const events = db.listTicketEvents(t.id).filter((e: { event_type: string }) => e.event_type === "reopened");
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].detail).rule, "requester_reports_persists");
});

test("someone other than the requester cannot reopen a ticket", () => {
  const t = resolvedTicket();
  say(t, "it's still broken", "U-STRANGER");
  say(t, "it's still broken", "U-HELPER");
  assert.equal(db.getTicket(t.id).status, "resolved");
});

test("an ambiguous message does not reopen on its own; it is left for reassessment", () => {
  const t = resolvedTicket();
  say(t, "Is the next batch shipping in May?");
  assert.equal(db.getTicket(t.id).status, "resolved");
});

test("an open ticket is unaffected by thank-yous", () => {
  n += 1;
  const programId = `reopen-open-${n}`;
  db.saveProgram({ id: programId, name: programId, helpChannel: `C-${programId}`, channels: [`C-${programId}`] });
  const id = db.createTicket({
    programId,
    channel: `C-${programId}`,
    threadTs: "t-open",
    requesterId: "U-REQ",
    question: "q",
  });
  tickets.noteThreadActivity({ channel: `C-${programId}`, threadTs: "t-open", userId: "U-REQ", text: "Thanks!" });
  assert.equal(db.getTicket(id).status, "open");
});
export {};
