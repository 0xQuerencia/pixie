const { test } = require("node:test");
const assert = require("node:assert/strict");
const maintenance = require("./maintenance");

test("maintenance mode is opt-in", () => {
  const previous = process.env.PIXIE_MAINTENANCE;
  delete process.env.PIXIE_MAINTENANCE;
  assert.equal(maintenance.enabled(), false);
  process.env.PIXIE_MAINTENANCE = "1";
  assert.equal(maintenance.enabled(), true);
  if (previous === undefined) delete process.env.PIXIE_MAINTENANCE;
  else process.env.PIXIE_MAINTENANCE = previous;
});

export {};
