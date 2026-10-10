process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const dashboardApi = require("./web/dashboardApi");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("a source-fetch error does not expose url secrets in knowledge status", async () => {
  const source = { name: "Bad source", type: "url", url: "not-a-url?token=TOP_SECRET" };
  programs.saveProgram({ id: "status-leak", name: "Status Leak", sources: [source] });
  await knowledge.refreshSource(source, true);
  const body = JSON.stringify(dashboardApi.knowledgeStatus("status-leak"));
  assert.doesNotMatch(body, /TOP_SECRET/);
});
export {};
