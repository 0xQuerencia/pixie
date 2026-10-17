export {};
process.env.PIXIE_DB_PATH = ":memory:";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const db = require("./db");
const programs = require("./programs");
const programDocs = require("./programDocs");
const evalHarness = require("./evalHarness");
const programSeed = require("./programSeed");
const testPrograms = require("./testPrograms");
const knowledge = require("./knowledge");

const FIXTURES = path.join(__dirname, "__fixtures__", "seed");
const DEMO = path.join(FIXTURES, "demo-program");
const WORKSPACE = "T-SEED";

db.open(":memory:");

beforeEach(() => {
  testPrograms.set([]);
});

function load(dir: string) {
  const { seed, errors } = programSeed.loadProgramDir(dir);
  assert.deepEqual(errors, []);
  return seed;
}

test("a valid program directory loads with docs, cases and normalized sources", () => {
  const seed = load(DEMO);
  assert.equal(seed.id, "demo-program");
  assert.equal(seed.docs.length, 1);
  assert.equal(seed.cases.length, 2);
  assert.deepEqual(
    seed.sources.map((source: { type: string }) => source.type),
    ["url", "reference"],
  );
});

test("applying a seed creates a draft program with claimed channels, docs and cases", () => {
  const result = programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  assert.equal(result.created, true);
  assert.deepEqual(result.docs, { created: 1, updated: 0, unchanged: 0, deactivated: 0 });
  const program = programs.get("demo-program");
  assert.equal(program.lifecycle, "draft");
  assert.equal(program.helpChannel, "C0DEMOHELP1");
  assert.equal(db.getChannelOwner(WORKSPACE, "C0DEMOORG01").kind, "organizer");
  assert.equal(evalHarness.listCases("demo-program").length, 2);
  assert.match(knowledge.getContext("what do participants get", "demo-program"), /pineapple sticker/);
});

test("seeding twice changes nothing", () => {
  programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  const again = programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  assert.equal(again.created, false);
  assert.deepEqual(again.docs, { created: 0, updated: 0, unchanged: 1, deactivated: 0 });
  assert.equal(programDocs.listDocs("demo-program").length, 1);
  assert.equal(evalHarness.listCases("demo-program").length, 2);
});

test("a seed never activates a program that was already deployed", () => {
  programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  db.saveProgram({ ...programs.get("demo-program"), lifecycle: "paused" });
  programs.invalidate();
  programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  assert.equal(programs.get("demo-program").lifecycle, "paused");
});

test("a changed doc is versioned and a removed doc is deactivated", () => {
  const seed = load(DEMO);
  programSeed.apply(seed, { workspaceId: WORKSPACE });
  const changed = { ...seed, docs: [{ ...seed.docs[0], body: "- Participants get a mango sticker." }] };
  const result = programSeed.apply(changed, { workspaceId: WORKSPACE });
  assert.equal(result.docs.updated, 1);
  assert.equal(programDocs.listDocs("demo-program")[0].version, 2);
  const removed = programSeed.apply({ ...seed, docs: [] }, { workspaceId: WORKSPACE });
  assert.equal(removed.docs.deactivated, 1);
  assert.equal(programDocs.docSections("demo-program").length, 0);
});

test("dry run writes nothing", () => {
  const result = programSeed.apply(load(DEMO), { workspaceId: WORKSPACE, dryRun: true });
  assert.equal(result.docs.created, 1);
  assert.equal(programs.get("demo-program"), null);
  assert.equal(programDocs.listDocs("demo-program").length, 0);
});

test("a channel owned by another program blocks the seed", () => {
  db.saveProgram({ id: "other-program", name: "Other" });
  db.claimProgramChannel({
    workspaceId: WORKSPACE,
    programId: "other-program",
    channelId: "C0DEMOHELP1",
    kind: "help",
  });
  programs.invalidate();
  assert.throws(() => programSeed.apply(load(DEMO), { workspaceId: WORKSPACE }), /already claimed by other-program/);
});

test("validation reports file and field for every problem", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const bad = path.join(dir, "bad-program");
  fs.mkdirSync(path.join(bad, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(bad, "program.json"),
    JSON.stringify({
      id: "bad-program",
      name: "Bad",
      channels: { help: "not-a-channel" },
      sources: [{ name: "x", url: "u", type: "ftp" }],
    }),
  );
  fs.writeFileSync(path.join(bad, "docs", "x.md"), "---\nsection: nonsense\ntrust: supporting\ntitle: X\n---\nbody\n");
  fs.writeFileSync(
    path.join(bad, "eval.json"),
    JSON.stringify([{ kind: "weird", question: "q", expect: { mode: "clarify" } }]),
  );
  const { errors } = programSeed.loadProgramDir(bad);
  const text = errors.join("\n");
  assert.match(text, /program\.json: channels: invalid Slack id "not-a-channel"/);
  assert.match(text, /program\.json: sources\[0\]\.type: unknown "ftp"/);
  assert.match(text, /x\.md: section: unknown "nonsense"/);
  assert.match(text, /x\.md: trust: seed docs must be official/);
  assert.match(text, /eval\.json: \[0\]\.kind: unknown "weird"/);
  assert.match(text, /eval\.json: \[0\]\.expect: invalid expect\.mode/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a directory name that disagrees with the id is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const wrong = path.join(dir, "folder-name");
  fs.mkdirSync(wrong);
  fs.writeFileSync(path.join(wrong, "program.json"), JSON.stringify({ id: "other-id", name: "X" }));
  assert.match(programSeed.loadProgramDir(wrong).errors.join("\n"), /id: must match directory name/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("settings from program.json are applied and unknown or mistyped settings are rejected", () => {
  programSeed.apply(load(DEMO), { workspaceId: WORKSPACE });
  const program = programs.get("demo-program");
  assert.equal(program.ticketsEnabled, false);
  assert.equal(program.helperPing, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  const bad = path.join(dir, "bad-settings");
  fs.mkdirSync(bad);
  fs.writeFileSync(
    path.join(bad, "program.json"),
    JSON.stringify({ id: "bad-settings", name: "Bad", settings: { ticketsEnabled: "yes", madeUp: true } }),
  );
  const text = programSeed.loadProgramDir(bad).errors.join("\n");
  assert.match(text, /settings\.ticketsEnabled: expected boolean/);
  assert.match(text, /settings\.madeUp: unknown setting/);
  fs.rmSync(dir, { recursive: true, force: true });
});
