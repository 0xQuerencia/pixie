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
  programs.saveProgram({ id: "life-a", name: "Life A", lifecycle: "draft", helpChannel: "C-LIFE-H", organizerChannel: "C-LIFE-O" });
  assert.equal(lifecycle.transition("life-a", "testing", "U-owner").ok, false);
  addOfficial("life-a");
  assert.deepEqual(lifecycle.transition("life-a", "testing", "U-owner"), { ok: true, lifecycle: "testing", blockers: [] });

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
  assert.ok(db.listAuditEvents({ programId: "life-a" }).some((event) => event.action === "program.lifecycle.transition"));
});
