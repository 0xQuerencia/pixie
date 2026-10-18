const db = require("../db");
const retention = require("../retention");
const { redactSecrets, redactInternalContent } = require("../redact");

interface TraceInput {
  programId: string;
  ticketId?: number | null;
  threadTs?: string | null;
  requestId?: string | null;
  stage: string;
  payload?: Record<string, unknown>;
  ttlMs?: number;
}

interface TraceRow {
  id: number;
  ticket_id: number | null;
  stage: string;
  payload_json: string;
  created_at: number;
  request_id: string | null;
}

const DAY_MS = 86400000;
const MIN_TTL_MS = 60_000;
const DEFAULT_TTL_MS = retention.DEFAULTS.tracesDays * DAY_MS;
const MAX_JSON_CHARS = 12000;
const MAX_TEXT_CHARS = 1200;
const MAX_LIST_ITEMS = 30;
const KNOWN_STAGES = new Set([
  "engagement",
  "context",
  "generation",
  "intent",
  "retrieval",
  "selected_evidence",
  "grounding",
  "decision",
  "handoff",
  "final_action",
  "final",
]);
let ready = false;

function ensureSchema(): void {
  if (ready) return;
  db.handle().exec(`
    CREATE TABLE IF NOT EXISTS answer_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id TEXT NOT NULL,
      ticket_id INTEGER,
      thread_ts TEXT,
      request_id TEXT,
      stage TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_answer_traces_ticket
      ON answer_traces(program_id, ticket_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_answer_traces_thread
      ON answer_traces(program_id, thread_ts, created_at ASC);
  `);
  ready = true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scrubString(value: string): string {
  return redactInternalContent(redactSecrets(value));
}

function stringValue(value: unknown, maxLength = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  return scrubString(value).slice(0, maxLength);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringList(value: unknown, maxItems = MAX_LIST_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .slice(0, maxItems)
    .map((item) => scrubString(item).slice(0, MAX_TEXT_CHARS));
}

function putString(
  out: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  maxLength?: number,
): void {
  const value = stringValue(input[key], maxLength);
  if (value !== undefined) out[key] = value;
}

function putNumber(out: Record<string, unknown>, input: Record<string, unknown>, key: string): void {
  const value = numberValue(input[key]);
  if (value !== undefined) out[key] = value;
}

function putBoolean(out: Record<string, unknown>, input: Record<string, unknown>, key: string): void {
  const value = booleanValue(input[key]);
  if (value !== undefined) out[key] = value;
}

function canonicalDecision(value: unknown): string | undefined {
  const action = String(value || "").toLowerCase();
  if (["answer", "reply"].includes(action)) return "answer";
  if (["escalate", "handoff"].includes(action)) return "escalate";
  if (["clarify", "ask_clarifying"].includes(action)) return "clarify";
  if (["silent", "silence", "ignored", "ignore", "abstain"].includes(action)) return "ignored";
  return undefined;
}

function putStrings(
  out: Record<string, unknown>,
  input: Record<string, unknown>,
  key: string,
  maxItems?: number,
): void {
  if (!Array.isArray(input[key])) return;
  out[key] = stringList(input[key], maxItems);
}

function normalizedJev(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["action", "reason", "decision", "status"]) putString(out, value, key, 120);
  for (const key of ["probability", "latencyMs", "risk"]) putNumber(out, value, key);
  putBoolean(out, value, "cached");
  return Object.keys(out).length ? out : null;
}

function normalizedScores(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["lexical", "semantic", "total", "score"]) putNumber(out, value, key);
  return Object.keys(out).length > 0 ? out : null;
}

function normalizedRetrievalItem(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["id", "evidenceId", "source", "heading"]) putString(out, value, key, 240);
  for (const key of ["lexical", "semantic", "total", "score", "rank"]) putNumber(out, value, key);
  const scores = normalizedScores(value.scores);
  if (scores) out.scores = scores;
  return out;
}

function normalizedRetrievalList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map(normalizedRetrievalItem)
    .filter((item) => Object.keys(item).length > 0);
}

function normalizedEvidenceList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((item) => {
      const out = normalizedRetrievalItem(item);
      if (isRecord(item)) putString(out, item, "label", 240);
      return out;
    })
    .filter((item) => Object.keys(item).length > 0);
}

function normalizedClaims(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((item) => {
    if (!isRecord(item)) return [];
    const out: Record<string, unknown> = {};
    putString(out, item, "claim", 600);
    putBoolean(out, item, "supported");
    const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds : item.evidence_ids;
    if (Array.isArray(evidenceIds)) out.evidenceIds = stringList(evidenceIds, 12);
    putString(out, item, "reason", 200);
    return Object.keys(out).length > 0 ? [out] : [];
  });
}

function normalizePayload(stage: string, value: unknown): Record<string, unknown> {
  const input = isRecord(value) ? value : {};
  const out: Record<string, unknown> = {};

  if (stage === "grounding") {
    out.verdict = stringValue(input.verdict, 80) || "unknown";
    putBoolean(out, input, "sendable");
    putStrings(out, input, "errors", 20);
    const jev = normalizedJev(input.jev);
    if (jev) out.jev = jev;
    const claims = normalizedClaims(input.claims);
    const legacy = Array.isArray(input.unsupported) ? normalizedClaims(input.unsupported) : [];
    out.claims = claims.length ? claims : legacy;
    return out;
  }

  if (stage === "engagement") {
    for (const key of ["role", "intent", "classifier", "classifierError"]) putString(out, input, key, 240);
    for (const key of ["addressed", "engaged"]) putBoolean(out, input, key);
    putString(out, input, "program", 120);
    const jev = normalizedJev(input.jev);
    if (jev) out.jev = jev;
    return out;
  }

  if (stage === "context") {
    for (const key of ["scope", "question"]) putString(out, input, key, 300);
    for (const key of ["threadChars", "classifierContextChars", "recentChannelMessages", "recentChannelLimit"])
      putNumber(out, input, key);
    return out;
  }

  if (stage === "generation") {
    for (const key of ["model", "router", "source"]) putString(out, input, key, 200);
    for (const key of ["latencyMs", "answerChars"]) putNumber(out, input, key);
    putBoolean(out, input, "unclear");
    return out;
  }

  if (stage === "intent") {
    for (const key of ["intent", "source", "reason", "classifierError"]) putString(out, input, key, 240);
    putNumber(out, input, "confidence");
    putBoolean(out, input, "engaged");
    return out;
  }

  if (stage === "retrieval") {
    putString(out, input, "question");
    for (const key of ["sources", "results"]) {
      if (Array.isArray(input[key])) out[key] = normalizedRetrievalList(input[key]);
    }
    return out;
  }

  if (stage === "selected_evidence") {
    const evidenceIds = input.evidenceIds ?? input.selectedEvidenceIds ?? input.ids;
    if (Array.isArray(evidenceIds)) out.evidenceIds = stringList(evidenceIds, 30);
    if (Array.isArray(input.evidence)) out.evidence = normalizedEvidenceList(input.evidence);
    return out;
  }

  if (stage === "decision") {
    for (const key of ["expectedAction", "action", "reason"]) putString(out, input, key, 240);
    putBoolean(out, input, "grounded");
    out.decision = canonicalDecision(input.action || input.expectedAction) || "unknown";
    return out;
  }

  if (stage === "handoff") {
    for (const key of ["reason", "question", "target"]) putString(out, input, key, 400);
    putStrings(out, input, "sources", 30);
    return out;
  }

  if (stage === "final" || stage === "final_action") {
    for (const key of ["action", "finalAction", "reason"]) putString(out, input, key, 240);
    putBoolean(out, input, "sent");
    putNumber(out, input, "latencyMs");
    out.decision = canonicalDecision(input.action || input.finalAction) || "unknown";
    return out;
  }

  return out;
}

function compact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 40 ? value.slice(0, Math.max(20, Math.floor(value.length * 0.65))) : value;
  }
  if (Array.isArray(value)) {
    const items = value.length > 1 ? value.slice(0, Math.max(1, Math.ceil(value.length * 0.65))) : value;
    return items.map((item) => compact(item));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
}

function boundedPayload(stage: string, payload: Record<string, unknown>): string {
  let candidate: unknown = payload;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const serialized = JSON.stringify(candidate);
    if (serialized.length <= MAX_JSON_CHARS) return serialized;
    const next = compact(candidate);
    if (JSON.stringify(next) === serialized) break;
    candidate = next;
  }
  const fallback = stage === "grounding" ? { verdict: "unknown", claims: [] } : {};
  const serialized = JSON.stringify(candidate);
  return serialized.length <= MAX_JSON_CHARS ? serialized : JSON.stringify(fallback);
}

function canonicalStage(value: unknown): string {
  const stage = typeof value === "string" ? value.slice(0, 80) : "unknown";
  return KNOWN_STAGES.has(stage) ? stage : "unknown";
}

function sanitize(value: unknown, stage = "unknown"): unknown {
  return normalizePayload(canonicalStage(stage), value);
}

function parsePayload(row: TraceRow): Record<string, unknown> {
  try {
    const payload = JSON.parse(row.payload_json);
    if (!isRecord(payload)) throw new Error("stored trace payload is not an object");
    return normalizePayload(canonicalStage(row.stage), payload);
  } catch (error) {
    throw new Error(`stored trace payload is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readRows(rows: TraceRow[]) {
  return rows.map((row) => ({
    id: row.id,
    ticketId: row.ticket_id,
    stage: row.stage,
    payload: parsePayload(row),
    createdAt: row.created_at,
    requestId: row.request_id,
  }));
}

function append(input: TraceInput): number {
  ensureSchema();
  const now = Date.now();
  const stage = canonicalStage(input.stage);
  const payload = boundedPayload(stage, normalizePayload(stage, input.payload));
  const requestedTtl = Number(input.ttlMs);
  const policyTtl = Number(retention.policyFor(input.programId).tracesDays) * DAY_MS;
  const ttl = Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : policyTtl;
  const result = db
    .handle()
    .query(
      `INSERT INTO answer_traces
       (program_id,ticket_id,thread_ts,request_id,stage,payload_json,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.programId,
      input.ticketId ?? null,
      input.threadTs ?? null,
      input.requestId ?? null,
      stage,
      payload,
      now,
      now + Math.max(MIN_TTL_MS, ttl),
    );
  return Number(result.lastInsertRowid);
}

function forTicket(programId: string, ticketId: number) {
  ensureSchema();
  return readRows(
    db
      .handle()
      .query(
        `SELECT id,ticket_id,stage,payload_json,created_at,request_id
         FROM answer_traces WHERE program_id = ? AND ticket_id = ? AND expires_at > ?
         ORDER BY created_at ASC, id ASC LIMIT 300`,
      )
      .all(programId, ticketId, Date.now()) as TraceRow[],
  );
}

function forThread(programId: string, threadTs: string) {
  ensureSchema();
  return readRows(
    db
      .handle()
      .query(
        `SELECT id,ticket_id,stage,payload_json,created_at,request_id
         FROM answer_traces WHERE program_id = ? AND thread_ts = ? AND expires_at > ?
         ORDER BY created_at ASC, id ASC LIMIT 300`,
      )
      .all(programId, threadTs, Date.now()) as TraceRow[],
  );
}

function list(programId: string, options: { limit?: number; decision?: string; q?: string } = {}) {
  ensureSchema();
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const rows = readRows(
    db
      .handle()
      .query(
        `SELECT id,ticket_id,stage,payload_json,created_at,request_id
       FROM answer_traces WHERE program_id = ? AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(programId, Date.now(), limit) as TraceRow[],
  );
  return rows.filter((row: Record<string, unknown>) => {
    const payload = (row.payload || {}) as Record<string, unknown>;
    const decision = typeof payload.decision === "string" ? payload.decision : "";
    return (
      (!options.decision || decision === options.decision) &&
      (!options.q || JSON.stringify(payload).toLowerCase().includes(options.q.toLowerCase()))
    );
  });
}

function get(programId: string, id: number) {
  ensureSchema();
  const row = db
    .handle()
    .query(
      `SELECT id,ticket_id,stage,payload_json,created_at,request_id
     FROM answer_traces WHERE program_id = ? AND id = ? AND expires_at > ?`,
    )
    .get(programId, id, Date.now()) as TraceRow | null;
  return row ? readRows([row])[0] || null : null;
}

function sweepExpired(programId?: string, now = Date.now()): number {
  ensureSchema();
  if (programId !== undefined) {
    return db.handle().query("DELETE FROM answer_traces WHERE program_id = ? AND expires_at <= ?").run(programId, now)
      .changes;
  }
  return db.handle().query("DELETE FROM answer_traces WHERE expires_at <= ?").run(now).changes;
}

export = { append, forTicket, forThread, list, get, sweepExpired, ensureSchema, sanitize, DEFAULT_TTL_MS };
