const db = require("./db");
const log = require("./log");
const supportMemory = require("./supportMemory");
import type { SlackClient } from "./types";

interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  user_id: string | null;
}
interface ThreadScope {
  channel?: string | null;
  workspace?: string | null;
}
type ThreadScopeInput = string | ThreadScope | null;
interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
}
interface ThreadRow {
  seeded?: boolean;
  pixie_spoke?: boolean;
}
interface TopicRow {
  topic: string;
  was_helpful: boolean;
}
interface RecentMessage {
  text: string;
  speaker: "pixie" | "human";
  userId: string | null;
}

const SEED_LIMIT = 30;
const INTENT_CONTEXT_LIMIT = 8;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARS = 4000;
const LEGACY_THREAD_SCOPE = "legacy";
const transientThreads = new Map<string, Map<string, ThreadMessage[]>>();

function scopeKey(scope: ThreadScopeInput): string {
  if (typeof scope === "string") return JSON.stringify(["channel", scope]);
  if (scope && typeof scope === "object") {
    return JSON.stringify(["workspace", scope.workspace || null, "channel", scope.channel || null]);
  }
  return LEGACY_THREAD_SCOPE;
}

function hasExplicitScope(scope: ThreadScopeInput): boolean {
  return typeof scope === "string" || Boolean(scope && typeof scope === "object");
}

function threadRows(threadTs: string, scope: ThreadScopeInput = null): ThreadMessage[] {
  const scopes = transientThreads.get(threadTs);
  if (!scopes) return [];
  if (hasExplicitScope(scope)) return scopes.get(scopeKey(scope)) || [];
  const legacy = scopes.get(LEGACY_THREAD_SCOPE);
  if (legacy) return legacy;
  const scopedRows = [...scopes.entries()]
    .filter(([key, rows]) => key !== LEGACY_THREAD_SCOPE && rows.length > 0)
    .map(([, rows]) => rows);
  return scopedRows.length === 1 ? scopedRows[0] : [];
}

function addToThread(
  threadTs: string,
  role: ThreadMessage["role"],
  content: string,
  userId: string | null = null,
  channelOrScope: ThreadScopeInput = null,
  workspace: string | null = null,
) {
  if (!threadTs) return;
  const scope = workspace
    ? {
        channel: typeof channelOrScope === "string" ? channelOrScope : channelOrScope?.channel,
        workspace,
      }
    : channelOrScope;
  const key = scopeKey(scope);
  const scopes = transientThreads.get(threadTs) || new Map<string, ThreadMessage[]>();
  const rows = scopes.get(key) || [];
  rows.push({ role, content, user_id: userId });
  if (rows.length > MAX_CONTEXT_MESSAGES * 3) rows.splice(0, rows.length - MAX_CONTEXT_MESSAGES * 3);
  scopes.set(key, rows);
  transientThreads.set(threadTs, scopes);
  const channel = typeof scope === "string" ? scope : scope?.channel || null;
  db.touchThread(threadTs, channel, { pixieSpoke: role === "assistant" });
}

function contextTokens(text: string): Set<string> {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((word: string) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function selectContextMessages(messages: ThreadMessage[], currentQuestion: string | null = null): ThreadMessage[] {
  const lastMessage = messages.at(-1);
  const questionAlreadyStored =
    currentQuestion && lastMessage?.role === "user" && lastMessage.content === currentQuestion;
  const candidates =
    currentQuestion && !questionAlreadyStored
      ? [...messages, { role: "user" as const, content: currentQuestion, user_id: null }]
      : messages;
  if (candidates.length <= MAX_CONTEXT_MESSAGES) return candidates;

  const latestQuestionIndex = [...candidates]
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user")
    .at(-1)?.index;
  const question =
    currentQuestion || (latestQuestionIndex === undefined ? "" : candidates[latestQuestionIndex]?.content || "");
  const questionTokens = contextTokens(question);
  const selected = new Set<number>();

  if (latestQuestionIndex !== undefined) {
    selected.add(latestQuestionIndex);
    if (latestQuestionIndex > 0 && messages[latestQuestionIndex - 1]?.role === "assistant") {
      selected.add(latestQuestionIndex - 1);
    }
  }

  const ranked = candidates
    .map((message, index) => ({
      index,
      score: overlap(contextTokens(message.content), questionTokens) * 10 + index / messages.length,
    }))
    .filter(({ index }) => !selected.has(index))
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, MAX_CONTEXT_MESSAGES);

  for (const { index } of ranked) {
    if (selected.size >= MAX_CONTEXT_MESSAGES) break;
    const adjacentAssistant =
      candidates[index].role === "user"
        ? [index - 1, index + 1].find((neighbor) => candidates[neighbor]?.role === "assistant")
        : undefined;
    if (
      selected.size + (adjacentAssistant !== undefined && !selected.has(adjacentAssistant) ? 2 : 1) >
      MAX_CONTEXT_MESSAGES
    )
      continue;
    selected.add(index);
    if (adjacentAssistant !== undefined) {
      selected.add(adjacentAssistant);
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .reduce<{ message: ThreadMessage; rendered: string }[]>((result, index) => {
      const message = candidates[index];
      const rendered = `${message.role}: ${message.content}`;
      const currentLength = result.reduce((length, item) => length + item.rendered.length + 1, 0);
      if (currentLength + rendered.length <= MAX_CONTEXT_CHARS || result.length === 0) {
        result.push({ message, rendered });
      }
      return result;
    }, [])
    .map(({ message }) => message);
}

function getThreadContext(
  threadTs: string,
  currentQuestionOrScope: string | ThreadScope | null = null,
  channelOrScope: ThreadScopeInput = null,
) {
  const currentQuestion = typeof currentQuestionOrScope === "string" ? currentQuestionOrScope : null;
  const scope =
    currentQuestionOrScope && typeof currentQuestionOrScope === "object" ? currentQuestionOrScope : channelOrScope;
  const messages = threadRows(threadTs, scope);
  if (messages.length === 0) return null;
  return selectContextMessages(messages, currentQuestion)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function getThreadMessages(
  threadTs: string,
  limitOrScope: number | ThreadScopeInput = 8,
  channelOrScope: ThreadScopeInput = null,
) {
  if (!threadTs) return [];
  const limit = typeof limitOrScope === "number" ? limitOrScope : 8;
  const scope = typeof limitOrScope === "number" ? channelOrScope : limitOrScope;
  return threadRows(threadTs, scope)
    .slice(-limit)
    .map((message) => ({
      text: message.content,
      speaker: message.role === "assistant" ? "pixie" : "human",
    }));
}

function roleForMessage(message: SlackMessage, botUserId: string) {
  return message.user === botUserId || message.bot_id ? "assistant" : "user";
}

function hasSpokenInThread(threadTs: string) {
  return !!db.getThread(threadTs)?.pixie_spoke;
}

async function seedFromSlack(
  client: SlackClient,
  channel: string,
  threadTs: string,
  botUserId: string,
  currentTs: string | null = null,
  workspace: string | null = null,
) {
  const existing = db.getThread(threadTs);
  const scope = workspace ? { channel, workspace } : channel;
  if (existing?.seeded && threadRows(threadTs, scope).length) return;

  db.touchThread(threadTs, channel, { seeded: true });

  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: SEED_LIMIT });
    const messages = res.messages || [];
    for (const m of messages) {
      if (currentTs && m.ts === currentTs) continue;
      const text = (m.text || "").trim();
      if (!text) continue;
      addToThread(threadTs, roleForMessage(m, botUserId), text, m.user || null, scope);
    }
    log.debug("context", `seeded thread ${threadTs} with ${messages.length} messages`);
  } catch (error: unknown) {
    log.debug(
      "context",
      `could not seed thread ${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function threadCrowd(messages: SlackMessage[], userId: string, botUserId: string) {
  let pixieIn = false;
  let othersPresent = false;
  for (const m of messages) {
    if (roleForMessage(m, botUserId) === "assistant") pixieIn = true;
    else if (m.user && m.user !== userId) othersPresent = true;
  }
  return { pixieIn, othersPresent };
}

const CROWD_CHECK_LIMIT = 200;

async function fetchThreadCrowd(
  client: SlackClient,
  {
    channel,
    threadTs,
    messageTs,
    userId,
    botUserId,
    parentUserId = null,
  }: {
    channel: string;
    threadTs: string;
    messageTs: string;
    userId: string;
    botUserId: string;
    parentUserId?: string | null;
  },
) {
  const fallback = {
    pixieIn: false,
    othersPresent: Boolean(parentUserId && parentUserId !== userId && parentUserId !== botUserId),
  };
  if (!client?.conversations?.replies || !threadTs || !messageTs) return fallback;
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: CROWD_CHECK_LIMIT });
    const before = (res.messages || []).filter((m) => Number(m.ts) < Number(messageTs));
    return threadCrowd(before, userId, botUserId);
  } catch (error: unknown) {
    log.debug("context", `thread crowd check failed: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function recentChannelMessages(
  client: SlackClient,
  channel: string,
  latestTs: string,
  botUserId: string,
  limit = INTENT_CONTEXT_LIMIT,
): Promise<RecentMessage[]> {
  if (!client?.conversations?.history || !channel) return [];
  try {
    const result = await client.conversations.history({
      channel,
      latest: latestTs,
      inclusive: false,
      limit,
    });
    return (result.messages || [])
      .reverse()
      .map((message) => ({
        text: (message.text || "").trim(),
        speaker: (roleForMessage(message, botUserId) === "assistant" ? "pixie" : "human") as "pixie" | "human",
        userId: message.user || null,
      }))
      .filter((message) => message.text);
  } catch (error: unknown) {
    log.debug(
      "context",
      `could not fetch recent channel context: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

const STOPWORDS = new Set(
  (
    "a an the is are was were do does did how what when where why who which can could should would will i you my me" +
    " to of in on for with and or but if it its this that these those get got have has had am be been im ive dont" +
    " cant whats hows pls plz help there here about from any some so just like need want know"
  ).split(" "),
);

const MAX_TOPIC_WORDS = 5;

function deriveTopic(question: string) {
  const words = (question || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w: string) => w.length > 2 && !STOPWORDS.has(w));

  const topic = [...new Set(words)].slice(0, MAX_TOPIC_WORDS).join(" ");
  return topic || (question || "").slice(0, 40).trim();
}

function updateUserHistory(userId: string, question: string, wasHelpful = true) {
  const topic = deriveTopic(question);
  if (topic) db.recordTopic(userId, topic, wasHelpful);
}

function getUserContext(userId: string) {
  const rows = db.getTopics(userId);
  if (rows.length === 0) return null;
  return {
    recentTopics: rows.map((r: TopicRow) => r.topic),
    helpfulAnswers: rows.filter((r: TopicRow) => r.was_helpful).map((r: TopicRow) => r.topic),
  };
}

const ATTEMPT_PATTERNS = [
  /\bclear[-\s]?cookies?\b[\s\S]*\b(?:didn['’]?t|didnt|doesn['’]?t|doesnt|not)\s+(?:help|work|fix|solve|change)\b/i,
  /\b(?:already\s+)?clear(?:ed|ing)?[-\s]+(?:the\s+)?(?:cookies?|cache|browser\s+data)\b/i,
  /\b(?:restarted|rebooted|reinstalled|refreshed|reset|logged\s+out|signed\s+out)\b/i,
  /\b(?:i|we)\s+(?:already\s+)?(?:tried|attempted)\b/i,
  /\b(?:i|we)\s+(?:already\s+)?did\b/i,
  /\b(?:clicked|submitted)\s+(?:the\s+)?(?:button|form|request|submit|save)\b/i,
  /\b(?:didn['’]?t|didnt|doesn['’]?t|doesnt|not|never)\s+(?:help|work|fix|solve|change)\b/i,
];

const ENVIRONMENT_NAMES: Array<[RegExp, string]> = [
  [/\bchrome(?:ium)?\b/i, "Chrome"],
  [/\bfirefox\b/i, "Firefox"],
  [/\bsafari\b/i, "Safari"],
  [/\b(?:microsoft\s+)?edge\b/i, "Edge"],
  [/\bopera\b/i, "Opera"],
  [/\bbrave\b/i, "Brave"],
  [/\bwindows(?:\s+\d+)?\b/i, "Windows"],
  [/\b(?:macos|mac\s+os|os\s+x|mac)\b/i, "macOS"],
  [/\blinux\b/i, "Linux"],
  [/\bubuntu\b/i, "Ubuntu"],
  [/\bios\b/i, "iOS"],
  [/\bipados\b/i, "iPadOS"],
  [/\bandroid\b/i, "Android"],
  [/\biphone\b/i, "iPhone"],
  [/\bipad\b/i, "iPad"],
  [/\b(?:pixel|galaxy)\b/i, "Mobile device"],
  [/\bmobile\b/i, "Mobile"],
  [/\btablet\b/i, "Tablet"],
  [/\bdesktop\b/i, "Desktop"],
  [/\blaptop\b/i, "Laptop"],
];

const SUPPORT_WORDS =
  /\b(?:help|support|issue|problem|error|broken|fail(?:ed|ing|ure)?|work(?:ing)?|fix|login|log\s+in|portal|app|site|page|button|account|setting|documentation|docs|unable|stuck|won['’]?t|cannot|can't)\b/i;
const SUPPORT_PROBLEM_WORDS =
  /\b(?:help|support|issue|problem|error|broken|fail(?:ed|ing|ure)?|unable|stuck|won['’]?t|cannot|can't|doesn['’]?t|didn['’]?t|not)\b/i;
const QUESTION_START = /^(?:how|what|where|when|why|who|can|could|would|should|is|are|do|does|did|will|please)\b/i;

function textValue(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isAttemptReport(value: unknown): boolean {
  const text = textValue(value);
  return Boolean(text) && ATTEMPT_PATTERNS.some((pattern) => pattern.test(text));
}

function extractAttemptedSteps(value: unknown): string[] {
  const text = textValue(value);
  if (!text) return [];
  const steps: string[] = [];
  const add = (step: string) => {
    const normalized = step
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;:]+$/, "");
    if (normalized && !steps.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
      steps.push(normalized);
    }
  };
  const clearCookies = text.match(/\bclear(?:ed|ing)?(?:[-\s]+(?:the\s+)?)cookies?\b/i);
  if (clearCookies) add(clearCookies[0]);
  for (const match of text.matchAll(
    /\b(?:restarted|rebooted|reinstalled|refreshed|reset|logged\s+out|signed\s+out)\b/gi,
  )) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b(?:clicked|submitted)\s+(?:the\s+)?(?:button|form|request|submit|save)\b/gi)) {
    add(match[0]);
  }
  const tried = text.match(/\b(?:tried|attempted)\s+([^.!?;]+)/i);
  if (tried) add(tried[1].replace(/\b(?:but|and)\s+(?:it\s+)?(?:didn['’]?t|doesn['’]?t)\s+.*$/i, ""));
  if (
    !steps.length &&
    /\b(?:didn['’]?t|didnt|doesn['’]?t|doesnt|not|never)\s+(?:help|work|fix|solve|change)\b/i.test(text)
  ) {
    add("an earlier step");
  }
  return steps;
}

function detectEnvironment(value: unknown): string[] {
  const text = textValue(value);
  return ENVIRONMENT_NAMES.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

function isSupportQuestionOrAttempt(value: unknown): boolean {
  const text = textValue(value);
  if (!text) return false;
  if (isAttemptReport(text)) return true;
  return (
    SUPPORT_WORDS.test(text) && (text.includes("?") || QUESTION_START.test(text) || SUPPORT_PROBLEM_WORDS.test(text))
  );
}

function rememberSupportContext({
  programId,
  userId,
  question,
  threadTs = null,
}: {
  programId?: string | null;
  userId?: string | null;
  question?: string | null;
  threadTs?: string | null;
}) {
  if (!programId || !userId || !question?.trim()) return;
  const value = question.trim();
  if (!isSupportQuestionOrAttempt(value)) return;
  supportMemory.remember({ programId, userId, kind: "problem", value, sourceThreadTs: threadTs });
  const attemptedSteps = extractAttemptedSteps(value);
  const attemptedValue = attemptedSteps.join(", ");
  if (attemptedValue && supportMemory.normalizeValue(attemptedValue) !== supportMemory.normalizeValue(value)) {
    supportMemory.remember({
      programId,
      userId,
      kind: "attempt",
      value: attemptedValue,
      sourceThreadTs: threadTs,
      confidence: 0.9,
    });
  }
  const environment = detectEnvironment(value);
  if (environment.length) {
    supportMemory.remember({
      programId,
      userId,
      kind: "environment",
      value: environment.join(", "),
      sourceThreadTs: threadTs,
      confidence: 0.85,
    });
  }
}

export = {
  addToThread,
  getThreadContext,
  getThreadMessages,
  hasSpokenInThread,
  seedFromSlack,
  recentChannelMessages,
  threadCrowd,
  fetchThreadCrowd,
  updateUserHistory,
  getUserContext,
  isAttemptReport,
  extractAttemptedSteps,
  detectEnvironment,
  isSupportQuestionOrAttempt,
  rememberSupportContext,
  deriveTopic,
};
