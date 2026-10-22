import crypto = require("crypto");
import db = require("./db");
import log = require("./log");
import programs = require("./programs");
import programModel = require("./programModel");
import resolutionJudge = require("./resolutionJudge");
import jobLease = require("./jobLease");
import lastWord = require("./lastWord");
import resolutionPolicy = require("./resolutionPolicy");
import eligibility = require("./eligibility");
import configModule = require("./config");
import type { Program } from "./types";

interface Row {
  id?: number;
  ticket_id?: number;
  program_id?: string;
  status?: string;
  created_at?: number;
  updated_at?: number;
  event_type?: string;
  actor_id?: string | null;
  detail?: string | Detail | null;
  ts?: string | number | null;
  text?: string;
  content?: string;
  user?: string;
  bot_id?: string;
  requester_id?: string;
  thread_ts?: string;
  channel?: string;
  workspace_id?: string | null;
  question?: string;
  resolution?: string | null;
  claimed_at?: number | null;
  confidence?: number;
  verdict?: string;
  errorKind?: string;
  reason?: string;
  role?: string;
  userId?: string | null;
  autoResolve?: boolean;
  [key: string]: unknown;
}

interface Detail {
  ts?: string;
  text?: string;
  messageKey?: string;
  [key: string]: unknown;
}

interface Client {
  conversations?: {
    replies?: (args: Record<string, unknown>) => Promise<{
      messages: Row[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

type Judge = typeof resolutionJudge.judgeResolution;
type JudgeResult = Awaited<ReturnType<Judge>>;
const { config } = configModule;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return String(error);
}

interface TranscriptRow {
  ts?: string | number | null;
  role: string;
  userId?: string | null;
  text: string;
}

const RESOLUTION_CONFIDENCE = 0.8;
const DEBOUNCE_MS = 2 * 60 * 1000;
const STALE_QUIET_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const RECENT_CLAIM_MS = 10 * 60 * 1000;
const SWEEP_MAX_JUDGEMENTS = 5;
const SWEEP_SPACING_MS = 20 * 1000;
const STARTUP_SWEEP_DELAY_MS = 10 * 60 * 1000;
const JEV_BACKOFF_MS = 15 * 60 * 1000;
const SWEEP_MAX_EXAMINED = 40;
const THREAD_PAGES = 5;
const ESCALATE_CONFIDENCE = 0.8;
const REOPEN_VERDICTS = new Set(["still_open", "needs_clarification", "escalate"]);
const SWEEP_EXAMINE_SPACING_MS = 3000;
const BACKOFF_ERRORS = new Set(["rate_limit", "quota"]);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const backlog: Array<{ ticketId: number; client: Client | null; program: Row | Program | null; judge: Judge }> = [];
const backlogIds = new Set<string>();
let backlogTimer: ReturnType<typeof setTimeout> | null = null;
let backlogRunning = false;
let backlogLastCallAt = 0;
const inFlight = new Map<string, Promise<Row>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let backoffUntil = 0;

function openStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened", "ai_answered"].includes(status)
  );
}

function autoResolveEnabled(ticket: Row, program: Row | Program | null): boolean {
  const behavior = program ? (programModel.behaviorFor(program) as { help?: { autoResolve?: boolean } }) : null;
  return !!behavior && behavior.help?.autoResolve === true;
}

function parseDetail(event: Row): Detail {
  try {
    return JSON.parse(String(event.detail || "{}")) as Detail;
  } catch (_) {
    return {};
  }
}

function eventRoleMap(ticket: Row): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const event of db.listTicketEvents(ticket.id) as Row[]) {
    if (event.event_type !== "helper_reply") continue;
    const detail = parseDetail(event);
    if (detail.ts) map.set(String(detail.ts), { role: "helper", userId: event.actor_id });
  }
  return map;
}

function slackRole(message: Row, ticket: Row, helperReplies: Map<string, Row>): Row {
  const override = helperReplies.get(String(message.ts || ""));
  if (override) return override;
  const botId = config?.slack?.botUserId;
  if (message.bot_id || (botId && message.user === botId)) return { role: "pixie", userId: message.user || botId };
  if (message.user === ticket.requester_id) return { role: "requester", userId: message.user };
  if (message.user && db.isHelper(ticket.program_id, message.user)) return { role: "helper", userId: message.user };
  return { role: "other", userId: message.user || null };
}

function normalizeSlackMessages(messages: Row[], ticket: Row): TranscriptRow[] {
  const helperReplies = eventRoleMap(ticket);
  return (messages || [])
    .map((message: Row): TranscriptRow => {
      const who = slackRole(message, ticket, helperReplies);
      return {
        ts: message.ts || null,
        role: who.role || "other",
        userId: who.userId,
        text: String(message.text || "").trim(),
      };
    })
    .filter((message) => Boolean(message.text));
}

function fallbackTranscript(ticket: Row): TranscriptRow[] {
  const rows: TranscriptRow[] = [
    {
      ts: ticket.created_at || null,
      role: "requester",
      userId: ticket.requester_id || null,
      text: ticket.question || "",
    },
  ];
  for (const row of db.listTicketEvents(ticket.id) as Row[]) {
    const detail = parseDetail(row);
    if (row.event_type === "helper_reply")
      rows.push({
        ts: row.created_at,
        role: "helper",
        userId: row.actor_id,
        text: detail.text || "A helper replied in the thread.",
      });
    if (row.event_type === "requester_followup")
      rows.push({
        ts: row.created_at,
        role: "requester",
        userId: row.actor_id,
        text: detail.text || "The requester followed up.",
      });
  }
  try {
    const context = require("./context").getThreadMessages(ticket.thread_ts, 40, ticket.channel_id || null);
    for (const row of context) rows.push({ role: row.speaker === "pixie" ? "pixie" : "requester", text: row.text });
  } catch (_) {}
  return rows;
}

// complete is false whenever the newest messages might be missing: more pages than we read, or no Slack view at all
async function fetchTranscript(
  ticket: Row,
  client: Client | null,
): Promise<{ rows: TranscriptRow[]; complete: boolean }> {
  if (client?.conversations?.replies) {
    try {
      const messages: Row[] = [];
      let cursor: string | undefined;
      let more = false;
      for (let page = 0; page < THREAD_PAGES; page += 1) {
        const result = await client.conversations.replies({
          channel: ticket.channel,
          ts: ticket.thread_ts,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...(result.messages || []));
        cursor = result.response_metadata?.next_cursor;
        more = Boolean(result.has_more && cursor);
        if (!more) break;
      }
      return { rows: normalizeSlackMessages(messages, ticket), complete: !more };
    } catch (error: unknown) {
      log.debug("resolution", `thread fetch failed for #${ticket.id}: ${errorMessage(error)}`);
    }
  }
  return { rows: fallbackTranscript(ticket), complete: false };
}

function lastMessageKey(transcript: TranscriptRow[]): string {
  const last = transcript.at(-1);
  if (!last) return "empty";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([last.ts || null, last.role, last.text]))
    .digest("hex");
}

function wasJudged(ticketId: number, messageKey: string): boolean {
  return (db.listTicketEvents(ticketId) as Row[]).some(
    (event: Row) => event.event_type === "resolution_judged" && parseDetail(event).messageKey === messageKey,
  );
}

function recordJudgement(ticket: Row, messageKey: string, decision: JudgeResult, gate: string | null = null): void {
  const addTicketEvent = db.addTicketEvent as (event: Record<string, unknown>) => unknown;
  addTicketEvent({
    ticketId: ticket.id,
    programId: ticket.program_id,
    eventType: "resolution_judged",
    detail: {
      messageKey,
      verdict: decision.verdict,
      confidence: decision.confidence ?? null,
      reasonCode: decision.reasonCode ?? null,
      evidence: decision.evidence?.ref ?? null,
      gate,
    },
  });
}

function hasAnswer(transcript: TranscriptRow[]): boolean {
  let pixieAnswered = false;
  for (const message of transcript) {
    if (message.role === "helper") return true;
    if (message.role === "pixie") pixieAnswered = true;
    if (pixieAnswered && message.role === "requester") return true;
  }
  return false;
}

function recentClaimWithoutReply(ticket: Row, now: number): boolean {
  if (!ticket.claimed_at || now - ticket.claimed_at >= RECENT_CLAIM_MS) return false;
  const claimedAt = Number(ticket.claimed_at);
  return !(db.listTicketEvents(ticket.id) as Row[]).some(
    (event: Row) => event.event_type === "helper_reply" && Number(event.created_at) >= claimedAt,
  );
}

function lastMessageAt(transcript: TranscriptRow[]): number | null {
  let latest = null;
  for (const row of transcript) {
    const raw = Number(row?.ts);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const ms = raw < 1e11 ? Math.round(raw * 1000) : raw;
    latest = latest === null ? ms : Math.max(latest, ms);
  }
  return latest;
}

// Deterministic checks on a resolution the judge proposed; the first failure names why it was not applied
function resolutionGate(
  ticket: Row,
  transcript: TranscriptRow[],
  decision: JudgeResult,
  policy: ReturnType<typeof resolutionPolicy.closurePolicy>,
): string | null {
  if (!policy.auto) return "policy_manual";
  const evidence = decision.evidence;
  if (!evidence) return "no_evidence";
  if (Number(decision.confidence) < policy.minConfidence) return "low_confidence";
  const row = transcript[evidence.index];
  if (!row || row.role !== evidence.role || !policy.evidenceRoles.includes(row.role)) return "evidence_role";
  if (row.role === "requester" && row.userId !== ticket.requester_id) return "evidence_role";
  const firstAnswer = transcript.findIndex((entry) => entry.role === "pixie" || entry.role === "helper");
  if (firstAnswer < 0 || evidence.index <= firstAnswer) return "evidence_before_answer";
  const kind = resolutionPolicy.followUpKind(row.text);
  if (kind === "persists") return "evidence_persists";
  if (!policy.ackOk && kind !== "confirm") return "needs_explicit_confirmation";
  const later = transcript.slice(evidence.index + 1);
  if (later.some((entry) => entry.role === "requester" && resolutionPolicy.followUpKind(entry.text) === "persists")) {
    return "contradicted";
  }
  const helperInvolved =
    transcript.some((entry) => entry.role === "helper") ||
    (db.listTicketEvents(ticket.id) as Row[]).some((event: Row) => event.event_type === "helper_reply");
  if (policy.needsHelper && !helperInvolved) return "needs_human_involvement";
  return null;
}

function closeoutPolicy(ticket: Row, prog: Row | Program | null) {
  return resolutionPolicy.closurePolicy({
    category: typeof ticket.category === "string" ? ticket.category : null,
    sensitive: eligibility.sensitiveHit(String(ticket.question || ""), prog as Program | null),
  });
}

const INCOMPLETE_KEY = "incomplete-history";

// A history that may be missing its newest messages cannot support closing or reopening anything
function incompleteHistory(ticket: Row): Row {
  if (!wasJudged(ticket.id, INCOMPLETE_KEY)) {
    recordJudgement(ticket, INCOMPLETE_KEY, { verdict: "incomplete_history" }, "incomplete_history");
  }
  return { skipped: true, reason: "incomplete_history" };
}

async function reassessClosed(
  ticket: Row,
  prog: Row | Program | null,
  { client, judge }: { client: Client | null; judge: Judge },
): Promise<Row> {
  const { rows: transcript, complete } = await fetchTranscript(ticket, client);
  if (!complete) return incompleteHistory(ticket);
  const last = transcript.at(-1);
  if (!last || last.role !== "requester" || last.userId !== ticket.requester_id) return { skipped: true };
  const lastAt = lastMessageAt([last]);
  if (!lastAt || lastAt <= Number(ticket.resolved_at || 0)) return { skipped: true, reason: "not_after_resolution" };
  const kind = resolutionPolicy.followUpKind(last.text);
  if (kind === "ack" || kind === "confirm") return { skipped: true, reason: "no_new_issue" };
  const messageKey = lastMessageKey(transcript);
  if (wasJudged(ticket.id, messageKey)) return { skipped: true, reason: "already_judged" };
  const tickets = require("./tickets");
  const reopen = (rule: string, detail: Record<string, unknown> = {}) =>
    tickets.reopenForRequester({ ticket, userId: ticket.requester_id, client, prog, rule, detail });
  if (kind === "persists") {
    recordJudgement(ticket, messageKey, { verdict: "persists_rule" });
    return { reopened: reopen("requester_reports_persists") };
  }
  if (!autoResolveEnabled(ticket, prog) || Date.now() < backoffUntil) return { skipped: true };
  let decision: JudgeResult;
  try {
    decision = await judge({ ticket, transcript });
  } catch (_) {
    decision = { verdict: "unknown" };
  }
  if (decision.verdict === "unknown") return { decision };
  recordJudgement(ticket, messageKey, decision);
  const evidence = decision.evidence;
  const row = evidence ? transcript[evidence.index] : null;
  const evidenceAt = row ? lastMessageAt([row]) : null;
  const proven =
    REOPEN_VERDICTS.has(decision.verdict) &&
    Number(decision.confidence) >= ESCALATE_CONFIDENCE &&
    row?.role === "requester" &&
    row.userId === ticket.requester_id &&
    evidenceAt !== null &&
    evidenceAt > Number(ticket.resolved_at || 0);
  if (!proven) return { decision };
  return {
    decision,
    reopened: reopen("jev_reassessment", { verdict: decision.verdict, reasonCode: decision.reasonCode }),
  };
}

async function judgeTicketOnce(
  ticketId: number,
  {
    client = null,
    program = null,
    now = Date.now(),
    judge = resolutionJudge.judgeResolution,
    historical = false,
  }: { client?: Client | null; program?: Row | Program | null; now?: number; judge?: Judge; historical?: boolean } = {},
): Promise<Row> {
  let ticket = db.getTicket(ticketId);
  const prog = program || (ticket && programs.get(ticket.program_id));
  if (ticket && ["resolved", "closed"].includes(ticket.status) && !historical) {
    return reassessClosed(ticket, prog, { client, judge });
  }
  if (!ticket || !openStatus(ticket.status) || !autoResolveEnabled(ticket, prog)) return { skipped: true };
  if (Date.now() < backoffUntil) return { skipped: true, reason: "backoff" };
  const { rows: transcript, complete } = await fetchTranscript(ticket, client);
  if (!complete) return incompleteHistory(ticket);
  const policy = closeoutPolicy(ticket, prog);
  const helperLast = policy.lastWord
    ? lastWord.helperLastWord({
        programId: ticket.program_id,
        requesterId: ticket.requester_id,
        threadTs: ticket.thread_ts,
        rows: transcript.map((row) => ({ ts: row.ts, userId: row.userId, isBot: row.role === "pixie" })),
        now,
      })
    : null;
  if (helperLast) {
    const tickets = require("./tickets");
    const result = tickets.resolveTicket({
      ticketId: ticket.id,
      actorId: null,
      creditId: helperLast.helperId,
      resolution: "resolved: a helper had the last word and the requester didn't come back",
      source: historical ? "backfill" : "auto",
      resolutionMeta: { rule: "last_word", helper: helperLast.helperId },
      resolvedAt: helperLast.at,
      programId: ticket.program_id,
      workspaceId: ticket.workspace_id,
      client,
      program: prog,
    });
    return { lastWord: helperLast, result };
  }
  const messageKey = lastMessageKey(transcript);
  if (wasJudged(ticket.id, messageKey)) return { skipped: true, reason: "already_judged" };
  if (!hasAnswer(transcript)) {
    recordJudgement(ticket, messageKey, { verdict: "no_answer" });
    return { skipped: true, reason: "no_answer" };
  }
  if (recentClaimWithoutReply(ticket, now)) {
    recordJudgement(ticket, messageKey, { verdict: "recent_claim" });
    return { skipped: true, reason: "recent_claim" };
  }
  let decision: JudgeResult;
  try {
    decision = await judge({ ticket, transcript });
  } catch (_) {
    decision = { verdict: "unknown" };
  }
  if (
    decision.verdict === "unknown" &&
    typeof decision.errorKind === "string" &&
    BACKOFF_ERRORS.has(decision.errorKind)
  ) {
    backoffUntil = Date.now() + JEV_BACKOFF_MS;
    log.warn(
      "resolution",
      `jev ${decision.errorKind}; pausing auto-resolve judgements for ${JEV_BACKOFF_MS / 60000} min`,
    );
    return { decision, skipped: true, reason: "backoff" };
  }
  // An unavailable or garbled judge says nothing about the thread, so the message stays unjudged
  if (decision.verdict === "unknown") return { decision };
  const gate = decision.verdict === "resolved" ? resolutionGate(ticket, transcript, decision, policy) : null;
  recordJudgement(ticket, messageKey, decision, gate);
  if (decision.verdict === "escalate") return escalate(ticket, prog, decision, { client });
  if (decision.verdict !== "resolved" || gate) return { decision, ...(gate ? { gate } : {}) };
  ticket = db.getTicket(ticket.id);
  if (!ticket || !openStatus(ticket.status) || recentClaimWithoutReply(ticket, now))
    return { skipped: true, reason: "ticket_changed" };
  const tickets = require("./tickets");
  const reason = String(decision.reason || "Jev found clear evidence that the issue was solved.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const result = tickets.resolveTicket({
    ticketId: ticket.id,
    actorId: null,
    resolution: `auto-resolved: ${reason}`,
    source: historical ? "backfill" : "auto",
    resolutionMeta: {
      verdict: decision.verdict,
      confidence: decision.confidence,
      reason,
      reasonCode: decision.reasonCode,
      evidence: decision.evidence,
      ...(historical ? { lane: "backlog" } : {}),
    },
    resolvedAt: lastMessageAt(transcript),
    programId: ticket.program_id,
    workspaceId: ticket.workspace_id,
    client,
    program: prog,
  });
  return { decision, result };
}

// Handing a ticket to a person is the only action an unresolved verdict may take
async function escalate(
  ticket: Row,
  prog: Row | Program | null,
  decision: JudgeResult,
  { client }: { client: Client | null },
): Promise<Row> {
  const fresh = db.getTicket(ticket.id);
  const evidence = decision.evidence;
  if (
    !fresh ||
    !["open", "reopened"].includes(fresh.status) ||
    Number(decision.confidence) < ESCALATE_CONFIDENCE ||
    evidence?.role !== "requester"
  ) {
    return { decision };
  }
  await require("./tickets").handOffToHelper({
    ticket: fresh,
    client,
    program: prog,
    channel: fresh.channel,
    threadTs: fresh.thread_ts,
    question: fresh.question,
    requesterId: fresh.requester_id,
    workspaceId: fresh.workspace_id,
    role: "help",
    handoffReason: `Jev judged the thread needs a person (${decision.reasonCode})`,
  });
  return { decision, escalated: true };
}

function judgeTicket(
  ticketId: number,
  options: {
    client?: Client | null;
    program?: Row | Program | null;
    now?: number;
    judge?: Judge;
    historical?: boolean;
  } = {},
): Promise<Row> {
  const key = String(ticketId);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = judgeTicketOnce(ticketId, options).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

function schedule({
  ticketId,
  client = null,
  program = null,
  delayMs = DEBOUNCE_MS,
  judge = resolutionJudge.judgeResolution,
}: {
  ticketId?: number;
  client?: Client | null;
  program?: Row | Program | null;
  delayMs?: number;
  judge?: Judge;
} = {}): ReturnType<typeof setTimeout> | null {
  if (!ticketId) return null;
  const prior = timers.get(String(ticketId));
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    timers.delete(String(ticketId));
    void judgeTicket(ticketId, { client, program, judge }).catch((error: unknown) =>
      log.warn("resolution", `judgement failed for #${ticketId}: ${errorMessage(error)}`),
    );
  }, delayMs);
  if (timer.unref) timer.unref();
  timers.set(String(ticketId), timer);
  return timer;
}

function enqueueForJudge({
  ticketId,
  client = null,
  program = null,
  judge = resolutionJudge.judgeResolution,
  autoStart = true,
}: {
  ticketId: number;
  client?: Client | null;
  program?: Row | Program | null;
  judge?: Judge;
  autoStart?: boolean;
}): boolean {
  const key = String(ticketId || "");
  if (!key || backlogIds.has(key)) return false;
  backlogIds.add(key);
  backlog.push({ ticketId, client, program, judge });
  if (autoStart) void drainBacklog();
  return true;
}

async function drainBacklog({
  now = Date.now(),
  spacingMs = SWEEP_SPACING_MS,
}: { now?: number; spacingMs?: number } = {}): Promise<Row> {
  if (backlogRunning || backlog.length === 0) return { judged: 0, queued: backlog.length };
  if (now < backoffUntil) {
    if (!backlogTimer) {
      backlogTimer = setTimeout(
        () => {
          backlogTimer = null;
          void drainBacklog({ spacingMs }).catch((error: unknown) =>
            log.warn("resolution", `backlog drain failed: ${errorMessage(error)}`),
          );
        },
        Math.max(1, backoffUntil - now),
      );
      if (backlogTimer.unref) backlogTimer.unref();
    }
    return { judged: 0, queued: backlog.length, reason: "backoff" };
  }
  const elapsed = now - backlogLastCallAt;
  if (backlogLastCallAt && elapsed < spacingMs) {
    if (!backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error: unknown) =>
          log.warn("resolution", `backlog drain failed: ${errorMessage(error)}`),
        );
      }, spacingMs - elapsed);
      if (backlogTimer.unref) backlogTimer.unref();
    }
    return { judged: 0, queued: backlog.length, reason: "spacing" };
  }
  const item = backlog.shift();
  if (!item) return { judged: 0, queued: 0 };
  backlogIds.delete(String(item.ticketId));
  backlogRunning = true;
  backlogLastCallAt = now;
  try {
    const result = await judgeTicket(item.ticketId, {
      client: item.client,
      program: item.program,
      judge: item.judge,
      historical: true,
    });
    return { judged: result?.decision ? 1 : 0, queued: backlog.length, result };
  } finally {
    backlogRunning = false;
    if (backlog.length > 0 && !backlogTimer) {
      backlogTimer = setTimeout(() => {
        backlogTimer = null;
        void drainBacklog({ spacingMs }).catch((error: unknown) =>
          log.warn("resolution", `backlog drain failed: ${errorMessage(error)}`),
        );
      }, spacingMs);
      if (backlogTimer.unref) backlogTimer.unref();
    }
  }
}

function ticketActivityAt(ticket: Row): number {
  const events = db.listTicketEvents(ticket.id) as Row[];
  return Math.max(Number(ticket.updated_at) || 0, ...events.map((event) => Number(event.created_at) || 0));
}

async function sweepStale({
  client = null,
  now = Date.now(),
  quietMs = STALE_QUIET_MS,
  useLease = true,
  judge = resolutionJudge.judgeResolution,
  maxJudgements = SWEEP_MAX_JUDGEMENTS,
  spacingMs = SWEEP_SPACING_MS,
  maxExamined = SWEEP_MAX_EXAMINED,
  examineSpacingMs = SWEEP_EXAMINE_SPACING_MS,
}: {
  client?: Client | null;
  now?: number;
  quietMs?: number;
  useLease?: boolean;
  judge?: Judge;
  maxJudgements?: number;
  spacingMs?: number;
  maxExamined?: number;
  examineSpacingMs?: number;
} = {}): Promise<Row> {
  const run = async () => {
    const seen = new Set();
    let judged = 0;
    let jevCalls = 0;
    let examined = 0;
    for (const program of programs.all()) {
      for (const ticket of db.getTicketsForProgram(program.id)) {
        if (jevCalls >= maxJudgements || Date.now() < backoffUntil) return { judged };
        if (seen.has(ticket.id) || !openStatus(ticket.status) || now - ticketActivityAt(ticket) < quietMs) continue;
        seen.add(ticket.id);
        if (examined >= maxExamined) return { judged };
        if (examined > 0 && examineSpacingMs > 0) await new Promise((resolve) => setTimeout(resolve, examineSpacingMs));
        if (jevCalls > 0 && spacingMs > 0) await new Promise((resolve) => setTimeout(resolve, spacingMs));
        examined += 1;
        const result = await judgeTicket(ticket.id, { client, program, now, judge });
        if (result.lastWord) judged += 1;
        if (result.decision) jevCalls += 1;
        if (!result.skipped || result.reason === "no_answer" || result.reason === "recent_claim") judged += 1;
      }
    }
    return { judged };
  };
  if (!useLease) return run();
  return (await jobLease.runOnce("ticket-resolution-sweep", 25 * 60 * 1000, run)).result || { judged: 0 };
}

function start(
  client: Client,
  { intervalMs = SWEEP_INTERVAL_MS }: { intervalMs?: number } = {},
): ReturnType<typeof setInterval> {
  if (sweepTimer) return sweepTimer;
  startupTimer = setTimeout(() => {
    void sweepStale({ client }).catch((error: unknown) =>
      log.warn("resolution", `startup sweep failed: ${errorMessage(error)}`),
    );
  }, STARTUP_SWEEP_DELAY_MS);
  if (startupTimer.unref) startupTimer.unref();
  sweepTimer = setInterval(() => {
    void sweepStale({ client }).catch((error: unknown) =>
      log.warn("resolution", `stale sweep failed: ${errorMessage(error)}`),
    );
  }, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function stop() {
  if (sweepTimer) clearInterval(sweepTimer);
  if (startupTimer) clearTimeout(startupTimer);
  sweepTimer = null;
  startupTimer = null;
  backoffUntil = 0;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  inFlight.clear();
  if (backlogTimer) clearTimeout(backlogTimer);
  backlogTimer = null;
  backlogRunning = false;
  backlog.length = 0;
  backlogIds.clear();
  backlogLastCallAt = 0;
}

export = {
  schedule,
  judgeTicket,
  sweepStale,
  start,
  stop,
  hasAnswer,
  enqueueForJudge,
  drainBacklog,
  RESOLUTION_CONFIDENCE,
  DEBOUNCE_MS,
  STALE_QUIET_MS,
  SWEEP_SPACING_MS,
  JEV_BACKOFF_MS,
};
