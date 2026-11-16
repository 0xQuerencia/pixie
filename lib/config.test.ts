type TestAny = any;
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeBaseUrl,
  missingVars,
  isAdmin,
  config,
  zenStandby,
  nextZenApiKey,
  collectZenKeys,
  penalizeZenKey,
  nextHcaiApiKey,
  collectHcaiKeys,
  penalizeHcaiKey,
  nextGroqApiKey,
  collectGroqKeys,
  penalizeGroqKey,
  ZEN_BASE_URL,
  HCAI_BASE_URL,
  GROQ_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_GROQ_MODEL,
} = require("./config");

test("isAdmin denies everyone when no allowlist is configured", () => {
  const saved = config.slack.adminUserIds;
  config.slack.adminUserIds = [];
  try {
    assert.equal(isAdmin("U1"), false);
    assert.equal(isAdmin(undefined), false);
  } finally {
    config.slack.adminUserIds = saved;
  }
});

test("isAdmin allows only listed users", () => {
  const saved = config.slack.adminUserIds;
  config.slack.adminUserIds = ["U1", "U2"];
  try {
    assert.equal(isAdmin("U1"), true);
    assert.equal(isAdmin("U2"), true);
    assert.equal(isAdmin("U3"), false);
    assert.equal(isAdmin(""), false);
  } finally {
    config.slack.adminUserIds = saved;
  }
});

test("zenStandby is null when the call site already targets Zen", () => {
  assert.equal(zenStandby(ZEN_BASE_URL, "any-model"), null);
});

test("zenStandby names Zen and the given model for a self-hosted gateway", () => {
  const standby = zenStandby("http://9router.railway.internal:20128/v1", "deepseek-v4-flash-free");
  assert.equal(standby.baseUrl, ZEN_BASE_URL);
  assert.equal(standby.model, "deepseek-v4-flash-free");
});

test("the built-in model defaults are names Zen serves", () => {
  assert.ok(!DEFAULT_MODEL.includes("/"), `${DEFAULT_MODEL} is gateway-only`);
  assert.ok(!DEFAULT_VISION_MODEL.includes("/"), `${DEFAULT_VISION_MODEL} is gateway-only`);
});

test("normalizeBaseUrl falls back when unset", () => {
  assert.equal(normalizeBaseUrl(undefined, ZEN_BASE_URL), ZEN_BASE_URL);
  assert.equal(normalizeBaseUrl("", ZEN_BASE_URL), ZEN_BASE_URL);
});

test("normalizeBaseUrl strips a trailing slash", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1/", ZEN_BASE_URL), "https://example.com/v1");
});

test("normalizeBaseUrl tolerates a full chat/completions URL", () => {
  assert.equal(
    normalizeBaseUrl("https://opencode.ai/zen/v1/chat/completions", ZEN_BASE_URL),
    "https://opencode.ai/zen/v1",
  );
});

test("missingVars reports every absent required var at once", () => {
  const saved = { ...process.env };
  delete process.env.OPENCODE_API_KEY;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_HELP_CHANNEL;
  delete process.env.SLACK_FAQ_CHANNELS;

  try {
    const missing = missingVars({ needsSlack: true });
    assert.ok(missing.includes("OPENCODE_API_KEY"));
    assert.ok(missing.includes("SLACK_BOT_TOKEN"));
    assert.equal(missing.length, 5);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("collectZenKeys finds bare and numbered keys in order, filtering blanks", () => {
  const mockEnv = {
    OPENCODE_API_KEY_3: "key-3",
    OPENCODE_API_KEY: "key-1",
    OPENCODE_API_KEY_2: "key-2",
    OPENCODE_API_KEY_7: " key-7 ",
    OPENCODE_API_KEY_4: "",
    OTHER_VAR: "ignore",
  };
  const keys = collectZenKeys(mockEnv);
  assert.deepEqual(keys, ["key-1", "key-2", "key-3", "key-7"]);
});

test("nextZenApiKey skips a penalized key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    penalizeZenKey("key-a", 10000);
    assert.equal(nextZenApiKey(), "key-b");
    assert.equal(nextZenApiKey(), "key-b");
  } finally {
    config.zenApiKeys = saved;
    penalizeZenKey("key-a", 0);
  }
});

test("an all-cooling pool still returns a key rather than undefined", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    penalizeZenKey("key-a", 5000);
    penalizeZenKey("key-b", 10000);
    assert.equal(nextZenApiKey(), "key-a");
  } finally {
    config.zenApiKeys = saved;
    penalizeZenKey("key-a", 0);
    penalizeZenKey("key-b", 0);
  }
});

test("penalizeZenKey ignores non-pool keys", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a"];
  try {
    penalizeZenKey("9router-key", 10000);
    assert.equal(nextZenApiKey(), "key-a");
  } finally {
    config.zenApiKeys = saved;
  }
});

test("nextZenApiKey returns undefined with no keys configured", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = [];
  try {
    assert.equal(nextZenApiKey(), undefined);
  } finally {
    config.zenApiKeys = saved;
  }
});

test("nextZenApiKey always returns the only configured key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["solo-key"];
  try {
    assert.equal(nextZenApiKey(), "solo-key");
    assert.equal(nextZenApiKey(), "solo-key");
    assert.equal(nextZenApiKey(), "solo-key");
  } finally {
    config.zenApiKeys = saved;
  }
});

test("nextZenApiKey round-robins across every configured key", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    const first = nextZenApiKey();
    const second = nextZenApiKey();
    assert.notEqual(first, second);
    assert.ok(["key-a", "key-b"].includes(first));
    assert.ok(["key-a", "key-b"].includes(second));
  } finally {
    config.zenApiKeys = saved;
  }
});

test("default answer provider uses Zen credentials, custom router does not", () => {
  const saved = config.zenApiKeys;
  config.zenApiKeys = ["key-a", "key-b"];
  try {
    const getApiKey = (fnOrStr: TestAny) => (typeof fnOrStr === "function" ? fnOrStr() : fnOrStr);
    const key = getApiKey(config.answer.apiKey);
    if (process.env.PIXIE_ANSWER_BASE_URL) assert.ok(!["key-a", "key-b"].includes(key));
    else assert.ok(["key-a", "key-b"].includes(key));
  } finally {
    config.zenApiKeys = saved;
  }
});

test("config.answer has a real fallback, not null", () => {
  assert.notEqual(config.answer.fallback, null);
});

test("pingAnswer has a real fallback, not null", () => {
  assert.notEqual(config.pingAnswer.fallback, null);
});

test("collectHcaiKeys finds bare and numbered keys in order, filtering blanks", () => {
  const mockEnv = {
    HCAI_API_KEY_2: "hc-2",
    HCAI_API_KEY: "hc-1",
    HCAI_API_KEY_5: " hc-5 ",
    HCAI_API_KEY_3: "",
    OPENCODE_API_KEY: "ignore",
  };
  const keys = collectHcaiKeys(mockEnv);
  assert.deepEqual(keys, ["hc-1", "hc-2", "hc-5"]);
});

test("nextHcaiApiKey round-robins independently of the Zen pool", () => {
  const savedHcai = config.hcaiApiKeys;
  const savedZen = config.zenApiKeys;
  config.hcaiApiKeys = ["hc-a", "hc-b"];
  config.zenApiKeys = ["zen-a"];
  try {
    const first = nextHcaiApiKey();
    const second = nextHcaiApiKey();
    assert.notEqual(first, second);
    assert.ok(["hc-a", "hc-b"].includes(first));
    assert.equal(nextZenApiKey(), "zen-a");
  } finally {
    config.hcaiApiKeys = savedHcai;
    config.zenApiKeys = savedZen;
  }
});

test("penalizeHcaiKey skips a cooling key without touching the Zen pool's cooldown", () => {
  const savedHcai = config.hcaiApiKeys;
  const savedZen = config.zenApiKeys;
  config.hcaiApiKeys = ["hc-a", "hc-b"];
  config.zenApiKeys = ["hc-a"];
  try {
    penalizeHcaiKey("hc-a", 10000);
    assert.equal(nextHcaiApiKey(), "hc-b");
    assert.equal(nextHcaiApiKey(), "hc-b");
    assert.equal(nextZenApiKey(), "hc-a");
  } finally {
    config.hcaiApiKeys = savedHcai;
    config.zenApiKeys = savedZen;
    penalizeHcaiKey("hc-a", 0);
  }
});

test("HCAI_BASE_URL is a distinct endpoint from Zen's", () => {
  assert.notEqual(HCAI_BASE_URL, ZEN_BASE_URL);
  assert.equal(HCAI_BASE_URL, "https://ai.hackclub.com/proxy/v1");
});

test("collectGroqKeys finds bare and numbered keys in order, filtering blanks", () => {
  const mockEnv = {
    GROQ_API_KEY_2: "gsk-2",
    GROQ_API_KEY: "gsk-1",
    GROQ_API_KEY_5: " gsk-5 ",
    GROQ_API_KEY_3: "",
    OPENCODE_API_KEY: "ignore",
  };
  const keys = collectGroqKeys(mockEnv);
  assert.deepEqual(keys, ["gsk-1", "gsk-2", "gsk-5"]);
});

test("nextGroqApiKey round-robins independently of the Zen pool", () => {
  const savedGroq = config.groqApiKeys;
  const savedZen = config.zenApiKeys;
  config.groqApiKeys = ["groq-a", "groq-b"];
  config.zenApiKeys = ["zen-a"];
  try {
    const first = nextGroqApiKey();
    const second = nextGroqApiKey();
    assert.notEqual(first, second);
    assert.ok(["groq-a", "groq-b"].includes(first));
    assert.equal(nextZenApiKey(), "zen-a");
  } finally {
    config.groqApiKeys = savedGroq;
    config.zenApiKeys = savedZen;
  }
});

test("penalizeGroqKey skips a cooling key without touching other pools", () => {
  const savedGroq = config.groqApiKeys;
  config.groqApiKeys = ["groq-a", "groq-b"];
  try {
    penalizeGroqKey("groq-a", 10000);
    assert.equal(nextGroqApiKey(), "groq-b");
    assert.equal(nextGroqApiKey(), "groq-b");
  } finally {
    config.groqApiKeys = savedGroq;
    penalizeGroqKey("groq-a", 0);
  }
});

test("GROQ_BASE_URL is pointed at Groq OpenAI-compatible endpoint", () => {
  assert.equal(GROQ_BASE_URL, "https://api.groq.com/openai/v1");
});

test("missingVars ignores Slack vars when Slack is not needed", () => {
  const saved = { ...process.env };
  process.env.OPENCODE_API_KEY = "test-key";
  delete process.env.SLACK_BOT_TOKEN;

  try {
    assert.deepEqual(missingVars({ needsSlack: false }), []);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("validate fails closed listing every missing var at once", () => {
  const saved = { ...process.env };
  delete process.env.OPENCODE_API_KEY;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_APP_TOKEN;
  delete process.env.SLACK_HELP_CHANNEL;
  delete process.env.SLACK_FAQ_CHANNELS;
  const { validate } = require("./config");
  try {
    assert.throws(() => validate({ needsSlack: true }), /missing required environment variable/);
    assert.deepEqual(missingVars({ needsSlack: false }), ["OPENCODE_API_KEY"]);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("tier objects carry no secret strings — only thunks", () => {
  for (const tier of [config.answer, config.intent, config.vision, config.pingAnswer, config.helpAnswer]) {
    const blob = JSON.stringify(tier);
    assert.equal(/xoxb-/.test(blob), false, "slack token leaked into tier JSON");
    assert.equal(/sk-/.test(blob), false, "api key leaked into tier JSON");
  }
  assert.equal(typeof config.answer.apiKey, "function");
});

test("reportChannel defaults to null and never to a secret", () => {
  assert.ok(config.reportChannel === null || typeof config.reportChannel === "string");
  if (config.reportChannel) assert.equal(/xoxb-|sk-/.test(config.reportChannel), false);
});

test("refreshIntervalMin is a positive number", () => {
  assert.ok(Number.isFinite(config.refreshIntervalMin) && config.refreshIntervalMin > 0);
});
export {};


test("answer and ping provider defaults never require the old private Railway hostname", () => {
  assert.doesNotMatch(config.answer.baseUrl, /pixie\\.railway\\.internal/i);
  assert.doesNotMatch(config.pingAnswer.baseUrl, /pixie\\.railway\\.internal/i);
});
