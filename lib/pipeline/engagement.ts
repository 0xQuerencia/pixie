const jevDecision = require("../jevDecision");
const intent = require("../intent");
const log = require("../log");
import type { ChannelRole } from "../types";

interface RecentMessage {
  text?: string;
  speaker?: string;
  userId?: string | null;
}
interface EngagementContext {
  message: string;
  program: unknown;
  userId?: string | null;
  channel?: string | null;
  addressed?: boolean;
  threadMessages?: unknown[];
  recentMessages?: RecentMessage[];
}
interface JEVResult {
  action?: string;
  errorKind?: string;
  intent?: string;
  decision?: { intent?: string };
  reason?: string;
  shouldEngageP?: number | null;
  latencyMs?: number;
  cached?: boolean;
}

function isIdentityOrSmalltalk(text: string) {
  const t = String(text || "")
    .replace(/^<@[^>]+>\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,]+$/g, "")
    .trim();
  if (!t) return false;
  if (/\bwho\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\bwhat\s*(are|r)\s*(u|you)\b/.test(t)) return true;
  if (/\b(your|ur)\s*name\b/.test(t)) return true;
  if (/\babout\s*(yourself|you|u)\b/.test(t)) return true;
  if (/\bwho\s*(made|created|built)\s*(you|u)\b/.test(t)) return true;
  if (/^(hi+|hello+|hey+|yo|sup|thanks?|thx|ty|gm|gn|morning)\b/.test(t) && t.split(/\s+/).length <= 3) return true;
  return false;
}

function postureFor(role: ChannelRole) {
  if (role === "help") return "help";
  if (role === "dm") return "dm";
  return "main";
}

function fromJev(res: JEVResult | null) {
  if (!res) return { engage: false, intent: null, error: "unknown", source: "jev" };
  const detail = {
    action: res.action ?? null,
    reason: res.reason ?? null,
    probability: res.shouldEngageP ?? null,
    latencyMs: res.latencyMs ?? null,
    cached: res.cached === true,
  };
  if (res.action === "error" || res.errorKind) {
    return { engage: false, intent: null, error: res.errorKind || "unknown", source: "jev", detail };
  }
  const intentName = res.intent || res.decision?.intent || null;
  return { engage: res.action === "engage", intent: intentName, error: null, source: "jev", detail };
}

async function fromLegacyIntent({
  message,
  program,
  userId,
  channel,
  addressed,
  threadMessages,
  recentMessages,
}: EngagementContext) {
  const result = await intent
    .classifyIntentContext(message, program, { userId, channel, addressed, threadMessages, recentMessages })
    .catch(() => null);
  if (!result) return { engage: false, intent: null, error: "unavailable", source: "intent" };
  if (result.directedAtHuman) return { engage: false, intent: "human_conversation", error: null, source: "intent" };
  if (result.verdict === intent.HELP_NEEDED)
    return { engage: true, intent: "support_question", error: null, source: "intent" };
  if (result.verdict === intent.OFF_TOPIC)
    return { engage: false, intent: "unrelated_chatter", error: null, source: "intent" };
  return {
    engage: false,
    intent: addressed ? "addressed_smalltalk" : "human_conversation",
    error: null,
    source: "intent",
  };
}

const RECENT_LINE_CHARS = 200;

function formatRecent(recentMessages: RecentMessage[] = [], userId: string | null | undefined) {
  return (recentMessages || [])
    .filter((m) => m && m.text)
    .map((m) => {
      const who = m.speaker === "pixie" ? "pixie" : userId && m.userId === userId ? "same sender" : "other member";
      return `${who}: ${String(m.text).replace(/\s+/g, " ").slice(0, RECENT_LINE_CHARS)}`;
    })
    .join("\n");
}

function conversationContextFor({
  threadContext,
  recentMessages,
  userId,
}: {
  threadContext?: string;
  recentMessages?: RecentMessage[];
  userId?: string | null;
}) {
  const recent = formatRecent(recentMessages, userId);
  return [recent && `Recent channel messages:\n${recent}`, threadContext && `Thread:\n${threadContext}`]
    .filter(Boolean)
    .join("\n\n");
}

interface ClassifyOptions extends EngagementContext {
  threadContext?: string;
  role: ChannelRole;
}

async function classify({
  message,
  threadContext = "",
  program,
  role,
  addressed = false,
  userId = null,
  channel = null,
  threadMessages = [],
  recentMessages = [],
}: ClassifyOptions) {
  if (addressed && isIdentityOrSmalltalk(message)) {
    return { engage: true, intent: "addressed_smalltalk", error: null, source: "heuristic" };
  }
  if (jevDecision.isEnabled()) {
    try {
      const res = await jevDecision.evaluateSupportDecision({
        message,
        conversationContext: conversationContextFor({ threadContext, recentMessages, userId }),
        program,
        channelPosture: postureFor(role),
        addressed,
      });
      if (res && res.action !== "existing") return fromJev(res);
    } catch (error: unknown) {
      log.debug("engagement", `jev threw: ${error instanceof Error ? error.name : "Error"}`);
      return { engage: false, intent: null, error: "unknown", source: "jev" };
    }
  }
  return fromLegacyIntent({ message, program, userId, channel, addressed, threadMessages, recentMessages });
}

export = { conversationContextFor, classify, isIdentityOrSmalltalk, fromJev };
