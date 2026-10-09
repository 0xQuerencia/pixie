const db = require("../db");

interface TraceInput {
  programId: string;
  ticketId?: number | null;
  threadTs?: string | null;
  requestId?: string | null;
  stage: string;
  payload?: Record<string, unknown>;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_JSON_CHARS = 12000;
const SECRET_KEY = /token|secret|authorization|cookie|api[_-]?key|password|prompt/i;
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

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 1200) : value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : sanitize(child, depth + 1);
  }
  return out;
}

function append(input: TraceInput): number {
  ensureSchema();
  const now = Date.now();
  const payload = JSON.stringify(sanitize(input.payload || {})).slice(0, MAX_JSON_CHARS);
  const result = db
    .handle()
    .query(
      `INSERT INTO answer_traces
       (program_id,ticket_id,thread_ts,request_id,stage,payload_json,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.programId,
      input.ticketId || null,
      input.threadTs || null,
      input.requestId || null,
      String(input.stage || "unknown").slice(0, 80),
      payload,
      now,
      now + Math.max(60_000, Number(input.ttlMs) || DEFAULT_TTL_MS),
    );
  return Number(result.lastInsertRowid);
}

function forTicket(programId: string, ticketId: number) {
  ensureSchema();
  db.handle().query("DELETE FROM answer_traces WHERE expires_at <= ?").run(Date.now());
  return db
    .handle()
    .query(
      `SELECT id,stage,payload_json,created_at,request_id
       FROM answer_traces WHERE program_id = ? AND ticket_id = ?
       ORDER BY created_at ASC, id ASC LIMIT 300`,
    )
    .all(programId, ticketId)
    .map((row: { id: number; stage: string; payload_json: string; created_at: number; request_id: string | null }) => ({
      id: row.id,
      stage: row.stage,
      payload: (() => {
        try {
          return JSON.parse(row.payload_json);
        } catch {
          return {};
        }
      })(),
      createdAt: row.created_at,
      requestId: row.request_id,
    }));
}

export = { append, forTicket, ensureSchema, sanitize, DEFAULT_TTL_MS };
