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
]);

function incidentTerms(text: unknown): Set<string> {
  const raw = String(text || "").toLowerCase();
  const terms = new Set(retrieve.tokenize(raw).filter((term) => !INCIDENT_NOISE.has(term)));
  if (ACCESS_LANGUAGE.test(raw)) terms.add("incident_service");
  return terms;
}

function incidentSimilarity(question: string, incident: Row): number {
  if (!OUTAGE_LANGUAGE.test(String(question || ""))) return 0;
  const texts = [incident.title, incident.description].filter(Boolean);
  let score = 0;
  for (const text of texts) {
    if (!OUTAGE_LANGUAGE.test(String(text || ""))) continue;
    const questionTerms = incidentTerms(question);
    const incidentTermsForText = incidentTerms(text);
    const namesAffectedThing = [...questionTerms].some((term) => incidentTermsForText.has(term));
    if (!namesAffectedThing) continue;
    const wordingScore = incidentSimilarityScore(question, String(text));
    const genericServiceMatch = questionTerms.has("incident_service") && incidentTermsForText.has("incident_service");
    if (wordingScore >= SIMILARITY_THRESHOLD || genericServiceMatch) {
      score = Math.max(score, wordingScore, genericServiceMatch ? 0.5 : 0);
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
      const leftOutage = OUTAGE_LANGUAGE.test(questions[left]);
      const rightOutage = OUTAGE_LANGUAGE.test(questions[right]);
      if (leftOutage && rightOutage) {
        const leftTerms = incidentTerms(questions[left]);
        const rightTerms = incidentTerms(questions[right]);
        const sharedService = [...leftTerms].some((term) => rightTerms.has(term));
        const similar = incidentSimilarityScore(questions[left], questions[right]);
        if (sharedService && similar >= threshold) union(left, right);
      } else if (!leftOutage && !rightOutage && similarityScore(questions[left], questions[right]) >= threshold) {
        // Preserve the existing duplicate-question burst behavior for ordinary
        // support gaps; semantic outage grouping above is the additional gate.
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
      `SELECT id, question, thread_ts, created_at FROM tickets
     WHERE program_id = ? AND created_at > ? AND status NOT IN ('closed','spam','duplicate')
     ORDER BY created_at ASC LIMIT 300`,
    )
    .all(programId, cutoff) as Row[];
}

function fetchLiveIncidents(programId: string, now: number): Row[] {
  return db
    .handle()
    .query(
      "SELECT * FROM program_incidents WHERE program_id = ? AND status IN ('candidate','confirmed') AND created_at > ? ORDER BY created_at DESC LIMIT 10",
    )
    .all(programId, now - INCIDENT_COOLDOWN_MS) as Row[];
}

function findCooldownIncident(live: Row[], representative: string): Row | undefined {
  return live.find((inc) => isSimilar(String(inc.title || ""), representative));
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
}: {
  programId: string;
  representative: string;
  memberRows: Row[];
  windowMs: number;
  startedAt: number;
  now: number;
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
      burstReason(memberRows.length, windowMs),
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

function getIncident(id: number): Row | null {
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

function incidentTickets(incidentId: number): Row[] {
  return db
    .handle()
    .query(
      `SELECT t.* FROM tickets t JOIN incident_tickets it ON it.ticket_id = t.id WHERE it.incident_id = ? ORDER BY t.created_at ASC`,
    )
    .all(incidentId) as Row[];
}

function detectBursts({
  programId,
  windowMs = INCIDENT_WINDOW_MS,
  threshold = INCIDENT_THRESHOLD,
}: { programId?: string; windowMs?: number; threshold?: number } = {}): Row {
  if (!programId) return { error: "programId required" };
  const now = Date.now();
  const rows = fetchRecentTickets(programId, now - windowMs);
  if (rows.length < threshold) return { candidates: [] };

  const groups = incidentClusterQuestions(rows.map((r) => String(r.question || "")));
  const questionIndex = buildQuestionIndex(rows);
  const used = new Set<number>();
  const out: Row[] = [];
  for (const members of groups) {
    if (members.length < threshold) continue;
    const memberRows = resolveBurstMembers(rows, members, questionIndex, used);
    if (memberRows.length < threshold) continue;
    const startedAt = Math.min(...memberRows.map((r) => Number(r.created_at)));
    const representative = String(
      memberRows.sort((a, b) => Number(a.created_at) - Number(b.created_at))[0].question || "",
    );
    const same = findCooldownIncident(fetchLiveIncidents(programId, now), representative);
    if (same) {
      const linked = linkRowsToIncident(Number(same.id), memberRows, programId, now);
      out.push({ incidentId: same.id, title: same.title, status: same.status, linked, deduped: true });
      continue;
    }
    const { incidentId, title } = insertCandidate({ programId, representative, memberRows, windowMs, startedAt, now });
    linkRowsToIncident(incidentId, memberRows, programId, now);
    out.push({ incidentId, title, status: "candidate", linked: memberRows.length, deduped: false });
  }
  return { candidates: out };
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
  const t = Date.now();
  db.handle()
    .query(
      "UPDATE program_incidents SET status = 'confirmed', confirmed_at = ?, description = ?, declared_by = ?, public_message = ? WHERE id = ?",
    )
    .run(t, description || null, actorId, publicMessage || null, incidentId);
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
  const already = db
    .handle()
    .query("SELECT 1 FROM incident_reports WHERE incident_id = ? AND channel = ? AND thread_ts = ?")
    .get(incidentId, channel, threadTs);
  if (already) return { ok: true, deduped: true };
  db.handle()
    .query(
      "INSERT INTO incident_reports (incident_id, program_id, ticket_id, requester_id, channel, thread_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(incidentId, programId, ticketId, requesterId || null, channel, threadTs, Date.now());
  return { ok: true, deduped: false };
}

function affectedReports(incidentId: number, onlyUnnotified = false): Row[] {
  const clause = onlyUnnotified ? "AND notified_at IS NULL" : "";
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
  if (!client) return { error: "slack client unavailable" };
  const prog = programs.get(inc.program_id);
  const pending = affectedReports(incidentId, true);
  const text = resolutionMessage || defaultResolutionText(String(inc.title || ""));
  let notified = 0;
  const errors = [];
  for (const r of pending) {
    try {
      await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: String(r.channel || ""),
        threadTs: r.thread_ts || null,
        text,
      });
      db.handle().query("UPDATE incident_reports SET notified_at = ? WHERE id = ?").run(Date.now(), r.id);
      notified += 1;
    } catch (e: any) {
      errors.push({ reportId: r.id, error: e.message });
    }
  }
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: inc.program_id,
    actorId,
    action: "incident.notified_affected",
    entityType: "incident",
    entityId: incidentId,
    metadata: { notified, failed: errors.length },
  });
  return { ok: true, notified, failed: errors.length, errors };
}

function setIncidentStatus({
  incidentId,
  status,
  actorId = null,
}: {
  incidentId: number;
  status: string;
  actorId?: string | null;
}): Row {
  const inc = getIncident(incidentId);
  if (!inc) return { error: "incident not found" };
  if (!["candidate", "confirmed", "dismissed", "resolved"].includes(status)) return { error: "invalid status" };
  const t = Date.now();
  const extra = status === "confirmed" ? ", confirmed_at = ?" : status === "resolved" ? ", resolved_at = ?" : "";
  const params = status === "candidate" || status === "dismissed" ? [status, incidentId] : [status, t, incidentId];
  db.handle()
    .query(`UPDATE program_incidents SET status = ?${extra} WHERE id = ?`)
    .run(...params);
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: inc.program_id,
    actorId,
    action: `incident.${status}`,
    entityType: "incident",
    entityId: incidentId,
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
  return { ok: true };
}

function unlinkTicket({ incidentId, ticketId }: { incidentId: number; ticketId: number }): Row {
  db.handle().query("DELETE FROM incident_tickets WHERE incident_id = ? AND ticket_id = ?").run(incidentId, ticketId);
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
};
