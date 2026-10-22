const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const health = require("./providerHealth");

const err = (status?: number, code?: string) =>
  Object.assign(new Error("x"), { response: status ? { status } : undefined, code });
const realNow = Date.now;
let clock = 1_000_000;

beforeEach(() => {
  health.reset();
  clock = 1_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
});

async function fail(key: string, e: Error) {
  await assert.rejects(health.guard(key, async () => Promise.reject(e)));
}

test("auth and not-found failures open the circuit on the first call", async () => {
  for (const status of [401, 402, 403, 404]) {
    health.reset();
    await fail("p", err(status));
    assert.equal(health.isOpen("p"), true, String(status));
  }
});

test("transient failures need three in a row to open", async () => {
  await fail("p", err(503));
  await fail("p", err(undefined, "ECONNRESET"));
  assert.equal(health.isOpen("p"), false);
  await fail("p", err(429));
  assert.equal(health.isOpen("p"), true);
});

test("request-shape errors are not provider health signals", async () => {
  for (let i = 0; i < 5; i += 1) await fail("p", err(400));
  assert.equal(health.isOpen("p"), false);
});

test("an open circuit short-circuits without calling the provider", async () => {
  await fail("p", err(403));
  let calls = 0;
  await assert.rejects(
    health.guard("p", async () => {
      calls += 1;
    }),
    (e: { code?: string }) => e.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});

test("after the cooldown exactly one probe goes through and success closes the circuit", async () => {
  await fail("p", err(403));
  clock += health.BASE_COOLDOWN_MS + 1;
  let calls = 0;
  const first = health.guard("p", async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return "ok";
  });
  await assert.rejects(
    health.guard("p", async () => "second"),
    (e: { code?: string }) => e.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(await first, "ok");
  assert.equal(calls, 1);
  assert.equal(health.isOpen("p"), false);
  assert.equal(await health.guard("p", async () => "again"), "again");
});

test("a failed probe reopens with a longer cooldown, capped", async () => {
  await fail("p", err(403));
  clock += health.BASE_COOLDOWN_MS + 1;
  await fail("p", err(403));
  assert.equal(health.isOpen("p"), true);
  clock += health.BASE_COOLDOWN_MS + 1;
  assert.equal(health.isOpen("p"), true, "second cooldown is longer than the first");
  for (let i = 0; i < 12; i += 1) {
    clock += health.MAX_COOLDOWN_MS + 1;
    await fail("p", err(403));
  }
  clock += health.MAX_COOLDOWN_MS + 1;
  assert.equal(health.isOpen("p"), false, "cooldown never exceeds the cap");
});

test("keys are independent", async () => {
  await fail("a", err(403));
  assert.equal(health.isOpen("a"), true);
  assert.equal(health.isOpen("b"), false);
  assert.equal(await health.guard("b", async () => 1), 1);
});

test("one outage notice per thread until the provider recovers", async () => {
  assert.equal(health.noticeDue("t1"), true);
  health.markNotified("t1");
  assert.equal(health.noticeDue("t1"), false);
  assert.equal(health.noticeDue("t2"), true);
  clock += health.NOTICE_TTL_MS + 1;
  assert.equal(health.noticeDue("t1"), true);

  health.markNotified("t1");
  await fail("p", err(403));
  clock += health.BASE_COOLDOWN_MS + 1;
  await health.guard("p", async () => "ok");
  assert.equal(health.noticeDue("t1"), true, "recovery starts a new outage period");
});

test("isProviderFailure separates provider faults from our own bugs", () => {
  assert.equal(health.isProviderFailure(err(403)), true);
  assert.equal(health.isProviderFailure(err(503)), true);
  assert.equal(health.isProviderFailure(err(undefined, "ECONNABORTED")), true);
  assert.equal(health.isProviderFailure(new health.ProviderUnavailableError("p")), true);
  assert.equal(health.isProviderFailure(new TypeError("undefined is not a function")), false);
  assert.equal(health.isProviderFailure(err(400)), false);
});

export {};
