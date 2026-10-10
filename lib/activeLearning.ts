const audit = require("./audit");
const db = require("./db");
const log = require("./log");
const retrieve = require("./retrieve");
const resolutionMemory = require("./resolutionMemory");
import type { Program, Ticket } from "./types";

interface TicketEvent {
  event_type: string;
  actor_id: string | null;
}

interface LearnedFact {
  id: number;
  question: string;
  answer: string;
  status: string;
  category: string | null;
  program_id: string | null;
  last_supported_at?: number | null;
  created_at?: number | null;
}

interface ActiveTicket extends Ticket {
  program?: Program | null;
  resolution: string | null;
  category: string | null;
}

interface Extraction {
  problem: string;
  solution?: string;
  cause?: string;
  category?: string;
}

interface FactDraft {
  question: string;
  answer: string;
  category: string | null;
}

interface LearningResult {
  ok: boolean;
  skipped?: boolean;
  duplicate?: boolean;
  refreshed?: boolean;
  autoLearned?: boolean;
  superseded?: number[];
  fact?: LearnedFact | null;
  error?: string;
}

const SIMILARITY_THRESHOLD = 0.6;
const PROGRAM_OBJECT_TOKENS = new Set(["submission", "project", "program", "review", "payout"]);
const INTENT_GROUPS: Array<[string, string[]]> = [
  ["location", ["where", "find", "locate"]],
  ["timing", ["when", "long", "arrive", "take", "timing"]],
  ["edit", ["edit", "change", "modify", "cancel"]],
  ["eligibility", ["eligible", "qualify", "eligibility"]],
];
const CLOSED = new Set(["resolved", "closed"]);
const EXCLUDED = new Set(["duplicate", "spam"]);

function normalizeAnswer(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function similarity(left: string, right: string): number {
  const a = new Set(retrieve.tokenize(left));
  const b = new Set(retrieve.tokenize(right));
  if (a.size === 0 || b.size === 0) return normalizeAnswer(left) === normalizeAnswer(right) ? 1 : 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

function intentGroups(question: string): Set<string> {
  const tokens = new Set(retrieve.tokenize(question));
  return new Set(INTENT_GROUPS.filter(([, words]) => words.some((word) => tokens.has(word))).map(([group]) => group));
}

function canSupersede(existingQuestion: string, nextQuestion: string): boolean {
  if (similarity(existingQuestion, nextQuestion) < SIMILARITY_THRESHOLD) return false;
  const existingIntent = intentGroups(existingQuestion);
  const nextIntent = intentGroups(nextQuestion);
  if (existingIntent.size > 0 || nextIntent.size > 0) {
    return [...existingIntent].some((group) => nextIntent.has(group));
  }
  const existingTokens = new Set<string>(retrieve.tokenize(existingQuestion) as string[]);
  const nextTokens = new Set<string>(retrieve.tokenize(nextQuestion) as string[]);
  const informativeShared = [...existingTokens].filter(
    (token) => nextTokens.has(token) && !PROGRAM_OBJECT_TOKENS.has(token),
  );
  return informativeShared.length >= 2;
}

function helperAnswered(ticket: ActiveTicket): boolean {
  const events = db.listTicketEvents(ticket.id, 100);
  if (events.some((event: TicketEvent) => event.event_type === "helper_reply")) return true;
  const requester = ticket.requester_id;
  return [ticket.assignee_id, ticket.resolved_by].some((id) => id && id !== requester);
}

function excludedTicket(ticket: ActiveTicket): boolean {
  if (!ticket || EXCLUDED.has(ticket.status) || ticket.duplicate_of) return true;
  return db.listTicketEvents(ticket.id, 100).some((event: TicketEvent) => EXCLUDED.has(event.event_type));
}

function answerFromExtraction(extraction: Extraction | null, ticket: ActiveTicket): FactDraft | null {
  if (!extraction) return null;
  const answer = [extraction.solution, extraction.cause ? `Cause: ${extraction.cause}` : null]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!answer) return null;
  return {
    question: extraction.problem,
    answer,
    category: extraction.category || ticket.category || null,
  };
}

async function extractFact(ticket: ActiveTicket): Promise<FactDraft> {
  let extraction = null;
  try {
    extraction = await resolutionMemory.extractCandidate(ticket, db.listTicketEvents(ticket.id, 50));
  } catch (error) {
    log.warn(
      "active-learning",
      `extraction failed for #${ticket.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return (
    answerFromExtraction(extraction, ticket) || {
      question: ticket.question,
      answer: String(ticket.resolution || "").trim(),
      category: ticket.category || null,
    }
  );
}

async function learnFromResolution({
  ticket,
  workerId = null,
}: {
  ticket: ActiveTicket;
  workerId?: string | null;
}): Promise<LearningResult> {
  if (!ticket || !CLOSED.has(ticket.status) || excludedTicket(ticket) || !helperAnswered(ticket)) {
    return { ok: false, skipped: true };
  }
  if (!String(ticket.resolution || "").trim()) return { ok: false, skipped: true };

  const existingForTicket = db.learnedFactForTicket(ticket.id);
  if (existingForTicket && existingForTicket.status !== "superseded") {
    return { ok: true, fact: existingForTicket, duplicate: true };
  }

  const fact = await extractFact(ticket);
  if (!fact.question || !fact.answer) return { ok: false, skipped: true };
  // A helper resolution is useful evidence, but it is never policy authority
  // by itself. Keep every automatically extracted fact reviewable until a
  // human explicitly approves it.
  const status = "candidate";
  const overlaps = fact.category
    ? db
        .learnedFactsForOverlap(ticket.program_id, fact.category)
        .filter((row: LearnedFact) => row.status === "candidate" || row.status === "pending")
        .filter((row: LearnedFact) => canSupersede(row.question, fact.question))
    : [];
  const same = overlaps.find((row: LearnedFact) => normalizeAnswer(row.answer) === normalizeAnswer(fact.answer));
  if (same) {
    db.refreshLearnedFact(same.id);
    return { ok: true, fact: db.getLearnedFactById(same.id), refreshed: true };
  }

  const helperId = workerId || ticket.assignee_id || ticket.resolved_by || null;
  const id = db.addLearnedFact({
    question: fact.question,
    answer: fact.answer,
    authorId: helperId,
    status,
    sourceTs: `resolution:${ticket.id}`,
    channel: ticket.channel,
    programId: ticket.program_id,
    category: fact.category,
    ticketId: ticket.id,
    resolverId: helperId,
    autoLearned: false,
  });
  if (!id) {
    const duplicate = db.learnedFactForTicket(ticket.id);
    return duplicate ? { ok: true, fact: duplicate, duplicate: true } : { ok: false, error: "could not store fact" };
  }
  for (const old of overlaps) db.supersedeLearnedFact(old.id, id);
  const stored = db.getLearnedFactById(id);
  audit.record({
    programId: ticket.program_id,
    actorId: helperId,
    action: "knowledge.candidate_proposed",
    entityType: "learned_fact",
    entityId: id,
    metadata: { ticketId: ticket.id, resolverId: helperId, autoLearned: false },
  });
  return {
    ok: true,
    fact: stored,
    autoLearned: false,
    superseded: overlaps.map((row: LearnedFact) => row.id),
  };
}

export = {
  learnFromResolution,
  similarity,
  canSupersede,
  SIMILARITY_THRESHOLD,
};
