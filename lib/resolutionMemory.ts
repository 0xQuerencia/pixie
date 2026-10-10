import db = require("./db");
import log = require("./log");
import audit = require("./audit");
import learn = require("./learn");
import configModule = require("./config");
import type { Ticket } from "./types";

interface DbRow {
  id?: number;
  ticket_id?: number;
  program_id?: string;
  event_type?: string;
  actor_id?: string;
  detail?: unknown;
  created_at?: number;
  [key: string]: unknown;
}
const { config } = configModule;

interface CandidateExtraction {
  problem: string;
  solution: string;
  category: string | null;
  cause: string | null;
}

const CANDIDATE = "candidate";
const REJECTED = "rejected";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message);
  return String(error);
}

function existingCandidate(ticketId: number): DbRow | null {
  try {
    return db.candidateForTicket(ticketId);
  } catch (e: unknown) {
    log.warn("resolution-memory", `failed to fetch existing candidate for ticket ${ticketId}: ${errorMessage(e)}`);
    return null;
  }
}

function validateExtraction(obj: unknown): CandidateExtraction | null {
  if (!obj || typeof obj !== "object") return null;
  const value = obj as Record<string, unknown>;
  const problem = String(value.problem || "").trim();
  const solution = String(value.solution || "").trim();
  if (!problem || !solution) return null;
  if (problem.length > 500 || solution.length > 2000) return null;
  const category =
    String(value.category || "")
      .trim()
      .slice(0, 60) || null;
  const cause =
    String(value.cause || "")
      .trim()
      .slice(0, 500) || null;
  return { problem, solution, category, cause };
}

async function extractCandidate(ticket: Ticket, _events: DbRow[]): Promise<CandidateExtraction | null> {
  const llm = require("./llm");
  const threadBits = [];
  try {
    const msgs = db.getThreadMessages(ticket.thread_ts) || [];
    for (const m of msgs.slice(-10)) threadBits.push(`${m.role}: ${(m.content || "").slice(0, 400)}`);
  } catch (e: unknown) {
    log.warn("resolution-memory", `failed to get thread messages for ticket ${ticket.thread_ts}: ${errorMessage(e)}`);
  }
  const prompt = [
    "Extract a reusable support fact from this resolved ticket as JSON:",
    '{"problem": "<one-line user problem>", "cause": "<root cause or empty>", "solution": "<verified fix>", "category": "<short category>"}',
    "Reply with JSON only. If no reusable fact exists, reply {}.",
    "",
    `Question: ${ticket.question}`,
    `Resolution: ${ticket.resolution || ""}`,
    ...(threadBits.length > 0 ? ["", "Thread:", ...threadBits] : []),
  ].join("\n");
  const res = await llm.complete(
    {
      apiKey: config.intent.apiKey,
      baseUrl: config.intent.baseUrl,
      model: config.intent.model,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 400,
      temperature: 0,
      ...(config.intent.fallback ? { fallback: config.intent.fallback } : {}),
    },
    "resolution-memory",
  );
  const text = (res && res.text ? res.text : "").trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return validateExtraction(JSON.parse(match[0]));
  } catch (e: unknown) {
    log.debug("resolution-memory", `failed to parse candidate JSON: ${errorMessage(e)}`);
    return null;
  }
}

async function proposeFromTicket({
  ticketId,
  actorId,
}: {
  ticketId: number;
  actorId: string | null;
}): Promise<Record<string, unknown>> {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (ticket.status !== "resolved") return { error: "only resolved tickets yield candidates" };
  const dupe = existingCandidate(ticketId);
  if (dupe) return { ok: true, candidate: dupe, duplicate: true };

  let extraction = null;
  try {
    extraction = await extractCandidate(ticket, db.listTicketEvents(ticketId, 50));
  } catch (e: unknown) {
    log.warn("resolution-memory", `extraction failed for #${ticketId}: ${errorMessage(e)}`);
  }
  const question = extraction ? extraction.problem : ticket.question;
  const answer = extraction
    ? [extraction.solution, extraction.cause ? `Cause: ${extraction.cause}` : null].filter(Boolean).join("\n")
    : ticket.resolution || ticket.summary || ticket.question;
  const addLearnedFact = db.addLearnedFact as (row: Record<string, unknown>) => number | null;
  const id = addLearnedFact({
    question,
    answer,
    authorId: actorId || null,
    status: CANDIDATE,
    channel: ticket.channel,
    programId: ticket.program_id,
    category: (extraction && extraction.category) || ticket.category || null,
    ticketId: ticket.id,
    resolverId: ticket.assignee_id || actorId || null,
  });
  if (!id) return { error: "could not store candidate" };
  const candidate = db.getLearnedFactById(id);
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: ticket.program_id,
    actorId,
    action: "knowledge.candidate_proposed",
    entityType: "learned_fact",
    entityId: id,
    metadata: { ticketId },
  });
  return { ok: true, candidate, aiExtracted: !!extraction };
}

function approveCandidate({
  id,
  actorId,
  edits = {},
}: {
  id: number;
  actorId: string | null;
  edits?: { question?: string; answer?: string; category?: string };
}): Record<string, unknown> {
  const row = db.getLearnedFactById(id);
  if (!row) return { error: "candidate not found" };
  if (row.status !== CANDIDATE && row.status !== "pending") return { error: "only candidates can be approved here" };
  const approveWithEdits = db.approveLearnedFactWithEdits as (
    factId: number,
    patch: Record<string, unknown>,
  ) => boolean;
  const approvedNow = approveWithEdits(id, {
    question: edits.question || null,
    answer: edits.answer || null,
    category: edits.category || null,
  });
  if (!approvedNow) return { error: "approval failed" };
  learn.invalidateCorpus();
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: row.program_id,
    actorId,
    action: "knowledge.candidate_approved",
    entityType: "learned_fact",
    entityId: id,
    metadata: { ticketId: row.ticket_id },
  });
  return { ok: true, fact: db.getLearnedFactById(id) };
}

function rejectCandidate({ id, actorId }: { id: number; actorId: string | null }): Record<string, unknown> {
  const row = db.getLearnedFactById(id);
  if (!row) return { error: "candidate not found" };
  if (row.status !== CANDIDATE && row.status !== "pending" && !(row.status === "approved" && row.auto_learned)) {
    return { error: "only candidates can be rejected here" };
  }
  if (!db.setLearnedStatus(id, REJECTED)) return { error: "rejection failed" };
  require("./learn").invalidateCorpus();
  const recordAudit = audit.record as (entry: Record<string, unknown>) => unknown;
  recordAudit({
    programId: row.program_id,
    actorId,
    action: "knowledge.candidate_rejected",
    entityType: "learned_fact",
    entityId: id,
    metadata: { ticketId: row.ticket_id },
  });
  return { ok: true };
}

function listCandidates(programId: string, status = CANDIDATE, limit = 50): DbRow[] {
  if (status === CANDIDATE) return db.listReviewableLearnedFacts(programId, limit);
  const listLearnedFacts = db.listLearnedFacts as (
    factStatus: string,
    factLimit: number,
    factProgramId: string,
  ) => DbRow[];
  return listLearnedFacts(status, limit, programId);
}

export = {
  proposeFromTicket,
  approveCandidate,
  rejectCandidate,
  listCandidates,
  validateExtraction,
  extractCandidate,
  CANDIDATE,
  REJECTED,
};
