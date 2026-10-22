const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const llm = require("./llm");
const health = require("./providerHealth");
const jev = require("./jevDecision");

const realPost = axios.post;
const realNow = Date.now;
let posts = 0;
let clock = 5_000_000;

const OK = { data: { choices: [{ message: { content: "fine" }, finish_reason: "stop" }] } };
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { response: { status } });
const base = {
  baseUrl: "https://router.test/v1",
  apiKey: "k",
  model: "primary",
  maxTokens: 10,
  messages: [{ role: "user", content: "hi" }],
};

beforeEach(() => {
  health.reset();
  posts = 0;
  clock = 5_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  axios.post = realPost;
  Date.now = realNow;
});

test("a 403 is tried once, then later calls never reach the provider", async () => {
  axios.post = async () => {
    posts += 1;
    throw httpError(403);
  };
  await assert.rejects(llm.complete(base, "answer"));
  assert.equal(posts, 1, "non-retryable status is not retried");
  for (let i = 0; i < 9; i += 1) await assert.rejects(llm.complete(base, "answer"));
  assert.equal(posts, 1, "nine more calls made no provider request");
});

test("an open primary skips straight to its fallback", async () => {
  const seen: string[] = [];
  axios.post = async (_url: string, body: { model: string }) => {
    seen.push(body.model);
    if (body.model === "primary") throw httpError(403);
    return OK;
  };
  const withFallback = { ...base, fallback: { ...base, model: "backup" } };
  assert.equal((await llm.complete(withFallback, "answer")).text, "fine");
  assert.equal((await llm.complete(withFallback, "answer")).text, "fine");
  assert.deepEqual(seen, ["primary", "backup", "backup"]);
});

test("a 404 on both models surfaces one provider failure and then stops calling out", async () => {
  axios.post = async () => {
    posts += 1;
    throw httpError(404);
  };
  const withFallback = { ...base, fallback: { ...base, model: "backup" } };
  await assert.rejects(llm.complete(withFallback, "answer"));
  const after = posts;
  await assert.rejects(llm.complete(withFallback, "answer"), (e: unknown) => health.isProviderFailure(e));
  assert.equal(posts, after);
});

test("a 503 outage recovers through bounded backoff", async () => {
  let up = false;
  axios.post = async () => {
    posts += 1;
    if (!up) throw httpError(503);
    return OK;
  };
  for (let i = 0; i < 3; i += 1) await assert.rejects(llm.complete(base, "answer"));
  assert.equal(health.isOpen(llm.healthKey(base)), true);
  const frozen = posts;
  await assert.rejects(llm.complete(base, "answer"));
  assert.equal(posts, frozen);
  up = true;
  clock += health.BASE_COOLDOWN_MS + 1;
  assert.equal((await llm.complete(base, "answer")).text, "fine");
  assert.equal(health.isOpen(llm.healthKey(base)), false);
});

test("a missing credential (401) opens the circuit instead of retrying forever", async () => {
  axios.post = async () => {
    posts += 1;
    throw httpError(401);
  };
  await assert.rejects(llm.complete({ ...base, apiKey: () => undefined }, "answer"));
  await assert.rejects(llm.complete({ ...base, apiKey: () => undefined }, "answer"));
  assert.equal(posts, 1);
});

const JEV_CFG = {
  enabled: true,
  experientialApiKeyPresent: true,
  model: "jev-1.13-free",
  baseUrl: "https://jev.test/v1",
  timeoutMs: 50,
  engageThreshold: 0.7,
};
const msg = (n: number) => ({
  message: `how do I submit ${n}`,
  program: { id: "acme", name: "Acme" },
  channelPosture: "help",
});

async function jevWith(httpPost: unknown, n = 0) {
  process.env.JEV_API_KEY = "test";
  return jev.evaluateSupportDecision(msg(n), { config: JEV_CFG, httpPost, noTelemetry: true });
}

test("Jev auth failure is tried once and then short-circuited", async () => {
  let calls = 0;
  const post = async () => {
    calls += 1;
    return { status: 401, data: {} };
  };
  assert.equal((await jevWith(post, 1)).errorKind, "auth");
  for (let i = 2; i < 6; i += 1) assert.equal((await jevWith(post, i)).action, "error");
  assert.equal(calls, 1);
});

test("Jev malformed output three times opens the circuit; recovery after cooldown", async () => {
  let calls = 0;
  let good = false;
  const post = async () => {
    calls += 1;
    if (!good) return { status: 200, data: { not: "an evaluation" } };
    return {
      status: 200,
      data: {
        answers: {
          intent: { type: "choice", choice: "unrelated_chatter" },
          shouldEngage: { type: "noul", noul: 0.1 },
        },
      },
    };
  };
  for (let i = 0; i < 3; i += 1) assert.equal((await jevWith(post, 10 + i)).action, "error");
  const frozen = calls;
  assert.equal((await jevWith(post, 20)).action, "error");
  assert.equal(calls, frozen);
  good = true;
  clock += health.BASE_COOLDOWN_MS + 1;
  assert.equal((await jevWith(post, 21)).action, "silence");
});

test("Jev timeout is a transient failure, not an instant open", async () => {
  const post = async () => {
    throw Object.assign(new Error("timeout of 50ms exceeded"), { code: "ECONNABORTED" });
  };
  const first = await jevWith(post, 30);
  assert.equal(first.errorKind, "timeout");
  assert.equal(health.isOpen("jev"), false);
});

export {};
