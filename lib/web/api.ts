const db = require("../db");
const cache = require("../cache");
const learn = require("../learn");
const knowledge = require("../knowledge");
const report = require("../report");
const programs = require("../programs");
const log = require("../log");
const config = require("../config").config;
const { probe } = require("../probe");
const retrieve = require("../retrieve");
const llm = require("../llm");
const claimVerifier = require("../claimVerifier");
const { coverageStats, relativeTime } = require("../stats");
const programDocs = require("../programDocs");
const lifecycle = require("../lifecycle");
const evalHarness = require("../evalHarness");
const inspector = require("../inspect");
import type { Program, ProgramSource, SlackClient, Ticket } from "../types";

interface LearnedFactRow {
  id: number;
  question: string;
  answer: string;
  author_id: string | null;
  source_ts: string | null;
  channel: string | null;
  created_at: number;
  program_id: string | null;
}

interface GapRow {
  id: number;
  question: string;
  user_id: string | null;
  channel: string | null;
  message_ts: string | null;
  created_at: number;
  count: number;
  last_asked: number;
  detail?: string | null;
}

interface MetricCountRow {
  kind: string;
  count: number;
}
interface MetricDetailRow {
  detail: string | null;
  count: number;
}
interface SourceRow extends ProgramSource {
  fail_count?: number;
  last_success_at?: number | null;
  last_error?: string | null;
}
interface CacheEntryRow {
  question_hash: string;
  question: string;
  ask_count: number;
}
interface ChannelCountRow {
  count: number;
}
interface ChannelConfigRow {
  channelId: string;
  [key: string]: unknown;
}
interface ChannelClaimRow {
  program_id: string;
  channel_id?: string;
  workspace_id?: string | null;
}
interface HelperRow {
  user_id: string;
  helper_source: string;
  role: string;
  active: number;
  ping_eligible: number;
}
interface AffectedReportRow {
  notified_at: number | null;
}
interface MacroRow {
  id: number;
  program_id: string;
  [key: string]: unknown;
}
interface DraftBindingRow {
  program_id: string;
  channel_id?: string;
  channelId?: string;
  [key: string]: unknown;
}

interface ProgramSaveBody {
  id?: string;
  name?: string;
  [key: string]: unknown;
}
interface ProgramSyncBody {
  id?: string;
  name?: string;
  workspaceId?: string | null;
  actorId?: string | null;
  claimedBy?: string | null;
  behavior?: Record<string, unknown> | null;
  status?: string | null;
  lifecycle?: string | null;
  channels?: string[];
  helpChannel?: string | null;
  organizerChannel?: string | null;
  programChannels?: Array<string | { id: string; kind?: string }>;
  [key: string]: unknown;
}
interface ChannelRoleBody {
  id: string;
  kind?: string;
}
interface TestQuestionBody {
  question?: string;
  role?: string;
  channelId?: string;
  workspaceId?: string | null;
  addressed?: boolean;
}
interface TicketSearchParams {
  programId?: string | null;
  status?: string | null;
  assigneeId?: string | null;
  requesterId?: string | null;
  category?: string | null;
  priority?: string | null;
  q?: string | null;
  since?: string | number | null;
  until?: string | number | null;
  sinceMs?: string | number | null;
  limit?: string | number;
  offset?: string | number;
}
interface TicketActionBody {
  programId?: string | null;
  workspaceId?: string | null;
  actorId?: string | null;
  assigneeId?: string | null;
  resolution?: string | null;
  source?: string;
  text?: string;
  body?: string;
  until?: string | number;
  canonicalId?: string | number;
}
interface ChannelToggleBody {
  programId?: string;
  channelId?: string;
  field?: string;
  value?: string | boolean | null;
}
interface ChannelAddBody {
  programId?: string;
  channelId?: string;
  isHelp?: boolean;
}
interface HelperSyncBody {
  actorId?: string | null;
  source?: string;
  members?: string[];
  pingIneligible?: string[];
  reconcile?: boolean;
}
interface CopilotBody {
  programId?: string | null;
  actorId?: string | null;
  question?: string;
  threadTs?: string | null;
  text?: string;
  ticketId?: string | number;
  limit?: string | number;
}
interface KnowledgeProposeBody {
  actorId?: string | null;
  ticketId?: string | number;
}
interface CandidateActionBody {
  actorId?: string | null;
  action?: string;
  edits?: Record<string, unknown>;
}
interface GapClusterQuery {
  sinceMs?: string | number;
  minAskers?: string | number;
}
interface FaqProposeBody {
  actorId?: string | null;
  question?: string;
}
interface MacroQuery {
  actorId?: string | null;
  enabledOnly?: string;
  q?: string | null;
  category?: string | null;
  limit?: string | number;
}
interface MacroBody extends MacroQuery {
  id?: string | number;
  onSendTransition?: unknown;
  on_send_transition?: unknown;
  ticketId?: string | number;
  ticketIds?: Array<string | number>;
  selector?: string;
  duration?: string;
  action?: string;
  userId?: string;
  tags?: string[];
  [key: string]: unknown;
}
interface IncidentQuery {
  status?: string | null;
  limit?: string | number;
  onlyUnnotified?: string;
  severity?: string;
}
interface IncidentBody {
  actorId?: string | null;
  action?: string;
  ticketId?: string | number;
  title?: string;
  description?: string | null;
  publicMessage?: string | null;
  resolutionMessage?: string | null;
}
interface RadarQuery {
  status?: string | null;
  severity?: string | null;
  limit?: string | number;
}
interface RadarActionBody {
  actorId?: string | null;
  action?: string;
  duration?: string;
}
interface AnalyticsQuery {
  days?: string | number;
  from?: string | number;
  until?: string | number;
  bucket?: string;
  operation?: string | null;
  limit?: string | number;
  offset?: string | number;
  recentLimit?: string | number;
  since?: string | number;
  q?: string | null;
  category?: string | null;
  ticketId?: string | number;
}
interface RoutingBody {
  actorId?: string | null;
  userId?: string;
  tags?: string[];
}
interface RetentionBody {
  actorId?: string | null;
  confirm?: boolean;
  policy?: Record<string, unknown>;
}
interface DraftSyncBody {
  draft?: {
    id?: string;
    status?: string;
    privateSandboxOnly?: boolean;
    autoAssign?: boolean;
    ticketsEnabled?: boolean;
    workspaceId?: string;
    sandboxBindings?: Array<{
      sandboxOnly?: boolean;
      enabled?: boolean;
      role?: string;
      channelId?: string;
    }>;
  };
}
interface TestQuestionSettings {
  aiReplies?: boolean;
  escalateUnknown?: boolean;
  [key: string]: unknown;
}
interface EngagementResult {
  engage: boolean;
  intent: string | null;
  error: string | null;
  source: string | null;
}
interface RetentionValues {
  [key: string]: number;
}
interface UserInfoPublic {
  slackId: string;
  displayName?: string | null;
  realName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
}
interface TicketEventRow {
  event_type: string;
  actor_id: string | null;
  [key: string]: unknown;
}
interface NoteRow {
  id: number;
  body: string;
  author_id: string | null;
  created_at: number;
  [key: string]: unknown;
}

interface ApiResponse {
  [key: string]: unknown;
  error?: string;
  ok?: boolean;
  status?: number;
  id?: number | string;
  kind?: string;
  text?: string;
  programId?: string;
  program?: Program | null;
  ticket?: Ticket | ApiResponse | null;
  events?: TicketEventRow[];
  notes?: NoteRow[];
  rows?: Ticket[];
  sources?: string[] | Array<Record<string, unknown>>;
  metrics?: Record<string, number>;
  displayName?: string | null;
  avatarUrl?: string | null;
  realName?: string | null;
  username?: string | null;
  slackId?: string;
  reason?: string;
  fact?: LearnedFactRow | null;
  candidate?: LearnedFactRow | null;
  grounded?: boolean;
  changed?: boolean;
  users?: Record<string, UserInfoPublic | null>;
}

interface KnowledgeDoc {
  chunk: { source: string; heading?: string; text: string };
  length: number;
}
interface CacheRow {
  question_hash: string;
  question: string;
  ask_count: number;
  source: string | null;
  written_at: number;
}
interface UserInfo {
  at: number;
  ok: boolean;
  displayName?: string | null;
  realName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  reason?: string;
}
interface SlackError {
  message?: string;
  code?: string;
  data?: { error?: string };
}
interface SlackChannel {
  id: string;
  name: string;
  is_member?: boolean;
}
interface SlackChannelPage {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
}
interface DashboardChannel {
  id: string;
  name: string;
  isMember: boolean;
}

function buildPulse(): ApiResponse {
  const stats = coverageStats();
  const now = Date.now();

  const prev = report.collect(1);
  const curr = report.collect(0);

  const delta = curr.answered.total > 0 && prev.answered.total > 0 ? curr.coverage - prev.coverage : 0;

  const pendingCount = learn.pending().length;
  const knownCount = cache.cachedCount();
  const instant = stats.instant;

  return {
    coverage: stats.rate,
    coverageDelta: delta,
    answered: stats.docs + stats.chat + stats.link,
    silent: stats.silent,
    knownCold: knownCount,
    instantPercent: instant,
    queue: pendingCount,
    corpusRefreshedAt: knowledge.lastBuiltAt?.toISOString() || null,
    corpusRefreshedRelative: relativeTime(knowledge.lastBuiltAt?.getTime()),
    time: now,
  };
}

async function handleAsk(question: string): Promise<ApiResponse> {
  if (!question) return { error: "empty question" };
  return probe(question);
}

function queueList(): ApiResponse[] {
  const pending = learn.pending(100);
  return pending.map((row: LearnedFactRow) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    authorId: row.author_id,
    channel: row.channel,
    sourceTs: row.source_ts,
    created: row.created_at,
    createdRelative: relativeTime(row.created_at),
  }));
}

function queueApprove(id: number): void {
  learn.approve(id);
}

function queueDrop(id: number): void {
  learn.forget(id);
}

function queueEdit(id: number, question: string, answer: string): void {
  if (!question || !answer) return;
  const original = db.getLearnedFactById(id);
  if (!original) return;
  learn.forget(id);
  learn.teach({
    question,
    answer,
    authorId: original.author_id || null,
    threadTs: original.source_ts || null,
    channel: original.channel || null,
    programId: original.program_id || null,
  });
}

function gapsList() {
  const counts = db.gapCountsByKind();
  const docs = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.DOCS });
  const transient = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.TRANSIENT });
  const noise = db.topGaps(50, 30 * 24 * 60 * 60 * 1000, { kind: report.NOISE });

  const unjudged = db
    .handle()
    .query(
      "SELECT id, question, user_id, channel, message_ts, created_at FROM doc_gaps WHERE kind IS NULL ORDER BY created_at DESC LIMIT 100",
    )
    .all()
    .map((r: GapRow) => ({
      id: r.id,
      question: r.question,
      userId: r.user_id,
      channel: r.channel,
      messageTs: r.message_ts,
      created: r.created_at,
    }));

  return {
    counts: {
      docs: counts[report.DOCS] || 0,
      transient: counts[report.TRANSIENT] || 0,
      noise: counts[report.NOISE] || 0,
      unjudged: counts.unjudged || 0,
    },
    columns: {
      docs: docs.map((g: GapRow) => ({ id: g.id, question: g.question, count: g.count, lastAsked: g.last_asked })),
      transient: transient.map((g: GapRow) => ({
        id: g.id,
        question: g.question,
        count: g.count,
        lastAsked: g.last_asked,
      })),
      noise: noise.map((g: GapRow) => ({ id: g.id, question: g.question, count: g.count, lastAsked: g.last_asked })),
      unjudged,
    },
  };
}

function gapsMove(id: number, kind: string): void {
  if ([report.DOCS, report.TRANSIENT, report.NOISE].includes(kind)) {
    db.setGapKind(id, kind);
  }
}

async function gapsRejudge(id: number): Promise<ApiResponse> {
  const row = db.handle().query("SELECT question FROM doc_gaps WHERE id = ?").get(id);
  if (!row) return { error: "not found" };
  const kind = await report.judgeGap(row.question);
  if (kind) db.setGapKind(id, kind);
  return { id, kind: kind || "unknown" };
}

function silenceList(): ApiResponse {
  const details = db.metricDetails("silent");
  return {
    breakdown: details.map((d: MetricDetailRow) => ({ reason: d.detail, count: d.count })),
    total: details.reduce((sum: number, d: { detail: string | null; count: number }) => sum + d.count, 0),
  };
}

function knowledgeInfo(): ApiResponse {
  const sources = knowledge.loadSources().map((s: SourceRow) => ({
    name: s.name,
    type: s.type,
    url: publicSourceUrl(s.url),
    ...sourceHealthShape(s),
  }));

  const corpus = knowledge.getCorpus();
  const index = knowledge.getIndex();

  return {
    sources,
    metrics: sourceHealthMetrics(),
    corpusLength: corpus.length,
    chunkCount: index.docs.length,
    lastBuilt: knowledge.lastBuiltAt?.toISOString() || null,
    lastBuiltRelative: relativeTime(knowledge.lastBuiltAt?.getTime()),
  };
}

function sourceHealthMetrics(): Record<string, number> {
  const counts = Object.fromEntries(db.metricCounts().map((row: MetricCountRow) => [row.kind, row.count]));
  return {
    sourceRefreshFailure: counts.source_refresh_failure || 0,
    staleDynamicSourceUsed: counts.stale_dynamic_source_used || 0,
  };
}

function sourceHealthShape(source: SourceRow): ApiResponse {
  const health = knowledge.sourceEligibility(source);
  return {
    authority: health.authority,
    freshness: health.freshness,
    lastSuccessAt: health.lastSuccessAt,
    failCount: health.failCount,
    hasLastGood: health.hasLastGood,
    exactClaimsAllowed: health.exactClaimsAllowed,
    eligible: health.eligible,
  };
}

function publicSourceUrl(value: unknown): string | null {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (_) {
    return String(value).split(/[?#]/, 1)[0];
  }
}

function scopedSources(programId: string): ProgramSource[] | null {
  const program = programs.get(programId);
  if (!program) return null;
  const shared = program.sharedSources === false ? [] : programs.shared().sources || [];
  const seen = new Set<string>();
  return [...(program.sources || []), ...shared].filter((source: ProgramSource) => {
    const key = knowledge.sourceCacheKey(source);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function internalKnowledgeHealth(programId: string): ApiResponse {
  const sources = scopedSources(programId);
  if (!sources) return { error: "unknown program" };
  return {
    programId,
    sources: sources.map((source: ProgramSource) => ({
      name: source.name,
      type: source.type,
      url: publicSourceUrl(source.url),
      ...sourceHealthShape(source),
    })),
    metrics: sourceHealthMetrics(),
  };
}

function knowledgeCorpus(): ApiResponse {
  const index = knowledge.getIndex();
  return {
    corpus: knowledge.getCorpus().slice(0, 50000),
    chunks: index.docs.map((d: KnowledgeDoc) => ({
      source: d.chunk.source,
      heading: d.chunk.heading || null,
      text: d.chunk.text.slice(0, 300),
      length: d.chunk.text.length,
      termCount: d.length,
    })),
  };
}

async function knowledgeRefresh(): Promise<void> {
  const before = new Map(
    (knowledge.loadSources() as SourceRow[]).map((source: SourceRow) => [
      knowledge.sourceCacheKey(source),
      knowledge.sourceFreshness(source).failCount,
    ]),
  );
  await knowledge.refreshCorpus(true);
  for (const source of knowledge.loadSources() as SourceRow[]) {
    const key = knowledge.sourceCacheKey(source);
    const beforeFailures = before.get(key) || 0;
    const health = knowledge.sourceFreshness(source);
    for (let i = Number(beforeFailures); i < health.failCount; i += 1) {
      db.recordMetric("source_refresh_failure", null, source.name);
    }
    if (health.authority === "dynamic" && health.freshness === "stale" && health.hasLastGood) {
      db.recordMetric("stale_dynamic_source_used", null, source.name);
    }
  }
}

function cacheList(): ApiResponse {
  const stale = cache.staleCacheEntries(db.CACHE_FRESH_MS, 20);
  const top = cache.topCached(20);

  return {
    known: cache.cachedCount(),
    stale: stale.map((r: CacheEntryRow) => ({
      hash: r.question_hash,
      question: r.question,
      askCount: r.ask_count,
    })),
    top: top.map((r: CacheRow) => ({
      hash: r.question_hash,
      question: r.question,
      askCount: r.ask_count,
      source: r.source,
      ageMs: Date.now() - r.written_at,
      stale: Date.now() - r.written_at > db.CACHE_FRESH_MS,
    })),
  };
}

function cacheBust(hash: string): void {
  cache.forget(hash);
}

function handleTeach(
  question: string,
  answer: string,
  authorId: string,
  programId: string | null = null,
): ApiResponse | boolean {
  if (!question || !answer) return false;
  if (!programId || !programs.get(programId)) return { error: "programId required (an existing program)" };
  return learn.teach({ question, answer, authorId, programId });
}

function reportText(week = 0): ApiResponse {
  return { text: report.reportText(week) };
}

let slackClient: SlackClient | null = null;

function setSlackClient(client: SlackClient): void {
  slackClient = client;
}

async function reportPost(): Promise<boolean> {
  if (!slackClient) return false;
  return report.postWeekly(slackClient);
}

function healthCheck(): ApiResponse {
  const missing = [];
  if (!config.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  return {
    models: {
      answer: config.answer.model,
      answerUrl: config.answer.baseUrl,
      intent: config.intent.model,
      vision: config.vision.model,
    },
    channels: {
      help: config.slack.helpChannel || "not set",
      faq: config.slack.faqChannels,
      autoReply: config.slack.autoReplyChannel || "not set",
      report: config.reportChannel || "not set",
    },
    admins: config.slack.adminUserIds,
    missing,
    dbPath: process.env.PIXIE_DB_PATH || "default (pixie.db)",
  };
}
// No inline source text in the fleet list
function programsList() {
  return programs.all().map((program) => ({
    ...program,
    sources: (program.sources || []).map(({ content: _content, ...source }) => source),
  }));
}

function programSave(prog: ProgramSaveBody): ApiResponse {
  if (!prog || !prog.id || !prog.name) return { error: "id and name are required" };
  programs.saveProgram(prog);
  return { ok: true, program: programs.get(prog.id) };
}

function programRemove(id: string): ApiResponse {
  if (!id) return { error: "id required" };
  programs.removeProgram(id);
  return { ok: true };
}

function programSetPosture(id: string, posture: string): ApiResponse {
  const existing = programs.get(id);
  if (!existing) return { error: "program not found" };
  programs.saveProgram({ ...existing, posture });
  return { ok: true, posture };
}

function ticketsList(programId: string | null = null, status: string | null = null): ApiResponse[] {
  if (programId) {
    return db.getTicketsForProgram(programId, status);
  }
  const queryStr = status
    ? "SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC LIMIT 100"
    : "SELECT * FROM tickets ORDER BY created_at DESC LIMIT 100";
  return status ? db.handle().query(queryStr).all(status) : db.handle().query(queryStr).all();
}

function ticketUpdate(
  id: number,
  status: string,
  assigneeId: string | null = null,
  actorId: string | null = null,
): ApiResponse {
  const map: Record<string, string> = {
    claimed: "claim",
    unclaim: "unclaim",
    resolved: "resolve",
    reopen: "reopen",
    closed: "close",
  };
  const action = map[status];
  if (!action) return { error: `unknown status ${status}` };
  const body: TicketActionBody = { actorId, assigneeId };
  if (action === "claim") body.assigneeId = assigneeId || "admin";
  if (action === "resolve") body.resolution = "resolved via admin dashboard";
  const res = internalTicketAction(id, action, body);
  if (res.error) return res;
  return res;
}

function channelsList() {
  const list = programs.getChannelsList();
  return list.map((ch: ChannelConfigRow) => {
    let msgCount = 0;
    let ticketCount = 0;
    try {
      msgCount =
        db.handle().query("SELECT COUNT(*) as count FROM user_messages WHERE channel = ?").get(ch.channelId)?.count ||
        0;
      ticketCount =
        db.handle().query("SELECT COUNT(*) as count FROM tickets WHERE channel = ?").get(ch.channelId)?.count || 0;
    } catch (e) {
      log.debug(
        "web/api",
        `channel counts query failed for ${ch.channelId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      ...ch,
      msgCount,
      ticketCount,
    };
  });
}

function channelToggle(body: ChannelToggleBody = {}): ApiResponse {
  const { channelId, programId, field, value } = body;
  if (!channelId) return { error: "channelId required" };
  if (!programId) return { error: "programId required" };

  const prog = programs.get(programId) || null;
  if (!prog) return { error: "program not found" };

  if (field === "posture") {
    programs.saveProgram({ ...prog, posture: value });
  } else if (field === "ticketDestination") {
    programs.setChannelTicketDestination(prog.id, channelId);
  } else if (field === "helpChannel") {
    programs.saveProgram({ ...prog, helpChannel: value ? channelId : null });
  } else if (field === "replyEnabled") {
    programs.saveProgram({ ...prog, posture: value ? "active" : "muted" });
  }

  return { ok: true, channels: channelsList() };
}

function channelAdd(body: ChannelAddBody = {}): ApiResponse {
  const { programId, channelId, isHelp } = body;
  if (!channelId) return { error: "channelId required" };
  if (!programId) return { error: "programId required" };
  const ok = programs.addChannelToProgram(programId, channelId.trim(), !!isHelp);
  return { ok, channels: channelsList() };
}

function channelRemove(programId: string, channelId: string): ApiResponse {
  if (!channelId) return { error: "channelId required" };
  if (!programId) return { error: "programId required" };
  const ok = programs.removeChannelFromProgram(programId, channelId);
  return { ok, channels: channelsList() };
}

function internalAuth(req: Request): ApiResponse {
  const token = process.env.PIXIE_INTERNAL_TOKEN;
  if (!token) return { ok: false, status: 404, body: { error: "internal api disabled" } };
  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (presented.length !== token.length) return { ok: false, status: 401, body: { error: "unauthorized" } };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ presented.charCodeAt(i);
  if (diff !== 0) return { ok: false, status: 401, body: { error: "unauthorized" } };
  return { ok: true };
}

function internalHistoryImportProgress(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../ticketBackfill").getProgress(programId);
}

function internalHistoryImportStart(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  if (!slackClient) return { error: "Slack client unavailable" };
  const backfill = require("../ticketBackfill");
  void backfill.startProgramImport(programId, slackClient);
  return { ok: true, started: true, progress: backfill.getProgress(programId) };
}

function ticketActorAllowed(programId: string, actorId: string | null): boolean {
  try {
    return require("../tickets").isActorAllowed(programId, actorId, false);
  } catch (_) {
    return false;
  }
}

function needProgram(programId: string): ApiResponse | null {
  if (!programs.get(programId)) return { error: "unknown program" };
  return null;
}

function needProgramActor(programId: string | null, actorId: string | null): ApiResponse | null {
  if (!programs.get(programId)) return { error: "unknown program" };
  if (!ticketActorAllowed(programId as string, actorId)) return { error: "actor is not a helper of this program" };
  return null;
}

function programThreadTs(programId: string | null, threadTs: string | null | undefined): string | null {
  if (!programId || !threadTs) return null;
  return db.getTicketByThreadTs(threadTs, null, programId) ? threadTs : null;
}

function ticketTenantError(ticket: Ticket, body: TicketActionBody = {}): string | null {
  if (body.programId && body.programId !== ticket.program_id) return "program mismatch";
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) return "workspace mismatch";
  return null;
}

function ticketDetail(id: number, programId?: string | null): ApiResponse | null {
  const ticket = db.getTicket(id);
  if (!ticket) return null;
  if (programId !== undefined && programId !== ticket.program_id) return { error: "program mismatch" };
  const resolutionSummary = ticket.resolution_summary || null;
  return {
    ticket: { ...ticket, resolutionSummary },
    resolutionSummary,
    events: db.listTicketEvents(id),
    notes: db.listTicketNotes(id),
  };
}

const CHANNEL_KINDS = new Set(["help", "organizer", "discussion", "announcement"]);

function internalProgramSync(id: string, body: ProgramSyncBody = {}): ApiResponse {
  if (!id || !/^[a-z0-9][a-z0-9-]{1,60}[a-z0-9]$/.test(id)) {
    return { error: "invalid program id (lowercase slug, 3-62 chars)" };
  }
  const {
    programChannels = [],
    behavior: behaviorPatch,
    status: statusValue,
    lifecycle: lifecycleValue,
    ...fields
  } = body;
  if (!fields.name || String(fields.name).length > 80) return { error: "name is required (max 80 chars)" };

  const programModel = require("../programModel");
  if (statusValue !== undefined && statusValue !== null && !programModel.STATUSES.includes(statusValue)) {
    return { error: `invalid status ${statusValue} (sandbox|live|paused)` };
  }
  if (lifecycleValue !== undefined && lifecycleValue !== null && !lifecycle.LIFECYCLES.includes(lifecycleValue)) {
    return { error: `invalid lifecycle ${lifecycleValue}` };
  }
  if (lifecycleValue !== undefined && lifecycleValue !== null) {
    return { error: "lifecycle changes require POST /programs/:id/lifecycle" };
  }

  const routing = require("../routing");
  const channels = Array.isArray(programChannels) ? programChannels : [];
  const workspaceId = fields.workspaceId || null;

  const existing = programs.get(id);
  const merged = {
    ...(existing || { id, links: {} }),
    ...fields,
    id,
    deploymentMode: "hosted_shared",
    supportActive: fields.supportActive === false ? false : true,
  };
  if (Object.hasOwn(body, "behavior")) {
    merged.behavior = programModel.mergeBehavior(existing?.behavior || null, behaviorPatch);
  }
  if (statusValue !== undefined && statusValue !== null) merged.status = statusValue;
  if (!existing && !merged.lifecycle) merged.lifecycle = "draft";

  const roleCheck = validateSyncChannelRoles(id, merged, channels, workspaceId);
  if (roleCheck) return roleCheck;
  programs.saveProgram(merged);
  const semanticKeys = ["sources", "behavior", "pinnedRules", "requireGroundedAnswer", "aiAnswers", "autoEscalate"];
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const changed =
    existing &&
    semanticKeys.some(
      (key) =>
        Object.hasOwn(body, key) &&
        stable((merged as Record<string, unknown>)[key]) !== stable((existing as Record<string, unknown>)[key]),
    );
  if (changed) {
    lifecycle.contentChanged(id, body.actorId || body.claimedBy || null);
  }

  if (channels.length > 0) {
    for (const ch of channels) {
      const kind = typeof ch === "object" ? ch.kind || "help" : "help";
      if (!CHANNEL_KINDS.has(kind) && kind !== "release") return { error: `invalid channel kind ${kind}` };
    }
    for (const ch of channels) {
      if (typeof ch === "object" && ch.kind === "release" && ch.id) {
        try {
          db.releaseProgramChannel({ workspaceId, channelId: ch.id, programId: id });
        } catch (e) {
          log.warn("web/api", `channel release failed (${ch.id}): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const toClaim = channels.filter((ch) => !(typeof ch === "object" && ch.kind === "release"));
    const claim = routing.claimChannelsForProgram({
      workspaceId,
      programId: id,
      channels: toClaim,
      claimedBy: body.claimedBy || null,
    });
    if (!claim.ok) {
      return {
        error: `channel ${claim.conflictChannel} is already owned by program ${claim.ownerProgramId}`,
        status: 409,
        conflictChannel: claim.conflictChannel,
      };
    }
  }

  if (body.claimedBy) {
    try {
      db.syncHelper({ programId: id, userId: body.claimedBy, source: "creator", role: "organizer" });
    } catch (e) {
      log.warn(
        "web/api",
        `creator helper sync failed (${body.claimedBy}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  try {
    require("../audit").record({
      programId: id,
      actorId: body.claimedBy || null,
      action: existing ? "program.updated" : "program.created",
      entityType: "program",
      entityId: id,
    });
  } catch (error) {
    log.warn("web/api", `program audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    require("../knowledge").invalidate();
  } catch (error) {
    log.warn("web/api", `knowledge invalidation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, program: programs.get(id) };
}

function bodyWithin(body: Record<string, unknown>, max = 350_000): ApiResponse | null {
  try {
    if (JSON.stringify(body).length > max) return { error: `request too large (max ${max} bytes)`, status: 413 };
  } catch (_) {
    return { error: "invalid request body" };
  }
  return null;
}

function internalProgramInspect(programId: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const missing = needProgram(programId);
  if (missing) return Promise.resolve(missing);
  const oversized = bodyWithin(body, 20_000);
  if (oversized) return Promise.resolve(oversized);
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim()) return Promise.resolve({ error: "question required" });
  if (question.length > 2000) return Promise.resolve({ error: "question too long (max 2000 chars)" });
  return inspector
    .inspect(programId, question, { role: typeof body.role === "string" ? body.role : undefined })
    .then((result: ApiResponse) => result)
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
}

function internalProgramDocs(programId: string, section: string | null = null): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  try {
    return { docs: section ? programDocs.listBySection(programId, section, false) : programDocs.listDocs(programId) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function internalProgramDoc(programId: string, docId: number): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const doc = programDocs.getDoc(programId, docId);
  return doc ? { doc } : { error: "document not found" };
}

function internalProgramDocUpsert(
  programId: string,
  docId: number | null,
  body: Record<string, unknown> = {},
): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const oversized = bodyWithin(body);
  if (oversized) return oversized;
  try {
    const input = { ...body, updatedBy: body.updatedBy || body.updated_by || body.actorId || "internal" };
    const doc =
      docId === null ? programDocs.createDoc(programId, input) : programDocs.updateDoc(programId, docId, input);
    if (!doc) return { error: "document not found" };
    return { ok: true, doc };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function internalProgramDocDelete(programId: string, docId: number): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return programDocs.deleteDoc(programId, docId) ? { ok: true } : { error: "document not found" };
}

function internalProgramDocSupersede(
  programId: string,
  docId: number,
  body: Record<string, unknown> = {},
): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const oversized = bodyWithin(body);
  if (oversized) return oversized;
  try {
    const doc = programDocs.supersedeDoc(programId, docId, {
      ...body,
      updatedBy: body.updatedBy || body.updated_by || body.actorId || "internal",
    });
    return doc ? { ok: true, doc } : { error: "document not found" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function internalProgramEvalCases(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return { cases: evalHarness.listCases(programId, false) };
}

function internalProgramEvalCaseCreate(programId: string, body: Record<string, unknown> = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const oversized = bodyWithin(body, 50_000);
  if (oversized) return oversized;
  try {
    return { ok: true, case: evalHarness.createCase(programId, body) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function internalProgramEvalCaseDelete(programId: string, caseId: number): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return evalHarness.deleteCase(programId, caseId) ? { ok: true } : { error: "eval case not found" };
}

function internalProgramEvalRun(programId: string, body: Record<string, unknown> = {}): Promise<ApiResponse> {
  const missing = needProgram(programId);
  if (missing) return Promise.resolve(missing);
  return evalHarness
    .run(
      programId,
      typeof body.triggeredBy === "string" ? body.triggeredBy : typeof body.actorId === "string" ? body.actorId : null,
    )
    .then((result: ApiResponse) => result)
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
}

function internalProgramEvalRuns(programId: string, limit: string | number | null = null): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return { runs: evalHarness.runs(programId, Number(limit) || 50) };
}

function internalProgramLifecycle(programId: string, body: Record<string, unknown> = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  if (typeof body.to !== "string") return { error: "to required" };
  return lifecycle.transition(programId, body.to, typeof body.actorId === "string" ? body.actorId : null);
}

function internalProgramLiveTest(programId: string, body: Record<string, unknown> = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return lifecycle.setLiveTest(
    programId,
    String(body.status || ""),
    typeof body.actorId === "string" ? body.actorId : null,
    typeof body.note === "string" ? body.note : null,
  );
}

function internalProgramPurge(programId: string, body: Record<string, unknown> = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  if (body.archive !== true) return { error: "archive must be true" };
  if (lifecycle.current(programId) !== "archived") return { error: "program must be archived before purge" };
  try {
    const purge = require("../programPurge");
    if (typeof purge.purgeProgram !== "function") return { error: "purge unavailable", status: 501 };
    return purge.purgeProgram(db.handle(), programId, { dryRun: body.dryRun === true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "MODULE_NOT_FOUND")
      return { error: "purge unavailable", status: 501 };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function internalProgramTraces(programId: string, query: Record<string, string> = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const traceStore = require("../pipeline/traceStore");
  const traces = traceStore.list(programId, {
    limit: Number(query.limit) || 100,
    decision: query.decision || "",
    q: query.q || "",
  });
  const summary: Record<string, number> = {};
  for (const trace of traces) {
    const decision = typeof trace.payload?.decision === "string" ? trace.payload.decision : trace.stage;
    summary[decision] = (summary[decision] || 0) + 1;
  }
  return { traces, summary };
}

function internalProgramTrace(programId: string, traceId: number): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const trace = require("../pipeline/traceStore").get(programId, traceId);
  return trace ? { trace } : { error: "trace not found" };
}

function validateSyncChannelRoles(
  id: string,
  merged: ProgramSyncBody,
  channels: Array<string | ChannelRoleBody>,
  workspaceId: string | null,
): ApiResponse | null {
  const programModel = require("../programModel");
  const releases = new Set<string>();
  const toClaim = [];
  for (const ch of channels) {
    const channelId = typeof ch === "string" ? ch : ch?.id;
    const kind = typeof ch === "object" ? ch.kind || "help" : "help";
    if (!channelId) continue;
    if (kind === "release") releases.add(channelId as string);
    else toClaim.push({ id: channelId as string, kind });
  }
  let helpChannel = merged.helpChannel || null;
  let organizerChannel = merged.organizerChannel || null;
  let mainChannels = new Set<string>((merged.channels || []) as string[]);
  if (toClaim.length > 0) {
    const helpEntry = toClaim.find((c) => c.kind === "help");
    if (helpEntry) helpChannel = helpEntry.id as string;
    const orgEntry = toClaim.find((c) => c.kind === "organizer");
    if (orgEntry) organizerChannel = orgEntry.id as string;
    mainChannels = new Set(
      toClaim.filter((c) => c.kind !== "help" && c.kind !== "organizer").map((c) => c.id as string),
    );
  }
  for (const released of releases) mainChannels.delete(released);
  if (helpChannel) mainChannels.delete(helpChannel);
  if (organizerChannel) mainChannels.delete(organizerChannel);

  const candidate = {
    id,
    workspaceId: merged.workspaceId || workspaceId || null,
    helpChannel,
    organizerChannel,
    channels: [...mainChannels],
  };
  const rest = programs.all().filter((p: Program) => p && p.id !== id && p.id !== programs.shared().id);
  let claims: ChannelClaimRow[] = [];
  try {
    claims = (db.listChannelClaims?.() || []).filter((c: ChannelClaimRow) => c.program_id !== id);
  } catch (_) {
    claims = [];
  }
  const { config: liveConfig } = require("../config");
  const check = programModel.validateChannelRoles({
    programs: [...rest, candidate],
    legacyHelp: liveConfig?.slack?.helpChannel || null,
    legacyMain: liveConfig?.slack?.faqChannels || [],
    claims,
  });
  if (check.ok) return null;
  const first = check.errors[0];
  return {
    error: `channel ${first.channelId} conflicts with another program: ${first.message}`,
    status: 409,
    conflictChannel: first.channelId,
  };
}

function sourceNamesFromContextLegacy(context: string): string[] {
  const names: string[] = [];
  for (const line of String(context || "").split("\n")) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function testQuestionExpectedAction({
  program,
  role,
  settings,
  addressed = false,
  engagement,
  grounded,
  hasAnswer = false,
}: {
  program: Program;
  role: string;
  settings: TestQuestionSettings;
  addressed?: boolean;
  engagement: EngagementResult;
  grounded: boolean;
  hasAnswer?: boolean;
}): ApiResponse {
  const messagePolicy = require("../pipeline/messagePolicy");
  const plan = messagePolicy.planEngagement({ role, settings, addressed, engagement });
  if (!plan.proceed) return { expectedAction: "silence", reason: plan.reason };
  const aiOff = program?.aiAnswers === false || (role === "help" && settings?.aiReplies === false);
  let action =
    aiOff && plan.kind === "program"
      ? role === "help" && settings?.escalateUnknown !== false
        ? "escalate"
        : addressed
          ? "uncertain"
          : "silence"
      : messagePolicy.finalAction({ role, settings, addressed, kind: plan.kind, grounded, hasAnswer, unclear: false });
  if (action.startsWith("escalate")) {
    const policy = require("../tickets/policy").ticketPolicy({ program, role });
    const human = policy.recordTicket || policy.pingHelpers;
    action = human
      ? "escalate"
      : action === "escalate_and_reply_chat"
        ? "reply_chat"
        : addressed
          ? "uncertain"
          : "silence";
  }
  const map: Record<string, string> = {
    reply: "reply",
    reply_chat: "reply",
    uncertain: "uncertain",
    escalate: "ticket+helper",
    silence: "silence",
  };
  return { expectedAction: map[action] || "silence", reason: plan.reason };
}

function sourceNamesFromContext(context: string): string[] {
  const names: string[] = [];
  for (const line of String(context || "").split("\n")) {
    const match = line.match(/^###\s+(.+?)\s*$/);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

async function internalTestQuestionImpl(programId: string, body: TestQuestionBody = {}): Promise<ApiResponse> {
  const program = programs.get(programId);
  if (!program) return { error: "unknown program" };
  const question = String(body.question || "").trim();
  if (!question) return { error: "question required" };
  if (question.length > 1000) return { error: "question too long (max 1000 chars)" };

  let role: string = ["main", "help", "organizer"].includes(body.role || "") ? body.role || "help" : "help";
  if (body.channelId) {
    try {
      const resolved = require("../channelPolicy").resolve(
        body.channelId,
        body.workspaceId || program.workspaceId || null,
        {},
      );
      if (resolved && ["help", "main", "organizer"].includes(resolved.role)) role = resolved.role;
    } catch (_) {}
  }
  const addressed = body.addressed === true;
  const behavior = require("../programModel").behaviorFor(program);
  const settings =
    role === "help"
      ? behavior.help
      : role === "organizer"
        ? { ...behavior.main, ambientProgramReplies: false, ticketsEnabled: false, helperEscalationEnabled: false }
        : behavior.main;

  let engagement = { engage: false, intent: null, error: "unavailable", source: null };
  try {
    engagement = await require("../pipeline/engagement").classify({
      message: question,
      program,
      role,
      addressed,
      noTelemetry: true,
    });
  } catch (_) {}

  let context = "";
  try {
    context = require("../knowledge").getContext(question, programId) || "";
  } catch (_) {
    context = "";
  }
  const sources = sourceNamesFromContext(context);

  let retrieval: Array<{ source: string; heading: string; lexical: number; semantic: number; total: number }> = [];
  try {
    const index = require("../knowledge").getIndex(programId);
    retrieval = retrieve
      .scoreDetailed(index, question)
      .slice(0, 10)
      .map(
        (entry: {
          chunk: { source?: string; heading?: string };
          lexical: number;
          semantic: number;
          total: number;
        }) => ({
          source: String(entry.chunk?.source || ""),
          heading: String(entry.chunk?.heading || ""),
          lexical: Number(entry.lexical.toFixed(4)),
          semantic: Number(entry.semantic.toFixed(4)),
          total: Number(entry.total.toFixed(4)),
        }),
      );
  } catch (_) {}

  let result = null;
  try {
    result = await require("../lookup").lookupAnswer(question, "", program, null, {
      skipCache: true,
      noTelemetry: true,
    });
  } catch (error) {
    log.warn("web/api", "test-question lookup failed");
    result = null;
  }
  let grounding = result?.verification || null;
  if (!grounding) {
    const evidence = sourceNamesFromContext(context).map((source) => ({
      id: `${source}#probe`,
      programId,
      sourceName: source,
      text: context,
      authority: "source",
      kind: "source",
    }));
    grounding = claimVerifier.verifyAnswerSync({ programId, answer: result?.answer || "", evidence });
  }
  const grounded = grounding.sendable === true;

  const decided = testQuestionExpectedAction({
    program,
    role,
    settings,
    addressed,
    engagement,
    grounded,
    hasAnswer: Boolean(result?.answer),
  });
  return {
    ok: true,
    programId,
    role,
    addressed,
    intent: engagement.intent || null,
    engaged: Boolean(engagement.engage),
    classifierError: engagement.error || null,
    sources,
    retrieval,
    grounding,
    grounded,
    expectedAction: decided.expectedAction,
    reason: decided.reason,
    why:
      decided.expectedAction === "reply"
        ? "Pixie has a supported answer and would reply."
        : decided.expectedAction === "ticket+helper"
          ? "Pixie could not verify a sendable answer, so it would escalate to a helper."
          : decided.expectedAction === "uncertain"
            ? "Pixie would acknowledge uncertainty without guessing."
            : "The engagement policy says to stay silent for this message.",
    answerPreview:
      decided.expectedAction === "reply" && result && result.answer ? String(result.answer).slice(0, 500) : null,
  };
}

async function internalTestQuestion(programId: string, body: TestQuestionBody = {}): Promise<ApiResponse> {
  return llm.withNoTelemetry(() => internalTestQuestionImpl(programId, body));
}

function internalTicketSearch(params: TicketSearchParams): ApiResponse {
  if (!params.programId) return { error: "programId required" };
  return db.searchTickets({
    programId: params.programId,
    status: params.status || null,
    assigneeId: params.assigneeId || null,
    requesterId: params.requesterId || null,
    category: params.category || null,
    priority: params.priority || null,
    q: params.q || null,
    sinceMs: params.since ? Number(params.since) : null,
    untilMs: params.until ? Number(params.until) : null,
    limit: params.limit || 50,
    offset: params.offset || 0,
  });
}

function internalTicketAction(id: number, action: string, body: TicketActionBody = {}): ApiResponse {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }

  const tickets = require("../tickets");
  const base = {
    programId: body.programId || null,
    workspaceId: body.workspaceId || null,
    client: slackClient || null,
  };
  const source = body.source || "dashboard";
  let res = null;
  switch (action) {
    case "claim":
      res = tickets.claimTicket({
        ticketId: id,
        actorId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "assign":
      if (!body.assigneeId) return { error: "assigneeId required" };
      res = tickets.assignTicket({
        ticketId: id,
        actorId,
        assigneeId: body.assigneeId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "unclaim":
      res = tickets.unclaimTicket({
        ticketId: id,
        actorId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "resolve":
      res = tickets.resolveTicket({
        ticketId: id,
        actorId,
        resolution: body.resolution || null,
        source,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "reopen":
      res = tickets.reopenTicket({
        ticketId: id,
        actorId,
        source,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "close":
      res = tickets.closeTicket({
        ticketId: id,
        actorId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "snooze":
      res = tickets.snoozeTicket({
        ticketId: id,
        actorId,
        until: body.until,
        programId: base.programId,
        workspaceId: base.workspaceId,
      });
      break;
    case "duplicate":
      res = tickets.duplicateTicket({
        ticketId: id,
        actorId,
        canonicalId: body.canonicalId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    case "escalate":
      res = tickets.escalateStatusTicket({
        ticketId: id,
        actorId,
        programId: base.programId,
        workspaceId: base.workspaceId,
        client: base.client,
      });
      break;
    default:
      return { error: `unknown action ${action}` };
  }
  if (res.error) return res;
  return { ok: true, ticket: ticketDetail(id) };
}

async function internalTicketReply(id: number, body: TicketActionBody = {}): Promise<ApiResponse> {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (!slackClient) return { error: "slack client unavailable" };
  const tickets = require("../tickets");
  return tickets.replyToTicket({
    ticketId: id,
    authorId: actorId,
    text: body.text,
    client: slackClient,
    programId: body.programId,
    workspaceId: body.workspaceId,
    source: "dashboard",
  });
}

function internalTicketNote(id: number, body: TicketActionBody = {}): ApiResponse {
  const ticket = db.getTicket(id);
  if (!ticket) return { error: "ticket not found" };
  if (body.programId && body.programId !== ticket.program_id) {
    return { error: "program mismatch" };
  }
  if (body.workspaceId && ticket.workspace_id && body.workspaceId !== ticket.workspace_id) {
    return { error: "workspace mismatch" };
  }
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(ticket.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const tickets = require("../tickets");
  return tickets.addInternalNote({
    ticketId: id,
    authorId: actorId,
    body: body.body,
    programId: body.programId,
    workspaceId: body.workspaceId,
  });
}

function internalHelpersSync(programId: string, body: HelperSyncBody = {}): ApiResponse {
  if (!programs.get(programId)) return { error: "unknown program" };
  const actorId = body.actorId || null;
  const { isAdmin } = require("../config");
  if (!(actorId && (isAdmin(actorId) || db.isHelper(programId, actorId)))) {
    return { error: "actor is not a helper of this program" };
  }
  const source = body.source || "organizer_channel";
  const members = Array.isArray(body.members) ? body.members : [];
  const seen = new Set<string>();
  for (const userId of members) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    db.syncHelper({ programId, userId, source, role: "helper" });
  }
  const notPinged = new Set<string>((Array.isArray(body.pingIneligible) ? body.pingIneligible : []) as string[]);
  if (Array.isArray(body.pingIneligible)) {
    for (const userId of seen) db.setHelperPingEligible({ programId, userId, eligible: !notPinged.has(userId) });
  }
  if (body.reconcile) {
    for (const row of db.listHelpers(programId) as HelperRow[]) {
      const userId = row.user_id as string;
      if (row.helper_source === source && !seen.has(userId)) {
        db.removeHelper({ programId, userId });
      }
    }
  }
  return { ok: true, helpers: db.listHelpers(programId) };
}

async function internalCopilot(action: string, body: CopilotBody = {}): Promise<ApiResponse> {
  const copilot = require("../copilot");
  const programId = body.programId || null;
  const actorId = body.actorId || null;
  const denied = needProgramActor(programId, actorId);
  if (denied) return denied;
  const program = programs.get(programId);
  const budget = copilot.checkBudget(actorId || "unknown");
  if (budget) return budget;

  try {
    switch (action) {
      case "draft": {
        if (!body.question) return { error: "question required" };
        const res = await copilot.draftReply({
          program,
          question: body.question,
          threadTs: programThreadTs(programId, body.threadTs),
        });
        copilot.auditCopilot(programId, actorId, "draft", { grounded: res.grounded });
        return res;
      }
      case "improve": {
        const res = await copilot.improveReply({ text: body.text });
        if (res.error) return res;
        copilot.auditCopilot(programId, actorId, "improve", { changed: res.changed });
        return res;
      }
      case "summarize": {
        const ticket = body.ticketId ? db.getTicket(Number(body.ticketId)) : null;
        if (body.ticketId && (!ticket || ticket.program_id !== programId))
          return { error: "ticket not found in this program" };
        return copilot.summarizeThread({
          program,
          ticket,
          threadTs: programThreadTs(programId, body.threadTs) || (ticket && ticket.thread_ts) || null,
        });
      }
      case "factcheck": {
        if (!body.text) return { error: "text required" };
        return copilot.factCheck({ program, text: body.text });
      }
      case "similar": {
        if (!body.question) return { error: "question required" };
        return copilot.findSimilar({ programId, question: body.question, limit: body.limit });
      }
      case "ask": {
        if (!body.question) return { error: "question required" };
        const res = await copilot.ask({
          program,
          question: body.question,
          threadTs: programThreadTs(programId, body.threadTs),
        });
        copilot.auditCopilot(programId, actorId, "ask", { grounded: res.grounded });
        return res;
      }
      default:
        return { error: `unknown copilot action ${action}` };
    }
  } catch (e) {
    log.warn("api", `copilot ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { error: "copilot unavailable right now" };
  }
}

function internalKnowledgeCandidates(programId: string, status: string | null = null): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const memory = require("../resolutionMemory");
  return memory.listCandidates(programId, status || memory.CANDIDATE, 50);
}

async function internalKnowledgePropose(programId: string, body: KnowledgeProposeBody = {}): Promise<ApiResponse> {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const memory = require("../resolutionMemory");
  const ticket = body.ticketId ? db.getTicket(Number(body.ticketId)) : null;
  if (!ticket || ticket.program_id !== programId) return { error: "ticket not found in this program" };
  return memory.proposeFromTicket({ ticketId: ticket.id, actorId: body.actorId || null });
}

function internalKnowledgeCandidateAction(id: number, body: CandidateActionBody = {}): ApiResponse {
  const memory = require("../resolutionMemory");
  const actorId = body.actorId || null;
  const row = db.getLearnedFactById(Number(id));
  if (!row) return { error: "candidate not found" };
  const programId = row.program_id;
  if (!programId || !ticketActorAllowed(programId, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  if (body.action === "approve") return memory.approveCandidate({ id: Number(id), actorId, edits: body.edits || {} });
  if (body.action === "reject") return memory.rejectCandidate({ id: Number(id), actorId });
  return { error: `unknown action ${body.action}` };
}

function internalGapClusters(programId: string, query: GapClusterQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const clusters = require("../gapClusters");
  return clusters.clusterGaps({
    programId,
    sinceMs: query.sinceMs ? Number(query.sinceMs) : undefined,
    minAskers: query.minAskers ? Number(query.minAskers) : undefined,
  });
}

async function internalFaqPropose(programId: string, body: FaqProposeBody = {}): Promise<ApiResponse> {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const clusters = require("../gapClusters");
  return clusters.proposeFaq({ programId, actorId: body.actorId || null, question: body.question });
}

function macroScope(
  id: number,
  actorId: string | null,
): { error: string; macro?: never } | { error?: never; macro: MacroRow } {
  const macros = require("../macros");
  const macro = macros.get(Number(id));
  if (!macro) return { error: "macro not found" };
  if (!ticketActorAllowed(macro.program_id, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  return { macro };
}

function internalMacrosList(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const macros = require("../macros");
  return macros.list(programId, { enabledOnly: query.enabledOnly === "1", q: query.q || null });
}

function internalMacroCreate(programId: string, body: MacroBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const macros = require("../macros");
  const { onSendTransition, on_send_transition, ...fields } = body;
  const transition = onSendTransition !== undefined ? onSendTransition : on_send_transition;
  return macros.create({
    programId,
    ...fields,
    onSendTransition: transition === undefined ? null : transition,
    createdBy: body.actorId || null,
  });
}

function internalMacroUpdate(id: number, body: MacroBody = {}): ApiResponse {
  const scoped = macroScope(id, body.actorId || null);
  if ("error" in scoped) return scoped;
  const { actorId, onSendTransition, on_send_transition, ...patch } = body;
  if (onSendTransition !== undefined || on_send_transition !== undefined) {
    patch.on_send_transition = onSendTransition !== undefined ? onSendTransition : on_send_transition;
  }
  return require("../macros").update(Number(id), patch, actorId || null);
}

function internalMacroDelete(id: number, body: MacroBody = {}): ApiResponse {
  const scoped = macroScope(id, body.actorId || null);
  if ("error" in scoped) return scoped;
  return require("../macros").remove(Number(id), body.actorId || null);
}

async function internalMacroSend(id: number, body: MacroBody = {}): Promise<ApiResponse> {
  const scoped = macroScope(id, body.actorId || null);
  if ("error" in scoped) return scoped;
  if (!body.ticketId) return { error: "ticketId required" };
  if (!slackClient) return { error: "slack client unavailable" };
  return require("../macros").send({
    id: Number(id),
    ticketId: Number(body.ticketId),
    actorId: body.actorId || null,
    client: slackClient,
  });
}

async function internalMacroBulkSend(id: number, body: MacroBody = {}): Promise<ApiResponse> {
  const scoped = macroScope(id, body.actorId || null);
  if ("error" in scoped) return scoped;
  if (!slackClient) return { error: "slack client unavailable" };
  let ticketIds = body.ticketIds;
  if (!Array.isArray(ticketIds) && body.selector === "waiting_for_helper") {
    ticketIds = require("../macros").waitingTicketIds({
      programId: scoped.macro.program_id,
      category: body.category || null,
    });
  }
  if (!Array.isArray(ticketIds)) return { error: "ticketIds must be an array" };
  return require("../macros").sendBulk({
    macroId: Number(id),
    ticketIds,
    actorId: body.actorId || null,
    client: slackClient,
  });
}

function internalMacroTemplates(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgramActor(programId, query.actorId || null);
  if (missing) return missing;
  const macros = require("../macros");
  return { templates: macros.suggestedTemplates(), placeholders: macros.placeholderDocs() };
}

function internalMacroWaiting(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgramActor(programId, query.actorId || null);
  if (missing) return missing;
  const ticketIds = require("../macros").waitingTicketIds({ programId, category: query.category || null });
  return { programId, category: query.category || null, ticketIds, count: ticketIds.length };
}

function internalMacroSuggest(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../macros").suggestFor({
    programId,
    question: query.q || "",
    limit: query.limit ? Number(query.limit) : 3,
  });
}

function internalRoutingRecommend(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../helperRoute").recommend({
    programId,
    category: query.category || null,
    limit: query.limit ? Number(query.limit) : 3,
  });
}

function internalHelperStats(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const stats = require("../helperStats").listHelperStats(programId, {
    recentLimit: Math.min(Math.max(Number(query.recentLimit) || 20, 1), 100),
    since: query.since ? Number(query.since) : Date.now() - 30 * 86400000,
  });
  const program = require("../assignmentLifecycle").programAcceptStats(programId);
  return {
    programId,
    acceptRate: program.acceptRate,
    acceptedAssignments: program.acceptedAssignments,
    completedOffers: program.completedOffers,
    assignmentLifecycle: program.assignmentLifecycle,
    helpers: stats,
  };
}

function internalLeaderboard(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return {
    programId,
    days,
    leaderboard: require("../ticketMetrics").leaderboard(programId, { since: Date.now() - days * 86400000 }),
  };
}

function internalShadowRouting(programId: string, query: MacroQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return { programId, mode: "shadow", decisions: require("../shadowRouting").list(programId, query.limit) };
}

async function internalDraftSync(programId: string, body: DraftSyncBody = {}): Promise<ApiResponse> {
  const draft = body.draft || {};
  if (programId !== draft.id) return { error: "draft id mismatch" };
  if (draft.status !== "suspended" || draft.privateSandboxOnly !== true)
    return { error: "only private suspended drafts may sync" };
  if (draft.autoAssign === true || draft.ticketsEnabled === true) return { error: "draft safety flags invalid" };
  const bindings = Array.isArray(draft.sandboxBindings) ? draft.sandboxBindings : [];
  for (const binding of bindings) {
    if (
      binding.sandboxOnly !== true ||
      binding.enabled !== true ||
      !["help", "ticket"].includes(binding.role as string)
    )
      return { error: "invalid sandbox binding" };
    if (db.getChannelOwner(draft.workspaceId || "default", binding.channelId))
      return { error: `sandbox channel ${binding.channelId} has a production claim` };
  }
  try {
    const result = await require("../knowledge").ingestDraftSources(draft);
    return {
      ok: true,
      programId,
      ...result,
      bindings: require("../draftSandbox")
        .bindingRows()
        .filter((row: DraftBindingRow) => row.program_id === programId),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "draft ingestion failed" };
  }
}

function internalRoutingExpertise(programId: string, body: RoutingBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const actorId = body.actorId || null;
  if (!body.userId) return { error: "userId required" };
  const tags = require("../helperRoute").setExpertise({ programId, userId: body.userId, tags: body.tags || [] });
  try {
    require("../audit").record({
      programId,
      actorId,
      action: "routing.expertise_updated",
      entityType: "helper",
      entityId: body.userId,
    });
  } catch (error) {
    log.warn("web/api", `routing audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, tags };
}

function internalDuplicates(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../incidents").suggestDuplicates({
    programId,
    ticketId: query.ticketId ? Number(query.ticketId) : null,
    question: query.q || "",
    limit: query.limit ? Number(query.limit) : 5,
  });
}

function internalIncidents(programId: string, query: IncidentQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../incidents").listIncidents(
    programId,
    query.status || null,
    query.limit ? Math.min(Number(query.limit) || 50, 200) : 50,
  );
}

function internalIncidentDetail(programId: string, incidentId: number): ApiResponse {
  if (!programId) return { error: "programId required" };
  const missing = needProgram(programId);
  if (missing) return missing;
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId), programId);
  if (!inc) return { error: "incident not found" };
  return { incident: inc, tickets: incidents.incidentTickets(Number(incidentId), programId) };
}

function internalIncidentDetect(programId: string, body: IncidentBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../incidents").detectBursts({ programId });
}

function internalIncidentCreate(programId: string, body: IncidentBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../incidents").createIncident({
    programId,
    title: body.title,
    description: body.description || null,
    publicMessage: body.publicMessage || null,
    actorId: body.actorId || null,
  });
}

function internalIncidentAction(incidentId: number, body: IncidentBody = {}): ApiResponse {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  if (!ticketActorAllowed(inc.program_id, body.actorId || null)) {
    return { error: "actor is not a helper of this program" };
  }
  if (body.action === "link")
    return incidents.linkTicket({
      incidentId: Number(incidentId),
      ticketId: Number(body.ticketId),
      actorId: body.actorId || null,
    });
  if (body.action === "unlink")
    return incidents.unlinkTicket({ incidentId: Number(incidentId), ticketId: Number(body.ticketId) });
  if (body.action === "announcement") return incidents.draftAnnouncement({ incidentId: Number(incidentId) });
  if (body.action === "declare") {
    return incidents.declareIncident({
      incidentId: Number(incidentId),
      actorId: body.actorId || null,
      description: body.description || null,
      publicMessage: body.publicMessage || null,
    });
  }
  return incidents.setIncidentStatus({
    incidentId: Number(incidentId),
    status: body.action,
    actorId: body.actorId || null,
  });
}

async function internalIncidentNotify(incidentId: number, body: IncidentBody = {}): Promise<ApiResponse> {
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId));
  if (!inc) return { error: "incident not found" };
  if (!ticketActorAllowed(inc.program_id, body.actorId || null)) {
    return { error: "actor is not a helper of this program" };
  }
  if (!slackClient) return { error: "slack client unavailable" };
  return incidents.notifyAffectedUsers({
    incidentId: Number(incidentId),
    actorId: body.actorId || null,
    client: slackClient,
    resolutionMessage: body.resolutionMessage || null,
  });
}

function internalIncidentAffected(programId: string, incidentId: number, query: IncidentQuery = {}): ApiResponse {
  if (!programId) return { error: "programId required" };
  const missing = needProgram(programId);
  if (missing) return missing;
  const incidents = require("../incidents");
  const inc = incidents.getIncident(Number(incidentId), programId);
  if (!inc) return { error: "incident not found" };
  const reports = incidents.affectedReports(Number(incidentId), query.onlyUnnotified === "1", programId);
  return {
    total: reports.length,
    unnotified: reports.filter((r: AffectedReportRow) => !r.notified_at).length,
    reports,
  };
}

function internalRadarList(programId: string, query: RadarQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return {
    signals: require("../radar").listSignals(programId, {
      status: query.status || null,
      severity: query.severity || null,
      limit: query.limit,
    }),
  };
}

function internalRadarEvaluate(programId: string, body: CandidateActionBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  return require("../radar").evaluateProgram(programId);
}

function internalRadarAction(signalId: number, body: RadarActionBody = {}): ApiResponse {
  const radar = require("../radar");
  const requireHelper = (programId: string, actorId: string | null) => ticketActorAllowed(programId, actorId);
  const actorId = body.actorId || null;
  if (body.action === "acknowledge") return radar.acknowledgeSignal({ id: Number(signalId), actorId, requireHelper });
  if (body.action === "resolve") return radar.resolveSignal({ id: Number(signalId), actorId, requireHelper });
  if (body.action === "suppress")
    return radar.suppressSignal({ id: Number(signalId), actorId, duration: body.duration, requireHelper });
  return { error: `unknown action ${body.action}` };
}

function internalHealthScore(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../programHealth").computeHealthScore(programId);
}

function internalWaitEstimate(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../waitTime").estimate({
    programId,
    category: query.category || null,
    ticketId: query.ticketId ? Number(query.ticketId) : null,
  });
}

function internalAnalytics(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return require("../supportAnalytics").overview(programId, days * 86400000);
}

function internalUsage(query: AnalyticsQuery = {}): ApiResponse {
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  return { days, rows: db.llmUsageSummary(days * 86400000) };
}

function internalProgramUsage(programId: string, query: AnalyticsQuery = {}): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return db.llmUsageReport({
    programId,
    from: query.from,
    until: query.until,
    bucket: query.bucket || "day",
    operation: query.operation || null,
    limit: query.limit,
    offset: query.offset,
  });
}

function internalSlaCheck(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../sla").checkProgram({ programId });
}

function internalRetentionPreview(programId: string): ApiResponse {
  const missing = needProgram(programId);
  if (missing) return missing;
  return require("../retention").preview(programId);
}

function internalRetentionSweep(programId: string, body: RetentionBody = {}): ApiResponse {
  const actorId = body.actorId || null;
  if (!programs.get(programId)) return { error: "unknown program" };
  const { isAdmin } = require("../config");
  const organizer = (db.listHelpers(programId) as HelperRow[]).find(
    (h: HelperRow) => h.user_id === actorId && (h.role === "organizer" || h.role === "owner"),
  );
  if (!(actorId && (isAdmin(actorId) || organizer))) {
    return { error: "retention sweeps require a program organizer" };
  }
  if (!body.confirm) return { error: "confirm required" };
  return require("../retention").sweepProgram(programId, { dryRun: false });
}

function internalRetentionPolicy(programId: string, body: RetentionBody = {}): ApiResponse {
  const denied = needProgramActor(programId, body.actorId || null);
  if (denied) return denied;
  const problem = require("../retention").validatePolicy(body.policy || {});
  if (problem) return { error: problem };
  const p = body.policy || {};
  const map = {
    contextDays: "retention_context_days",
    ticketsDays: "retention_tickets_days",
    notesDays: "retention_notes_days",
    tracesDays: "retention_traces_days",
    analyticsDays: "retention_analytics_days",
    auditDays: "retention_audit_days",
  };
  const row: RetentionValues = {};
  for (const [key, col] of Object.entries(map)) {
    if (p[key] !== undefined) row[col] = Number(p[key]);
  }
  const cols = Object.entries(row);
  if (cols.length > 0) {
    db.handle()
      .query(`UPDATE programs SET ${cols.map(([c]) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...cols.map(([, v]) => v), Date.now(), programId);
    programs.invalidate();
  }
  try {
    require("../audit").record({
      programId,
      actorId: body.actorId || null,
      action: "retention.policy_updated",
      entityType: "program",
      entityId: programId,
    });
  } catch (error) {
    log.warn("web/api", `retention audit write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ok: true, policy: require("../retention").policyFor(programId) };
}

let slackChannelsCache: { at: number; channels: DashboardChannel[] } = { at: 0, channels: [] };

const userInfoCache = new Map<string, UserInfo>();
const USER_INFO_TTL_MS = 60 * 60 * 1000;
const USER_INFO_MISS_TTL_MS = 5 * 60 * 1000;

function cachedUserInfo(userId: string): UserInfo | null {
  const hit = userInfoCache.get(userId);
  if (!hit) return null;
  const ttl = hit.ok ? USER_INFO_TTL_MS : USER_INFO_MISS_TTL_MS;
  if (Date.now() - hit.at >= ttl) return null;
  return hit;
}

async function internalUserInfo(userId: string): Promise<ApiResponse> {
  if (!userId) return { ok: false, reason: "user id required" };
  const cached = cachedUserInfo(userId);
  if (cached) {
    return cached.ok
      ? {
          ok: true,
          slackId: userId,
          displayName: cached.displayName,
          realName: cached.realName,
          username: cached.username,
          avatarUrl: cached.avatarUrl,
        }
      : { ok: false, slackId: userId, reason: cached.reason };
  }
  const token = config.slack.botToken;
  if (!token && !slackClient) return { ok: false, slackId: userId, reason: "slack not connected" };
  try {
    const client = slackClient || new (require("@slack/web-api").WebClient)(token);
    const res = await client.users.info({ user: userId });
    const u = res.user || {};
    const profile = u.profile || {};
    const displayName = profile.display_name || profile.real_name || u.name || null;
    const realName = profile.real_name || u.real_name || null;
    const username = u.name || null;
    const avatarUrl = profile.image_192 || profile.image_72 || null;
    userInfoCache.set(userId, { at: Date.now(), ok: true, displayName, realName, username, avatarUrl });
    return { ok: true, slackId: userId, displayName, realName, username, avatarUrl };
  } catch (e) {
    const error = e as SlackError;
    const reason = (error && error.message) || "lookup failed";
    userInfoCache.set(userId, { at: Date.now(), ok: false, reason });
    return { ok: false, slackId: userId, reason };
  }
}

const USER_INFO_BATCH_CAP = 200;

async function internalUserInfoBatch(userIds: unknown): Promise<ApiResponse> {
  const ids = [
    ...new Set(
      (Array.isArray(userIds) ? userIds : []).filter(
        (id: unknown): id is string => typeof id === "string" && Boolean(id),
      ),
    ),
  ].slice(0, USER_INFO_BATCH_CAP);
  const users: Record<string, UserInfoPublic | null> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const info = await internalUserInfo(id);
        users[id] = info.ok
          ? {
              slackId: id,
              displayName: info.displayName,
              realName: info.realName,
              username: info.username,
              avatarUrl: info.avatarUrl,
            }
          : null;
      } catch (_) {
        users[id] = null;
      }
    }),
  );
  return { users };
}

let slackChannelsInFlight: Promise<ApiResponse> | null = null;

function slackChannels() {
  if (!slackChannelsInFlight) {
    slackChannelsInFlight = fetchSlackChannels().finally(() => {
      slackChannelsInFlight = null;
    });
  }
  return slackChannelsInFlight;
}

async function fetchSlackChannels(): Promise<ApiResponse> {
  if (!config.slack.botToken) {
    return { ok: false, reason: "no SLACK_BOT_TOKEN in this environment", channels: [] };
  }

  if (slackChannelsCache.channels.length && Date.now() - slackChannelsCache.at < 5 * 60 * 1000) {
    return { ok: true, channels: slackChannelsCache.channels };
  }

  try {
    const { WebClient } = require("@slack/web-api");
    const client = new WebClient(config.slack.botToken);
    const channels: DashboardChannel[] = [];
    let cursor;
    do {
      const res: SlackChannelPage = await client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      for (const ch of res.channels || []) {
        channels.push({ id: ch.id, name: ch.name, isMember: !!ch.is_member });
      }
      cursor = res.response_metadata?.next_cursor;
    } while (cursor);

    channels.sort((a, b) => a.name.localeCompare(b.name));
    slackChannelsCache = { at: Date.now(), channels };
    return { ok: true, channels };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e), channels: [] };
  }
}

async function internalSlackMembership(channelId: string): Promise<ApiResponse> {
  if (!channelId) return { ok: false, hasAccess: false, reason: "channel required" };
  const token = config.slack.botToken;
  if (!token && !slackClient) return { ok: false, hasAccess: false, reason: "slack not connected" };
  try {
    const client = slackClient || new (require("@slack/web-api").WebClient)(token);
    const info = await client.conversations.info({ channel: channelId });
    const ch = info.channel || {};
    return {
      ok: true,
      hasAccess: !!ch.is_member,
      name: ch.name || null,
      isPrivate: !!ch.is_private,
      isArchived: !!ch.is_archived,
    };
  } catch (e) {
    const error = e as SlackError;
    const code = error.code || (error.data && error.data.error);
    if (code === "channel_not_found") return { ok: true, hasAccess: false, reason: "channel_not_found" };
    return { ok: false, hasAccess: false, reason: e instanceof Error ? e.message : "lookup failed" };
  }
}

export = {
  buildPulse,
  handleAsk,
  queueList,
  queueApprove,
  queueDrop,
  queueEdit,
  gapsList,
  gapsMove,
  gapsRejudge,
  silenceList,
  knowledgeInfo,
  knowledgeCorpus,
  knowledgeRefresh,
  cacheList,
  cacheBust,
  handleTeach,
  reportText,
  reportPost,
  setSlackClient,
  healthCheck,
  programsList,
  programSave,
  programRemove,
  programSetPosture,
  ticketsList,
  ticketUpdate,
  channelsList,
  channelToggle,
  channelAdd,
  channelRemove,
  slackChannels,
  internalSlackMembership,
  internalUserInfo,
  internalUserInfoBatch,
  internalAuth,
  internalHistoryImportProgress,
  internalHistoryImportStart,
  ticketDetail,
  internalProgramSync,
  internalProgramInspect,
  internalProgramDocs,
  internalProgramDoc,
  internalProgramDocUpsert,
  internalProgramDocDelete,
  internalProgramDocSupersede,
  internalProgramEvalCases,
  internalProgramEvalCaseCreate,
  internalProgramEvalCaseDelete,
  internalProgramEvalRun,
  internalProgramEvalRuns,
  internalProgramLifecycle,
  internalProgramLiveTest,
  internalProgramPurge,
  internalProgramTraces,
  internalProgramTrace,
  internalTestQuestion,
  testQuestionExpectedAction,
  sourceNamesFromContext,
  internalTicketSearch,
  internalTicketAction,
  internalTicketReply,
  internalTicketNote,
  internalHelpersSync,
  internalCopilot,
  internalKnowledgeCandidates,
  internalKnowledgeHealth,
  internalKnowledgePropose,
  internalKnowledgeCandidateAction,
  internalGapClusters,
  internalFaqPropose,
  internalMacrosList,
  internalMacroTemplates,
  internalMacroWaiting,
  internalMacroCreate,
  internalMacroUpdate,
  internalMacroDelete,
  internalMacroSend,
  internalMacroBulkSend,
  internalMacroSuggest,
  internalRoutingRecommend,
  internalHelperStats,
  internalLeaderboard,
  internalShadowRouting,
  internalDraftSync,
  internalRoutingExpertise,
  internalDuplicates,
  internalIncidents,
  internalIncidentDetail,
  internalIncidentDetect,
  internalIncidentCreate,
  internalIncidentAction,
  internalIncidentNotify,
  internalIncidentAffected,
  internalRadarList,
  internalRadarEvaluate,
  internalRadarAction,
  internalHealthScore,
  internalWaitEstimate,
  internalAnalytics,
  internalUsage,
  internalProgramUsage,
  internalSlaCheck,
  internalRetentionPreview,
  internalRetentionSweep,
  internalRetentionPolicy,
};
