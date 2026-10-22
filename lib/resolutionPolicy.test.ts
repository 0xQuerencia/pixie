const { test } = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./resolutionPolicy");

const KINDS: Array<[string, string]> = [
  ["Thanks!", "ack"],
  ["Thanks again!", "ack"],
  ["thank you again :pray:", "ack"],
  ["I can't thank you enough", "ack"],
  ["It's broken again", "persists"],
  ["Still broken", "persists"],
  ["Thanks, but it broke again", "persists"],
  ["That fixed it, thanks", "confirm"],
  ["thx :pray:", "ack"],
  ["ok cool, appreciate it", "ack"],
  ["That worked, thanks", "confirm"],
  ["it's fixed now", "confirm"],
  ["All good, solved", "confirm"],
  ["it's still broken", "persists"],
  ["still not working after the restart", "persists"],
  ["Thanks but same error again", "persists"],
  ["nope, no luck", "persists"],
  ["it works now but the error is back", "other"],
  ["not broken anymore, thanks", "other"],
  ["still works great", "other"],
  ["Is the next batch shipping in May?", "other"],
  ["", "other"],
];
for (const [text, kind] of KINDS) {
  test(`followUpKind(${JSON.stringify(text)}) is ${kind}`, () => {
    assert.equal(policy.followUpKind(text), kind);
  });
}

test("informational questions close on a thank-you, from the requester or a helper", () => {
  for (const category of ["advice_how_to", "other", null, undefined, ""]) {
    const p = policy.closurePolicy({ category });
    assert.equal(p.auto, true);
    assert.equal(p.ackOk, true);
    assert.equal(p.minConfidence, 0.8);
    assert.deepEqual(p.evidenceRoles, ["requester", "helper"]);
    assert.equal(p.lastWord, true);
    assert.equal(p.needsHelper, false);
  }
});

test("troubleshooting needs an explicit confirmation from the requester", () => {
  for (const category of ["site_bug", "review", "some_custom_category"]) {
    const p = policy.closurePolicy({ category });
    assert.equal(p.auto, true);
    assert.equal(p.ackOk, false);
    assert.equal(p.minConfidence, 0.9);
    assert.deepEqual(p.evidenceRoles, ["requester"]);
    assert.equal(p.lastWord, false);
    assert.equal(p.needsHelper, false);
  }
});

test("account and fulfilment issues also need a human to have taken part", () => {
  for (const category of ["fulfillment_shipping", "account_access"]) {
    const p = policy.closurePolicy({ category });
    assert.equal(p.auto, true);
    assert.equal(p.ackOk, false);
    assert.equal(p.needsHelper, true);
    assert.equal(p.lastWord, false);
    assert.equal(p.minConfidence, 0.9);
  }
});

test("sensitive or disputed tickets are never closed automatically", () => {
  for (const category of ["advice_how_to", "fulfillment_shipping", null]) {
    const p = policy.closurePolicy({ category, sensitive: true });
    assert.equal(p.auto, false);
    assert.equal(p.lastWord, false);
  }
});
export {};
