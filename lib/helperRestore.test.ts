export {};
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Database } = require("bun:sqlite");
const db = require("./db");
const testPrograms = require("./testPrograms");
const helperRestore = require("./helperRestore");

db.open(":memory:");

function archiveWith(rows: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-"));
  const file = path.join(dir, "pixie-archive-test.db");
  db.ensureSchema(file);
  const archive = new Database(file);
  archive.exec(rows);
  archive.close();
  return { dir, file };
}

test("active helpers and their expertise come back for programs that exist, and nothing else", () => {
  testPrograms.set([{ id: "restore-a", name: "A" }]);
  const { dir, file } = archiveWith(`
    INSERT INTO program_helpers (program_id, user_id, helper_source, role, active, added_at) VALUES
      ('restore-a', 'U1', 'manual', 'owner', 1, 1), ('restore-a', 'U2', 'manual', 'helper', 0, 1), ('gone-prog', 'U3', 'manual', 'helper', 1, 1);
    INSERT INTO helper_expertise (program_id, user_id, tag, solved_count, updated_at) VALUES ('restore-a', 'U1', 'billing', 4, 1);
  `);
  try {
    const dry = helperRestore.restore(file, { execute: false });
    assert.equal(db.listHelpers("restore-a").length, 0, "dry run changes nothing");
    assert.deepEqual(dry.map((row: { programId: string; helpers: number }) => [row.programId, row.helpers]), [["gone-prog", 1], ["restore-a", 1]]);
    const real = helperRestore.restore(file, { execute: true });
    assert.match(real.find((row: { programId: string }) => row.programId === "gone-prog").skipped, /not in the live database/);
    assert.deepEqual(db.listHelpers("restore-a").map((row: { user_id: string; role: string }) => [row.user_id, row.role]), [["U1", "owner"]]);
    assert.equal(db.handle().query("SELECT solved_count AS n FROM helper_expertise WHERE program_id = 'restore-a' AND tag = 'billing'").get().n, 4);
    assert.equal(db.listHelpers("gone-prog").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restoring is idempotent and can be limited to one program", () => {
  testPrograms.set([{ id: "restore-b", name: "B" }, { id: "restore-c", name: "C" }]);
  const { dir, file } = archiveWith(`
    INSERT INTO program_helpers (program_id, user_id, helper_source, role, active, added_at) VALUES ('restore-b', 'U1', 'manual', 'helper', 1, 1), ('restore-c', 'U2', 'manual', 'helper', 1, 1);
  `);
  try {
    helperRestore.restore(file, { execute: true, program: "restore-b" });
    helperRestore.restore(file, { execute: true, program: "restore-b" });
    assert.equal(db.listHelpers("restore-b").length, 1);
    assert.equal(db.listHelpers("restore-c").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
