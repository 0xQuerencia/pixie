process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const docs = require("./programDocs");
const lifecycle = require("./lifecycle");

before(() => {
  db.close();
  db.open(":memory:");
});

function addOfficial(programId: string) {
  docs.createDoc(programId, {
    section: "overview",
    title: "Overview",
    body: "official content",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
}

test("lifecycle enforces blockers, audits transitions, and archives claims", () => {
  programs.saveProgram({
    id: "life-a",
    name: "Life A",
    lifecycle: "draft",
    helpChannel: "C-LIFE-H",
    organizerChannel: "C-LIFE-O",
  });
  assert.equal(lifecycle.transition("life-a", "testing", "U-owner").ok, false);
  addOfficial("life-a");
  assert.deepEqual(lifecycle.transition("life-a", "testing", "U-owner"), {
    ok: true,
    lifecycle: "testing",
    blockers: [],
  });

  db.syncHelper({ programId: "life-a", userId: "U-owner", role: "owner" });
  const hash = docs.contentHash("life-a");
  db.handle()
    .query(
      "INSERT INTO program_eval_runs (program_id, content_hash, started_at, finished_at, total, passed, failed, status, results, triggered_by) VALUES (?, ?, ?, ?, 1, 1, 0, 'passed', '[]', ?)",
    )
    .run("life-a", hash, Date.now(), Date.now(), "U-owner");
  assert.equal(lifecycle.transition("life-a", "approved", "U-owner").ok, true);
  docs.updateDoc("life-a", docs.listDocs("life-a")[0].id, { body: "changed", updatedBy: "U-owner" });
  assert.equal(lifecycle.current("life-a"), "testing");
  assert.match(lifecycle.transition("life-a", "approved", "U-owner").blockers.join(" "), /latest eval/);

  db.handle().query("UPDATE programs SET lifecycle = 'approved' WHERE id = ?").run("life-a");
  db.claimProgramChannel({ workspaceId: "TW-LIFE", channelId: "C-LIFE-H", programId: "life-a", kind: "help" });
  db.claimProgramChannel({ workspaceId: "TW-LIFE", channelId: "C-LIFE-O", programId: "life-a", kind: "organizer" });
  assert.equal(lifecycle.transition("life-a", "active", "U-owner").ok, true);
  assert.equal(lifecycle.transition("life-a", "paused", "U-owner").lifecycle, "paused");
  assert.equal(lifecycle.transition("life-a", "active", "U-owner").lifecycle, "active");
  assert.equal(lifecycle.transition("life-a", "archived", "U-owner").lifecycle, "archived");
  assert.equal(db.listProgramChannels("life-a").length, 0);
  assert.ok(
    db.listAuditEvents({ programId: "life-a" }).some((event) => event.action === "program.lifecycle.transition"),
  );
});
function activeProgram(id: string) {
  programs.saveProgram({ id, name: id, lifecycle: "active", helpChannel: `C-${id}-H`, channels: [`C-${id}-H`] });
  db.claimProgramChannel({ workspaceId: "TW-LIFE", channelId: `C-${id}-H`, programId: id, kind: "help" });
  db.syncHelper({ programId: id, userId: "U-owner", role: "owner" });
}

test("archive, pause and deploy need a program owner or admin, not just the internal token", () => {
  activeProgram("life-authz");
  for (const to of ["paused", "archived"]) {
    const refused = lifecycle.transition("life-authz", to, null);
    assert.equal(refused.ok, false, to);
    assert.match(refused.blockers.join(" "), /requires a program owner or admin/);
    assert.equal(lifecycle.transition("life-authz", to, "U-stranger").ok, false, to);
  }
  assert.equal(lifecycle.current("life-authz"), "active");
  assert.equal(db.listProgramChannels("life-authz").length, 1);
});

test("archiving clears the program's channel fields so nothing routes to it", () => {
  activeProgram("life-routes");
  assert.equal(lifecycle.transition("life-routes", "archived", "U-owner").ok, true);
  assert.equal(programs.forChannel("C-life-routes-H", "TW-LIFE").id, "shared");
  const stored = programs.get("life-routes");
  assert.equal(stored.helpChannel, null);
  assert.deepEqual(stored.channels, []);
});

test("a program with tickets off can go live without an organizer channel", () => {
  programs.saveProgram({
    id: "life-quiet",
    name: "Quiet",
    lifecycle: "approved",
    ticketsEnabled: false,
    helpChannel: "C-quiet-H",
    channels: ["C-quiet-H"],
  });
  db.claimProgramChannel({ workspaceId: "TW-LIFE", channelId: "C-quiet-H", programId: "life-quiet", kind: "help" });
  db.syncHelper({ programId: "life-quiet", userId: "U-owner", role: "owner" });
  assert.equal(lifecycle.transition("life-quiet", "active", "U-owner").ok, true);
});

test("a ticketing program still needs an organizer channel", () => {
  programs.saveProgram({
    id: "life-tix",
    name: "Tix",
    lifecycle: "approved",
    ticketsEnabled: true,
    helpChannel: "C-tix-H",
    channels: ["C-tix-H"],
  });
  db.claimProgramChannel({ workspaceId: "TW-LIFE", channelId: "C-tix-H", programId: "life-tix", kind: "help" });
  db.syncHelper({ programId: "life-tix", userId: "U-owner", role: "owner" });
  const result = lifecycle.transition("life-tix", "active", "U-owner");
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(" "), /organizer channel/);
});

test("ordinary metadata saves preserve lifecycle and archived programs cannot be revived", () => {
  programs.saveProgram({ id: "life-write", name: "Write", lifecycle: "draft" });
  programs.saveProgram({ id: "life-write", name: "Renamed", lifecycle: "active" });
  assert.equal(lifecycle.current("life-write"), "draft");
  const sync = require("./web/api").internalProgramSync("life-write", { name: "Synced" });
  assert.equal(sync.ok, true);
  assert.equal(lifecycle.current("life-write"), "draft");
  db.handle().query("UPDATE programs SET lifecycle = 'archived' WHERE id = ?").run("life-write");
  programs.saveProgram({ id: "life-write", name: "Still archived", status: "live" });
  assert.equal(lifecycle.current("life-write"), "archived");
});

test("an empty eval run cannot approve a program", () => {
  programs.saveProgram({ id: "life-empty-eval", name: "Empty eval", lifecycle: "testing" });
  db.syncHelper({ programId: "life-empty-eval", userId: "U-empty-owner", role: "owner" });
  const hash = docs.contentHash("life-empty-eval");
  db.handle()
    .query(
      "INSERT INTO program_eval_runs (program_id, content_hash, started_at, finished_at, total, passed, failed, status, results, triggered_by) VALUES (?, ?, ?, ?, 0, 0, 0, 'failed', '[]', ?)",
    )
    .run("life-empty-eval", hash, Date.now(), Date.now(), "U-empty-owner");
  const result = lifecycle.transition("life-empty-eval", "approved", "U-empty-owner");
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(" "), /at least one passing case/);
});
