export {};
process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const db = require("./db");
const programs = require("./programs");
const programDocs = require("./programDocs");
const programSeed = require("./programSeed");
const knowledge = require("./knowledge");

db.open(":memory:");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-root-"));
const FIXTURE: Record<string, Record<string, string>> = {
  "alpha-prog": {
    "faq.md": "How many stickers does a participant get? Alpha participants receive pineapple stickers.",
    "rules.md": "Alpha projects must be shipped before the alpha deadline. Ask the alpha helpers if unsure.",
  },
  "beta-prog": {
    "faq.md": "How many stickers does a participant get? Beta participants receive coconut stickers.",
    "rules.md": "Beta projects must be shipped before the beta deadline. Ask the beta helpers if unsure.",
  },
};

function section(name: string) {
  return name === "faq.md" ? "faq" : "eligibility";
}

for (const [id, files] of Object.entries(FIXTURE)) {
  fs.mkdirSync(path.join(root, id, "docs"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const meta = `---\nsection: ${section(name)}\ntitle: "${id} ${name}"\ntrust: official\nsource_ref: private/${id}/${name}\n---\n\n# ${id} ${name}\n\n${body}\n`;
    fs.writeFileSync(path.join(root, id, "docs", name), meta);
  }
  programs.saveProgram({ id, name: id, workspaceId: "T-CORPUS", scope: "program", sources: [] });
}

function load(id: string) {
  const errors: string[] = [];
  const docs = programSeed.loadDocs(path.join(root, id), errors);
  assert.deepEqual(errors, []);
  return docs;
}

test("docs sync creates official docs and is idempotent", () => {
  for (const id of Object.keys(FIXTURE)) {
    const first = programSeed.syncDocs({ id, docs: load(id) }, false);
    assert.equal(first.created, 2);
    assert.equal(programSeed.syncDocs({ id, docs: load(id) }, false).created, 0);
    assert.ok(
      programDocs
        .listDocs(id)
        .every((d: { trust: string; active: number }) => d.trust === "official" && d.active === 1),
    );
  }
});

test("a dry run writes nothing", () => {
  programs.saveProgram({ id: "gamma-prog", name: "gamma", workspaceId: "T-CORPUS", scope: "program", sources: [] });
  const docs = load("alpha-prog");
  assert.equal(programSeed.syncDocs({ id: "gamma-prog", docs }, true).created, 2);
  assert.equal(programDocs.listDocs("gamma-prog").length, 0);
});

test("retrieval scoped to one program never returns another program's text", () => {
  const alpha = knowledge.getContext("How many stickers does a participant get?", "alpha-prog");
  const beta = knowledge.getContext("How many stickers does a participant get?", "beta-prog");
  assert.match(alpha, /pineapple/);
  assert.doesNotMatch(alpha, /coconut|beta/i);
  assert.match(beta, /coconut/);
  assert.doesNotMatch(beta, /pineapple|alpha/i);
  for (const id of Object.keys(FIXTURE)) assert.equal(knowledge.getIndex(id).docs.length > 0, true);
});

test("docs that reference research material are rejected", () => {
  for (const body of ["See research/notes for details", "see ../research/x.md", "the source-ledger says"]) {
    assert.ok(programSeed.unsafeDocReason({ body, sourceRef: null, file: "x.md" }));
  }
  assert.equal(programSeed.unsafeDocReason({ body: "plain", sourceRef: "private/a/b.md", file: "x.md" }), null);
});
