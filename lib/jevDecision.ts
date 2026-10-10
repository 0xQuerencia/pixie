import configModule = require("./config");
import log = require("./log");

const { config, jevConfig } = configModule;
interface JevConfig {
  enabled?: boolean;
  experientialApiKeyPresent?: boolean;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  engageThreshold?: number;
}
interface JevStateInput {
  message?: string;
  conversationContext?: string;
  program?: string | { id?: string; name?: string } | null;
  channelPosture?: string;
  addressed?: boolean;
}
interface JevState {
  message: string | undefined;
  conversationContext: string;
  program: { id: string | null; name: string | null };
  channelPosture: string;
  addressed: boolean;
}
interface ProviderAnswer {
  probability?: unknown;
  choice?: unknown;
  probabilities?: Record<string, unknown>;
}
interface ProviderResponse {
  answers?: { intent?: ProviderAnswer; shouldEngage?: ProviderAnswer };
}
interface Decision {
  intent: string | null;
  shouldEngage: boolean;
  confidence: Record<string, number | undefined>;
  probabilities: { shouldEngage?: number };
  source: string;
}
interface BoolResult {
  value: boolean;
  confidence?: number;
}
interface JevError {
  name?: string;
  message?: string;
  code?: string;
  status?: number | string;
  statusCode?: number | string;
  jevErrorKind?: string;
  response?: { status?: number | string };
}
interface EvaluationArgs {
  state: JevState | unknown;
  questions: object | unknown;
  timeoutMs?: number;
  model: string;
}
type EvaluateFn = (args: EvaluationArgs) => Promise<unknown>;
interface EvaluationDeps {
  config?: JevConfig;
  model?: string;
  questions?: object;
  evaluateFn?: EvaluateFn;
  httpPost?: unknown;
  timeoutMs?: number;
  noTelemetry?: boolean;
}
interface SupportInput extends JevStateInput {}
interface SupportOutcome {
  action: string;
  intent: string | null;
  shouldEngageP: number | null;
  reason: string;
  latencyMs: number;
  errorKind: string | null;
  cached?: boolean;
}

const JEV_MODEL_DEFAULT = "jev-latest:free";
const JEV_BASE_URL_DEFAULT = "https://api.experientiallabs.ai/v1/systemone";
const MAX_MESSAGE_CHARS = 1000;
const MAX_CONTEXT_CHARS = 1500;

function truncate(text: string, max: number): string {
  const s = String(text || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

function effectiveConfig(): JevConfig {
  try {
    const live = typeof jevConfig === "function" ? jevConfig() : null;
    if (live) return live;
  } catch (_) {}
  return config.jev;
}

function providerOf() {
  return "experiential";
}

function providerKeyPresent(cfg = effectiveConfig()) {
  if (!cfg) return false;
  return Boolean(cfg.experientialApiKeyPresent);
}

function isEnabled(cfg = effectiveConfig()) {
  return Boolean(cfg && cfg.enabled && providerKeyPresent(cfg));
}

function isFreeModel(model: unknown): boolean {
  return typeof model === "string" && /[:-]free$/.test(model.trim());
}

function buildJevState({
  message,
  conversationContext = "",
  program,
  channelPosture = "main",
  addressed = false,
}: JevStateInput): JevState {
  const prog =
    program && typeof program === "object"
      ? { id: program.id || null, name: program.name || null }
      : { id: typeof program === "string" ? program : null, name: null };
  const posture = channelPosture === "help" || channelPosture === "dm" ? channelPosture : "main";
  return {
    message: truncate(message!, MAX_MESSAGE_CHARS),
    conversationContext: truncate(conversationContext, MAX_CONTEXT_CHARS),
    program: prog,
    channelPosture: posture,
    addressed: Boolean(addressed),
  };
}

const INTENT_CHOICES = {
  support_question: "A clear request for program help or a factual program/support question.",
  direct_program_question:
    "A clear question about the program, its process, policy, grants, shipping, submissions, or participation.",
  addressed_general_request:
    "Addressed to Pixie but not about the program, e.g. a recipe, a joke, or a general question.",
  addressed_smalltalk: "The sender directly addresses Pixie for greeting, thanks, or light conversation.",
  ambiguous_followup: "A follow-up whose meaning depends on a clear recent or thread referent.",
  unrelated_chatter: "A reaction, joke, unrelated chat, or message Pixie should not enter.",
  human_conversation:
    "Humans talking to each other rather than asking Pixie for help, including a statement that replies to or continues an earlier member message.",
};

function buildJevQuestions() {
  return {
    intent: {
      type: "choice",
      instructions: [
        "You route messages for Pixie, the support assistant of one Hack Club program (named in state.program). Classify what kind of message this is; never judge whether Pixie knows the answer — later steps check the docs.",
        "state.channelPosture: 'main' is the program's own community channel (mostly members chatting); 'help' is its support channel; 'dm' is a private message. state.addressed is true when the sender @mentioned or named Pixie.",
        "In a main or help channel, a genuine information-seeking question (what / how / when / where / can I / does / is there ...) about how something works, a term, a rule, a deadline, rewards, shipping, submissions, hardware, or participation is a program question EVEN IF you do not recognize the term: unfamiliar nouns in a program channel are almost always program-specific concepts.",
        "Questions one member asks another about their own life or project ('did you finish your game?', 'when did yours arrive?') are human_conversation. Reactions, jokes and banter ('lmao gg', 'that's insane') are unrelated_chatter.",
        "If addressed and the request is not about the program (a recipe, a joke, general knowledge), choose addressed_general_request; greetings/thanks to Pixie are addressed_smalltalk.",
        "A vague follow-up ('how do i do this', 'what about that') is ambiguous_followup; it only deserves engagement when state.conversationContext makes the referent clear.",
        "Read state.conversationContext (the channel's recent messages and any thread) before classifying. A statement or fragment that continues or answers an earlier member message ('it expires tomorrow', 'yeah same', 'mine arrived monday', 'nvm got it') is human_conversation, even when it mentions a program term. A statement is not a program question unless it describes a problem the sender needs help with.",
      ].join(" "),
      criteria: INTENT_CHOICES,
    },
    shouldEngage: {
      type: "boolean",
      instructions:
        "Should Pixie look this up in the program's docs? True for program questions and support requests (including unfamiliar program terms), for any request addressed to Pixie, and for a follow-up whose referent is clear from state.conversationContext. False for banter, reactions, members talking to each other, statements that reply to an earlier member message, and vague follow-ups with no clear referent. Do not consider whether the docs contain the answer.",
      criteria: {
        true: "Program/support question, addressed request, or follow-up with a clear referent.",
        false: "Chatter, human conversation, or a vague follow-up without a referent.",
      },
    },
  };
}

function probOf(answer: ProviderAnswer | null | undefined): number | null {
  const p = answer && typeof answer.probability === "number" ? answer.probability : null;
  return typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : null;
}

function boolFrom(answer: ProviderAnswer | null | undefined): BoolResult {
  const p = probOf(answer);
  if (p === null) return { value: false, confidence: undefined };
  return { value: p >= 0.5, confidence: p >= 0.5 ? p : 1 - p };
}

function parseEvaluationResult(result: ProviderResponse): Decision {
  const answers = (result && result.answers) || {};
  const engage = boolFrom(answers.shouldEngage);
  const engageProbability = probOf(answers.shouldEngage);
  const intent =
    answers.intent && typeof answers.intent.choice === "string" && Object.hasOwn(INTENT_CHOICES, answers.intent.choice)
      ? answers.intent.choice
      : null;
  return {
    intent,
    shouldEngage: engage.value,
    confidence: {
      ...(engage.confidence !== undefined ? { shouldEngage: engage.confidence } : {}),
      ...(answers.intent ? { intent: maxProb(answers.intent.probabilities) } : {}),
    },
    probabilities: engageProbability === null ? {} : { shouldEngage: engageProbability },
    source: "jev",
  };
}

function maxProb(probs: Record<string, unknown> | undefined): number | undefined {
  if (!probs || typeof probs !== "object") return undefined;
  const vals = Object.values(probs).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return vals.length > 0 ? Math.max(...vals) : undefined;
}

function fallbackDecision() {
  return {
    intent: null,
    shouldEngage: false,
    confidence: {},
    probabilities: {},
    source: "fallback",
  };
}

const PROGRAM_INTENT = new Set(["support_question", "direct_program_question"]);
const ADDRESSED_INTENT = new Set(["addressed_general_request", "addressed_smalltalk"]);
const SILENT_INTENT = new Set(["unrelated_chatter", "human_conversation"]);

function decideAction(
  decision: Decision,
  cfg: JevConfig = effectiveConfig(),
  state: Partial<JevState> = {},
): { action: string; reason: string } {
  if (!decision || decision.source === "existing") return { action: "existing", reason: "jev_disabled" };
  const engageP = decision.probabilities?.shouldEngage;
  const intent = decision.intent;
  if (intent && PROGRAM_INTENT.has(intent)) return { action: "engage", reason: "jev_program_intent" };
  if (intent && ADDRESSED_INTENT.has(intent)) {
    return state.addressed
      ? { action: "engage", reason: "jev_addressed" }
      : { action: "silence", reason: "jev_unaddressed_general" };
  }
  if (intent && SILENT_INTENT.has(intent)) return { action: "silence", reason: "jev_chatter" };
  if (intent === "ambiguous_followup") {
    const hasContext = Boolean(String(state.conversationContext || "").trim());
    return hasContext && engageP !== undefined && engageP >= 0.5
      ? { action: "engage", reason: "jev_followup_with_referent" }
      : { action: "silence", reason: "jev_followup_no_referent" };
  }
  const threshold = Number.isFinite(cfg.engageThreshold) ? (cfg.engageThreshold as number) : 0.7;
  if (decision.shouldEngage && engageP !== undefined && engageP >= threshold)
    return { action: "engage", reason: "jev_engage" };
  return { action: "silence", reason: "jev_deny" };
}

const ERROR_KINDS = new Set([
  "auth",
  "quota",
  "rate_limit",
  "timeout",
  "bad_response",
  "unavailable",
  "network",
  "config",
  "unknown",
]);

function classifyError(err: JevError | null | undefined): string {
  if (!err) return "unknown";
  if (err.jevErrorKind && ERROR_KINDS.has(err.jevErrorKind)) return err.jevErrorKind;
  if (err.jevErrorKind === "provider") return "unavailable";
  if (err.jevErrorKind === "other") return "unknown";
  if (err.name === "AbortError" || /abort|timeout|timed out/i.test(err.message || "")) return "timeout";
  if (/rate.?limit/i.test(`${err.name || ""} ${err.message || ""}`)) return "rate_limit";
  const status = err.status || err.statusCode || err.response?.status;
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (Number(status) >= 500) return "unavailable";
  if (/network|fetch|socket|econn|enotfound|eai_again/i.test(err.message || "") || err.code) {
    if (!status) return "network";
  }
  if (/parse|valid|schema|unsupported/i.test(err.message || "")) return "bad_response";
  if (/api key/i.test(err.message || "")) return "auth";
  return "unknown";
}

const decisionCache = new Map();
const inflightEvaluations = new Map();
const jevStats = { calls: 0, cacheHits: 0 };

function jevCacheTtlMs() {
  const n = Number(process.env.JEV_CACHE_TTL_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return 120 * 1000;
}

function experientialApiKey() {
  return (process.env.JEV_API_KEY || process.env.EXPERIENTIAL_API_KEY || "").trim() || null;
}

function cacheKeyFor({ model, state }: { model: string; state: JevState }): string {
  const fingerprint = JSON.stringify({
    model,
    message: state.message,
    conversationContext: state.conversationContext,
    program: state.program,
    channelPosture: state.channelPosture,
    addressed: state.addressed,
  });
  return require("crypto").createHash("sha256").update(fingerprint).digest("hex");
}

function getStats() {
  return { ...jevStats };
}

function clearDecisionCache() {
  decisionCache.clear();
  inflightEvaluations.clear();
}

function telemetryEnabled(noTelemetry = false) {
  const llm = require("./llm");
  return !noTelemetry && !(typeof llm.telemetrySuppressed === "function" && llm.telemetrySuppressed());
}

function logDecision({
  intent,
  shouldEngageP,
  action,
  reason,
  latencyMs,
  errorKind,
  enabled,
  model,
  keyHash,
}: {
  intent: string | null;
  shouldEngageP: number | null;
  action: string;
  reason: string;
  latencyMs: number;
  errorKind: string | null;
  enabled: boolean;
  model: string;
  keyHash?: string | null;
}): void {
  const fmt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "?");
  log.info(
    "jev",
    `[jev] enabled=${enabled} provider=experiential model=${model || "?"} jev_intent=${intent || "?"} ` +
      `jev_should_engage=${fmt(shouldEngageP)} final_action=${action} reason=${reason} latency_ms=${latencyMs}` +
      `${errorKind ? ` error=${errorKind}` : ""}${keyHash ? ` key=${keyHash}` : ""}`,
  );
}

async function evaluateSupportDecision(
  { message, conversationContext = "", program = null, channelPosture = "main", addressed = false }: SupportInput = {},
  deps: EvaluationDeps = {},
): Promise<SupportOutcome> {
  const cfg = deps.config || effectiveConfig();
  const startedAt = Date.now();
  if (!isEnabled(cfg)) {
    return {
      action: "existing",
      intent: null,
      shouldEngageP: null,
      reason: "jev_disabled",
      latencyMs: Date.now() - startedAt,
      errorKind: null,
    };
  }
  const model = deps.model || cfg.model || JEV_MODEL_DEFAULT;
  // fail-closed billing
  if (!isFreeModel(model)) {
    const latencyMs = Date.now() - startedAt;
    logDecision({
      intent: null,
      shouldEngageP: null,
      action: "error",
      reason: "jev_error_config",
      latencyMs,
      errorKind: "config",
      enabled: true,
      model,
    });
    return {
      action: "error",
      intent: null,
      shouldEngageP: null,
      reason: "jev_error_config",
      latencyMs,
      errorKind: "config",
    };
  }
  const state = buildJevState({ message, conversationContext, program, channelPosture, addressed });
  const questions = deps.questions || buildJevQuestions();
  const evaluateFn: EvaluateFn =
    deps.evaluateFn ||
    ((args: EvaluationArgs) =>
      require("./jevExperiential").experientialEvaluate(
        {
          baseUrl: cfg.baseUrl || JEV_BASE_URL_DEFAULT,
          apiKey: experientialApiKey(),
          model: args.model,
          state: args.state,
          questions: args.questions,
          timeoutMs: args.timeoutMs,
        },
        { httpPost: deps.httpPost },
      ));
  const cacheable = !deps.evaluateFn && !deps.questions;
  const key = cacheable ? cacheKeyFor({ model, state }) : null;
  const keyHash = key ? key.slice(0, 12) : null;
  if (key) {
    const hit = decisionCache.get(key);
    // cache side effects
    if (hit && hit.expiresAt > Date.now()) {
      jevStats.cacheHits += 1;
      if (telemetryEnabled(deps.noTelemetry)) {
        try {
          require("./db").recordMetric("jev_cache_hit", 0, hit.result.action || null, state.program?.id || null);
        } catch (_) {}
      }
      log.info(
        "jev",
        `[jev] cached=true action=${hit.result.action} reason=${hit.result.reason}${keyHash ? ` key=${keyHash}` : ""}`,
      );
      return { ...hit.result, latencyMs: 0, cached: true };
    }
    // shared in-flight promise
    if (inflightEvaluations.has(key)) return inflightEvaluations.get(key);
  }
  const run = (async () => {
    try {
      const result = await evaluateFn({
        state,
        questions,
        timeoutMs: deps.timeoutMs || cfg.timeoutMs,
        model,
      });
      const decision = parseEvaluationResult(result as ProviderResponse);
      const { action, reason } = decideAction(decision, cfg, state);
      const latencyMs = Date.now() - startedAt;
      const probability = decision.probabilities?.shouldEngage;
      const shouldEngageP = typeof probability === "number" && Number.isFinite(probability) ? probability : null;
      logDecision({
        intent: decision.intent,
        shouldEngageP,
        action,
        reason,
        latencyMs,
        errorKind: null,
        enabled: true,
        model,
        keyHash,
      });
      if (telemetryEnabled(deps.noTelemetry)) {
        try {
          require("./db").recordMetric("jev_decision", latencyMs, `${action}:${reason}`, state.program?.id || null);
        } catch (_) {}
      }
      const outcome = { action, intent: decision.intent, shouldEngageP, reason, latencyMs, errorKind: null };
      if (key) {
        jevStats.calls += 1;
        decisionCache.set(key, { expiresAt: Date.now() + jevCacheTtlMs(), result: outcome });
      }
      return outcome;
    } catch (err) {
      throw err;
    } finally {
      if (key) inflightEvaluations.delete(key);
    }
  })();
  if (key) inflightEvaluations.set(key, run);
  try {
    return await run;
  } catch (err) {
    const errorKind = classifyError(err as JevError);
    const latencyMs = Date.now() - startedAt;
    const reason = `jev_error_${errorKind}`;
    logDecision({
      intent: null,
      shouldEngageP: null,
      action: "error",
      reason,
      latencyMs,
      errorKind,
      enabled: true,
      model,
      keyHash,
    });
    if (telemetryEnabled(deps.noTelemetry)) {
      try {
        require("./db").recordMetric("jev_error", latencyMs, errorKind, state.program?.id || null);
      } catch (_) {}
    }
    return { action: "error", intent: null, shouldEngageP: null, reason, latencyMs, errorKind };
  }
}

async function evaluateCustomDecision(
  { state, questions }: { state?: unknown; questions?: object } = {},
  deps: EvaluationDeps = {},
): Promise<{ status: string; latencyMs: number; result?: unknown; errorKind?: string }> {
  const cfg = deps.config || effectiveConfig();
  const startedAt = Date.now();
  if (!isEnabled(cfg)) return { status: "disabled", latencyMs: Date.now() - startedAt };

  const model = deps.model || cfg.model || JEV_MODEL_DEFAULT;
  if (!isFreeModel(model)) {
    return { status: "error", errorKind: "config", latencyMs: Date.now() - startedAt };
  }

  const evaluateFn: EvaluateFn =
    deps.evaluateFn ||
    ((args: EvaluationArgs) =>
      require("./jevExperiential").experientialEvaluate(
        {
          baseUrl: cfg.baseUrl || JEV_BASE_URL_DEFAULT,
          apiKey: experientialApiKey(),
          model: args.model,
          state: args.state,
          questions: args.questions,
          timeoutMs: args.timeoutMs,
        },
        { httpPost: deps.httpPost },
      ));

  try {
    const result = await evaluateFn({
      state,
      questions,
      timeoutMs: deps.timeoutMs || cfg.timeoutMs,
      model,
    });
    const latencyMs = Date.now() - startedAt;
    log.info("jev", `[jev] task=custom status=ok latency_ms=${latencyMs}`);
    return { status: "ok", result, latencyMs };
  } catch (err) {
    const errorKind = classifyError(err as JevError);
    const latencyMs = Date.now() - startedAt;
    log.info("jev", `[jev] task=custom status=error error=${errorKind} latency_ms=${latencyMs}`);
    return { status: "error", errorKind, latencyMs };
  }
}

export = {
  evaluateSupportDecision,
  evaluateCustomDecision,
  providerOf,
  providerKeyPresent,
  experientialApiKey,
  isFreeModel,
  getStats,
  clearDecisionCache,
  buildJevState,
  buildJevQuestions,
  parseEvaluationResult,
  decideAction,
  isEnabled,
  effectiveConfig,
  fallbackDecision,
  classifyError,
  JEV_MODEL_DEFAULT,
  JEV_BASE_URL_DEFAULT,
  MAX_MESSAGE_CHARS,
  MAX_CONTEXT_CHARS,
  INTENT_CHOICES,
};
