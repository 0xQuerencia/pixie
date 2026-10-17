export {};
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Database } = require("bun:sqlite");
const db = require("./db");

function legacyDatabase(file: string) {
  const legacy = new Database(file, { create: true });
  legacy.exec(`
    CREATE TABLE answered_messages (ts TEXT PRIMARY KEY, answered_at INTEGER NOT NULL);
    CREATE TABLE threads (thread_ts TEXT PRIMARY KEY, seeded INTEGER NOT NULL DEFAULT 0, pixie_spoke INTEGER NOT NULL DEFAULT 0, helper_pinged INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE muted_threads (thread_ts TEXT PRIMARY KEY, muted_at INTEGER NOT NULL);
    CREATE TABLE user_topics (user_id TEXT NOT NULL, topic TEXT NOT NULL, was_helpful INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, topic));
    INSERT INTO answered_messages VALUES ('100.1', 1), ('100.2', 2);
    INSERT INTO threads VALUES ('t1', 1, 1, 0, 5);
    INSERT INTO muted_threads VALUES ('t1', 7);
    INSERT INTO user_topics VALUES ('U1', 'hackatime', 1, 9);
  `);
  legacy.close();
}

test("opening a legacy database keeps answered, thread and topic state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-migrate-"));
  const file = path.join(dir, "legacy.db");
  legacyDatabase(file);
  db.close();
  db.open(file);
  try {
    const answered = db.handle().query("SELECT workspace_id, channel, ts FROM answered_messages ORDER BY ts").all();
    assert.deepEqual(answered, [
      { workspace_id: "default", channel: "", ts: "100.1" },
      { workspace_id: "default", channel: "", ts: "100.2" },
    ]);
    const thread = db.handle().query("SELECT thread_ts, seeded, pixie_spoke FROM threads").get();
    assert.deepEqual(thread, { thread_ts: "t1", seeded: 1, pixie_spoke: 1 });
    assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM muted_threads").get().n, 1);
    const topic = db.handle().query("SELECT user_id, program_id, topic FROM user_topics").get();
    assert.deepEqual(topic, { user_id: "U1", program_id: "__legacy__", topic: "hackatime" });
  } finally {
    db.close();
    db.open(":memory:");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a migrated database twice changes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-migrate-"));
  const file = path.join(dir, "legacy.db");
  legacyDatabase(file);
  try {
    db.close();
    db.open(file);
    db.close();
    db.open(file);
    assert.equal(db.handle().query("SELECT COUNT(*) AS n FROM answered_messages").get().n, 2);
  } finally {
    db.close();
    db.open(":memory:");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
