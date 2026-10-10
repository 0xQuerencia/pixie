const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHILDREN = 6;
const CHILD_SCRIPT =
  'const fs = require("node:fs"); const db = require("./lib/db"); const file = process.argv.at(-1); fs.writeFileSync(`${file}.ready.${process.pid}`, "1"); const wait = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(`${file}.go`)) Atomics.wait(wait, 0, 0, 10); try { db.ensureSchema(file); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }';

test("concurrent ensureSchema runs apply the data migrations exactly once", async () => {
  const db = require("./db");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pixie-migration-race-"));
  const filename = path.join(directory, "pixie.sqlite");
  try {
    db.close();
    db.open(filename);
    db.addLearnedFact({
      question: "legacy race question",
      answer: "legacy race answer",
      status: "approved",
      sourceTs: "legacy-race",
      programId: "race-program",
      autoLearned: true,
    });
    db.handle().query("DELETE FROM schema_data_migrations").run();
    db.close();

    const children = Array.from({ length: CHILDREN }, () =>
      Bun.spawn([process.execPath, "-e", CHILD_SCRIPT, filename], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = fs.readdirSync(directory).filter((entry: string) => entry.includes(".ready.")).length;
      if (ready === CHILDREN) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.writeFileSync(`${filename}.go`, "go");
    const outcomes = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        return { exitCode, stderr };
      }),
    );
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.exitCode !== 0),
      [],
    );

    db.open(filename);
    const [row] = db.handle().query("SELECT status FROM learned_facts").all();
    assert.equal(row.status, "candidate");
    const markers = db.handle().query("SELECT version FROM schema_data_migrations").all();
    assert.equal(new Set(markers.map((m: { version: string }) => m.version)).size, markers.length);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    db.open(":memory:");
  }
});
export {};
