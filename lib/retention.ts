// Terminal tickets only
import db = require("./db");
import type { SQLQueryBindings } from "bun:sqlite";
import audit = require("./audit");

const AUDIT_MIN_DAYS = 365;
const DEFAULTS = {
  contextDays: 30,
  ticketsDays: 180,
  tracesDays: 30,
  analyticsDays: 365,
  auditDays: 365,
  knowledge: "keep",
};

const SWEEPABLE_STATUSES = ["resolved", "closed", "duplicate", "spam"];
const DAY_MS = 86400000;

interface RetentionRow {
  retention_context_days: number | null;
  retention_tickets_days: number | null;
  retention_traces_days: number | null;
  retention_analytics_days: number | null;
  retention_audit_days: number | null;
}

interface RetentionPatch {
  contextDays?: number | string;
  ticketsDays?: number | string;
  tracesDays?: number | string;
  analyticsDays?: number | string;
  auditDays?: number | string;
  knowledge?: string;
}

interface CountRow {
  n: number;
}
type DatabaseHandle = ReturnType<typeof db.handle>;

function toPositiveDays(value: number | string | null | undefined, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function policyFor(programId: string) {
  const row =
    db
      .handle()
      .query<RetentionRow, [string]>(
        `SELECT retention_context_days, retention_tickets_days,
            retention_traces_days, retention_analytics_days, retention_audit_days
     FROM programs WHERE id = ?`,
      )
      .get(programId) || ({} as RetentionRow);
  return {
    contextDays: toPositiveDays(row.retention_context_days, DEFAULTS.contextDays),
    ticketsDays: toPositiveDays(row.retention_tickets_days, DEFAULTS.ticketsDays),
    tracesDays: toPositiveDays(row.retention_traces_days, DEFAULTS.tracesDays),
    analyticsDays: toPositiveDays(row.retention_analytics_days, DEFAULTS.analyticsDays),

    auditDays: Math.max(toPositiveDays(row.retention_audit_days, DEFAULTS.auditDays), AUDIT_MIN_DAYS),
    knowledge: "keep",
  };
}

function validatePolicy(patch: RetentionPatch = {}) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "knowledge") {
      if (value !== "keep") return "only 'keep' is supported for approved knowledge";
      continue;
    }
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return `${key} must be a positive number of days`;
  }
  if (patch.auditDays !== undefined && Number(patch.auditDays) < AUDIT_MIN_DAYS) {
    return `audit retention cannot go below the platform minimum of ${AUDIT_MIN_DAYS} days`;
  }
  return null;
}

function eligibleTicketIds(h: DatabaseHandle, programId: string, ticketCutoff: number) {
  const placeholders = SWEEPABLE_STATUSES.map(() => "?").join(",");
  const rows = h
    .query(`SELECT id FROM tickets WHERE program_id = ? AND created_at < ? AND status IN (${placeholders})`)
    .all(programId, ticketCutoff, ...(SWEEPABLE_STATUSES as SQLQueryBindings[])) as Array<{ id: number }>;
  return rows.map((t) => t.id);
}

function countFor(h: DatabaseHandle, sql: string, ...params: SQLQueryBindings[]) {
  return h.query(sql).get(...params) as CountRow;
}

function preview(programId: string, now = Date.now()) {
  const p = policyFor(programId);
  const h = db.handle();
  const traceStore = require("./pipeline/traceStore");
  traceStore.ensureSchema();
  const ticketCutoff = now - p.ticketsDays * DAY_MS;
  const ids = eligibleTicketIds(h, programId, ticketCutoff);
  let events = 0;
  let notes = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    events = countFor(h, `SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id IN (${placeholders})`, ...ids).n;
    notes = countFor(h, `SELECT COUNT(*) AS n FROM ticket_notes WHERE ticket_id IN (${placeholders})`, ...ids).n;
  }
  return {
    programId,
    policy: p,
    tickets: ids.length,
    ticketEvents: events,
    notes,
    metrics: countFor(
      h,
      "SELECT COUNT(*) AS n FROM metrics WHERE program_id = ? AND created_at < ?",
      programId,
      now - p.analyticsDays * DAY_MS,
    ).n,
    gaps: countFor(
      h,
      "SELECT COUNT(*) AS n FROM doc_gaps WHERE program_id = ? AND created_at < ?",
      programId,
      now - p.tracesDays * DAY_MS,
    ).n,
    supportMemory: countFor(
      h,
      "SELECT COUNT(*) AS n FROM support_memory WHERE program_id = ? AND created_at < ?",
      programId,
      now - p.contextDays * DAY_MS,
    ).n,
    answerTraces: countFor(
      h,
      "SELECT COUNT(*) AS n FROM answer_traces WHERE program_id = ? AND expires_at <= ?",
      programId,
      now,
    ).n,
    auditEligible: 0,
  };
}

function deleteTicketScope(h: DatabaseHandle, ids: number[]) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  h.query(`DELETE FROM ticket_events WHERE ticket_id IN (${placeholders})`).run(...ids);
  h.query(`DELETE FROM ticket_notes WHERE ticket_id IN (${placeholders})`).run(...ids);
  h.query(`DELETE FROM tickets WHERE id IN (${placeholders})`).run(...ids);
}

function sweepProgram(programId: string, { dryRun = true, now = Date.now() }: { dryRun?: boolean; now?: number } = {}) {
  const result = preview(programId, now);
  if (dryRun) return { ...result, deleted: false };
  const p = result.policy;
  const h = db.handle();
  const traceStore = require("./pipeline/traceStore");
  const ids = eligibleTicketIds(h, programId, now - p.ticketsDays * DAY_MS);
  h.transaction(() => {
    deleteTicketScope(h, ids);
    h.query("DELETE FROM metrics WHERE program_id = ? AND created_at < ?").run(
      programId,
      now - p.analyticsDays * DAY_MS,
    );
    h.query("DELETE FROM doc_gaps WHERE program_id = ? AND created_at < ?").run(programId, now - p.tracesDays * DAY_MS);
    h.query("DELETE FROM support_memory WHERE program_id = ? AND created_at < ?").run(
      programId,
      now - p.contextDays * DAY_MS,
    );
    traceStore.sweepExpired(programId, now);
    h.query("DELETE FROM sla_notifications WHERE program_id = ? AND sent_at < ?").run(
      programId,
      now - p.analyticsDays * DAY_MS,
    );
  })();
  audit.record({
    programId,
    actorId: null,
    action: "retention.sweep",
    entityType: "program",
    entityId: programId,
    metadata: { tickets: result.tickets, events: result.ticketEvents, notes: result.notes },
  });
  return { ...result, deleted: true };
}

export = { policyFor, validatePolicy, preview, sweepProgram, DEFAULTS, AUDIT_MIN_DAYS };
