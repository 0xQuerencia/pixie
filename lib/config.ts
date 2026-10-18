import dotenv = require("dotenv");
import type { WebClient } from "@slack/web-api";
import type { ProviderTier } from "./types";

interface KeyPoolState {
  index: number;
  now: number;
}
type RateLimitHandler = (key: string | undefined, ms?: number) => void;
dotenv.config();

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL = "deepseek-v4-flash-free";

const DEFAULT_VISION_MODEL = "mimo-v2.5-free";
const DEFAULT_REFRESH_INTERVAL_MIN = 30;

const NINE_ROUTER_BASE_URL = "http://pixie.railway.internal:20128/v1";
const ANSWER_FALLBACK_MODEL = "gc/gemini-3.1-flash-lite-preview";

const HCAI_BASE_URL = "https://ai.hackclub.com/proxy/v1";
const DEFAULT_HCAI_MODEL = "openrouter/free";
const DEFAULT_HCAI_VISION_MODEL = "xiaomi/mimo-v2-omni";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "qwen/qwen3.8-27b";
const DEFAULT_GROQ_INTENT_MODEL = "qwen/qwen3.8-27b";

const SLACK_VARS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_HELP_CHANNEL", "SLACK_FAQ_CHANNELS"];
const MODEL_VARS = ["OPENCODE_API_KEY"];

function stripTrailingSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function normalizeBaseUrl(url: string | undefined, fallback: string) {
  if (!url) return fallback;
  return stripTrailingSlash(url).replace(/\/chat\/completions$/, "");
}

const KEY_COOLDOWN_MS = 60 * 1000;
const coolingUntil = new Map();

function penalizeZenKey(key: string | undefined, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    coolingUntil.delete(key);
  } else if (config.zenApiKeys.includes(key)) {
    coolingUntil.set(key, Date.now() + ms);
  }
}

function scanPool(keys: string[], coolingUntil: Map<string, number>, state: KeyPoolState) {
  // One pool lap
  for (let i = 0; i < keys.length; i++) {
    const idx = state.index % keys.length;
    state.index += 1;
    const key = keys[idx];
    if (!key) continue;
    if (!((coolingUntil.get(key) || 0) > state.now)) return key;
  }
  return null;
}

function soonestRecovery(keys: string[], coolingUntil: Map<string, number>): string | undefined {
  return keys.reduce(
    (best: string, k: string) => ((coolingUntil.get(k) || 0) < (coolingUntil.get(best) || 0) ? k : best),
    keys[0],
  );
}

let zenKeyIndex = 0;
function nextZenApiKey() {
  const keys = config.zenApiKeys;
  if (!keys || keys.length === 0) return undefined;

  const state = { index: zenKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, coolingUntil, state);
  zenKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, coolingUntil);
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-2.5-flash";

function zenStandby(baseUrl: string, model = DEFAULT_MODEL): ProviderTier | null {
  // No self-fallback
  if (baseUrl === ZEN_BASE_URL) return null;
  return {
    baseUrl: ZEN_BASE_URL,
    apiKey: () => nextZenApiKey(),
    model: DEFAULT_MODEL,
  };
}

function standbyFallback(baseUrl: string, defaultZenModel = DEFAULT_MODEL): ProviderTier | null {
  if (baseUrl === OPENROUTER_BASE_URL) return zenStandby(baseUrl, defaultZenModel);
  if (baseUrl === ZEN_BASE_URL && !process.env.OPENROUTER_API_KEY) return null;

  if (process.env.OPENROUTER_API_KEY) {
    return {
      baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
      apiKey: () => process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      fallback: zenStandby(process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL, defaultZenModel),
    };
  }

  return zenStandby(baseUrl, defaultZenModel);
}

function parseChannels(raw: string | undefined) {
  return (raw || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

function positiveNumber(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFlag(raw: string | undefined, fallback = false) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return raw === "1" || String(raw).toLowerCase() === "true";
}

function probability(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

const JEV_BASE_URL = "https://api.experientiallabs.ai/v1/systemone";
const JEV_FREE_MODEL = "jev-latest:free";

function jevConfig() {
  return {
    enabled: envFlag(process.env.JEV_ENABLED, false),
    provider: "experiential",
    model: (process.env.JEV_MODEL || "").trim() || JEV_FREE_MODEL,
    baseUrl: (process.env.JEV_BASE_URL || JEV_BASE_URL).trim() || JEV_BASE_URL,
    timeoutMs: positiveNumber(process.env.JEV_TIMEOUT_MS, 8000),
    engageThreshold: probability(process.env.JEV_ENGAGE_THRESHOLD, 0.7),

    experientialApiKeyPresent: Boolean((process.env.JEV_API_KEY || process.env.EXPERIENTIAL_API_KEY || "").trim()),
  };
}

const faqChannels = parseChannels(process.env.SLACK_FAQ_CHANNELS);

const stagingOnlyChannels = parseChannels(process.env.PIXIE_STAGING_ONLY_CHANNELS);

const adminUserIds = parseChannels(process.env.PIXIE_ADMIN_USER_IDS);

const intentBaseUrl = normalizeBaseUrl(
  process.env.INTENT_CLASSIFIER_BASE_URL,
  process.env.GROQ_API_KEY ? GROQ_BASE_URL : ZEN_BASE_URL,
);
const visionBaseUrl = normalizeBaseUrl(
  process.env.PIXIE_VISION_BASE_URL || process.env.OPENCODE_BASE_URL,
  ZEN_BASE_URL,
);

function zenKeyOrder(name: string) {
  const m = name.match(/_(\d+)$/);
  return m ? Number(m[1]) : 1;
}

function collectNumberedKeys(env: NodeJS.ProcessEnv, prefix: string) {
  const pattern = new RegExp(`^${prefix}(_\\d+)?$`);
  return Object.keys(env)
    .filter((k) => pattern.test(k))
    .sort((a, b) => zenKeyOrder(a) - zenKeyOrder(b))
    .map((k) => (env[k] || "").trim())
    .filter(Boolean);
}

function collectZenKeys(env = process.env) {
  return collectNumberedKeys(env, "OPENCODE_API_KEY");
}

const zenApiKeys = collectZenKeys();

const hcaiCoolingUntil = new Map();
let hcaiKeyIndex = 0;

function penalizeHcaiKey(key: string | undefined, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    hcaiCoolingUntil.delete(key);
  } else if (config.hcaiApiKeys.includes(key)) {
    hcaiCoolingUntil.set(key, Date.now() + ms);
  }
}

function nextHcaiApiKey() {
  const keys = config.hcaiApiKeys;
  if (!keys || keys.length === 0) return undefined;

  const state = { index: hcaiKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, hcaiCoolingUntil, state);
  hcaiKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, hcaiCoolingUntil);
}

function collectHcaiKeys(env = process.env) {
  return collectNumberedKeys(env, "HCAI_API_KEY");
}

const hcaiApiKeys = collectHcaiKeys();

function hcaiTier(model: string): ProviderTier {
  return {
    apiKey: () => process.env.HCAI_API_KEY,
    baseUrl: HCAI_BASE_URL,
    model,
    onRateLimited: penalizeHcaiKey,
  };
}

function collectGroqKeys(env = process.env) {
  return collectNumberedKeys(env, "GROQ_API_KEY");
}

const groqApiKeys = collectGroqKeys();
const groqCoolingUntil = new Map();
let groqKeyIndex = 0;

function penalizeGroqKey(key: string | undefined, ms = KEY_COOLDOWN_MS) {
  if (!key) return;
  if (ms <= 0) {
    groqCoolingUntil.delete(key);
  } else {
    groqCoolingUntil.set(key, Date.now() + ms);
  }
}

function nextGroqApiKey() {
  const keys = config && config.groqApiKeys && config.groqApiKeys.length > 0 ? config.groqApiKeys : groqApiKeys;
  if (!keys || keys.length === 0) return process.env.GROQ_API_KEY || undefined;

  const state = { index: groqKeyIndex, now: Date.now() };
  const fresh = scanPool(keys, groqCoolingUntil, state);
  groqKeyIndex = state.index;
  if (fresh) return fresh;
  return soonestRecovery(keys, groqCoolingUntil);
}

const DEFAULT_PRIMARY_MODEL = "kr/claude-sonnet-4.5";
const DEFAULT_FALLBACK_MODEL = "ag/gemini-3.6-flash-low";

// Answers stay on Nine Router unless explicitly opened up
const allowOffRouter = process.env.PIXIE_ANSWER_ALLOW_FALLBACK === "1";

const nineRouterSecondaryFallbackTier = {
  apiKey: () => process.env.PIXIE_ANSWER_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL,
  fallback: allowOffRouter
    ? standbyFallback(normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL), DEFAULT_MODEL)
    : null,
};

const nineRouterAnswerTier = {
  apiKey: () => process.env.PIXIE_ANSWER_API_KEY || process.env.INTENT_CLASSIFIER_API_KEY || process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_MODEL || DEFAULT_PRIMARY_MODEL,
  fallback:
    allowOffRouter && process.env.OPENROUTER_API_KEY
      ? {
          apiKey: () => process.env.OPENROUTER_API_KEY,
          baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
          model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
          fallback: nineRouterSecondaryFallbackTier,
        }
      : nineRouterSecondaryFallbackTier,
};

const openRouterAnswerTier =
  allowOffRouter && process.env.OPENROUTER_API_KEY
    ? {
        apiKey: () => process.env.OPENROUTER_API_KEY,
        baseUrl: normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, OPENROUTER_BASE_URL),
        model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        fallback: nineRouterAnswerTier,
      }
    : nineRouterAnswerTier;

const nineRouterPingTier = {
  apiKey: () =>
    process.env.PIXIE_PING_API_KEY ||
    process.env.PIXIE_ANSWER_API_KEY ||
    process.env.INTENT_CLASSIFIER_API_KEY ||
    process.env.VISION_API_KEY,
  baseUrl: normalizeBaseUrl(process.env.PIXIE_PING_BASE_URL || process.env.PIXIE_ANSWER_BASE_URL, NINE_ROUTER_BASE_URL),
  model: process.env.PIXIE_PING_MODEL || process.env.PIXIE_MODEL || DEFAULT_PRIMARY_MODEL,
  fallback: openRouterAnswerTier,
};

const config = {
  zenApiKeys,
  hcaiApiKeys,
  groqApiKeys,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || null,

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    helpChannel: process.env.SLACK_HELP_CHANNEL,
    faqChannels,
    stagingOnlyChannels,
    autoReplyChannel: faqChannels[0] || null,
    botUserId: null as string | null,
    adminUserIds,
  },

  pingAnswer: nineRouterPingTier,
  helpAnswer: nineRouterAnswerTier,
  answer:
    process.env.PIXIE_ANSWER_PROVIDER === "hcai" && hcaiApiKeys.length > 0
      ? {
          apiKey: () => nextHcaiApiKey(),
          baseUrl: process.env.HCAI_BASE_URL || HCAI_BASE_URL,
          model: process.env.HCAI_MODEL || DEFAULT_HCAI_MODEL,
          onRateLimited: penalizeHcaiKey,
          fallback: nineRouterAnswerTier,
        }
      : nineRouterAnswerTier,
  intent: {
    apiKey: () => {
      if (process.env.INTENT_CLASSIFIER_API_KEY) return process.env.INTENT_CLASSIFIER_API_KEY;
      if (intentBaseUrl === GROQ_BASE_URL) return nextGroqApiKey();
      return nextZenApiKey();
    },
    baseUrl: intentBaseUrl,
    model:
      process.env.INTENT_CLASSIFIER_MODEL ||
      (intentBaseUrl === GROQ_BASE_URL ? process.env.GROQ_MODEL || DEFAULT_GROQ_INTENT_MODEL : DEFAULT_MODEL),
    fallback: standbyFallback(intentBaseUrl, DEFAULT_MODEL),
    onRateLimited: intentBaseUrl === GROQ_BASE_URL ? penalizeGroqKey : penalizeZenKey,
  },
  vision: {
    apiKey: () => process.env.VISION_API_KEY || nextZenApiKey(),
    baseUrl: visionBaseUrl,
    model: process.env.PIXIE_VISION_MODEL || DEFAULT_VISION_MODEL,
    fallback: standbyFallback(visionBaseUrl, DEFAULT_VISION_MODEL),
    onRateLimited: penalizeZenKey,
  },

  reportChannel: process.env.PIXIE_REPORT_CHANNEL || null,

  refreshIntervalMin: positiveNumber(process.env.REFRESH_INTERVAL_MIN, DEFAULT_REFRESH_INTERVAL_MIN),
  debug: process.env.PIXIE_DEBUG === "1" || process.env.PIXIE_DEBUG === "true",

  web: {
    baseUrl: process.env.PIXIE_WEB_BASE_URL || `http://localhost:${process.env.PIXIE_WEB_PORT || 4100}`,
  },

  escalateReaction: (process.env.PIXIE_ESCALATE_REACTION || "").replace(/:/g, "").trim() || null,

  ticketOpenReaction:
    process.env.PIXIE_TICKET_REACTION === ""
      ? null
      : (process.env.PIXIE_TICKET_REACTION || "ticket").replace(/:/g, "").trim() || null,
  ticketResolvedReaction:
    process.env.PIXIE_TICKET_REACTION === ""
      ? null
      : (process.env.PIXIE_TICKET_RESOLVED_REACTION || "white_check_mark").replace(/:/g, "").trim() || null,

  feedbackReactions: (process.env.PIXIE_FEEDBACK_REACTIONS ?? "")
    .split(",")
    .map((r) => r.replace(/:/g, "").trim())
    .filter(Boolean),

  jev: jevConfig(),
};

function missingVars({ needsSlack }: { needsSlack: boolean }) {
  const required = needsSlack ? [...MODEL_VARS, ...SLACK_VARS] : MODEL_VARS;
  return required.filter((name) => !process.env[name]);
}

function validate({ needsSlack = true }: { needsSlack?: boolean } = {}) {
  const missing = missingVars({ needsSlack });
  if (missing.length > 0) {
    throw new Error(
      `missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
        `see .env.example — copy it to .env and fill in the blanks`,
    );
  }
  return config;
}

async function resolveBotUserId(client: WebClient) {
  const auth = await client.auth.test();
  config.slack.botUserId = auth.user_id || null;
  return auth.user_id;
}

function isAdmin(userId: string | null | undefined) {
  // Fail closed
  return !!userId && config.slack.adminUserIds.includes(userId);
}

export = {
  config,
  jevConfig,
  validate,
  missingVars,
  isAdmin,
  resolveBotUserId,
  normalizeBaseUrl,
  zenStandby,
  standbyFallback,
  nextZenApiKey,
  collectZenKeys,
  zenKeyOrder,
  penalizeZenKey,
  nextHcaiApiKey,
  collectHcaiKeys,
  penalizeHcaiKey,
  nextGroqApiKey,
  collectGroqKeys,
  penalizeGroqKey,
  ZEN_BASE_URL,
  HCAI_BASE_URL,
  OPENROUTER_BASE_URL,
  GROQ_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_HCAI_MODEL,
  DEFAULT_HCAI_VISION_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_INTENT_MODEL,
  ANSWER_FALLBACK_MODEL,
};
