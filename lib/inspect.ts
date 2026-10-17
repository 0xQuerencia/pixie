import db = require("./db");
import docs = require("./programDocs");
import programs = require("./programs");

interface InspectOptions {
  role?: string;
  limit?: number;
}

interface RetrievalHit {
  rank: number;
  score: number;
  docId?: number;
  sourceKey?: string;
  section: string;
  trust: "official" | "supporting";
  updatedAt: number;
  excerpt: string;
}

interface TraceStep {
  name: string;
  ms: number;
  detail?: string;
}

function tokens(text: string): string[] {
  return [
    ...new Set(
      String(text || "")
        .toLocaleLowerCase()
        .match(/[a-z0-9][a-z0-9_-]*/g) || [],
    ),
  ];
}

function score(question: string, text: string): number {
  const query = tokens(question);
  const corpus = new Set(tokens(text));
  if (!query.length) return 0;
  return query.reduce((sum, token) => sum + (corpus.has(token) ? 1 : 0), 0) / query.length;
}

function excerpt(text: string): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function traceStep<T>(
  steps: TraceStep[],
  name: string,
  detail: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const started = Date.now();
  const result = await action();
  steps.push({ name, ms: Date.now() - started, detail });
  return result;
}

async function answerWithoutWrites(question: string, program: Record<string, unknown>, context: string) {
  const lookup = require("./lookup");
  const original = {
    recordMetric: db.recordMetric,
    recordLlmUsage: db.recordLlmUsage,
    recordGap: db.recordGap,
    recordRequest: db.recordRequest,
  };
  db.recordMetric = () => undefined;
  db.recordLlmUsage = () => undefined;
  db.recordGap = () => undefined;
  db.recordRequest = () => undefined;
  try {
    return await lookup.lookupAnswer(question, context, program, null, { skipCache: true });
  } finally {
    db.recordMetric = original.recordMetric;
    db.recordLlmUsage = original.recordLlmUsage;
    db.recordGap = original.recordGap;
    db.recordRequest = original.recordRequest;
  }
}

function escalation(program: Record<string, unknown>, question: string, reason: string) {
  const channel = program.helpChannel || program.organizerChannel || null;
  return channel ? { channel, reason, context: question } : null;
}

async function inspect(programId: string, question: string, options: InspectOptions = {}) {
  const program = programs.get(programId) as Record<string, unknown> | null;
  if (!program) throw new Error("unknown program");
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) throw new Error("question required");
  if (cleanQuestion.length > 2000) throw new Error("question too long (max 2000 chars)");
  const steps: TraceStep[] = [];
  const hits = await traceStep(steps, "retrieval", "program-scoped active official docs and source state", () => {
    const candidates: Array<{ text: string; hit: Omit<RetrievalHit, "rank" | "score"> }> = [];
    for (const doc of docs.listDocs(programId, { activeOnly: true }).filter((item) => item.trust === "official")) {
      candidates.push({
        text: `${doc.title} ${doc.body}`,
        hit: {
          docId: doc.id,
          section: doc.section,
          trust: "official",
          updatedAt: doc.updated_at,
          excerpt: excerpt(doc.body),
        },
      });
    }
    for (const state of docs.sourceStates(programId).filter((item) => item.ok === 1)) {
      candidates.push({
        text: `${state.source_key} ${state.text}`,
        hit: {
          sourceKey: state.source_key,
          section: "source",
          trust: "official",
          updatedAt: state.fetched_at,
          excerpt: excerpt(state.text),
        },
      });
    }
    const limit = Math.min(Math.max(Number(options.limit) || 8, 1), 20);
    return candidates
      .map((candidate) => ({ ...candidate.hit, score: score(cleanQuestion, candidate.text) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || (a.docId || 0) - (b.docId || 0))
      .slice(0, limit)
      .map((candidate, index) => ({ rank: index + 1, ...candidate }));
  });
  const context = `\n\nInspection context (read-only):\n${hits.map((hit) => `### ${hit.section}\n${hit.excerpt}`).join("\n\n") || "No matching program documents."}`;
  let result: { answer?: string } | null = null;
  try {
    result = await traceStep(steps, "answer", "real lookup answer path with dry-run writes suppressed", () =>
      answerWithoutWrites(cleanQuestion, program, context),
    );
  } catch (error) {
    steps.push({
      name: "answer",
      ms: 0,
      detail: `answer path failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const grounded = Boolean(result && require("./respond").isGroundedAnswer(result));
  const decision = grounded
    ? "answer"
    : program.autoEscalate === false
      ? "abstain"
      : escalation(program, cleanQuestion, "no grounded answer")
        ? "escalate"
        : "abstain";
  const escalationPreview = decision === "escalate" ? escalation(program, cleanQuestion, "no grounded answer") : null;
  steps.push({ name: "decision", ms: 0, detail: `${decision}; role=${options.role || "inspect"}` });
  steps.push({ name: "escalation_preview", ms: 0, detail: escalationPreview ? "available" : "none" });
  return {
    program: { id: program.id, name: program.name, lifecycle: program.lifecycle || "active" },
    retrieved: hits,
    answer: result?.answer || null,
    grounded,
    decision,
    escalation: escalationPreview,
    trace: { steps },
  };
}

export = { inspect };
