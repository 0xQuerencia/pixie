export {};
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Database } = require("bun:sqlite");
const db = require("./db");

const ROOT = path.join(__dirname, "..");

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bun", path.join(ROOT, "scripts", script), ...args], {
    env: { ...process.env, PIXIE_DB_PATH: "", RAILWAY_ENVIRONMENT: "", NODE_ENV: "test", ...env },
  });
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}` };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-reset-"));
  const file = path.join(dir, "pixie.db");
  db.ensureSchema(file);
  const live = new Database(file);
  live.exec(`
    INSERT INTO programs (id, name, posture, scope, updated_at) VALUES ('alpha', 'Alpha', 'active', 'program', 1), ('bravo', 'Bravo', 'active', 'program', 1);
    INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, created_at) VALUES ('alpha', 'C-A', 't1', 'U1', 'alpha question', 1), ('bravo', 'C-B', 't2', 'U2', 'bravo question', 1);
    INSERT INTO audit_events (program_id, action, created_at) VALUES ('alpha', 'program.created', 1);
  `);
  live.close();
  const archive = run("program-archive.ts", ["--db", file, "--output", path.join(dir, "archive")]);
  assert.equal(archive.code, 0, archive.out);
  const info = JSON.parse(archive.out.slice(archive.out.indexOf("{")));
  return { dir, file, archiveDb: info.dbPath as string };
}

function fingerprintOf(file: string, program: string) {
  const dry = run("program-reset.ts", ["--db", file, "--program", program]);
  assert.equal(dry.code, 0, dry.out);
  return dry.out.match(/current data\): ([0-9a-f]{8})/)?.[1] as string;
}

function count(file: string, sql: string) {
  const handle = new Database(file, { readonly: true });
  try {
    return handle.query(sql).get().n as number;
  } finally {
    handle.close();
  }
}

test("a matching archive and fingerprint reset only the chosen program and keep audit rows", () => {
  const { file, archiveDb } = fixture();
  const fingerprint = fingerprintOf(file, "alpha");
  const result = run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", fingerprint]);
  assert.equal(result.code, 0, result.out);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'alpha'"), 0);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'bravo'"), 1);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM tickets WHERE program_id = 'bravo'"), 1);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM audit_events WHERE program_id = 'alpha'"), 1);
});

test("data written after the archive makes the reset refuse", () => {
  const { file, archiveDb } = fixture();
  const live = new Database(file);
  live.exec("INSERT INTO tickets (program_id, channel, thread_ts, requester_id, question, created_at) VALUES ('alpha', 'C-A', 't9', 'U9', 'late question', 2)");
  live.close();
  const fingerprint = fingerprintOf(file, "alpha");
  const result = run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", fingerprint]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /archive does not match the live data/);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'alpha'"), 1);
});

test("a different database at the same path cannot reuse an old confirmation", () => {
  const { file, archiveDb } = fixture();
  const stale = fingerprintOf(file, "alpha");
  const live = new Database(file);
  live.exec("UPDATE tickets SET question = 'swapped' WHERE program_id = 'alpha'");
  live.close();
  const result = run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", stale]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /fingerprint mismatch/);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'alpha'"), 1);
});

test("a wrong fingerprint and a missing archive are refused", () => {
  const { file, archiveDb } = fixture();
  assert.notEqual(run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", "deadbeef"]).code, 0);
  assert.match(run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute"]).out, /requires --archive/);
});

test("a tampered archive file is refused", () => {
  const { file, archiveDb } = fixture();
  const fingerprint = fingerprintOf(file, "alpha");
  const archive = new Database(archiveDb);
  archive.exec("UPDATE tickets SET question = 'tampered' WHERE program_id = 'alpha'");
  archive.close();
  const result = run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", fingerprint]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /sha256 does not match/);
});

test("a running instance blocks the reset", () => {
  const { file, archiveDb } = fixture();
  const live = new Database(file);
  live.exec(`INSERT INTO job_leases (name, owner, expires_at) VALUES ('sla-check', 'pod', ${Date.now() + 60000})`);
  live.close();
  const archive = run("program-archive.ts", ["--db", file, "--output", path.join(path.dirname(file), "archive2")]);
  const info = JSON.parse(archive.out.slice(archive.out.indexOf("{")));
  const fingerprint = fingerprintOf(file, "alpha");
  const result = run("program-reset.ts", ["--db", file, "--program", "alpha", "--execute", "--archive", info.dbPath, "--confirm", fingerprint]);
  assert.notEqual(result.code, 0);
  assert.match(result.out, /instance looks active/);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'alpha'"), 1);
  assert.ok(archiveDb);
});

test("production needs the explicit flag and phrase on top of the fingerprint", () => {
  const { file, archiveDb } = fixture();
  const fingerprint = fingerprintOf(file, "alpha");
  const args = ["--db", file, "--program", "alpha", "--execute", "--archive", archiveDb, "--confirm", fingerprint];
  const refused = run("program-reset.ts", args, { RAILWAY_ENVIRONMENT: "production" });
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /--allow-production/);
  assert.equal(count(file, "SELECT COUNT(*) AS n FROM programs WHERE id = 'alpha'"), 1);
  const allowed = run("program-reset.ts", [...args, "--allow-production", "--phrase", `RESET-${fingerprint}`], { RAILWAY_ENVIRONMENT: "production" });
  assert.equal(allowed.code, 0, allowed.out);
});
