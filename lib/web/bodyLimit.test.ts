process.env.PIXIE_DB_PATH = ":memory:";
process.env.PIXIE_INTERNAL_TOKEN = "gauntlet-inspector-token";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("../db");
const api = require("./api");
const serve = require("./serve");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => db.close());

test("the inspector rejects an oversized body before parsing it", async () => {
  const sync = api.internalProgramSync("inspector-cap", {
    name: "Inspector cap",
    workspaceId: "W-INSPECTOR",
    claimedBy: "U-inspector",
    programChannels: [],
  });
  assert.equal(sync.ok, true);
  const raw = JSON.stringify({ question: "hello", padding: "x".repeat(2_000_000) });
  const response = await serve.handleRequest(
    new Request("http://localhost/internal/v1/programs/inspector-cap/test-question", {
      method: "POST",
      headers: { Authorization: "Bearer gauntlet-inspector-token", "Content-Type": "application/json" },
      body: raw,
    }),
  );
  assert.equal(response.status, 413);
});

test("a normal sized inspector body is still parsed", async () => {
  const response = await serve.handleRequest(
    new Request("http://localhost/internal/v1/programs/inspector-cap/test-question", {
      method: "POST",
      headers: { Authorization: "Bearer gauntlet-inspector-token", "Content-Type": "application/json" },
      body: JSON.stringify({ question: "q".repeat(1001) }),
    }),
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /question too long/);
});
export {};
