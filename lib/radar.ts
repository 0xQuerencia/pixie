const crypto = require("crypto");
const db = require("./db");
const audit = require("./audit");
const gapClusters = require("./gapClusters");
const incidents = require("./incidents");

interface RadarEvidence {
  count?: number;
  oldestWaitMs?: number;
  sampleTicketIds?: number[];
  statuses?: string[];
  recentCount?: number;
  baselinePerWindow?: number;
  windowMs?: number;
  askers?: number;
  askCount?: number;
  escalated?: number;
  covered?: boolean;
  sampleThreads?: Array<{ channel: string; messageTs: string }>;
  questionCount?: number;
  meanConfidence?: number;
  escalatedCount?: number;
  source?: string;
  failCount?: number;
  lastError?: string | null;
  lastSuccessAt?: number | null;
  reopenedCount?: number;
  totalCount?: number;
  rate?: number;
  incidentId?: number;
  linked?: number;
  startedAt?: number;
  affectedReports?: number;
}
interface RadarSignal {
  id: number;
  program_id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  summary: string | null;
  evidence: string | RadarEvidence | null;
  fingerprint: string;
  first_detected_at: number;
  last_detected_at: number;
  resolved_at?: number | null;
  suppressed_until?: number | null;
}
interface TicketAgeRow {
  id: number;
  status: string;
  created_at: number;
  reopen_count?: number;
}
interface ConfidenceRow {
  category: string;
  ai_confidence: number;
  status: string;
}
interface SourceHealthRow {
  name: string;
  fail_count: number;
  last_error: string | null;
  last_success_at: number | null;
}
interface IncidentCandidate {
  status?: string;
  title: string;
  linked: number;
  incidentId: number;
}
interface IncidentRow {
  id: number;
  title: string;
  started_at: number;
}
interface RadarFinding {
  type: string;
  severity: string;
  title: string;
  summary: string;
  evidence: RadarEvidence;
  fingerprint: string;
}
interface RadarResult {
  error?: string;
  signal?: RadarSignal | null;
  signals?: Array<RadarSignal | null>;
  baselinePerWindow?: number;
  severity?: string;
  ok?: boolean;
}

const TYPES = [
  "STALE_TICKETS",
  "ESCALATION_SPIKE",
  "FAQ_CLUSTER",
  "LOW_CONFIDENCE_TOPIC",
  "SOURCE_FAILURE",
  "KNOWLEDGE_GAP",
  "INCIDENT_CANDIDATE",
  "ACTIVE_INCIDENT",
  "REOPEN_SPIKE",
];
const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["active", "acknowledged", "resolved", "suppressed"];
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const SUPPRESS_DURATIONS_MS = { "1h": 3600000, "24h": 86400000, "7d": 7 * 86400000 };

const OPEN_STATUSES = ["open", "waiting_for_helper", "assigned", "claimed", "escalated", "reopened"];
const STALE_WARN_MS = 12 * 60 * 60 * 1000;
const STALE_HIGH_MS = 24 * 60 * 60 * 1000;
const ESCALATION_MIN_RECENT = 3;
const ESCALATION_WINDOW_MS = 60 * 60 * 1000;
const ESCALATION_BASELINE_WINDOW_MS = 6 * 60 * 60 * 1000;
const ESCALATION_BASELINE_MULTIPLIER = 2;
const ESCALATION_CRITICAL_RATIO = 4;
const ESCALATION_HIGH_RATIO = 2.5;
const FAQ_WINDOW_MS = 24 * 60 * 60 * 1000;
const FAQ_MIN_ASKERS = 5;
const FAQ_HIGH_ASKERS = 15;
const LOW_CONFIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const LOW_CONFIDENCE_MIN_QUESTIONS = 5;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const LOW_CONFIDENCE_HIGH_MEAN = 0.3;
const SOURCE_HIGH_FAILS = 3;
const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const REOPEN_MIN_COUNT = 3;
const REOPEN_RATE_THRESHOLD = 0.2;
const REOPEN_HIGH_RATE = 0.4;
const ACTIVE_INCIDENT_LIST_LIMIT = 20;
const RADAR_LOOP_DEFAULT_MIN = 10;
const RADAR_LEASE_NAME = "radar-eval";

function assertValid(type: string, severity: string): void {
  if (!TYPES.includes(type)) throw new Error(`invalid radar signal type: ${type}`);
  if (!SEVERITIES.includes(severity)) throw new Error(`invalid radar severity: ${severity}`);
}

function row(id: number): RadarSignal | null {
  return db.handle().query("SELECT * FROM radar_signals WHERE id = ?").get(id) as RadarSignal | null;
}

function listSignals(
  programId: string,
  {
    status = null,
    severity = null,
    limit = 100,
  }: { status?: string | null; severity?: string | null; limit?: number } = {},
): RadarSignal[] | { error: string } {
  if (!programId) return { error: "programId required" };
  const clauses = ["program_id = ?"];
  const params: Array<string | number> = [programId];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(severity);
  }
  const rows = db
    .handle()
    .query(`SELECT * FROM radar_signals WHERE ${clauses.join(" AND ")} ORDER BY last_detected_at DESC LIMIT ?`)
    .all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500));
  return (rows as RadarSignal[])
    .map((r: RadarSignal) => ({
      ...r,
      evidence: r.evidence ? (JSON.parse(r.evidence as string) as RadarEvidence) : null,
    }))
    .sort(
      (a: RadarSignal, b: RadarSignal) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.last_detected_at - a.last_detected_at,
    );
}

function upsertSignal({
  programId,
  type,
  severity,
  title,
  summary,
  evidence,
  fingerprint,
  now = Date.now(),
}: {
  programId: string;
  type: string;
  severity: string;
  title: string;
  summary?: string;
  evidence: RadarEvidence;
  fingerprint: string;
  now?: number;
}): RadarSignal | null {
  assertValid(type, severity);
  if (!programId || !fingerprint) throw new Error("programId and fingerprint required");
  const existing = db
    .handle()
    .query("SELECT * FROM radar_signals WHERE program_id = ? AND type = ? AND fingerprint = ?")
    .get(programId, type, fingerprint);
  const evidenceJson = JSON.stringify(evidence || {});

  if (!existing) {
    const res = db
      .handle()
      .query(
        `INSERT INTO radar_signals (program_id, type, severity, status, title, summary, evidence, fingerprint, first_detected_at, last_detected_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(programId, type, severity, title, summary || null, evidenceJson, fingerprint, now, now, now, now);
    return row(Number(res.lastInsertRowid));
  }

  if (existing.status === "suppressed" && existing.suppressed_until && existing.suppressed_until > now) {
    db.handle()
      .query(
        "UPDATE radar_signals SET severity = ?, title = ?, summary = ?, evidence = ?, last_detected_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(severity, title, summary || null, evidenceJson, now, now, existing.id);
    return row(existing.id);
  }

  const wasClosed =
    existing.status === "resolved" ||
    (existing.status === "suppressed" && existing.suppressed_until && existing.suppressed_until <= now);
  const nextStatus = existing.status === "acknowledged" ? "acknowledged" : "active";
  const firstDetectedAt = wasClosed ? now : existing.first_detected_at;
  db.handle()
    .query(
      `UPDATE radar_signals SET severity = ?, status = ?, title = ?, summary = ?, evidence = ?,
       first_detected_at = ?, last_detected_at = ?, resolved_at = ?, suppressed_until = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      severity,
      nextStatus,
      title,
      summary || null,
      evidenceJson,
      firstDetectedAt,
      now,
      wasClosed ? null : existing.resolved_at,
      wasClosed ? null : existing.suppressed_until,
      now,
      existing.id,
    );
  return row(existing.id);
}

function autoResolveMissing(programId: string, type: string, seenFingerprints: Set<string>, now = Date.now()): void {
  const stale = db
    .handle()
    .query(
      "SELECT id, fingerprint FROM radar_signals WHERE program_id = ? AND type = ? AND status IN ('active','acknowledged')",
    )
    .all(programId, type);
  for (const s of stale) {
    if (seenFingerprints.has(s.fingerprint)) continue;
    db.handle()
      .query("UPDATE radar_signals SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, s.id);
  }
}

function programScoped(
  id: number,
  actorId: string | null,
  requireHelper: ((programId: string, actorId: string | null) => boolean) | null,
): { error: string } | { signal: RadarSignal } {
  const inc = row(id);
  if (!inc) return { error: "signal not found" };
  if (requireHelper && !requireHelper(inc.program_id, actorId))
    return { error: "actor is not a helper of this program" };
  return { signal: inc };
}

function acknowledgeSignal(
  {
    id,
    actorId = null,
    requireHelper = null,
  }: {
    id: number;
    actorId?: string | null;
    requireHelper?: ((programId: string, actorId: string | null) => boolean) | null;
  } = { id: 0 },
): RadarResult {
  const scoped = programScoped(id, actorId, requireHelper);
  if ("error" in scoped) return scoped;
  const now = Date.now();
  db.handle()
    .query(
      "UPDATE radar_signals SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, actorId, now, id);
  audit.record({
    programId: scoped.signal.program_id,
    actorId,
    action: "radar.acknowledged",
    entityType: "radar_signal",
    entityId: id,
  });
  return { ok: true, signal: row(id) };
}

function resolveSignal(
  {
    id,
    actorId = null,
    requireHelper = null,
  }: {
    id: number;
    actorId?: string | null;
    requireHelper?: ((programId: string, actorId: string | null) => boolean) | null;
  } = { id: 0 },
): RadarResult {
  const scoped = programScoped(id, actorId, requireHelper);
  if ("error" in scoped) return scoped;
  const now = Date.now();
  db.handle()
    .query("UPDATE radar_signals SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
  audit.record({
    programId: scoped.signal.program_id,
    actorId,
    action: "radar.resolved",
    entityType: "radar_signal",
    entityId: id,
  });
  return { ok: true, signal: row(id) };
}

function suppressSignal(
  {
    id,
    actorId = null,
    duration,
    requireHelper = null,
  }: {
    id: number;
    actorId?: string | null;
    duration?: string;
    requireHelper?: ((programId: string, actorId: string | null) => boolean) | null;
  } = { id: 0 },
): RadarResult {
  const scoped = programScoped(id, actorId, requireHelper);
  if ("error" in scoped) return scoped;
  const durationMs = duration ? SUPPRESS_DURATIONS_MS[duration as keyof typeof SUPPRESS_DURATIONS_MS] : undefined;
  if (!durationMs) return { error: `duration must be one of ${Object.keys(SUPPRESS_DURATIONS_MS).join(", ")}` };
  const now = Date.now();
  db.handle()
    .query("UPDATE radar_signals SET status = 'suppressed', suppressed_until = ?, updated_at = ? WHERE id = ?")
    .run(now + durationMs, now, id);
  audit.record({
    programId: scoped.signal.program_id,
    actorId,
    action: "radar.suppressed",
    entityType: "radar_signal",
    entityId: id,
    metadata: { duration },
  });
  return { ok: true, signal: row(id) };
}

function staleSeverity(oldestMs: number): string {
  return oldestMs > STALE_HIGH_MS ? "HIGH" : "MEDIUM";
}

function fetchOpenTickets(programId: string): TicketAgeRow[] {
  return db
    .handle()
    .query(
      `SELECT id, status, created_at FROM tickets
       WHERE program_id = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(",")})`,
    )
    .all(programId, ...OPEN_STATUSES);
}

function decideStaleTickets(openRows: TicketAgeRow[], now: number): RadarFinding | null {
  if (openRows.length === 0) return null;
  const stale = openRows
    .filter((t: TicketAgeRow) => now - t.created_at > STALE_WARN_MS)
    .sort((a: TicketAgeRow, b: TicketAgeRow) => a.created_at - b.created_at);
  if (stale.length === 0) return null;
  const oldestMs = now - stale[0].created_at;
  const hours = Math.round(oldestMs / 3600000);
  return {
    type: "STALE_TICKETS",
    severity: staleSeverity(oldestMs),
    title: `${stale.length} ticket${stale.length === 1 ? "" : "s"} waiting >12h`,
    summary: `Oldest has waited ${hours}h.`,
    fingerprint: "backlog",
    evidence: {
      count: stale.length,
      oldestWaitMs: oldestMs,
      sampleTicketIds: stale.slice(0, 5).map((t: TicketAgeRow) => t.id),
      statuses: [...new Set(stale.map((t: TicketAgeRow) => t.status))],
    },
  };
}

function detectStaleTickets(programId: string, now: number): RadarFinding | null {
  return decideStaleTickets(fetchOpenTickets(programId), now);
}

function escalationSeverity(ratio: number): string {
  if (ratio >= ESCALATION_CRITICAL_RATIO) return "CRITICAL";
  if (ratio >= ESCALATION_HIGH_RATIO) return "HIGH";
  return "MEDIUM";
}

function decideEscalationSpike(
  recent: number,
  baselineTotal: number,
): { baselinePerWindow: number; severity: string } | null {
  if (recent < ESCALATION_MIN_RECENT) return null;
  const baselineBuckets = ESCALATION_BASELINE_WINDOW_MS / ESCALATION_WINDOW_MS;
  const baselinePerWindow = baselineTotal / baselineBuckets;
  const threshold = Math.max(ESCALATION_MIN_RECENT, baselinePerWindow * ESCALATION_BASELINE_MULTIPLIER);
  if (recent < threshold) return null;
  const ratio = baselinePerWindow > 0 ? recent / baselinePerWindow : recent;
  return { baselinePerWindow, severity: escalationSeverity(ratio) };
}

function detectEscalationSpike(programId: string, now: number): RadarFinding | null {
  const recentCutoff = now - ESCALATION_WINDOW_MS;
  const baselineCutoff = now - ESCALATION_BASELINE_WINDOW_MS;
  const recent = db
    .handle()
    .query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ?")
    .get(programId, recentCutoff).n;
  const baselineTotal = db
    .handle()
    .query("SELECT COUNT(*) AS n FROM tickets WHERE program_id = ? AND created_at > ? AND created_at <= ?")
    .get(programId, baselineCutoff, recentCutoff).n;
  const decided = decideEscalationSpike(recent, baselineTotal);
  if (!decided) return null;
  return {
    type: "ESCALATION_SPIKE",
    severity: decided.severity,
    title: `${recent} new tickets in the last hour`,
    summary: `Baseline is ~${decided.baselinePerWindow.toFixed(1)}/hour over the prior 6h.`,
    fingerprint: "spike",
    evidence: {
      recentCount: recent,
      baselinePerWindow: Number(decided.baselinePerWindow.toFixed(2)),
      windowMs: ESCALATION_WINDOW_MS,
    },
  };
}

function faqSeverity(askers: number): string {
  return askers >= FAQ_HIGH_ASKERS ? "HIGH" : "MEDIUM";
}

function faqFingerprint(representative: string): string {
  return crypto.createHash("sha1").update(representative.toLowerCase()).digest("hex").slice(0, 16);
}

function detectFaqClusters(programId: string): RadarFinding[] {
  const { clusters, error } = gapClusters.clusterGaps({ programId, sinceMs: FAQ_WINDOW_MS, minAskers: FAQ_MIN_ASKERS });
  if (error || !clusters) return [];
  return clusters.map(
    (c: {
      askers: number;
      representative: string;
      askCount: number;
      covered: boolean;
      escalated: number;
      threads: Array<{ channel: string; messageTs: string }>;
    }) => ({
      type: "FAQ_CLUSTER",
      severity: faqSeverity(c.askers),
      title: `${c.askers} askers about "${c.representative.slice(0, 80)}"`,
      summary: `${c.askCount} question${c.askCount === 1 ? "" : "s"} in 24h${c.covered ? " (docs already cover this)" : ""}.`,
      fingerprint: faqFingerprint(c.representative),
      evidence: {
        askers: c.askers,
        askCount: c.askCount,
        escalated: c.escalated,
        covered: c.covered,
        sampleThreads: c.threads,
      },
    }),
  );
}

function lowConfidenceSeverity(mean: number): string {
  return mean < LOW_CONFIDENCE_HIGH_MEAN ? "HIGH" : "MEDIUM";
}

function decideLowConfidenceFinding(category: string, group: ConfidenceRow[]): RadarFinding | null {
  if (group.length < LOW_CONFIDENCE_MIN_QUESTIONS) return null;
  const mean = group.reduce((sum: number, r: ConfidenceRow) => sum + r.ai_confidence, 0) / group.length;
  if (mean >= LOW_CONFIDENCE_THRESHOLD) return null;
  const escalated = group.filter((r: ConfidenceRow) => r.status === "escalated" || r.status === "reopened").length;
  return {
    type: "LOW_CONFIDENCE_TOPIC",
    severity: lowConfidenceSeverity(mean),
    title: `Low answer confidence: ${category}`,
    summary: `${group.length} questions, mean confidence ${Math.round(mean * 100)}%.`,
    fingerprint: category,
    evidence: { questionCount: group.length, meanConfidence: Number(mean.toFixed(2)), escalatedCount: escalated },
  };
}

function detectLowConfidenceTopics(programId: string, now: number): RadarFinding[] {
  const cutoff = now - LOW_CONFIDENCE_WINDOW_MS;
  const rows = db
    .handle()
    .query(
      `SELECT COALESCE(category, 'uncategorized') AS category, ai_confidence, status FROM tickets
       WHERE program_id = ? AND created_at > ? AND ai_confidence IS NOT NULL`,
    )
    .all(programId, cutoff);
  const byCategory = new Map<string, ConfidenceRow[]>();
  for (const r of rows as ConfidenceRow[]) {
    const group = byCategory.get(r.category);
    if (group) group.push(r);
    else byCategory.set(r.category, [r]);
  }
  const out = [];
  for (const [category, group] of byCategory) {
    const finding = decideLowConfidenceFinding(category, group);
    if (finding) out.push(finding);
  }
  return out;
}

function sourceSeverity(failCount: number, neverSucceeded: boolean): string {
  if (failCount >= SOURCE_HIGH_FAILS) return "HIGH";
  if (neverSucceeded) return "MEDIUM";
  return "LOW";
}

function detectSourceFailures(programId: string): RadarFinding[] {
  const programs = require("./programs");
  const prog = programs.get(programId);
  const sources = prog && Array.isArray(prog.sources) ? prog.sources : [];
  if (sources.length === 0) return [];
  const knowledge = require("./knowledge");
  const keyed = sources
    .map((s: { name: string }) => ({ source: s, key: knowledge.sourceCacheKey(s) || s.name }))
    .filter((x: { key: string }) => x.key);
  const health = db.getSourceHealth(keyed.map((x: { key: string }) => x.key));
  const byKey = new Map((health as SourceHealthRow[]).map((h: SourceHealthRow) => [h.name, h]));
  const out = [];
  for (const { source, key } of keyed) {
    const h = byKey.get(key);
    if (!h || h.fail_count === 0) continue;
    const neverSucceeded = !h.last_success_at;
    const lastSuccessAt = h.last_success_at;
    const staleness = neverSucceeded
      ? "never had a successful refresh"
      : `last succeeded ${Math.round((Date.now() - (lastSuccessAt || 0)) / 3600000)}h ago`;
    out.push({
      type: "SOURCE_FAILURE",
      severity: sourceSeverity(h.fail_count, neverSucceeded),
      title: `Source "${source.name}" failed to refresh`,
      summary: `${h.fail_count} consecutive failure${h.fail_count === 1 ? "" : "s"}, ${staleness}.`,
      fingerprint: key,
      evidence: {
        source: source.name,
        failCount: h.fail_count,
        lastError: h.last_error,
        lastSuccessAt: h.last_success_at,
      },
    });
  }
  return out;
}

function reopenSeverity(rate: number): string {
  return rate >= REOPEN_HIGH_RATE ? "HIGH" : "MEDIUM";
}

function decideReopenSpike(rows: TicketAgeRow[]): RadarFinding | null {
  if (rows.length === 0) return null;
  const reopened = rows.filter((r: TicketAgeRow) => (r.reopen_count || 0) > 0).length;
  if (reopened < REOPEN_MIN_COUNT) return null;
  const rate = reopened / rows.length;
  if (rate < REOPEN_RATE_THRESHOLD) return null;
  return {
    type: "REOPEN_SPIKE",
    severity: reopenSeverity(rate),
    title: `${reopened} tickets reopened in 24h`,
    summary: `${Math.round(rate * 100)}% reopen rate over ${rows.length} tickets.`,
    fingerprint: "reopen",
    evidence: { reopenedCount: reopened, totalCount: rows.length, rate: Number(rate.toFixed(2)) },
  };
}

function detectReopenSpike(programId: string, now: number): RadarFinding | null {
  const cutoff = now - REOPEN_WINDOW_MS;
  const rows = db
    .handle()
    .query("SELECT reopen_count FROM tickets WHERE program_id = ? AND created_at > ?")
    .all(programId, cutoff);
  return decideReopenSpike(rows);
}

function detectIncidentSignals(programId: string): RadarFinding[] {
  const out: RadarFinding[] = [];
  let detected;
  try {
    detected = incidents.detectBursts({ programId });
  } catch (_) {
    detected = { candidates: [] };
  }
  for (const c of (detected.candidates || []) as IncidentCandidate[]) {
    // A confirmed incident already raises ACTIVE_INCIDENT
    if (c.status && c.status !== "candidate") continue;
    out.push({
      type: "INCIDENT_CANDIDATE",
      severity: "MEDIUM",
      title: `Possible incident: ${c.title}`,
      summary: `${c.linked} similar ticket${c.linked === 1 ? "" : "s"} clustered together.`,
      fingerprint: String(c.incidentId),
      evidence: { incidentId: c.incidentId, linked: c.linked },
    });
  }
  const active = incidents.listIncidents(programId, "confirmed", ACTIVE_INCIDENT_LIST_LIMIT);
  for (const inc of active as IncidentRow[]) {
    const affected = db
      .handle()
      .query("SELECT COUNT(*) AS n FROM incident_reports WHERE incident_id = ?")
      .get(inc.id).n;
    const startedAgoMin = Math.round((Date.now() - inc.started_at) / 60000);
    out.push({
      type: "ACTIVE_INCIDENT",
      severity: "CRITICAL",
      title: `Active incident: ${inc.title}`,
      summary: `Started ~${startedAgoMin}m ago. ${affected} affected report${affected === 1 ? "" : "s"} tracked.`,
      fingerprint: String(inc.id),
      evidence: { incidentId: inc.id, startedAt: inc.started_at, affectedReports: affected },
    });
  }
  return out;
}

function evaluateProgram(programId: string): { error: string } | { signals: Array<RadarSignal | null> } {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  const findings = [
    detectStaleTickets(programId, now),
    detectEscalationSpike(programId, now),
    ...detectFaqClusters(programId),
    ...detectLowConfidenceTopics(programId, now),
    ...detectSourceFailures(programId),
    detectReopenSpike(programId, now),
    ...detectIncidentSignals(programId),
  ].filter(Boolean) as RadarFinding[];

  const seenByType = new Map<string, Set<string>>();
  const signals: Array<RadarSignal | null> = [];
  for (const f of findings) {
    const seen = seenByType.get(f.type);
    if (seen) seen.add(f.fingerprint);
    else seenByType.set(f.type, new Set([f.fingerprint]));
    signals.push(upsertSignal({ programId, now, ...f }));
  }
  for (const type of TYPES) {
    autoResolveMissing(programId, type, seenByType.get(type) || new Set(), now);
  }
  return { signals };
}

function startRadarLoop(
  intervalMin = Number(process.env.PIXIE_RADAR_CHECK_MIN || RADAR_LOOP_DEFAULT_MIN),
  client: unknown = null,
): ReturnType<typeof setInterval> | null {
  if (!intervalMin || intervalMin <= 0) return null;
  const log = require("./log");
  const lease = require("./jobLease");
  const timer = setInterval(
    () => {
      lease
        .runOnce(RADAR_LEASE_NAME, intervalMin * 60 * 1000, async () => {
          const programs = require("./programs");
          for (const prog of programs.all()) {
            if (!prog) continue;
            try {
              evaluateProgram(prog.id);
            } catch (e) {
              log.warn("radar", `evaluate failed for ${prog.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
            await require("./incidentAlerts").dispatch({ client, programId: prog.id });
          }
        })
        .catch((e: unknown) => log.error("radar", `loop failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    intervalMin * 60 * 1000,
  );
  if (timer.unref) timer.unref();
  return timer;
}

export = {
  TYPES,
  SEVERITIES,
  STATUSES,
  SUPPRESS_DURATIONS_MS,
  listSignals,
  upsertSignal,
  acknowledgeSignal,
  resolveSignal,
  suppressSignal,
  evaluateProgram,
  startRadarLoop,
  getSignal: row,
  detectStaleTickets,
  detectEscalationSpike,
  detectFaqClusters,
  detectLowConfidenceTopics,
  detectSourceFailures,
  detectReopenSpike,
  detectIncidentSignals,
};
