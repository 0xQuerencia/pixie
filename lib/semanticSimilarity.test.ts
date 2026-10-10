const { test } = require("node:test");
const assert = require("node:assert/strict");
const semanticSimilarity = require("./semanticSimilarity");

test("semantic similarity connects common support paraphrases", () => {
  const score = semanticSimilarity.score(
    "Can I get my money back if I never activated the grant?",
    "Unused grants may be returned before activation.",
  );
  assert.ok(score >= 0.18, `expected a useful paraphrase score, got ${score}`);
});

test("semantic similarity does not invent a match for unrelated questions", () => {
  assert.ok(semanticSimilarity.score("Where is the deadline?", "The login page is broken.") < 0.18);
});

export {};
