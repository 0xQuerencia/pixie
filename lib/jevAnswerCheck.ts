import jev = require("./jevDecision");
import type { JevAnswerCheck } from "./types";

type Decision = "answer" | "clarify" | "escalate" | "ignore";

interface CheckInput {
  question?: unknown;
  context?: unknown;
  programId?: unknown;
  programName?: unknown;
  answer?: unknown;
  evidence?: Array<{ sourceName?: unknown; heading?: unknown; text?: unknown; programId?: unknown }>;
}

interface Outcome {
  status?: string;
  errorKind?: string;
  latencyMs?: number;
  result?: {
    answers?: Record<string, { choice?: unknown; score?: unknown }>;
  };
}

interface CheckDeps {
  evaluateDecision?: (input: unknown, deps: unknown) => Promise<Outcome>;
  jev?: unknown;
}

const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_CHARS = 700;
const MAX_ANSWER_CHARS = 1500;
const MAX_QUESTION_CHARS = 600;
const MAX_CONTEXT_CHARS = 1200;
const MAX_RISK_OK = 2;

const DECISIONS: Record<Decision, string> = {
  answer:
    "The proposed answer directly answers the question, is for the stated program, and every factual statement in it is supported by the supplied evidence.",
  clarify:
    "The question is too vague or lacks a clear referent, so the evidence cannot be applied without asking the requester something first.",
  escalate:
    "The question is a real program question but the evidence does not support the answer, contradicts it, or belongs to a different program; a human should answer.",
  ignore:
    "The message does not need a Pixie reply: it is chatter, not a request for help, or already answered by a person.",
};

const QUESTIONS = {
  decision: {
    type: "choice",
    instructions:
      "Decide what Pixie should do with the proposed answer. Choose answer only when it is fully supported by the supplied program evidence. Never reward fluent text that adds facts the evidence does not contain.",
    criteria: DECISIONS,
  },
  support: {
    type: "score",
    instructions:
      "Rate how well the supplied evidence supports every factual claim in the proposed answer. Invented details, wrong program, or contradictions are the highest risk.",
  },
};

function clean(value: unknown, max: number): string {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function tail(value: unknown, max: number): string {
  const text = String(value || "").trim();
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

function stateFor(input: CheckInput) {
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).slice(0, MAX_EVIDENCE).map((item) => ({
    source: clean(item.sourceName, 80),
    heading: clean(item.heading, 80),
    text: clean(item.text, MAX_EVIDENCE_CHARS),
  }));
  return {
    task: "answer_verification",
    program: { id: clean(input.programId, 80) || null, name: clean(input.programName, 80) || null },
    question: clean(input.question, MAX_QUESTION_CHARS),
    conversationContext: tail(input.context, MAX_CONTEXT_CHARS),
    proposedAnswer: clean(input.answer, MAX_ANSWER_CHARS),
    evidence,
  };
}

function isDecision(value: unknown): value is Decision {
  return typeof value === "string" && Object.hasOwn(DECISIONS, value);
}

async function checkAnswer(input: CheckInput, deps: CheckDeps = {}): Promise<JevAnswerCheck> {
  const startedAt = Date.now();
  const failed = (errorKind: string): JevAnswerCheck => ({
    status: "error",
    decision: null,
    risk: null,
    reason: `jev_${errorKind}`,
    errorKind,
    latencyMs: Date.now() - startedAt,
  });
  try {
    const evaluate: (input: unknown, deps: unknown) => Promise<Outcome> =
      deps.evaluateDecision || (jev.evaluateCustomDecision as (input: unknown, deps: unknown) => Promise<Outcome>);
    const outcome = await evaluate({ state: stateFor(input), questions: QUESTIONS }, deps.jev || deps);
    if (!outcome) return failed("unknown");
    if (outcome.status === "disabled")
      return { status: "disabled", decision: null, risk: null, reason: null, errorKind: null, latencyMs: 0 };
    if (outcome.status !== "ok") return failed(outcome.errorKind || "unknown");
    const answers = outcome.result?.answers;
    const choice = answers?.decision?.choice;
    const score = answers?.support?.score;
    if (!isDecision(choice) || typeof score !== "number" || !Number.isFinite(score)) return failed("bad_response");
    const risk = Math.min(5, Math.max(1, Math.round(score) + 1));
    return {
      status: "ok",
      decision: choice,
      risk,
      reason: choice === "answer" && risk <= MAX_RISK_OK ? "jev_supported" : `jev_${choice}_risk${risk}`,
      errorKind: null,
      latencyMs: outcome.latencyMs ?? Date.now() - startedAt,
    };
  } catch (_) {
    return failed("unknown");
  }
}

function sendable(check: JevAnswerCheck): boolean {
  return check.status === "ok" && check.decision === "answer" && check.risk !== null && check.risk <= MAX_RISK_OK;
}

export = { checkAnswer, sendable, stateFor, QUESTIONS, DECISIONS, MAX_RISK_OK };
