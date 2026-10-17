process.env.PIXIE_DB_PATH = ":memory:";
export {};

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const docs = require("./programDocs");
const knowledge = require("./knowledge");

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

  assert.deepEqual(
    docs.docSections("docs-a").map((item) => item.docId),
    [official.id],
  );
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

test("official seeded docs participate in scoped retrieval without leaking across programs", () => {
  programs.saveProgram({ id: "docs-retrieve-a", name: "Docs Retrieve A", sharedSources: false, lifecycle: "active" });
  programs.saveProgram({ id: "docs-retrieve-b", name: "Docs Retrieve B", sharedSources: false, lifecycle: "active" });
  docs.createDoc("docs-retrieve-a", {
    section: "faq",
    title: "A seeded policy",
    body: "Program A permits a blue pineapple sticker for completed projects.",
    trust: "official",
    origin: "manual",
    updatedBy: "seed",
  });
  docs.createDoc("docs-retrieve-b", {
    section: "faq",
    title: "B seeded policy",
    body: "Program B permits a green mango sticker for completed projects.",
    trust: "official",
    origin: "manual",
    updatedBy: "seed",
  });
  programs.invalidate();
  knowledge.invalidate();

  const aContext = knowledge.getContext("what sticker does the program permit", "docs-retrieve-a");
  const bContext = knowledge.getContext("what sticker does the program permit", "docs-retrieve-b");
  assert.match(aContext, /blue pineapple sticker/);
  assert.doesNotMatch(aContext, /green mango sticker/);
  assert.match(bContext, /green mango sticker/);
  assert.doesNotMatch(bContext, /blue pineapple sticker/);
});

test("document updates, supersedes and deletes invalidate retrieval immediately", () => {
  programs.saveProgram({ id: "docs-invalidate", name: "Docs Invalidate", sharedSources: false, lifecycle: "active" });
  const first = docs.createDoc("docs-invalidate", {
    section: "faq",
    title: "Versioned FAQ",
    body: "version alpha answer",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
  assert.match(knowledge.getContext("what is the alpha answer", "docs-invalidate"), /version alpha answer/);
  docs.updateDoc("docs-invalidate", first.id, { body: "version beta answer", updatedBy: "owner" });
  assert.doesNotMatch(knowledge.getContext("what is the beta answer", "docs-invalidate"), /version alpha answer/);
  assert.match(knowledge.getContext("what is the beta answer", "docs-invalidate"), /version beta answer/);
  const replacement = docs.supersedeDoc("docs-invalidate", first.id, {
    section: "faq",
    title: "Replacement FAQ",
    body: "version gamma answer",
    trust: "official",
    origin: "manual",
    updatedBy: "owner",
  });
  assert.match(knowledge.getContext("what is the gamma answer", "docs-invalidate"), /version gamma answer/);
  docs.deleteDoc("docs-invalidate", replacement.id);
  assert.doesNotMatch(knowledge.getContext("what is the gamma answer", "docs-invalidate"), /version gamma answer/);
});
