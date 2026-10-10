const { test } = require("node:test");
const assert = require("node:assert/strict");
const answerVerifier = require("./answerVerifier");

const claim = "The grant can be returned before activation.";

test("answer verifier fails closed for a needs_review top-level verdict", () => {
  const result = answerVerifier.verify({
    programId: "program-a",
    verdict: { verdict: "needs_review", claims: [{ claim, supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "program-a", supportsClaims: [claim] }],
  });
  assert.equal(result.sendable, false);
  assert.equal(result.verdict, "unsupported");
  assert.equal(result.claims[0].supported, false);
});

test("answer verifier rejects cross-program evidence", () => {
  const result = answerVerifier.verify({
    programId: "program-a",
    verdict: { verdict: "supported", claims: [{ claim, supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "program-b", supportsClaims: [claim] }],
  });
  assert.equal(result.sendable, false);
  assert.match(result.claims[0].reason, /same-program/);
});

test("answer verifier accepts exact same-program evidence only", () => {
  const result = answerVerifier.verify({
    programId: "program-a",
    verdict: { verdict: "supported", claims: [{ claim, supported: true, evidenceIds: ["e1"] }] },
    evidence: [{ id: "e1", programId: "program-a", supportsClaims: [claim] }],
  });
  assert.equal(result.sendable, true);
  assert.equal(result.verdict, "supported");
});

export {};
