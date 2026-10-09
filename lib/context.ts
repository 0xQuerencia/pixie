const db = require("./db");
const log = require("./log");
const supportMemory = require("./supportMemory");
import type { SlackClient } from "./types";

interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  user_id: string | null;
}
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
const transientThreads = new Map<string, ThreadMessage[]>();

function threadRows(threadTs: string): ThreadMessage[] {
  return transientThreads.get(threadTs) || [];
}

function addToThread(
  threadTs: string,
  role: ThreadMessage["role"],
  content: string,
  userId: string | null = null,
  channel: string | null = null,
) {
  if (!threadTs) return;
  const rows = threadRows(threadTs);
  rows.push({ role, content, user_id: userId });
  if (rows.length > MAX_CONTEXT_MESSAGES * 3) rows.splice(0, rows.length - MAX_CONTEXT_MESSAGES * 3);
  transientThreads.set(threadTs, rows);
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

function getThreadContext(threadTs: string, currentQuestion: string | null = null) {
  const messages = threadRows(threadTs);
  if (messages.length === 0) return null;
  return selectContextMessages(messages, currentQuestion)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

function getThreadMessages(threadTs: string, limit = 8) {
  if (!threadTs) return [];
  return threadRows(threadTs)
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
) {
  const existing = db.getThread(threadTs);
  if (existing?.seeded && threadRows(threadTs).length) return;

  db.touchThread(threadTs, channel, { seeded: true });

  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: SEED_LIMIT });
    const messages = res.messages || [];
    for (const m of messages) {
      if (currentTs && m.ts === currentTs) continue;
      const text = (m.text || "").trim();
      if (!text) continue;
      addToThread(threadTs, roleForMessage(m, botUserId), text, m.user || null, channel);
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
  supportMemory.remember({ programId, userId, kind: "problem", value, sourceThreadTs: threadTs });
  if (/\b(?:tried|attempted|already|i\s+did|we\s+did|clicked|submitted|restarted|refreshed|cleared)\b/i.test(value)) {
    supportMemory.remember({ programId, userId, kind: "attempt", value, sourceThreadTs: threadTs, confidence: 0.9 });
  }
  if (
    /\b(?:on|using|from)\s+(?:ios|android|iphone|ipad|windows|mac|linux|chrome|safari|firefox|mobile|desktop)\b/i.test(
      value,
    )
  ) {
    supportMemory.remember({
      programId,
      userId,
      kind: "environment",
      value,
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
  rememberSupportContext,
  deriveTopic,
};
