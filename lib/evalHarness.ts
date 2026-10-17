import db = require("./db");
import docs = require("./programDocs");
import inspectModule = require("./inspect");

interface SupportEvalCase {
  name: string;
  input: unknown;
  expected: Record<string, unknown>;
}

interface SupportEvalResult {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

const EVAL_KINDS = [
  "normal",
  "ambiguous",
  "missing",
  "cross_program",
  "contradictory",
  "outdated",
  "injection",
  "escalation",
  "regression",
] as const;

interface EvalExpect {
  mode?: "answer" | "escalate" | "abstain";
  mustInclude?: string[];
  mustNotInclude?: string[];
  sources?: string[];
}

interface EvalCase {
  id: number;
  program_id: string;
  kind: string;
  question: string;
  expect: string;
  origin: "manual" | "archive";
  active: number;
  created_at: number;
}

function parseExpect(value: unknown): EvalExpect {
  if (typeof value === "string") {
    try {
      return parseExpect(JSON.parse(value));
    } catch (_) {
      throw new Error("expect must be valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expect must be an object");
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (mode !== undefined && !["answer", "escalate", "abstain"].includes(String(mode)))
    throw new Error("invalid expect.mode");
  const strings = (name: string) => {
    const candidate = input[name];
    if (candidate === undefined) return undefined;
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string" || item.length > 1000)) {
      throw new Error(`${name} must be an array of strings`);
    }
    return candidate as string[];
  };
  return {
    mode: mode as EvalExpect["mode"],
    mustInclude: strings("mustInclude"),
    mustNotInclude: strings("mustNotInclude"),
    sources: strings("sources"),
  };
}

function caseRow(id: number | string): EvalCase | null {
  return (
    db.handle().query<EvalCase, [number | string]>("SELECT * FROM program_eval_cases WHERE id = ?").get(id) || null
  );
}

function listCases(programId: string, activeOnly = true): EvalCase[] {
  return db
    .handle()
    .query<EvalCase, [string]>(
      `SELECT * FROM program_eval_cases WHERE program_id = ?${activeOnly ? " AND active = 1" : ""} ORDER BY id`,
    )
    .all(programId);
}

function createCase(
  programId: string,
  input: { kind?: string; question?: string; expect?: unknown; origin?: string; active?: boolean },
): EvalCase {
  if (!input.kind || !EVAL_KINDS.includes(input.kind as (typeof EVAL_KINDS)[number]))
    throw new Error("invalid eval case kind");
  const question = String(input.question || "").trim();
  if (!question || question.length > 2000) throw new Error("question required (max 2000 chars)");
  const expected = parseExpect(input.expect || {});
  const origin = input.origin || "manual";
  if (origin !== "manual" && origin !== "archive") throw new Error("invalid eval case origin");
  const result = db
    .handle()
    .query(
      "INSERT INTO program_eval_cases (program_id, kind, question, expect, origin, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(programId, input.kind, question, JSON.stringify(expected), origin, input.active === false ? 0 : 1, Date.now());
  return caseRow(Number(result.lastInsertRowid)) as EvalCase;
}

function deleteCase(programId: string, id: number): boolean {
  return (
    db.handle().query("DELETE FROM program_eval_cases WHERE program_id = ? AND id = ?").run(programId, id).changes > 0
  );
}

type InspectResult = Awaited<ReturnType<typeof inspectModule.inspect>>;

function includes(text: string, expected: string): boolean {
  return text.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function grade(item: EvalCase, result: InspectResult) {
  const expected = parseExpect(item.expect);
  const answer = String(result.answer || "");
  const searchable = JSON.stringify({ answer: result.answer, retrieved: result.retrieved });
  const failures: string[] = [];
  if (expected.mode && result.decision !== expected.mode)
    failures.push(`mode expected ${expected.mode}, got ${result.decision}`);
  for (const value of expected.mustInclude || []) if (!includes(answer, value)) failures.push(`missing: ${value}`);
  for (const value of expected.mustNotInclude || [])
    if (includes(searchable, value)) failures.push(`forbidden: ${value}`);
  if (expected.sources?.length) {
    const retrieved = JSON.stringify(result.retrieved).toLocaleLowerCase();
    for (const source of expected.sources)
      if (!retrieved.includes(source.toLocaleLowerCase())) failures.push(`source: ${source}`);
  }
  if (item.kind === "cross_program" && !expected.mustNotInclude?.length)
    failures.push("cross_program requires mustNotInclude canaries");
  return {
    caseId: item.id,
    kind: item.kind,
    passed: failures.length === 0,
    failures,
    decision: result.decision,
    answer: result.answer,
    retrieved: result.retrieved,
  };
}

async function run(programId: string, triggeredBy: string | null = null) {
  const startedAt = Date.now();
  const contentHash = docs.contentHash(programId);
  const inserted = db
    .handle()
    .query(
      "INSERT INTO program_eval_runs (program_id, content_hash, started_at, finished_at, total, passed, failed, status, results, triggered_by) VALUES (?, ?, ?, NULL, 0, 0, 0, 'running', ?, ?)",
    )
    .run(programId, contentHash, startedAt, "[]", triggeredBy);
  const runId = Number(inserted.lastInsertRowid);
  const results = [];
  for (const item of listCases(programId)) {
    try {
      results.push(grade(item, await inspectModule.inspect(programId, item.question)));
    } catch (error) {
      results.push({
        caseId: item.id,
        kind: item.kind,
        passed: false,
        failures: [error instanceof Error ? error.message : String(error)],
        decision: "abstain",
        answer: null,
        retrieved: [],
      });
    }
  }
  const passed = results.filter((item) => item.passed).length;
  const failed = results.length - passed;
  const status = failed === 0 ? "passed" : "failed";
  db.handle()
    .query(
      "UPDATE program_eval_runs SET finished_at = ?, total = ?, passed = ?, failed = ?, status = ?, results = ? WHERE id = ? AND program_id = ?",
    )
    .run(Date.now(), results.length, passed, failed, status, JSON.stringify(results), runId, programId);
  return {
    id: runId,
    programId,
    contentHash,
    startedAt,
    finishedAt: Date.now(),
    total: results.length,
    passed,
    failed,
    status,
    results,
    triggeredBy,
  };
}

function runs(programId: string, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .handle()
    .query("SELECT * FROM program_eval_runs WHERE program_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
    .all(programId, safeLimit);
}

function latestRun(programId: string) {
  return (
    db
      .handle()
      .query("SELECT * FROM program_eval_runs WHERE program_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
      .get(programId) || null
  );
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matches((actual as Record<string, unknown>)[key], value),
    );
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((value) => actual.some((item) => matches(item, value)));
  }
  return actual === expected;
}

function runSupportEvals(
  cases: SupportEvalCase[],
  runner: (input: unknown, item: SupportEvalCase) => Record<string, unknown>,
): SupportEvalResult[] {
  return cases.map((item) => {
    const details = runner(item.input, item);
    const passed = matches(details, item.expected);
    return { name: item.name, passed, details };
  });
}

export = { EVAL_KINDS, runSupportEvals, matches, listCases, createCase, deleteCase, run, runs, latestRun, parseExpect };
