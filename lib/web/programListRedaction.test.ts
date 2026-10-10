process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "gauntlet-internal-token";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const programs = require("../programs");
const serve = require("./serve");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("the fleet list never returns inline source text", async () => {
  programs.saveProgram({
    id: "tenant-a",
    name: "Tenant A",
    sources: [{ name: "A private handbook", type: "text", content: "A-PRIVATE-DOC" }],
  });
  programs.saveProgram({
    id: "tenant-b",
    name: "Tenant B",
    sources: [{ name: "B private handbook", type: "text", content: "B-PRIVATE-DOC" }],
  });

  const response = await serve.handleRequest(
    new Request("http://localhost/internal/v1/programs", {
      headers: { Authorization: "Bearer gauntlet-internal-token" },
    }),
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.doesNotMatch(body, /A-PRIVATE-DOC|B-PRIVATE-DOC/);
  assert.match(body, /A private handbook/);
});
export {};
