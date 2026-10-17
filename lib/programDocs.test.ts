process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const docs = require("./programDocs");

before(() => {
  db.close();
  db.open(":memory:");
});

test("program docs are CRUD, versioned, supersedable, and program-scoped", () => {
  programs.saveProgram({ id: "docs-a", name: "Docs A", lifecycle: "draft" });
  programs.saveProgram({ id: "docs-b", name: "Docs B", lifecycle: "draft" });
  const official = docs.createDoc("docs-a", {
    section: "faq",
    title: "A FAQ",
    body: "A official answer",
    trust: "official",
    origin: "manual",
    updatedBy: "owner-a",
  });
  docs.createDoc("docs-a", {
    section: "faq",
    title: "A supporting",
    body: "A supporting note",
    trust: "supporting",
    origin: "slack",
    updatedBy: "helper-a",
  });
  docs.createDoc("docs-b", {
    section: "faq",
    title: "B FAQ",
    body: "B answer",
    trust: "official",
    origin: "manual",
    updatedBy: "owner-b",
  });

  assert.deepEqual(docs.docSections("docs-a").map((item) => item.docId), [official.id]);
  assert.equal(docs.listBySection("docs-a", "faq", true).length, 2);
  assert.equal(docs.docSections("docs-b")[0].text, "B answer");

  const updated = docs.updateDoc("docs-a", official.id, { body: "A revised answer", updatedBy: "owner-a" });
  assert.equal(updated.version, 2);
  const replacement = docs.supersedeDoc("docs-a", official.id, {
    section: "faq",
    title: "A FAQ v2",
    body: "A replacement answer",
    trust: "official",
    origin: "manual",
    updatedBy: "owner-a",
  });
  assert.equal(docs.getDoc("docs-a", official.id).active, 0);
  assert.equal(replacement.supersedes_id, official.id);
  assert.equal(docs.docSections("docs-a").length, 1);
  assert.equal(docs.deleteDoc("docs-a", replacement.id), true);
  assert.equal(docs.docSections("docs-a").length, 0);
});

test("contentHash includes active official docs and source state", () => {
  programs.saveProgram({ id: "docs-hash", name: "Docs Hash", lifecycle: "draft" });
  docs.createDoc("docs-hash", {
    section: "overview",
    title: "Overview",
    body: "first",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
  const first = docs.contentHash("docs-hash");
  docs.upsertSourceState("docs-hash", "source-a", "source text");
  const second = docs.contentHash("docs-hash");
  assert.notEqual(first, second);
  docs.createDoc("docs-hash", {
    section: "faq",
    title: "Supporting",
    body: "not authoritative",
    trust: "supporting",
    origin: "slack",
    updatedBy: "helper",
  });
  assert.equal(docs.contentHash("docs-hash"), second);
});
