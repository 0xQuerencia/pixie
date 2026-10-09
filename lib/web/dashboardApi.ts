const db = require("../db");
const programs = require("../programs");
const log = require("../log");
const ticketMetrics = require("../ticketMetrics");
import type { Ticket } from "../types";

interface DashboardParams {
  sort?: string;
  dir?: string;
  status?: string;
  statusGroup?: string;
  assigneeId?: string;
  requesterId?: string;
  category?: string;
  priority?: string;
  since?: string | number;
  until?: string | number;
  q?: string;
  limit?: string | number;
  offset?: string | number;
  days?: string | number;
  actorId?: string;
  userId?: string;
  active?: boolean;
  pingEligible?: boolean;
}
interface SearchTicket extends Ticket {
  first_responder_id?: string | null;
  notes_count?: number;
}
interface MetricTicketRow {
  created_at: number;
  first_response_at: number | null;
  first_human_response_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  assignee_id: string | null;
  status: string;
}
interface MetricRow {
  kind: string;
  detail: string | null;
}
interface VolumeDay {
  date: string;
  questions: number;
  aiOnly: number;
  human: number;
}
interface SourceStatusRow {
  name?: string;
  label?: string;
  type?: string;
  url?: string;
  status?: string;
  lastSyncedAt?: number | string | null;
  lastSuccessAt?: number | string | null;
  error?: string | null;
  chunks?: number | null;
}
interface HelperDbRow {
  user_id: string;
  role: string;
  active: number;
  ping_eligible: number;
  helper_source: string;
}
interface HelperStat {
  userId: string;
  expertise: string[];
  categoryResolved: string[];
  totals: { open: number; resolved: number };
  helpfulPercentage: number | null;
  lastActivity: number | null;
}

function needProgram(programId: string): { error: string } | null {
  if (!programId || !programs.get(programId)) return { error: "unknown program" };
  return null;
}

function ticketActorAllowed(programId: string, actorId: string | null): boolean {
  try {
    return require("../tickets").isActorAllowed(programId, actorId, false);
  } catch (_) {
    return false;
  }
}

const OPEN_GROUP = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const RESOLVED_GROUP = ["resolved"];

const SORTS: Record<string, { column: string; dir: string }> = {
  created: { column: "created_at", dir: "DESC" },
  updated: { column: "updated_at", dir: "DESC" },
  waiting: { column: "created_at", dir: "ASC" },
};

function escapeLike(value: unknown): string {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function ticketSearchScoped(programId: string, params: DashboardParams = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const sortKey = typeof params.sort === "string" ? params.sort : "";
  const sort = SORTS[sortKey] ? sortKey : "created";
  const dir = params.dir === "asc" || params.dir === "desc" ? params.dir.toUpperCase() : SORTS[sort].dir;
  const clauses = ["program_id = ?"];
  const values: Array<string | number> = [programId];
  if (params.status) {
    clauses.push("status = ?");
    values.push(params.status);
  } else if (params.statusGroup === "open") {
    clauses.push(`status IN (${OPEN_GROUP.map(() => "?").join(",")})`);
    values.push(...OPEN_GROUP);
  } else if (params.statusGroup === "resolved") {
    clauses.push(`status IN (${RESOLVED_GROUP.map(() => "?").join(",")})`);
    values.push(...RESOLVED_GROUP);
  }
  if (params.assigneeId) {
    clauses.push("assignee_id = ?");
    values.push(params.assigneeId);
  }
  if (params.requesterId) {
    clauses.push("requester_id = ?");
    values.push(params.requesterId);
  }
  if (params.category) {
    clauses.push("category = ?");
    values.push(params.category);
  }
  if (params.priority) {
    clauses.push("priority = ?");
    values.push(params.priority);
  }
  if (params.since) {
    clauses.push("created_at > ?");
    values.push(Number(params.since));
  }
  if (params.until) {
    clauses.push("created_at <= ?");
    values.push(Number(params.until));
  }
  if (params.q) {
    clauses.push("(question LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    values.push(`%${escapeLike(params.q)}%`, `%${escapeLike(params.q)}%`);
  }
  const where = clauses.join(" AND ");
  const safeLimit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(params.offset) || 0, 0);
  const total =
    db
      .handle()
      .query(`SELECT COUNT(*) AS n FROM tickets WHERE ${where}`)
      .get(...values)?.n || 0;
  const rows = db
    .handle()
    .query(`SELECT * FROM tickets WHERE ${where} ORDER BY ${SORTS[sort].column} ${dir} LIMIT ? OFFSET ?`)
    .all(...values, safeLimit, safeOffset) as SearchTicket[];
  if (rows.length === 0) return { total, rows };
  const ids = rows.map((r: SearchTicket) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const firstReplies = db
    .handle()
    .query(
      `SELECT ticket_id, actor_id, MIN(created_at) AS at FROM ticket_events
     WHERE ticket_id IN (${placeholders}) AND event_type = 'helper_reply' GROUP BY ticket_id`,
    )
    .all(...ids);
  const noteCounts = db
    .handle()
    .query(`SELECT ticket_id, COUNT(*) AS n FROM ticket_notes WHERE ticket_id IN (${placeholders}) GROUP BY ticket_id`)
    .all(...ids);
  const firstByTicket = new Map(
    (firstReplies as Array<{ ticket_id: number; actor_id: string | null }>).map((r) => [r.ticket_id, r.actor_id]),
  );
  const notesByTicket = new Map((noteCounts as Array<{ ticket_id: number; n: number }>).map((r) => [r.ticket_id, r.n]));
  for (const row of rows) {
    row.first_responder_id = firstByTicket.get(row.id) || null;
    row.notes_count = notesByTicket.get(row.id) || 0;
  }
  return { total, rows };
}

function ticketDetailScoped(programId: string, ticketId: number) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const ticket = db.getTicket(Number(ticketId));
  if (!ticket || ticket.program_id !== programId) return { error: "ticket not found" };
  const resolutionSummary = ticket.resolution_summary || null;
  let traces: unknown[] = [];
  try {
    traces = require("../pipeline/traceStore").forTicket(programId, ticket.id);
  } catch (_) {}
  return {
    ticket: { ...ticket, resolutionSummary },
    resolutionSummary,
    events: db.listTicketEvents(ticket.id),
    notes: db.listTicketNotes(ticket.id),
    traces,
  };
}

function median(values: number[]): number | null {
  const sorted = [...values].filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function average(values: number[]): number | null {
  const clean = [...values].filter((n) => Number.isFinite(n) && n >= 0);
  if (clean.length === 0) return null;
  return Math.round(clean.reduce((sum, n) => sum + n, 0) / clean.length);
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function volumeByDay(rows: MetricTicketRow[], cutoff: number, now: number): VolumeDay[] {
  const days = new Map();
  for (let t = Date.parse(`${utcDay(cutoff)}T00:00:00Z`); t <= now; t += 86400000) {
    const date = utcDay(t);
    days.set(date, { date, questions: 0, aiOnly: 0, human: 0 });
  }
  for (const row of rows) {
    const day = days.get(utcDay(row.created_at));
    if (!day) continue;
    day.questions += 1;
    if (row.first_human_response_at) day.human += 1;
    else if (row.first_response_at) day.aiOnly += 1;
  }
  return [...days.values()];
}

const BLOCKED_DETAILS = new Set(["ungrounded", "gap_escalated", "unclear_escalated"]);
const ANSWERED_KINDS = new Set(["answer_docs", "answer_chat", "answer_link"]);

function metricsOverview(programId: string, query: DashboardParams = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const days = Math.min(Math.max(Number(query.days) || 30, 1), 365);
  const now = Date.now();
  const cutoff = now - days * 86400000;

  const totals = ticketMetrics.programTotals(programId, { since: cutoff });

  const rows = db
    .handle()
    .query(
      `SELECT created_at, first_response_at, first_human_response_at, resolved_at, resolved_by, assignee_id, status
     FROM tickets WHERE program_id = ? AND created_at > ?`,
    )
    .all(programId, cutoff) as MetricTicketRow[];

  const firstLags = rows
    .filter((r: MetricTicketRow) => r.first_response_at)
    .map((r: MetricTicketRow) => r.first_response_at! - r.created_at);
  const resolveLags = rows
    .filter((r: MetricTicketRow) => r.status === "resolved" && r.resolved_at)
    .map((r: MetricTicketRow) => r.resolved_at! - r.created_at);
  const pixieAnswered = rows.filter((r: MetricTicketRow) => r.first_response_at && !r.first_human_response_at).length;
  const humanHandled = rows.filter((r: MetricTicketRow) => r.first_human_response_at).length;

  const metricRows = db
    .handle()
    .query("SELECT kind, detail FROM metrics WHERE program_id = ? AND created_at > ?")
    .all(programId, cutoff) as MetricRow[];
  const byReason: Record<string, number> = {};
  let blocked = 0;
  let answered = 0;
  for (const row of metricRows) {
    if (row.kind === "jev_downstream_block") {
      blocked += 1;
      const reason = `jev_downstream_block:${row.detail || "unknown"}`;
      byReason[reason] = (byReason[reason] || 0) + 1;
    } else if (row.kind === "silent" && row.detail !== null && BLOCKED_DETAILS.has(row.detail)) {
      blocked += 1;
      byReason[row.detail] = (byReason[row.detail] || 0) + 1;
    } else if (ANSWERED_KINDS.has(row.kind)) {
      answered += 1;
    }
  }

  const openLoad = db
    .handle()
    .query(
      `SELECT assignee_id AS userId, COUNT(*) AS openAssigned FROM tickets
     WHERE program_id = ? AND assignee_id IS NOT NULL
     AND created_at > ? AND status IN (${OPEN_GROUP.map(() => "?").join(",")}) GROUP BY assignee_id`,
    )
    .all(programId, cutoff, ...OPEN_GROUP) as Array<{ userId: string; openAssigned: number }>;
  const resolvedBy: Array<{ userId: string; resolved: number }> = ticketMetrics
    .leaderboard(programId, { since: cutoff })
    .filter((row: { resolved: number }) => row.resolved > 0)
    .map((row: { userId: string; resolved: number }) => ({ userId: row.userId, resolved: row.resolved }));
  const resolvedMap = new Map(resolvedBy.map((r) => [r.userId, r.resolved]));
  const helpers = openLoad.map((r) => ({
    userId: r.userId,
    openAssigned: r.openAssigned,
    resolved: resolvedMap.get(r.userId) || 0,
  }));
  for (const r of resolvedBy) {
    if (!helpers.some((h) => h.userId === r.userId)) {
      helpers.push({ userId: r.userId, openAssigned: 0, resolved: r.resolved });
    }
  }
  helpers.sort((a, b) => b.openAssigned + b.resolved - (a.openAssigned + a.resolved));

  return {
    programId,
    windowDays: days,
    created: totals.created,
    openTickets: totals.open,
    waitingForHelper: totals.waiting,
    resolved: totals.resolvedInWindow,
    firstResponse: { medianMs: totals.medianFirstResponseMs, averageMs: average(firstLags), n: firstLags.length },
    resolution: { medianMs: totals.medianResolveMs, averageMs: average(resolveLags), n: resolveLags.length },
    volumeByDay: volumeByDay(rows, cutoff, now),
    answers: { pixieAnswered, humanHandled },
    grounding: { blocked, byReason, answered, blockRate: rate(blocked, blocked + answered) },
    helpers,
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

const SOURCE_STATUSES = new Set(["Pending", "Fetching", "Processing", "Ready", "Error", "Stale"]);

function normalizeSourceStatus(value: unknown): string {
  const raw = String(value || "");
  const cap = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return SOURCE_STATUSES.has(cap) ? cap : "Pending";
}

function sanitizeSourceRow(row: SourceStatusRow) {
  return {
    name: row.name || "source",
    type: row.type || null,
    url: publicSourceUrl(row.url),
    status: normalizeSourceStatus(row.status),
    lastSyncedAt: Number.isFinite(Number(row.lastSyncedAt)) ? Number(row.lastSyncedAt) : null,
    lastSuccessAt: Number.isFinite(Number(row.lastSuccessAt)) ? Number(row.lastSuccessAt) : null,
    error: typeof row.error === "string" && row.error ? row.error.slice(0, 500) : null,
    chunks:
      Number.isInteger(row.chunks) && row.chunks !== null && row.chunks !== undefined && row.chunks >= 0
        ? row.chunks
        : null,
  };
}

function knowledgeStatus(programId: string) {
  const missing = needProgram(programId);
  if (missing) return missing;
  let knowledge = null;
  try {
    knowledge = require("../knowledge");
  } catch (_) {
    knowledge = null;
  }
  if (knowledge && typeof knowledge.sourceStatus === "function") {
    try {
      const rows = knowledge.sourceStatus(programId);
      const list = Array.isArray(rows) ? rows : [];
      return { programId, sources: list.map((s: SourceStatusRow) => sanitizeSourceRow(s)) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "knowledge status failed" };
    }
  }
  const program = programs.get(programId);
  const declared = Array.isArray(program.sources) ? program.sources : [];
  const sources = declared.map((source: SourceStatusRow) => {
    let key = null;
    try {
      key =
        knowledge && typeof knowledge.sourceCacheKey === "function" ? knowledge.sourceCacheKey(source) : source.name;
    } catch (_) {
      key = source.name;
    }
    let health = null;
    try {
      health = key ? db.getSourceHealth([key])[0] || null : null;
    } catch (_) {
      health = null;
    }
    const failCount = Number(health?.fail_count || 0);
    const hasLastGood = Boolean(health?.last_success_at);
    const status =
      !hasLastGood && failCount === 0
        ? "Pending"
        : failCount > 0 && !hasLastGood
          ? "Error"
          : failCount > 0
            ? "Stale"
            : "Ready";
    return sanitizeSourceRow({
      name: source.name || source.label,
      type: source.type,
      url: source.url,
      status,
      lastSyncedAt: Number(health?.fetched_at) || null,
      lastSuccessAt: Number(health?.last_success_at) || null,
      error: failCount > 0 ? health?.last_error : null,
      chunks: null,
    });
  });
  return { programId, sources };
}

function knowledgeRefresh(programId: string) {
  const missing = needProgram(programId);
  if (missing) return missing;
  let knowledge = null;
  try {
    knowledge = require("../knowledge");
  } catch (_) {
    knowledge = null;
  }
  if (!knowledge || typeof knowledge.refreshProgramSources !== "function") {
    return { error: "knowledge refresh is not available" };
  }
  try {
    const res = knowledge.refreshProgramSources(programId, { force: true });
    if (res && typeof res.catch === "function") {
      res.catch((e: unknown) =>
        log.warn(
          "web/dashboardApi",
          `program source refresh failed (${programId}): ${e instanceof Error ? e.message : e}`,
        ),
      );
    }
    return { started: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "knowledge refresh failed" };
  }
}

function helperRoster(programId: string) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const program = programs.get(programId);
  let stats: HelperStat[] = [];
  try {
    stats = require("../helperStats").listHelperStats(programId, { recentLimit: 1, since: Date.now() - 30 * 86400000 });
  } catch (_) {
    stats = [];
  }
  const byId = new Map(stats.map((s: HelperStat) => [s.userId, s]));
  const helpers = (db.listHelpers(programId, false) as HelperDbRow[]).map((h: HelperDbRow) => {
    const s = byId.get(h.user_id);
    return {
      userId: h.user_id,
      role: h.role,
      active: Boolean(h.active),
      pingEligible: h.ping_eligible !== 0,
      source: h.helper_source,
      expertise: s ? s.expertise : [],
      categoryResolved: s ? s.categoryResolved : [],
      openAssigned: s ? s.totals.open : 0,
      resolved: s ? s.totals.resolved : 0,
      helpfulPercentage: s ? s.helpfulPercentage : null,
      lastActivity: s ? s.lastActivity : null,
    };
  });
  helpers.sort((a, b) => b.openAssigned + b.resolved - (a.openAssigned + a.resolved));
  return { programId, categories: program.categories || null, helpers };
}

function helperSetActive(programId: string, body: DashboardParams = {}) {
  const missing = needProgram(programId);
  if (missing) return missing;
  const actorId = body.actorId || null;
  if (!ticketActorAllowed(programId, actorId)) {
    return { error: "actor is not a helper of this program" };
  }
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!userId) return { error: "userId required" };
  const row = (db.listHelpers(programId, false) as HelperDbRow[]).find((h: HelperDbRow) => h.user_id === userId);
  if (!row) return { error: "helper not found" };
  if (typeof body.pingEligible === "boolean") {
    db.setHelperPingEligible({ programId, userId, eligible: body.pingEligible });
  } else if (body.active === false) {
    db.removeHelper({ programId, userId });
  } else {
    db.syncHelper({ programId, userId, source: row.helper_source || "manual", role: row.role || "helper" });
  }
  try {
    require("../audit").record({
      programId,
      actorId,
      action:
        typeof body.pingEligible === "boolean"
          ? body.pingEligible
            ? "helper.pings_resumed"
            : "helper.pings_paused"
          : body.active === false
            ? "helper.deactivated"
            : "helper.activated",
      entityType: "helper",
      entityId: userId,
    });
  } catch (e) {
    log.warn("web/dashboardApi", `helper availability audit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const updated = (db.listHelpers(programId, false) as HelperDbRow[]).find((h: HelperDbRow) => h.user_id === userId);
  return {
    ok: true,
    helper: updated
      ? {
          userId: updated.user_id,
          active: Boolean(updated.active),
          pingEligible: updated.ping_eligible !== 0,
          role: updated.role,
        }
      : null,
  };
}

export = {
  OPEN_GROUP,
  RESOLVED_GROUP,
  ticketSearchScoped,
  ticketDetailScoped,
  metricsOverview,
  knowledgeStatus,
  knowledgeRefresh,
  helperRoster,
  helperSetActive,
};
