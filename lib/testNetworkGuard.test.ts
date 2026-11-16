process.env.PIXIE_DB_PATH = ":memory:";
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("unit test preload rejects external provider fetch with actionable error", async () => {
  await assert.rejects(
    fetch("https://example.invalid/v1/chat/completions"),
    /Unit test attempted external fetch/,
  );
});
