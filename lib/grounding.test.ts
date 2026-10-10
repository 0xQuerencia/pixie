const { test } = require("node:test");
const assert = require("node:assert/strict");
const grounding = require("./grounding");

const supported = {
  verdict: "supported",
  claims: [{ claim: "The build grant is available to students.", supported: true, evidenceIds: ["policy-1"] }],
};

test("parses fenced JSON with surrounding model prose", () => {
  const result = grounding.parseGroundingVerdict(
    `Here is the result:\n\`\`\`json\n${JSON.stringify(supported)}\n\`\`\``,
  );
  assert.equal(result.ok, true);
  assert.equal(result.claims[0].evidenceIds[0], "policy-1");
});

test("fails closed for malformed or schema-invalid verdicts", () => {
  assert.equal(grounding.parseGroundingVerdict("not json").ok, false);
  assert.equal(grounding.parseGroundingVerdict({ verdict: "supported", claims: [] }).ok, false);
  assert.equal(
    grounding.parseGroundingVerdict({
      verdict: "supported",
      claims: [{ claim: "x", supported: true, evidenceIds: [] }],
    }).ok,
    false,
  );
});

test("accepts exact support from same-program retrieved evidence", () => {
  const result = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [
      { id: "policy-1", programId: "build-grant", supportsClaims: ["The build grant is available to students."] },
    ],
  });
  assert.equal(result.supported, true);
});

test("rejects related policy evidence and cross-program evidence", () => {
  const related = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [
      { id: "policy-1", programId: "build-grant", supportsClaims: ["The build grant has a student application."] },
    ],
  });
  const crossProgram = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    evidence: [{ id: "policy-1", programId: "other-program", supportsClaims: [supported.claims[0].claim] }],
  });
  assert.equal(related.supported, false);
  assert.equal(crossProgram.supported, false);
});

test("allows only explicitly listed fixture-supported claims", () => {
  const result = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    fixtureClaims: [supported.claims[0].claim],
    allowFixtures: true,
  });
  assert.equal(result.supported, true);
  const notExplicit = grounding.validateClaimSupport({
    verdict: supported,
    programId: "build-grant",
    fixtureClaims: [],
  });
  assert.equal(notExplicit.supported, false);
});

test("uses an injected parser without calling a live model", () => {
  let calls = 0;
  const validator = grounding.createGroundingValidator({
    parse() {
      calls += 1;
      return { ...supported, ok: true };
    },
  });
  const result = validator.validate({
    programId: "build-grant",
    fixtureClaims: [supported.claims[0].claim],
    allowFixtures: true,
  });
  assert.equal(result.supported, true);
  assert.equal(calls, 1);
});
export {};
