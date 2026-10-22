import db = require("./db");
import audit = require("./audit");
import gapClusters = require("./gapClusters");
import programs = require("./programs");
import slackMessages = require("./slackMessages");
import retrieve = require("./retrieve");
import semanticSimilarity = require("./semanticSimilarity");
import type { SlackClient } from "./types";

interface Row {
  id?: number;
  program_id?: string;
  status?: string;
  kind?: string;
  created_at?: number;
  updated_at?: number;
  question?: string;
  summary?: string;
  title?: string;
  description?: string | null;
  thread_ts?: string;
  channel?: string;
  requester_id?: string | null;
  ticket_id?: number | null;
  notified_at?: number | null;
  [key: string]: unknown;
}

const SIMILARITY_THRESHOLD = 0.35;
const DUPLICATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const INCIDENT_WINDOW_MS = 60 * 60 * 1000;
const INCIDENT_THRESHOLD = 4;
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MIN_DISTINCT_REQUESTERS = 3;
const LIVE_STATUSES = ["candidate", "confirmed"];
const AUDIT_TICKET_SAMPLE = 50;
const TRANSITIONS: Record<string, string[]> = {
  candidate: ["confirmed", "dismissed"],
  confirmed: ["resolved", "dismissed"],
  dismissed: ["candidate", "confirmed"],
  resolved: ["confirmed", "dismissed"],
};

function similarityScore(a: string, b: string): number {
  return gapClusters.pairOverlap(a, b);
}

// Incident matching is intentionally more forgiving than duplicate-ticket
// matching. People describe the same outage with different verbs ("blank
// page", "redirects back to login", "can't sign in"), so use the shared
// semantic scorer only after the outage gate below has established that this
// is an operational report.
function incidentSimilarityScore(a: string, b: string): number {
  return semanticSimilarity.score(a, b);
}

function isSimilar(a: string, b: string, threshold = SIMILARITY_THRESHOLD): boolean {
  return similarityScore(a, b) >= threshold;
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), 10);
}

function scoreDuplicate(question: string, row: Row): number {
  return Number(similarityScore(question, String(row.question || "")).toFixed(3));
}

function rankDuplicateCandidates(question: string, rows: Row[], ticketId: number | null, limit: number): Row[] {
  return rows
    .filter((t) => t.id !== ticketId)
    .map((t) => ({
      ticketId: t.id,
      question: t.question,
      summary: t.summary,
      status: t.status,
      createdAt: t.created_at,
      similarity: scoreDuplicate(question, t),
    }))
    .filter((c) => c.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, clampLimit(limit));
}

function pickBestIncident(question: string, active: Row[]): Row | null {
  let best = null;
  let bestScore = 0;
  for (const inc of active) {
    const score = incidentSimilarity(question, inc);
    if (score > bestScore) {
      bestScore = score;
      best = inc;
    }
  }
  if (!best || bestScore < SIMILARITY_THRESHOLD) return null;
  return best;
}

const OUTAGE_LANGUAGE =
  /\b(?:down|offline|unavailable|broken|inaccessible|failing|failed|failure|error|issue|problem|outage|crash(?:ing)?|500)\b|\b(?:blank(?:\s+page)?|page\s+is\s+blank|redirect(?:s|ed)?(?:\s+\w+){0,2}\s+back\s+to\s+(?:the\s+)?login|sends?\s+me\s+back\s+to\s+(?:the\s+)?login|can(?:not|'t|t)\s+sign\s*[- ]?in|login\s+(?:is\s+)?(?:broken|failing)|not\s+(?:loading|load|working)|(?:isn'?t|is\s+not|can not|cannot|cant|can't|won't|wont|unable\s+to)\s+(?:load|open|access|reach|work|sign\s*[- ]?in))\b/i;
const DIRECT_OUTAGE_LANGUAGE =
  /\b(?:down|offline|unavailable|broken|inaccessible|failing|failed|failure|error|outage|crash(?:ing)?|500)\b|\b(?:blank(?:\s+page)?|page\s+is\s+blank|redirect(?:s|ed)?(?:\s+\w+){0,2}\s+back\s+to\s+(?:the\s+)?login|sends?\s+me\s+back\s+to\s+(?:the\s+)?login|can(?:not|'t|t)\s+sign\s*[- ]?in|login\s+(?:is\s+)?(?:broken|failing)|not\s+(?:loading|load|working)|(?:isn'?t|is\s+not|can not|cannot|cant|can't|won't|wont|unable\s+to)\s+(?:load|open|access|reach|work|sign\s*[- ]?in))\b/i;
const OPERATIONAL_LANGUAGE =
  /\b(?:delayed|late|stuck|missing|pending|(?:not|n't|never)\s+(?:received|arrived|delivered|showing|updated)|still\s+waiting)\b/i;
const ACCESS_LANGUAGE = /\b(?:site|website|webpage|page|portal|app|service|dashboard|load|open|access|reach)\b/i;
const INCIDENT_NOISE = new Set([
  "down",
  "offline",
  "unavailable",
  "broken",
  "inaccessible",
  "failing",
  "failed",
  "failure",
  "error",
  "outage",
  "crashing",
  "crash",
  "access",
  "open",
  "load",
  "loading",
  "reach",
  "working",
  "work",
  "currently",
  "right",
  "now",
  "site",
  "website",
  "webpage",
  "page",
  "portal",
  "app",
  "service",
  "dashboard",
  "people",
  "user",
  "users",
  "everyone",
  "anything",
  "something",
  "too",
  "problem",
  "issue",
  "cant",
  "cannot",
  "wont",
  "won",
  "unable",
]);
const NEGATED_OUTAGE =
  /\b(?:not|never|isn't|isnt|no\s+longer)\s+(?:currently\s+)?(?:down|offline|unavailable|broken|inaccessible|failing|failed|working|loading|load|open|access|reachable)\b/i;

function incidentTerms(text: unknown): Set<string> {
  const raw = String(text || "").toLowerCase();
  const terms = new Set(retrieve.tokenize(raw).filter((term) => !INCIDENT_NOISE.has(term)));
  if (ACCESS_LANGUAGE.test(raw)) terms.add("incident_service");
  return terms;
}

function isNegatedOutage(text: string): boolean {
  return NEGATED_OUTAGE.test(text);
}

function incidentConcreteTerms(text: unknown): Set<string> {
  const terms = incidentTerms(text);
  terms.delete("incident_service");
  return terms;
}

function isGenericOutageReport(text: string): boolean {
  return !isNegatedOutage(text) && incidentTerms(text).size === 1 && incidentTerms(text).has("incident_service");
}

function incidentSimilarity(question: string, incident: Row): number {
  const questionText = String(question || "");
  if (
    !OUTAGE_LANGUAGE.test(questionText) ||
    !DIRECT_OUTAGE_LANGUAGE.test(questionText) ||
    isNegatedOutage(questionText)
  ) {
    return 0;
  }
  const texts = [incident.title, incident.description].filter(Boolean);
  let score = 0;
  for (const text of texts) {
    const incidentText = String(text || "");
    if (!DIRECT_OUTAGE_LANGUAGE.test(incidentText) || isNegatedOutage(incidentText)) continue;
    const questionTerms = incidentConcreteTerms(questionText);
    const incidentTermsForText = incidentConcreteTerms(incidentText);
    const sharedConcreteTerm = [...questionTerms].some((term) => incidentTermsForText.has(term));
    const wordingScore = incidentSimilarityScore(question, String(text));
    const genericServiceMatch =
      isGenericOutageReport(questionText) && incidentTerms(incidentText).has("incident_service");
    if (sharedConcreteTerm || (genericServiceMatch && wordingScore >= SIMILARITY_THRESHOLD)) {
      score = Math.max(score, wordingScore, SIMILARITY_THRESHOLD);
    }
  }
  return score;
}

function incidentClusterQuestions(questions: string[], threshold = SIMILARITY_THRESHOLD): string[][] {
  const parents = questions.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[b] = a;
  };

  for (let left = 0; left < questions.length; left += 1) {
    for (let right = left + 1; right < questions.length; right += 1) {
      const leftOutage = DIRECT_OUTAGE_LANGUAGE.test(questions[left]);
      const rightOutage = DIRECT_OUTAGE_LANGUAGE.test(questions[right]);
      if (leftOutage && rightOutage && !isNegatedOutage(questions[left]) && !isNegatedOutage(questions[right])) {
        const leftTerms = incidentConcreteTerms(questions[left]);
        const rightTerms = incidentConcreteTerms(questions[right]);
        const sharedConcreteTerm = [...leftTerms].some((term) => rightTerms.has(term));
        const genericService =
          (isGenericOutageReport(questions[left]) || isGenericOutageReport(questions[right])) &&
          incidentTerms(questions[left]).has("incident_service") &&
          incidentTerms(questions[right]).has("incident_service");
        const similar = incidentSimilarityScore(questions[left], questions[right]);
        if ((sharedConcreteTerm || genericService) && similar >= threshold) union(left, right);
      } else if (
        !leftOutage &&
        !rightOutage &&
        OPERATIONAL_LANGUAGE.test(questions[left]) &&
        OPERATIONAL_LANGUAGE.test(questions[right]) &&
        similarityScore(questions[left], questions[right]) >= threshold
      ) {
        // Same non-outage problem in near-identical words ("payouts delayed");
        // plain repeated questions never reach here
        union(left, right);
      }
    }
  }

  const groups = new Map<number, string[]>();
  questions.forEach((question, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(question);
  });
  return [...groups.values()];
}

function burstConfidence(count: number): number {
  return Math.min(0.5 + count * 0.05, 0.95);
}

function burstReason(count: number, windowMs: number): string {
  return `${count} similar tickets in ${Math.round(windowMs / 60000)}m`;
}

function truncateTitle(s: unknown): string {
  return String(s).slice(0, 200);
}

function defaultResolutionText(title: string): string {
  return `Update: the issue reported earlier ("${title}") has been resolved. Please try again — if you're still stuck, reply here.`;
}

function fetchDuplicateRows(programId: string, cutoff: number): Row[] {
  return db
    .handle()
    .query(
      `SELECT id, question, summary, status, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status IN ('open','waiting_for_helper','assigned','claimed','escalated','reopened','resolved')
     ORDER BY created_at DESC LIMIT 200`,
    )
    .all(programId, cutoff) as Row[];
}

function fetchRecentTickets(programId: string, cutoff: number): Row[] {
  return db
    .handle()
    .query(
      `SELECT id, question, thread_ts, requester_id, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status NOT IN ('closed','spam','duplicate')
     ORDER BY created_at ASC LIMIT 300`,
    )
    .all(programId, cutoff) as Row[];
}

function recordIncidentAudit(
  incident: Row,
  action: string,
  actorId: string | null,
  metadata: Record<string, unknown> = {},
): void {
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: incident.program_id,
    actorId,
    action,
    entityType: "incident",
    entityId: incident.id,
    metadata,
  });
}

// Incidents this cluster already belongs to by shared tickets, live ones first
function overlappingIncident(programId: string, ticketIds: number[]): { incident: Row; linked: Set<number> } | null {
  if (ticketIds.length === 0) return null;
  const marks = ticketIds.map(() => "?").join(",");
  const links = db
    .handle()
    .query(
      `SELECT it.incident_id AS incident_id, it.ticket_id AS ticket_id FROM incident_tickets it
       JOIN program_incidents i ON i.id = it.incident_id
       WHERE i.program_id = ? AND it.program_id = ? AND it.ticket_id IN (${marks})`,
    )
    .all(programId, programId, ...ticketIds) as Array<{ incident_id: number; ticket_id: number }>;
  const byIncident = new Map<number, Set<number>>();
  for (const l of links) {
    if (!byIncident.has(l.incident_id)) byIncident.set(l.incident_id, new Set());
    byIncident.get(l.incident_id)?.add(l.ticket_id);
  }
  let best: { incident: Row; linked: Set<number> } | null = null;
  for (const [incidentId, linked] of byIncident) {
    const incident = getIncident(incidentId, programId);
    if (!incident) continue;
    const better =
      !best ||
      Number(LIVE_STATUSES.includes(String(incident.status))) >
        Number(LIVE_STATUSES.includes(String(best.incident.status))) ||
      (LIVE_STATUSES.includes(String(incident.status)) === LIVE_STATUSES.includes(String(best.incident.status)) &&
        linked.size > best.linked.size);
    if (better) best = { incident, linked };
  }
  return best;
}

function closedAt(incident: Row): number {
  return Number(incident.dismissed_at || incident.resolved_at || 0);
}

// Live incidents stay matchable at any age; closed ones only just after closing
function titleMatchedIncident(programId: string, representative: string, now: number): Row | null {
  const rows = db
    .handle()
    .query("SELECT * FROM program_incidents WHERE program_id = ? ORDER BY id DESC LIMIT 25")
    .all(programId) as Row[];
  const matches = rows.filter((inc) => {
    if (!isSimilar(String(inc.title || ""), representative)) return false;
    if (LIVE_STATUSES.includes(String(inc.status))) return true;
    return now - closedAt(inc) < INCIDENT_COOLDOWN_MS;
  });
  return matches.find((inc) => LIVE_STATUSES.includes(String(inc.status))) || matches[0] || null;
}

function distinctRequesters(rows: Row[]): number {
  return new Set(rows.map((r) => String(r.requester_id || ""))).size;
}

function buildQuestionIndex(rows: Row[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const question = String(r.question || "");
    if (!index.has(question)) index.set(question, []);
    const positions = index.get(question);
    if (positions) positions.push(i);
  });
  return index;
}

function resolveBurstMembers(
  rows: Row[],
  members: string[],
  questionIndex: Map<string, number[]>,
  used: Set<number>,
): Row[] {
  const memberRows: Row[] = [];
  for (const q of members) {
    const idx = (questionIndex.get(q) || []).find((i) => !used.has(i));
    if (idx === undefined) continue;
    used.add(idx);
    memberRows.push(rows[idx]);
  }
  return memberRows;
}

function linkRowsToIncident(incidentId: number, memberRows: Row[], programId: string, now: number): number {
  let linked = 0;
  for (const r of memberRows) {
    const res = db
      .handle()
      .query(
        "INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)",
      )
      .run(incidentId, r.id, programId, now);
    linked += res.changes;
  }
  return linked;
}

function insertCandidate({
  programId,
  representative,
  memberRows,
  windowMs,
  startedAt,
  now,
  recurrenceOf = null,
}: {
  programId: string;
  representative: string;
  memberRows: Row[];
  windowMs: number;
  startedAt: number;
  now: number;
  recurrenceOf?: number | null;
}): { incidentId: number; title: string } {
  const title = truncateTitle(representative);
  const res = db
    .handle()
    .query(
      `INSERT INTO program_incidents (program_id, title, status, reason, confidence, started_at, created_at)
     VALUES (?, ?, 'candidate', ?, ?, ?, ?)`,
    )
    .run(
      programId,
      title,
      burstReason(memberRows.length, windowMs) + (recurrenceOf ? `, recurrence of #${recurrenceOf}` : ""),
      burstConfidence(memberRows.length),
      startedAt,
      now,
    );
  return { incidentId: Number(res.lastInsertRowid), title };
}

function suggestDuplicates({
  programId,
  ticketId = null,
  question,
  limit = 5,
}: {
  programId?: string;
  ticketId?: number | null;
  question?: string;
  limit?: number;
}): Row {
  if (!programId || !question) return { error: "programId and question required" };
  const rows = fetchDuplicateRows(programId, Date.now() - DUPLICATE_WINDOW_MS);
  return { candidates: rankDuplicateCandidates(question, rows, ticketId, limit) };
}

function getIncident(id: number, programId?: string | null): Row | null {
  if (programId !== undefined) {
    return db
      .handle()
      .query("SELECT * FROM program_incidents WHERE id = ? AND program_id = ?")
      .get(id, programId) as Row | null;
  }
  return db.handle().query("SELECT * FROM program_incidents WHERE id = ?").get(id) as Row | null;
}

function listIncidents(programId: string, status: string | null = null, limit = 50): Row[] {
  if (status) {
    return db
      .handle()
      .query("SELECT * FROM program_incidents WHERE program_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?")
      .all(programId, status, limit) as Row[];
  }
  return db
    .handle()
    .query("SELECT * FROM program_incidents WHERE program_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(programId, limit) as Row[];
}

function incidentTickets(incidentId: number, programId?: string | null): Row[] {
  if (programId !== undefined) {
    return db
      .handle()
      .query(
        `SELECT t.* FROM tickets t
         JOIN incident_tickets it ON it.ticket_id = t.id
         JOIN program_incidents i ON i.id = it.incident_id
         WHERE it.incident_id = ? AND it.program_id = ? AND i.program_id = ?
         ORDER BY t.created_at ASC`,
      )
      .all(incidentId, programId, programId) as Row[];
  }
  return db
    .handle()
    .query(
      `SELECT t.* FROM tickets t JOIN incident_tickets it ON it.ticket_id = t.id WHERE it.incident_id = ? ORDER BY t.created_at ASC`,
    )
    .all(incidentId) as Row[];
}

function settleCluster({
  programId,
  memberRows,
  threshold,
  windowMs,
  now,
}: {
  programId: string;
  memberRows: Row[];
  threshold: number;
  windowMs: number;
  now: number;
}): Row | null {
  const ids = memberRows.map((r) => Number(r.id));
  const representative = String(memberRows[0].question || "");
  const matched =
    overlappingIncident(programId, ids) ||
    (() => {
      const byTitle = titleMatchedIncident(programId, representative, now);
      return byTitle ? { incident: byTitle, linked: new Set<number>() } : null;
    })();

  if (matched && LIVE_STATUSES.includes(String(matched.incident.status))) {
    const linked = linkRowsToIncident(Number(matched.incident.id), memberRows, programId, now);
    if (linked > 0) {
      recordIncidentAudit(matched.incident, "incident.tickets_linked", null, {
        linked,
        ticketIds: ids.slice(0, AUDIT_TICKET_SAMPLE),
      });
    }
    return {
      incidentId: matched.incident.id,
      title: matched.incident.title,
      status: matched.incident.status,
      linked,
      deduped: true,
    };
  }

  // Closed incidents are only reopened by reports they have not already seen
  let evidence = memberRows;
  let recurrenceOf: number | null = null;
  if (matched) {
    const since = closedAt(matched.incident);
    evidence = memberRows.filter((r) => !matched.linked.has(Number(r.id)) && Number(r.created_at) > since);
    recurrenceOf = Number(matched.incident.id);
    if (evidence.length < threshold || distinctRequesters(evidence) < Math.min(threshold, MIN_DISTINCT_REQUESTERS)) {
      return { suppressed: true, incidentId: matched.incident.id, status: matched.incident.status };
    }
  }

  const startedAt = Math.min(...evidence.map((r) => Number(r.created_at)));
  const { incidentId, title } = insertCandidate({
    programId,
    representative: String(evidence[0].question || ""),
    memberRows: evidence,
    windowMs,
    startedAt,
    now,
    recurrenceOf,
  });
  linkRowsToIncident(incidentId, evidence, programId, now);
  recordIncidentAudit({ id: incidentId, program_id: programId }, "incident.detected", null, {
    tickets: evidence.length,
    requesters: distinctRequesters(evidence),
    windowMinutes: Math.round(windowMs / 60000),
    ticketIds: evidence.slice(0, AUDIT_TICKET_SAMPLE).map((r) => Number(r.id)),
    recurrenceOf,
  });
  return { incidentId, title, status: "candidate", linked: evidence.length, deduped: false };
}

function detectBursts({
  programId,
  windowMs = INCIDENT_WINDOW_MS,
  threshold = INCIDENT_THRESHOLD,
}: { programId?: string; windowMs?: number; threshold?: number } = {}): Row {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  const rows = fetchRecentTickets(programId, now - windowMs);
  if (rows.length < threshold) return { candidates: [], suppressed: [] };

  const groups = incidentClusterQuestions(rows.map((r) => String(r.question || "")));
  const questionIndex = buildQuestionIndex(rows);
  const used = new Set<number>();
  const candidates: Row[] = [];
  const suppressed: Row[] = [];
  const minRequesters = Math.min(threshold, MIN_DISTINCT_REQUESTERS);
  for (const members of groups) {
    if (members.length < threshold) continue;
    const memberRows = resolveBurstMembers(rows, members, questionIndex, used).sort(
      (a, b) => Number(a.created_at) - Number(b.created_at),
    );
    if (memberRows.length < threshold || distinctRequesters(memberRows) < minRequesters) continue;
    // Write lock first, so a second worker sees this one's candidate
    const settle = db
      .handle()
      .transaction(() => settleCluster({ programId, memberRows, threshold, windowMs, now: Date.now() }));
    const result = settle.immediate();
    if (!result) continue;
    (result.suppressed ? suppressed : candidates).push(result);
  }
  return { candidates, suppressed };
}

function declareIncident({
  incidentId,
  actorId = null,
  description = null,
  publicMessage = null,
}: {
  incidentId: number;
  actorId?: string | null;
  description?: string | null;
  publicMessage?: string | null;
}): Row {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  const from = String(inc.status);
  if (from !== "confirmed" && !TRANSITIONS[from]?.includes("confirmed")) {
    return { error: `invalid transition: ${from} -> confirmed` };
  }
  const t = Date.now();
  const res = db
    .handle()
    .query(
      "UPDATE program_incidents SET status = 'confirmed', confirmed_at = ?, description = ?, declared_by = ?, public_message = ? WHERE id = ? AND status = ?",
    )
    .run(t, description || null, actorId, publicMessage || null, incidentId, from);
  if (res.changes === 0) return { error: "incident status changed, reload and retry" };
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: inc.program_id,
    actorId,
    action: "incident.declared",
    entityType: "incident",
    entityId: incidentId,
    metadata: { description, publicMessage },
  });
  return { ok: true, incident: getIncident(incidentId) };
}

function createIncident({
  programId,
  title,
  description = null,
  publicMessage = null,
  actorId = null,
}: {
  programId?: string;
  title?: string;
  description?: string | null;
  publicMessage?: string | null;
  actorId?: string | null;
}): Row {
  if (!programId) return { error: "programId required" };
  if (!programs.get(programId)) return { error: "unknown program" };
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) return { error: "title required" };
  const cleanDescription = description ? String(description).trim() : null;
  const cleanPublicMessage = publicMessage ? String(publicMessage).trim() : null;
  const now = Date.now();
  const result = db
    .handle()
    .query(
      `INSERT INTO program_incidents
      (program_id, title, status, started_at, created_at, confirmed_at, description, declared_by, public_message)
     VALUES (?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      programId,
      truncateTitle(cleanTitle),
      now,
      now,
      now,
      cleanDescription || null,
      actorId,
      cleanPublicMessage || null,
    );
  const incidentId = Number(result.lastInsertRowid);
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId,
    actorId,
    action: "incident.declared",
    entityType: "incident",
    entityId: incidentId,
    metadata: { source: "manual", description: cleanDescription, publicMessage: cleanPublicMessage },
  });
  return { ok: true, incident: getIncident(incidentId) };
}

function matchActiveIncident({ programId, question }: { programId?: string; question?: string }): Row | null {
  if (!programId || !question) return null;
  const active = listIncidents(programId, "confirmed", 20);
  if (active.length === 0) return null;
  return pickBestIncident(question, active);
}

function recordAffectedReport({
  incidentId,
  programId,
  ticketId = null,
  requesterId,
  channel,
  threadTs,
}: {
  incidentId: number;
  programId: string;
  ticketId?: number | null;
  requesterId?: string | null;
  channel: string;
  threadTs: string;
}): Row {
  const incident = getIncident(incidentId);
  if (!incident) return { error: "incident not found" };
  if (incident.program_id !== programId) return { error: "program mismatch" };
  const already = db
    .handle()
    .query("SELECT 1 FROM incident_reports WHERE incident_id = ? AND channel = ? AND thread_ts = ?")
    .get(incidentId, channel, threadTs);
  if (already) return { ok: true, deduped: true };
  if (ticketId) {
    // Only a ticket of this program may join this incident
    db.handle()
      .query(
        `INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at)
         SELECT ?, t.id, ?, ? FROM tickets t WHERE t.id = ? AND t.program_id = ?`,
      )
      .run(incidentId, programId, Date.now(), ticketId, programId);
  }
  db.handle()
    .query(
      "INSERT INTO incident_reports (incident_id, program_id, ticket_id, requester_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(incidentId, programId, ticketId, requesterId || null, channel, threadTs, Date.now());
  return { ok: true, deduped: false };
}

function affectedReports(incidentId: number, onlyUnnotified = false, programId?: string | null): Row[] {
  const clause = onlyUnnotified ? "AND notified_at IS NULL" : "";
  if (programId !== undefined) {
    return db
      .handle()
      .query(
        `SELECT r.* FROM incident_reports r
         JOIN program_incidents i ON i.id = r.incident_id
         WHERE r.incident_id = ? AND r.program_id = ? AND i.program_id = ? ${clause}
         ORDER BY r.created_at ASC`,
      )
      .all(incidentId, programId, programId) as Row[];
  }
  return db
    .handle()
    .query(`SELECT * FROM incident_reports WHERE incident_id = ? ${clause} ORDER BY created_at ASC`)
    .all(incidentId) as Row[];
}

async function notifyAffectedUsers({
  incidentId,
  actorId = null,
  client,
  resolutionMessage = null,
}: {
  incidentId: number;
  actorId?: string | null;
  client?: SlackClient;
  resolutionMessage?: string | null;
}): Promise<Row> {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  if (inc.status !== "resolved") return { error: "incident is not resolved" };
  if (!client) return { error: "slack client unavailable" };
  const prog = programs.get(inc.program_id);
  const pending = affectedReports(incidentId, true, inc.program_id);
  const text = resolutionMessage || defaultResolutionText(String(inc.title || ""));
  const claim = db.handle().query("UPDATE incident_reports SET notified_at = ? WHERE id = ? AND notified_at IS NULL");
  const release = db.handle().query("UPDATE incident_reports SET notified_at = NULL WHERE id = ?");
  let notified = 0;
  let skipped = 0;
  const errors = [];
  for (const r of pending) {
    // Claim first so a second click cannot message the same thread twice
    if (claim.run(Date.now(), r.id).changes === 0) continue;
    try {
      const sent = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: String(r.channel || ""),
        threadTs: r.thread_ts || null,
        text,
      });
      if (sent?.shadowed) {
        release.run(r.id);
        skipped += 1;
        continue;
      }
      notified += 1;
    } catch (e: any) {
      release.run(r.id);
      errors.push({ reportId: r.id, error: e.message });
    }
  }
  recordIncidentAudit(inc, "incident.notified_affected", actorId, {
    notified,
    failed: errors.length,
    skipped,
    reasons: errors.slice(0, 5).map((e) => String(e.error).slice(0, 120)),
  });
  return { ok: true, notified, failed: errors.length, skipped, errors };
}

// Audit trail for one incident, oldest first
function timeline(incidentId: number, programId: string): Row[] {
  const rows = db
    .handle()
    .query(
      `SELECT id, action, actor_id, metadata, created_at FROM audit_events
       WHERE program_id = ? AND entity_type = 'incident' AND entity_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 200`,
    )
    .all(programId, String(incidentId)) as Row[];
  return rows.map((r) => {
    let metadata: unknown = null;
    try {
      metadata = r.metadata ? JSON.parse(String(r.metadata)) : null;
    } catch (_) {
      metadata = null;
    }
    return { id: r.id, action: r.action, actorId: r.actor_id, at: r.created_at, metadata };
  });
}

function setIncidentStatus({
  incidentId,
  status,
  actorId = null,
  evidence = null,
}: {
  incidentId: number;
  status: string;
  actorId?: string | null;
  evidence?: string | null;
}): Row {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  if (!["candidate", "confirmed", "dismissed", "resolved"].includes(status)) return { error: "invalid status" };
  const from = String(inc.status);
  if (from === status) return { ok: true, unchanged: true, incident: inc };
  if (!(TRANSITIONS[from] || []).includes(status)) return { error: `invalid transition: ${from} -> ${status}` };
  if (status === "resolved" && !actorId) return { error: "resolving an incident needs a named actor" };
  const t = Date.now();
  const extra =
    status === "confirmed"
      ? ", confirmed_at = ?"
      : status === "resolved"
        ? ", resolved_at = ?"
        : status === "dismissed"
          ? ", dismissed_at = ?"
          : "";
  const params = status === "candidate" ? [status, incidentId, from] : [status, t, incidentId, from];
  // Compare-and-set on the status we validated against
  const res = db
    .handle()
    .query(`UPDATE program_incidents SET status = ?${extra} WHERE id = ? AND status = ?`)
    .run(...params);
  if (res.changes === 0) return { error: "incident status changed, reload and retry" };
  recordIncidentAudit(inc, `incident.${status}`, actorId, {
    from,
    ...(evidence ? { evidence: String(evidence).slice(0, 500) } : {}),
  });
  return { ok: true, incident: getIncident(incidentId) };
}

function linkTicket({
  incidentId,
  ticketId,
  actorId = null,
}: {
  incidentId: number;
  ticketId: number;
  actorId?: string | null;
}): Row {
  const inc = getIncident(incidentId);
  const ticket = db.getTicket(ticketId);
  if (!inc || !ticket) return { error: "incident or ticket not found" };
  if (inc.program_id !== ticket.program_id) return { error: "program mismatch" };
  db.handle()
    .query("INSERT OR IGNORE INTO incident_tickets (incident_id, ticket_id, program_id, linked_at) VALUES (?, ?, ?, ?)")
    .run(incidentId, ticketId, inc.program_id, Date.now());
  recordIncidentAudit(inc, "incident.ticket_linked", actorId, { ticketId, source: "manual" });
  return { ok: true };
}

function unlinkTicket({
  incidentId,
  ticketId,
  actorId = null,
}: {
  incidentId: number;
  ticketId: number;
  actorId?: string | null;
}): Row {
  const inc = getIncident(incidentId);
  const res = db
    .handle()
    .query("DELETE FROM incident_tickets WHERE incident_id = ? AND ticket_id = ?")
    .run(incidentId, ticketId);
  if (inc && res.changes > 0) recordIncidentAudit(inc, "incident.ticket_unlinked", actorId, { ticketId });
  return { ok: true };
}

function draftAnnouncement({ incidentId }: { incidentId: number }): Row {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  const tickets = incidentTickets(incidentId);
  return {
    ok: true,
    draft: `Heads up: we're seeing ${tickets.length} similar report${tickets.length === 1 ? "" : "s"} about "${inc.title}". We're looking into it — please keep discussion in your threads and we'll update here. (Draft only — a human posts this.)`,
    ticketCount: tickets.length,
  };
}

export = {
  suggestDuplicates,
  detectBursts,
  getIncident,
  listIncidents,
  incidentTickets,
  setIncidentStatus,
  linkTicket,
  unlinkTicket,
  draftAnnouncement,
  declareIncident,
  createIncident,
  matchActiveIncident,
  recordAffectedReport,
  affectedReports,
  notifyAffectedUsers,
  incidentClusterQuestions,
  recordIncidentAudit,
  timeline,
};
