const db = require("./db");
const reply = require("./reply");
const learn = require("./learn");
const knowledge = require("./knowledge");
const answer = require("./answer");
const teachThread = require("./teachThread");
const { config } = require("./config");

const llm = require("./llm");
const log = require("./log");
const brand = require("./brand");
const { coverageStats, relativeTime } = require("./stats");
import type { Program, SlackClient } from "./types";

interface GapSummary {
  id: number;
  question: string;
  program_id: string | null;
  ask_count: number;
}
interface MetricRow {
  kind: string;
  count: number;
}
interface AnsweredCounts {
  docs: number;
  chat: number;
  linked: number;
  total: number;
}
interface ReportCollection {
  until: number;
  counts: Record<string, number>;
  answered: AnsweredCounts;
  coverage: number;
  gaps: GapSummary[];
  gapKinds: Record<string, number>;
}
interface ReportBlock {
  type: string;
  text: { type: string; text: string };
}

function programName() {
  try {
    const progs = require("./programs").all();
    if (progs.length === 1 && progs[0].name) return progs[0].name;
  } catch (e) {}
  return "the configured program";
}

function scopedProgramName(programId: string | null = null) {
  if (programId) {
    try {
      const program = require("./programs").get(programId);
      if (program?.name) return program.name;
    } catch (_error) {}
  }
  return programName();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const JUDGE_MAX_TOKENS = 5;
const JUDGE_TIMEOUT_MS = 10000;

const JUDGE_PER_PASS = 5;
const JUDGE_SPACING_MS = 4000;
const JUDGE_CYCLE_MS = 10 * 60 * 1000;

const DOCS = "docs";
const TRANSIENT = "transient";
const NOISE = "noise";

const GAP_LIMIT = 10;
const PENDING_CAP = 100;
const REPORT_DAY = 1;
const REPORT_HOUR = 9;

const SENT_METRIC = "weekly_report";

let timer: ReturnType<typeof setInterval> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function judgePrompt() {
  const program = programName();
  const botName = brand.name();

  return [
    `Someone said this in a Slack help channel for ${program}, a Hack Club program where teenagers build and ship projects.`,
    `${botName}, a docs bot, did not answer. Decide what kind of gap it is.`,
    "",
    `${DOCS} — a real, genuine question about ${program} or its tooling that the documentation should answer.`,
    "  Three things have to be true at once: someone is asking a question, that question is about",
    "  the program or its tooling, and you could write a documentation section that would still be",
    '  useful to a different person next month. Examples: "what are the submission rules", "how do I join",',
    '  "which marketplaces should i look for", "how do i unlock the next region", "can i submit late".',
    "",
    `${TRANSIENT} — true when they asked, but useless as documentation. A service being down,`,
    "  a temporary bug, or something wrong with this one person's machine, account or setup.",
    '  Examples: "is the site down rn", "my pfp is bugged sometimes", "and my pc crashed",',
    '            "im getting a 502", "is it just me or is it slow".',
    "",
    `${NOISE} — anything that does not belong in a maintainer's to-do list. Fragments and`,
    "  half-typed messages, statements and opinions that aren't asking anything, thinking out loud,",
    `  chat about ${botName} itself, jokes, memes, banter, sexual or flirty comments about ${botName},`,
    "  thanks, a message aimed at one specific person, or a question about unrelated software and",
    "  general trivia. Crucially: a question whose only answer is to ask back, to talk to a human, or",
    "  to do something not in the documentation is also noise — the docs are not the place for it.",
    '  Examples: "even sp[aces failed me", "ridit isn\'t", "what should i add to pixie", "PIXOSTART",',
    '            "need to expand the docs", "what if i just used 60 api keys", "pixie say my name",',
    '            "marketing as in?", "what tht does", "what colour scheme is catppuccin",',
    '            "does pixie have a boyfriend", "are you a real person", "say something funny",',
    '            "can you do my homework for me", "what do you look like".',
    "",
    `Reply with EXACTLY one word: ${DOCS}, ${TRANSIENT} or ${NOISE}.`,
    "",
    `Be strict. ${DOCS} is a to-do list somebody has to work through, so when in doubt choose`,
    `${TRANSIENT} or ${NOISE}. Only answer ${DOCS} if all three of the "real question" conditions`,
    "hold at once — anything about a person rather than a topic, anything whose honest answer is to",
    `talk to a human, anything flirty or banter or meme, and anything that is not really asking ${program}`,
    "a question, is ${NOISE} or ${TRANSIENT}, never ${DOCS}.",
    `A message that isn't asking a question is never DOCS, however much it mentions ${program}.`,
  ].join("\n");
}

async function judgeGap(question: string): Promise<string | null> {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: [
          { role: "system", content: judgePrompt() },
          { role: "user", content: question },
        ],
      },
      "report",
    );

    const verdict = (text || "").trim().toLowerCase();
    return [DOCS, TRANSIENT, NOISE].find((kind) => verdict.startsWith(kind)) || null;
  } catch (e) {
    log.debug("report", `gap judge failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function classifyGaps({
  limit = JUDGE_PER_PASS,
  spacingMs = JUDGE_SPACING_MS,
}: { limit?: number; spacingMs?: number } = {}): Promise<number> {
  const pending = db.unclassifiedGaps(limit);
  if (pending.length === 0) return 0;

  let judged = 0;
  for (const gap of pending) {
    const kind = await judgeGap(gap.question);
    if (kind) {
      db.setGapKind(gap.id, kind);
      judged += 1;
      log.debug("report", `gap #${gap.id} judged ${kind}: "${gap.question.slice(0, 50)}"`);
    }
    await sleep(spacingMs);
  }

  if (judged > 0) log.info("report", `judged ${judged} gap(s)`);
  return judged;
}

const DRAFT_MAX_TOKENS = 400;
const DRAFT_TIMEOUT_MS = 15000;

const DRAFT_PER_PASS = 3;

const DRAFT_SOURCE_PREFIX = "gap-draft:";

const THREAD_REFS_PER_GAP = 2;
const THREAD_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const THREAD_CONTEXT_CHAR_CAP = 4000;

function draftPrompt(corpus: string, programId: string | null = null): string {
  const program = scopedProgramName(programId);
  const programRef = programId ? require("./programs").get(programId) : null;

  return [
    `Someone asked this in the Slack help channel for ${program}, a Hack Club program where teenagers build and ship projects.`,
    "The documentation doesn't cover it yet, and a maintainer decided it should.",
    "",
    `Below are the real ${program} documentation and the actual Slack thread(s) where this was asked — including`,
    "anything a human helper replied with there. Write the documentation entry that answers it, sourced ONLY",
    `from what's below, or from genuinely general knowledge that has nothing to do with ${program} specifics (basic`,
    "git, coding, tools). Direct and factual, the way a FAQ entry reads. Write only the answer itself: no",
    'restated question, no "Q:"/"A:" labels, no mention that this is a draft or where it came from.',
    "",
    answer.programGuardrail(programRef),
    "",
    "If none of the above actually answers it, reply with EXACTLY: UNKNOWN. A missing draft costs nothing — a",
    "maintainer writes it instead. A confident, invented answer in the review queue costs someone's trust.",
    "",
    "=== DOCUMENTATION ===",
    corpus || "(nothing relevant in the docs)",
  ].join("\n");
}

async function draftDoc(
  question: string,
  corpus = "",
  threadContext = "",
  programId: string | null = null,
): Promise<string | null> {
  try {
    const userContent = threadContext ? `${question}\n\n=== SLACK THREAD(S) ===\n${threadContext}` : question;
    const { text } = await llm.complete(
      {
        baseUrl: config.answer.baseUrl,
        apiKey: config.answer.apiKey,
        model: config.answer.model,
        fallback: config.answer.fallback,
        onRateLimited: config.answer.onRateLimited,
        maxTokens: DRAFT_MAX_TOKENS,
        temperature: 0.2,
        timeout: DRAFT_TIMEOUT_MS,
        messages: [
          { role: "system", content: draftPrompt(corpus, programId) },
          { role: "user", content: userContent },
        ],
      },
      "report",
    );

    const trimmed = (text || "").trim();
    if (!trimmed || trimmed.toUpperCase().startsWith("UNKNOWN")) return null;
    return trimmed;
  } catch (e) {
    log.debug("report", `doc draft failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function draftSourceTs(gapId: number): string {
  return `${DRAFT_SOURCE_PREFIX}${gapId}`;
}

async function gatherThreadContext(
  client: SlackClient | null,
  question: string,
  programId: string | null | undefined = undefined,
): Promise<string> {
  if (!client) return "";

  const refs = db.gapThreads(question, THREAD_REFS_PER_GAP, THREAD_LOOKBACK_MS, programId);
  const transcripts: string[] = [];
  for (const ref of refs) {
    try {
      const { messages } = await client.conversations.replies({
        channel: ref.channel,
        ts: ref.message_ts,
        limit: teachThread.THREAD_FETCH_LIMIT,
      });
      const transcript = teachThread.buildTranscript(messages || []);
      if (transcript) transcripts.push(transcript);
    } catch (e) {
      log.debug("report", `thread fetch failed for draft context: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return transcripts.join("\n\n---\n\n").slice(0, THREAD_CONTEXT_CHAR_CAP);
}

async function draftGaps(
  client: SlackClient | null,
  {
    limit = DRAFT_PER_PASS,
    spacingMs = JUDGE_SPACING_MS,
    sinceMs = WEEK_MS,
    programId,
  }: { limit?: number; spacingMs?: number; sinceMs?: number; programId?: string | null } = {},
): Promise<number> {
  const candidates = db
    .topGaps(GAP_LIMIT, sinceMs, { kind: DOCS, minAskers: 1, programId: programId || null })
    .filter((gap: GapSummary) => !db.hasCapturedSource(draftSourceTs(gap.id)))
    .slice(0, limit);
  if (candidates.length === 0) return 0;

  let drafted = 0;
  for (const gap of candidates) {
    const corpus = knowledge.getContext(gap.question, gap.program_id);
    const threadContext = await gatherThreadContext(client, gap.question, gap.program_id);
    const draftedAnswer = await draftDoc(gap.question, corpus, threadContext, gap.program_id);
    if (draftedAnswer) {
      const id = db.addLearnedFact({
        question: gap.question,
        answer: draftedAnswer,
        status: learn.PENDING,
        sourceTs: draftSourceTs(gap.id),
        programId: gap.program_id,
      });
      if (id) {
        drafted += 1;
        log.debug("report", `drafted a doc suggestion for gap #${gap.id}: "${gap.question.slice(0, 50)}"`);
      }
    }
    await sleep(spacingMs);
  }

  if (drafted > 0) log.info("report", `drafted ${drafted} doc suggestion(s)`);
  return drafted;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function delta(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return "no change";
  return `${diff > 0 ? "+" : ""}${diff}`;
}

function answeredFrom(counts: Record<string, number>): AnsweredCounts {
  const docs = counts.answer_docs || 0;
  const chat = counts.answer_chat || 0;
  const linked = counts.answer_link || 0;
  return { docs, chat, linked, total: docs + chat + linked };
}

function collect(weeksAgo = 0, programId: string | null = null): ReportCollection {
  const until = Date.now() - weeksAgo * WEEK_MS;
  const sinceMs = (weeksAgo + 1) * WEEK_MS;

  const counts = Object.fromEntries(db.metricCounts(sinceMs, until).map((r: MetricRow) => [r.kind, r.count])) as Record<
    string,
    number
  >;
  const answered = answeredFrom(counts);

  return {
    until,
    counts,
    answered,
    coverage: pct(answered.docs, answered.total),
    gaps: db.topGaps(GAP_LIMIT, sinceMs, { kind: DOCS, untilMs: until, programId, minAskers: 1 }),
    gapKinds: db.gapCountsByKind(sinceMs, until, programId),
  };
}

function reportLines(weeksAgo = 0, programId: string | null = null): string[] {
  const week = collect(weeksAgo, programId);
  const previous = collect(weeksAgo + 1, programId);
  const { known, instant, cacheHits } = coverageStats();

  const prog = programId ? programs.get(programId) : null;
  const title = prog ? `${prog.name} weekly report` : `${brand.name()} weekly report`;

  const lines = [`*${title}* — ${weeksAgo === 0 ? "last 7 days" : `week ending ${relativeTime(week.until)}`}`];

  if (week.answered.total === 0) {
    lines.push("", `_nobody asked ${brand.name()} anything this week._`);
    return lines;
  }

  const comparable = previous.answered.total > 0;
  const trend = comparable ? ` (${delta(week.coverage, previous.coverage)} vs the week before)` : "";

  lines.push("", `*${week.answered.total}* questions answered — *${week.coverage}%* straight from the docs${trend}.`);

  lines.push("", "*the docs should answer these*");
  if (week.gaps.length === 0) {
    lines.push("_nothing outstanding_ :yay:");
  } else {
    for (const gap of week.gaps) {
      lines.push(`• *${gap.ask_count}×* — ${gap.question.slice(0, 150)}`);
    }
  }

  const filtered = (week.gapKinds[TRANSIENT] || 0) + (week.gapKinds[NOISE] || 0);
  const unjudged = week.gapKinds.unjudged || 0;
  if (filtered > 0 || unjudged > 0) {
    const parts = [];
    if (filtered > 0) parts.push(`*${filtered}* were one-off problems or chatter, not docs gaps`);
    if (unjudged > 0) parts.push(`*${unjudged}* not sorted yet`);
    lines.push("", `_${parts.join(", ")}._`);
  }

  lines.push("", "*what went well*");
  lines.push(
    `• answered *${week.answered.docs}* questions from the docs` +
      (comparable ? `, against ${previous.answered.docs} the week before` : ""),
  );
  lines.push(`• knows *${known}* answers cold — *${cacheHits}* replies (${instant}%) needed no thinking at all`);

  const votes = db.feedbackTotals();
  if ((votes.up || 0) + (votes.down || 0) > 0) {
    lines.push(`• feedback: *${votes.up || 0}* up / *${votes.down || 0}* down`);
  }

  const firstToken = db.medianLatency("first_token");
  if (firstToken) lines.push(`• median time to first word: *${(firstToken / 1000).toFixed(1)}s*`);

  const pending = learn.pending(PENDING_CAP + 1, programId).length;
  if (pending > 0) {
    const shown = pending > PENDING_CAP ? `${PENDING_CAP}+` : String(pending);
    lines.push(
      "",
      `*waiting on you*\n${shown} candidate answer(s) to review — open ${brand.name()}'s Home tab to approve or drop.`,
    );
  }

  return lines;
}

function reportText(weeksAgo = 0, programId: string | null = null): string {
  return reportLines(weeksAgo, programId).join("\n");
}

function reportBlocks(weeksAgo = 0, programId: string | null = null): ReportBlock[] {
  return [{ type: "section", text: { type: "mrkdwn", text: reportText(weeksAgo, programId) } }];
}

const programs = require("./programs");

function reportChannel(programId: string | null = null): string | null {
  if (config.reportChannel) return config.reportChannel;
  if (config.slack?.helpChannel) return config.slack.helpChannel;
  if (config.reportChannel === null && config.slack?.helpChannel === null) return null;
  return programs.helpChannelName(programId);
}

function lastBoundary(at = new Date()) {
  const boundary = new Date(at);
  boundary.setHours(REPORT_HOUR, 0, 0, 0);

  const daysSinceMonday = (boundary.getDay() - REPORT_DAY + 7) % 7;
  boundary.setDate(boundary.getDate() - daysSinceMonday);

  if (boundary.getTime() > at.getTime()) boundary.setDate(boundary.getDate() - 7);
  return boundary.getTime();
}

function isReportDue(at = new Date()) {
  const sentAt = db.lastMetricAt(SENT_METRIC);
  return sentAt === null || sentAt < lastBoundary(at);
}

async function postWeekly(client: SlackClient, programId: string | null = null): Promise<boolean> {
  const channel = reportChannel(programId);
  if (!channel) return false;

  const text = reportText(0, programId);
  await client.chat.postMessage({
    channel,
    text: `${brand.name()} weekly report`,
    blocks: reply.plainDashesInBlocks(reportBlocks(0, programId)),
  });
  db.recordMetric(SENT_METRIC);
  log.info("report", `weekly report posted to ${channel}`);
  return true;
}

async function tick(client: SlackClient): Promise<boolean> {
  await classifyGaps().catch((e: unknown) =>
    log.debug("report", `classify pass failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  await draftGaps(client).catch((e: unknown) =>
    log.debug("report", `draft pass failed: ${e instanceof Error ? e.message : String(e)}`),
  );
  if (!isReportDue()) return false;
  return postWeekly(client);
}

function start(
  client: SlackClient,
  { cycleMs = JUDGE_CYCLE_MS }: { cycleMs?: number } = {},
): ReturnType<typeof setInterval> | null {
  if (timer) return timer;
  if (!reportChannel()) {
    log.info("report", `no report channel configured — weekly report disabled, ${brand.cmd("report")} still works`);
  }

  timer = setInterval(() => {
    tick(client).catch((e: unknown) =>
      log.error("report", "weekly tick failed:", e instanceof Error ? e.message : String(e)),
    );
  }, cycleMs);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export = {
  judgeGap,
  judgePrompt,
  classifyGaps,
  draftDoc,
  draftPrompt,
  draftGaps,
  draftSourceTs,
  gatherThreadContext,
  collect,
  reportText,
  reportBlocks,
  reportChannel,
  lastBoundary,
  isReportDue,
  postWeekly,
  tick,
  start,
  stop,
  DOCS,
  TRANSIENT,
  NOISE,
  SENT_METRIC,
  WEEK_MS,
};
