import path = require("node:path");
import sqlite = require("bun:sqlite");
import type { Database as DatabaseType, SQLQueryBindings } from "bun:sqlite";
import schema = require("./schema");
import log = require("./log");
import type {
  AuditEventRow,
  ChannelClaimRow,
  LearnedFactRow,
  ProgramRow,
  TicketEventRow,
  TicketRow,
  ThreadRow,
} from "./db.types";
import type { Program } from "./types";

const { Database } = sqlite;
const { SCHEMA, MIGRATIONS, POST_MIGRATION_SCHEMA } = schema;

type DbValue = string | number | boolean | null | Uint8Array;
interface SqlRow {
  [key: string]: unknown;
}
interface TopicRow {
  topic: string;
  program_id: string | null;
  was_helpful: number;
}
interface GapSummaryRow {
  id: number;
  question: string;
  program_id: string | null;
  ask_count: number;
  askers: number;
  last_asked: number;
}

interface UsageRow extends SqlRow {
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  cost_usd?: number | null;
  latency_ms?: number | null;
  errors?: number;
  rate_limited?: number;
  grounded_answers?: number;
  fallbacks?: number;
  suppressed?: number;
  bucket?: string;
  value?: string | null;
  provider?: string | null;
  created_at: number;
  operation?: string | null;
  model?: string | null;
  channel?: string | null;
  request_id?: string | null;
  event_id?: string | null;
  status?: string | null;
  result?: string | null;
  http_status?: number | null;
  attempt?: number | null;
  retry_count?: number | null;
}

interface ProgramDbRow extends SqlRow {
  id: string;
  name: string;
  posture: string;
  scope: string | null;
  workspace_id: string | null;
  deployment_mode: string | null;
  support_name: string | null;
  icon_url: string | null;
  reply_signature: string | null;
  ai_answers: number | null;
  tickets_enabled: number | null;
  auto_escalate: number | null;
  sensitive_categories: string | null;
  support_active: number | null;
  auto_assign: number | null;
  helper_ping_enabled: number | null;
  shadow_mode: number | null;
  incident_mode: string | null;
  public_tickets_enabled: number | null;
  sla_unassigned_ms: number | null;
  sla_assigned_ms: number | null;
  sla_waiting_ms: number | null;
  sla_target_ms: number | null;
  sla_notify_channel: string | null;
  retention_context_days: number | null;
  retention_tickets_days: number | null;
  retention_notes_days: number | null;
  retention_traces_days: number | null;
  retention_analytics_days: number | null;
  retention_audit_days: number | null;
  help_channel: string | null;
  organizer_channel: string | null;
  channels: string | null;
  helper_group: string | null;
  sources: string | null;
  milestones: string | null;
  guides: string | null;
  links: string | null;
  pinned_rules: string | null;
  categories: string | null;
  ticket_visibility: string | null;
  behavior: string | null;
  status: string | null;
  learning: string | null;
  updated_at: number;
}

interface MetricCountRow {
  kind: string;
  count: number;
}
interface LatencyRow {
  latency_ms: number;
}

interface ThreadMessage {
  role: string;
  content: string;
  user_id: string | null;
  created_at: number;
}

interface UserMessage {
  text: string;
  channel: string | null;
  threadTs: string | null;
  created_at: number;
}

type PersistedProgram = Partial<Program> & {
  id: string;
  name: string;
  sla?: {
    unassignedMs?: number | null;
    assignedMs?: number | null;
    waitingMs?: number | null;
    targetMs?: number | null;
    notifyChannel?: string | null;
  };
  retention?: {
    contextDays?: number | null;
    ticketsDays?: number | null;
    notesDays?: number | null;
    tracesDays?: number | null;
    analyticsDays?: number | null;
    auditDays?: number | null;
  };
};

interface CreateTicketOptions {
  programId: string;
  workspaceId?: string | null;
  channel: string;
  threadTs: string;
  requesterId: string;
  question: string;
  category?: string | null;
  priority?: string | null;
  summary?: string | null;
  createdAt?: number | null;
  visibility?: string | null;
}

interface HistoryImportRow {
  cursor: string | null;
  newest_ts_done: string | null;
  status: string;
  messages_scanned: number;
  tickets_created: number;
  tickets_enriched: number;
  resolved: number;
  closed: number;
  queued_for_judge: number;
  last_error: string | null;
  started_at: number | null;
  completed_at: number | null;
  rules_version: number;
  [key: string]: unknown;
}

interface HistoryImportPatch {
  updatedAt?: number;
  cursor?: string | null;
  newestTsDone?: string | null;
  status?: string;
  messagesScanned?: number;
  ticketsCreated?: number;
  ticketsEnriched?: number;
  resolved?: number;
  closed?: number;
  queuedForJudge?: number;
  lastError?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  rulesVersion?: number;
}

const DEFAULT_PATH = path.join(__dirname, "..", "pixie.db");

const ANSWERED_TTL_MS = 24 * 60 * 60 * 1000;
const THREAD_TTL_MS = 60 * 60 * 1000;
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
const CACHE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_THREAD_MESSAGES = 20;
const MAX_USER_TOPICS = 10;

const MAX_USER_MESSAGES = 12;
const USER_MESSAGE_WINDOW_MS = 2 * 60 * 60 * 1000;
const USER_MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;

const USER_TOPICS_MIGRATION = "user_topics_scope_v1";
const LEGACY_AUTO_LEARNED_MIGRATION = "legacy_auto_learned_v1";
const REPORT_DRAFT_SOURCE_PREFIX = "gap-draft:";

let db: DatabaseType | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
const ephemeralThreadMessages = new Map<string, ThreadMessage[]>();
const ephemeralUserMessages = new Map<string, UserMessage[]>();

interface Statement<Row> {
  get(...bindings: unknown[]): Row;
  all(...bindings: unknown[]): Row[];
  run(...bindings: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

function query<Row = SqlRow>(sql: string): Statement<Row> {
  return handle().query<Row, SQLQueryBindings[]>(sql) as Statement<Row>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrate(database: DatabaseType) {
  for (const [table, column, sql] of MIGRATIONS) {
    if (sql.startsWith("CREATE TABLE")) {
      const exists = database.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", table);
      if (exists) continue;
    } else {
      const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (columns.some((c: { name: string }) => c.name === column)) continue;
    }
    database.exec(sql);
    log.info("db", `migrated: ${table}.${column}`);
  }
}

function backfillResolvedCredits(database: DatabaseType) {
  const version = "resolved_credit_v1";
  if (database.query("SELECT 1 FROM ticket_metrics_migrations WHERE version = ?").get(version)) return;
  database.exec(`
    UPDATE tickets AS t SET resolved_credit_id = COALESCE(
      (SELECT e.actor_id FROM ticket_events e
       WHERE e.ticket_id = t.id AND e.program_id = t.program_id
         AND e.event_type = 'helper_reply' AND e.actor_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM program_helpers ph
                     WHERE ph.program_id = t.program_id AND ph.user_id = e.actor_id)
       ORDER BY e.created_at DESC, e.id DESC LIMIT 1),
      t.assignee_id,
      t.resolved_by
    ) WHERE t.status = 'resolved' AND t.resolved_credit_id IS NULL;
  `);
  database.query("INSERT INTO ticket_metrics_migrations (version, applied_at) VALUES (?, ?)").run(version, now());
}

function invalidateKnowledgeMaps() {
  try {
    require("./knowledge").invalidate();
  } catch (error: unknown) {
    log.debug("db", `knowledge invalidation skipped: ${errorMessage(error)}`);
  }
}

function invalidateTrustCaches() {
  try {
    require("./cache").clearCache();
  } catch (error: unknown) {
    log.debug("db", `answer cache invalidation skipped: ${errorMessage(error)}`);
  }
  invalidateKnowledgeMaps();
}

function ensureProgramScopedUserTopics(database: DatabaseType) {
  if (database.query("SELECT 1 FROM schema_data_migrations WHERE version = ?").get(USER_TOPICS_MIGRATION)) return;

  const columns = database.query<{ name: string; pk: number }, []>("PRAGMA table_info(user_topics)").all();
  const programColumn = columns.find((column) => column.name === "program_id");
  database.transaction(() => {
    if (programColumn && programColumn.pk === 0) {
      database.exec(`
        CREATE TABLE user_topics_scoped (
          user_id     TEXT NOT NULL,
          topic       TEXT NOT NULL,
          program_id  TEXT,
          was_helpful INTEGER NOT NULL DEFAULT 1,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (user_id, topic, program_id)
        );
        INSERT INTO user_topics_scoped (user_id, topic, program_id, was_helpful, created_at)
          SELECT user_id, topic, program_id, was_helpful, created_at FROM user_topics;
        DROP TABLE user_topics;
        ALTER TABLE user_topics_scoped RENAME TO user_topics;
      `);
    }
    database
      .query("INSERT INTO schema_data_migrations (version, applied_at) VALUES (?, ?)")
      .run(USER_TOPICS_MIGRATION, now());
  })();
}

function quarantineLegacyAutoLearned(database: DatabaseType) {
  if (database.query("SELECT 1 FROM schema_data_migrations WHERE version = ?").get(LEGACY_AUTO_LEARNED_MIGRATION))
    return;

  let changedRows = 0;
  database.transaction(() => {
    changedRows = database
      .query(
        `UPDATE learned_facts
            SET status = 'candidate', verified_at = NULL
          WHERE status = 'approved' AND auto_learned = 1 AND superseded_by IS NULL`,
      )
      .run().changes;
    if (changedRows > 0) database.query("DELETE FROM answer_cache").run();
    database
      .query("INSERT INTO schema_data_migrations (version, applied_at) VALUES (?, ?)")
      .run(LEGACY_AUTO_LEARNED_MIGRATION, now());
  })();

  if (changedRows > 0) invalidateKnowledgeMaps();
}

function open(filename = process.env.PIXIE_DB_PATH || DEFAULT_PATH) {
  if (db) return db;
  db = new Database(filename, { create: true });
  // SQLite WAL
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  ensureProgramScopedUserTopics(db);
  backfillResolvedCredits(db);
  quarantineLegacyAutoLearned(db);
  db.exec(POST_MIGRATION_SCHEMA);
  log.info("db", `opened ${filename}`);
  return db;
}

function ensureSchema(filename: string | null = null) {
  const file = filename || process.env.PIXIE_DB_PATH || DEFAULT_PATH;
  const database = new Database(file, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  migrate(database);
  ensureProgramScopedUserTopics(database);
  backfillResolvedCredits(database);
  quarantineLegacyAutoLearned(database);
  database.exec(POST_MIGRATION_SCHEMA);
  database.close();
}

function handle(): DatabaseType {
  if (!db) open();
  return db as DatabaseType;
}

function now() {
  return Date.now();
}

function claimMessage(ts: DbValue, channel = null) {
  // Atomic claim
  const changes = query("INSERT OR IGNORE INTO answered_messages (ts, channel, answered_at) VALUES (?, ?, ?)").run(
    ts,
    channel,
    now(),
  );
  return changes.changes > 0;
}

function wasAnswered(ts: DbValue) {
  return !!query("SELECT 1 FROM answered_messages WHERE ts = ?").get(ts);
}

function touchThread(threadTs: string, channel: string | null = null, fields: Record<string, unknown> = {}) {
  query(
    `INSERT INTO threads (thread_ts, channel, seeded, pixie_spoke, helper_pinged, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_ts) DO UPDATE SET
         channel       = COALESCE(excluded.channel, threads.channel),
         seeded        = MAX(threads.seeded, excluded.seeded),
         pixie_spoke   = MAX(threads.pixie_spoke, excluded.pixie_spoke),
         helper_pinged = MAX(threads.helper_pinged, excluded.helper_pinged),
         updated_at    = excluded.updated_at`,
  ).run(threadTs, channel, fields.seeded ? 1 : 0, fields.pixieSpoke ? 1 : 0, fields.helperPinged ? 1 : 0, now());
}

function getThread(threadTs: string) {
  return query("SELECT * FROM threads WHERE thread_ts = ?").get(threadTs) || null;
}

function addThreadMessage(threadTs: string, role: string, content: string, userId = null) {
  const list = ephemeralThreadMessages.get(threadTs) || [];
  list.push({ role, content, user_id: userId, created_at: now() });
  if (list.length > MAX_THREAD_MESSAGES) list.splice(0, list.length - MAX_THREAD_MESSAGES);
  ephemeralThreadMessages.set(threadTs, list);
}

function getThreadMessages(threadTs: string) {
  const cutoff = now() - THREAD_TTL_MS;
  return (ephemeralThreadMessages.get(threadTs) || [])
    .filter((row: ThreadMessage) => row.created_at > cutoff)
    .map(({ role, content, user_id }: ThreadMessage) => ({ role, content, user_id }));
}

function recordUserMessage({
  userId,
  channel = null,
  threadTs = null,
  text,
}: {
  userId: string;
  channel?: string | null;
  threadTs?: string | null;
  text: string;
}) {
  const body = text.trim();
  if (!userId || !body) return;

  const list = ephemeralUserMessages.get(userId) || [];
  list.push({ text: body, channel, threadTs, created_at: now() });
  if (list.length > MAX_USER_MESSAGES) {
    list.splice(0, list.length - MAX_USER_MESSAGES);
  }
  ephemeralUserMessages.set(userId, list);
}

function recentUserMessages(
  userId: string,
  { channel = null, limit = 3 }: { channel?: string | null; limit?: number } = {},
) {
  if (!userId) return [];
  const cutoff = now() - USER_MESSAGE_WINDOW_MS;
  const list = (ephemeralUserMessages.get(userId) || []).filter(
    (m: UserMessage) => m.created_at > cutoff && (!channel || m.channel === channel),
  );
  return list.slice(-limit);
}

function recordUserTopic(
  userId: string,
  topic: string,
  wasHelpfulOrProgram: boolean | string | null = true,
  programOrWasHelpful: string | boolean | null = null,
) {
  if (!userId || !topic) return;

  const wasHelpful =
    typeof wasHelpfulOrProgram === "boolean"
      ? wasHelpfulOrProgram
      : typeof programOrWasHelpful === "boolean"
        ? programOrWasHelpful
        : true;
  const programId =
    typeof wasHelpfulOrProgram === "string"
      ? wasHelpfulOrProgram
      : typeof programOrWasHelpful === "string"
        ? programOrWasHelpful
        : null;
  const scope = programId === null ? "program_id IS NULL" : "program_id = ?";
  const scopeParams = programId === null ? [] : [programId];
  const updated = query(
    `UPDATE user_topics SET created_at = ?, was_helpful = ?
       WHERE user_id = ? AND topic = ? AND ${scope}`,
  ).run(now(), wasHelpful ? 1 : 0, userId, topic, ...scopeParams);
  if (updated.changes === 0) {
    query("INSERT INTO user_topics (user_id, topic, program_id, was_helpful, created_at) VALUES (?, ?, ?, ?, ?)").run(
      userId,
      topic,
      programId,
      wasHelpful ? 1 : 0,
      now(),
    );
  }

  query(
    `DELETE FROM user_topics
       WHERE user_id = ? AND ${scope} AND topic NOT IN (
         SELECT topic FROM user_topics WHERE user_id = ? AND ${scope} ORDER BY created_at DESC LIMIT ?
       )`,
  ).run(userId, ...scopeParams, userId, ...scopeParams, MAX_USER_TOPICS);
}

function recordTopic(userId: string, topic: string, wasHelpful = true) {
  recordUserTopic(userId, topic, wasHelpful);
}

function userTopics(userId: string, programId: string | null = null): TopicRow[] {
  if (!userId) return [];
  const cutoff = now() - HISTORY_TTL_MS;
  if (programId) {
    return query<TopicRow>(
      "SELECT topic, program_id, was_helpful FROM user_topics WHERE user_id = ? AND program_id = ? AND created_at > ? ORDER BY created_at DESC",
    ).all(userId, programId, cutoff);
  }
  return query<TopicRow>(
    "SELECT topic, program_id, was_helpful FROM user_topics WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC",
  ).all(userId, cutoff);
}

function getTopics(userId: string): TopicRow[] {
  return userTopics(userId);
}

function recordGap(question: string, userId = null, channel = null, messageTs = null, programId = null) {
  query(
    "INSERT INTO doc_gaps (question, user_id, channel, message_ts, program_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(normalizeQuestion(question), userId, channel, messageTs, programId, now());
}

function normalizeQuestion(question: string) {
  return String(question || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function recordGapRejection(question: string) {
  const normalized = normalizeQuestion(question);
  if (!normalized) return;
  query("INSERT OR REPLACE INTO gap_rejections (question, created_at) VALUES (?, ?)").run(normalized, now());
}

function clearGapRejection(question: string) {
  const normalized = normalizeQuestion(question);
  if (!normalized) return;
  query("DELETE FROM gap_rejections WHERE question = ?").run(normalized);
}

function gapForThread(messageTs: string, sinceMs = 7 * 24 * 60 * 60 * 1000) {
  if (!messageTs) return null;
  return (
    query(
      "SELECT question, user_id FROM doc_gaps WHERE message_ts = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    ).get(messageTs, now() - sinceMs) || null
  );
}

function topGaps(
  limit = 20,
  sinceMs = 30 * 24 * 60 * 60 * 1000,
  {
    // Distinct askers
    kind = null,
    untilMs = null,
    programId = null,
    minAskers = 2,
    excludeRejected = true,
  } = {},
) {
  const clauses = ["created_at > ?"];
  const params = [now() - sinceMs];

  if (untilMs !== null) {
    clauses.push("created_at <= ?");
    params.push(untilMs);
  }
  if (kind !== null) {
    clauses.push("kind = ?");
    params.push(kind);
  }
  if (programId !== null) {
    clauses.push("program_id = ?");
    params.push(programId);
  }
  const normalizedQuestion = "LOWER(TRIM(question))";

  if (excludeRejected) {
    clauses.push(`${normalizedQuestion} NOT IN (SELECT question FROM gap_rejections WHERE created_at > ?)`);
    params.push(now() - sinceMs);
  }
  const sql = `SELECT MIN(id) AS id,
                      ${normalizedQuestion} AS question,
                      program_id,
                      COUNT(*) AS ask_count,
                      COUNT(DISTINCT user_id) AS askers,
                      MAX(created_at) AS last_asked
               FROM doc_gaps WHERE ${clauses.join(" AND ")}
               GROUP BY ${normalizedQuestion}, program_id
               HAVING COUNT(DISTINCT user_id) >= ?
               ORDER BY askers DESC, ask_count DESC, last_asked DESC
               LIMIT ?`;
  params.push(minAskers, limit);

  return query<GapSummaryRow>(sql).all(...params);
}

function unclassifiedGaps(limit = 5) {
  return query("SELECT id, question FROM doc_gaps WHERE kind IS NULL ORDER BY created_at DESC LIMIT ?").all(limit);
}

function setGapKind(id: number, kind: string) {
  query("UPDATE doc_gaps SET kind = ? WHERE id = ?").run(kind, id);
}

function gapThreads(
  question: string,
  limit = 2,
  sinceMs = 30 * 24 * 60 * 60 * 1000,
  programId: string | null | undefined = undefined,
) {
  const clauses = [
    "LOWER(TRIM(question)) = LOWER(TRIM(?))",
    "created_at > ?",
    "channel IS NOT NULL",
    "message_ts IS NOT NULL",
  ];
  const params: Array<string | number> = [question, now() - sinceMs];
  if (programId === null) clauses.push("program_id IS NULL");
  else if (programId !== undefined) {
    clauses.push("program_id = ?");
    params.push(programId);
  }
  params.push(limit);
  return query(
    `SELECT DISTINCT channel, message_ts FROM doc_gaps
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC LIMIT ?`,
  ).all(...params);
}

function gapCountsByKind(sinceMs = 7 * 24 * 60 * 60 * 1000, untilMs = null, programId = null) {
  const upper = untilMs === null ? now() : untilMs;
  const clauses = ["created_at > ?", "created_at <= ?"];
  const params = [now() - sinceMs, upper];
  if (programId) {
    clauses.push("program_id = ?");
    params.push(programId);
  }

  return Object.fromEntries(
    query<{ kind: string; count: number }>(
      `SELECT COALESCE(kind, 'unjudged') AS kind, COUNT(DISTINCT LOWER(TRIM(question))) AS count
         FROM doc_gaps WHERE ${clauses.join(" AND ")}
         GROUP BY COALESCE(kind, 'unjudged')`,
    )
      .all(...params)
      .map((r) => [r.kind, r.count]),
  );
}

function recordFeedback(messageTs: string, userId: string, vote: number) {
  query(
    `INSERT INTO feedback (message_ts, user_id, vote, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(message_ts, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
  ).run(messageTs, userId, vote, now());
}

function removeFeedback(messageTs: string, userId: string) {
  query("DELETE FROM feedback WHERE message_ts = ? AND user_id = ?").run(messageTs, userId);
}

function feedbackTotals() {
  return query("SELECT SUM(vote > 0) AS up, SUM(vote < 0) AS down FROM feedback").get() || { up: 0, down: 0 };
}

function addLearnedFact({
  question,
  answer,
  authorId = null,
  status = "pending",
  sourceTs = null,
  channel = null,
  programId = null,
  category = null,
  ticketId = null,
  resolverId = null,
  autoLearned = false,
}: Record<string, unknown>) {
  const result = query(
    `INSERT OR IGNORE INTO learned_facts (question, answer, author_id, status, source_ts, channel, program_id, category, ticket_id, resolver_id, verified_at, support_count, last_supported_at, auto_learned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    question,
    answer,
    authorId,
    status,
    sourceTs,
    channel,
    programId,
    category,
    ticketId,
    resolverId,
    status === "approved" ? now() : null,
    now(),
    autoLearned ? 1 : 0,
    now(),
  );
  if (result.changes > 0 && status === "approved") invalidateTrustCaches();
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

function assignUnownedLearnedFacts(ownerOfChannel: (channel: string | null) => string | null) {
  const rows = query("SELECT id, channel FROM learned_facts WHERE program_id IS NULL").all();
  let assigned = 0;
  const update = query("UPDATE learned_facts SET program_id = ? WHERE id = ? AND program_id IS NULL");
  for (const r of rows) {
    const owner = ownerOfChannel((r as { channel?: string | null }).channel || null);
    if (!owner) continue;
    assigned += update.run(owner, r.id).changes;
  }
  if (assigned > 0) invalidateTrustCaches();
  return { unowned: rows.length, assigned, remaining: rows.length - assigned };
}

function listLearnedFacts(status: string, limit = 25, programId = null): LearnedFactRow[] {
  const statusClause =
    status === "approved"
      ? "status = ? AND superseded_by IS NULL AND auto_learned = 0"
      : "status = ? AND superseded_by IS NULL";
  if (programId) {
    return query<LearnedFactRow>(
      `SELECT * FROM learned_facts WHERE ${statusClause} AND program_id = ? ORDER BY created_at ASC LIMIT ?`,
    ).all(status, programId, limit);
  }
  return query<LearnedFactRow>(`SELECT * FROM learned_facts WHERE ${statusClause} ORDER BY created_at ASC LIMIT ?`).all(
    status,
    limit,
  );
}

function listReviewableLearnedFacts(programId: string, limit = 50) {
  return query(
    `SELECT * FROM learned_facts
       WHERE program_id = ? AND superseded_by IS NULL
         AND (status = 'candidate' OR (status = 'approved' AND auto_learned = 1))
       ORDER BY COALESCE(last_supported_at, created_at) DESC LIMIT ?`,
  ).all(programId, limit);
}

function learnedFactsForOverlap(programId: string, category: string, limit = 100) {
  return query(
    `SELECT * FROM learned_facts
       WHERE program_id = ? AND category = ? AND status NOT IN ('superseded', 'rejected')
       ORDER BY COALESCE(last_supported_at, created_at) DESC LIMIT ?`,
  ).all(programId, category, limit);
}

function learnedFactForTicket(ticketId: number) {
  return query("SELECT * FROM learned_facts WHERE ticket_id = ? ORDER BY id DESC LIMIT 1").get(ticketId) || null;
}

function refreshLearnedFact(id: number) {
  const t = now();
  return (
    query(
      "UPDATE learned_facts SET support_count = COALESCE(support_count, 0) + 1, last_supported_at = ?, created_at = ? WHERE id = ? AND status NOT IN ('superseded', 'rejected')",
    ).run(t, t, id).changes > 0
  );
}

function supersedeLearnedFact(id: number, supersededBy: unknown) {
  const changed =
    query(
      "UPDATE learned_facts SET status = 'superseded', superseded_by = ?, superseded_at = ? WHERE id = ? AND status NOT IN ('superseded', 'rejected')",
    ).run(supersededBy, now(), id).changes > 0;
  if (changed) invalidateTrustCaches();
  return changed;
}

function getLearnedFactById(id: number): LearnedFactRow | null {
  return query<LearnedFactRow>("SELECT * FROM learned_facts WHERE id = ?").get(id) || null;
}

function approvedFacts(limit = 50, programId = null) {
  if (programId) {
    return query(
      "SELECT question, answer, category, created_at, last_supported_at, support_count FROM learned_facts WHERE status = 'approved' AND auto_learned = 0 AND superseded_by IS NULL AND program_id = ? ORDER BY COALESCE(last_supported_at, created_at) DESC LIMIT ?",
    )
      .all(programId, limit)
      .reverse();
  }
  return query(
    "SELECT question, answer, category, created_at, last_supported_at, support_count FROM learned_facts WHERE status = 'approved' AND auto_learned = 0 AND superseded_by IS NULL AND program_id IS NULL ORDER BY COALESCE(last_supported_at, created_at) DESC LIMIT ?",
  )
    .all(limit)
    .reverse();
}

function setLearnedStatus(id: number, status: string) {
  const result =
    status === "approved"
      ? query(
          `UPDATE learned_facts
            SET status = ?, verified_at = ?, auto_learned = 0
            WHERE id = ? AND status IN ('candidate', 'pending')
              AND NOT (program_id IS NULL AND COALESCE(source_ts, '') LIKE ?)`,
        ).run(status, now(), id, `${REPORT_DRAFT_SOURCE_PREFIX}%`)
      : query("UPDATE learned_facts SET status = ?, verified_at = NULL WHERE id = ?").run(status, id);
  if (result.changes > 0) invalidateTrustCaches();
  return result.changes > 0;
}

function updateLearnedFact(
  id: number,
  { question = null, answer = null, category = null }: Record<string, unknown> = {},
) {
  const changed =
    query(
      `UPDATE learned_facts SET question = COALESCE(?, question), answer = COALESCE(?, answer), category = COALESCE(?, category) WHERE id = ?`,
    ).run(question, answer, category, id).changes > 0;
  if (changed) invalidateTrustCaches();
  return changed;
}

function candidateForTicket(ticketId: number) {
  return (
    query("SELECT * FROM learned_facts WHERE ticket_id = ? AND status = 'candidate' LIMIT 1").get(ticketId) || null
  );
}

function deleteLearnedFact(id: number) {
  const changed = query("DELETE FROM learned_facts WHERE id = ?").run(id).changes > 0;
  if (changed) invalidateTrustCaches();
  return changed;
}

function deleteLearnedByStatus(status: string) {
  if (status === "all") {
    const changed = query("DELETE FROM learned_facts").run().changes;
    if (changed > 0) invalidateTrustCaches();
    return changed;
  }
  const changed = query("DELETE FROM learned_facts WHERE status = ?").run(status).changes;
  if (changed > 0) invalidateTrustCaches();
  return changed;
}

function deleteLearnedRange(fromId: number, toId: number) {
  const changed = query("DELETE FROM learned_facts WHERE id >= ? AND id <= ?").run(fromId, toId).changes;
  if (changed > 0) invalidateTrustCaches();
  return changed;
}

function pendingCountForQuestion(question: string) {
  return (
    query(
      "SELECT COUNT(*) AS count FROM learned_facts WHERE status = 'pending' AND LOWER(TRIM(question)) = LOWER(TRIM(?))",
    ).get(question)?.count || 0
  );
}

function hasCapturedSource(sourceTs: string) {
  if (!sourceTs) return false;
  return Boolean(query("SELECT 1 FROM learned_facts WHERE source_ts = ? LIMIT 1").get(sourceTs));
}

function muteThread(threadTs: string, channel = null) {
  query("INSERT OR REPLACE INTO muted_threads (thread_ts, channel, muted_at) VALUES (?, ?, ?)").run(
    threadTs,
    channel,
    now(),
  );
}

function isThreadMuted(threadTs: string) {
  if (!threadTs) return false;
  const row = query("SELECT 1 FROM muted_threads WHERE thread_ts = ? LIMIT 1").get(threadTs);
  return !!row;
}

function unmuteThread(threadTs: string) {
  if (!threadTs) return;
  query("DELETE FROM muted_threads WHERE thread_ts = ?").run(threadTs);
}

function markTakeover(threadTs: string, channel = null, byUser = null) {
  if (!threadTs) return;
  query("INSERT OR REPLACE INTO thread_takeover (thread_ts, channel, by_user, created_at) VALUES (?, ?, ?, ?)").run(
    threadTs,
    channel,
    byUser,
    now(),
  );
}

function isTakeover(threadTs: string) {
  if (!threadTs) return false;
  return !!query("SELECT 1 FROM thread_takeover WHERE thread_ts = ? LIMIT 1").get(threadTs);
}

function clearTakeover(threadTs: string) {
  if (!threadTs) return;
  query("DELETE FROM thread_takeover WHERE thread_ts = ?").run(threadTs);
}

function recordMetric(kind: string, latencyMs = null, detail = null, programId = null) {
  query("INSERT INTO metrics (kind, latency_ms, detail, program_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
    kind,
    latencyMs,
    detail,
    programId,
    now(),
  );
}

function recordLlmUsage(entry: Record<string, unknown> = {}) {
  try {
    query(
      `INSERT INTO llm_usage
       (operation, provider, program_id, channel, request_id, event_id, model, status, result, http_status, rate_limited, attempt, retry_count,
         prompt_tokens, cached_prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms, error_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.operation || "unknown",
      entry.provider || null,
      entry.programId || null,
      entry.channel || null,
      entry.requestId || null,
      entry.eventId || null,
      entry.model || null,
      entry.status || "error",
      entry.result || entry.status || "error",
      entry.httpStatus || null,
      entry.rateLimited ? 1 : 0,
      entry.attempt || 1,
      entry.retryCount || 0,
      entry.promptTokens ?? null,
      entry.cachedPromptTokens ?? null,
      entry.completionTokens ?? null,
      entry.totalTokens ?? null,
      entry.costUsd ?? null,
      entry.latencyMs ?? null,
      entry.errorKind || null,
      entry.createdAt || now(),
    );
  } catch (e: unknown) {
    log.debug("db", `llm telemetry write failed: ${errorMessage(e)}`);
  }
}

function llmUsageSummary(sinceMs = 24 * 60 * 60 * 1000) {
  try {
    return query(
      `SELECT operation, program_id, channel, model,
              COUNT(*) AS requests, SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN http_status = 429 THEN 1 ELSE 0 END) AS rate_limits,
              SUM(retry_count) AS retries, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens, SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
       FROM llm_usage WHERE created_at > ?
       GROUP BY operation, program_id, channel, model
       ORDER BY requests DESC`,
    ).all(now() - sinceMs);
  } catch (e: unknown) {
    log.debug("db", `llm telemetry read failed: ${errorMessage(e)}`);
    return [];
  }
}

interface LlmUsageOptions {
  programId?: string | null;
  from?: string | number | null;
  until?: string | number | null;
  bucket?: "hour" | "day";
  operation?: string | null;
  limit?: number;
  offset?: number;
}

const USAGE_BUCKETS = new Set(["hour", "day"]);
const USAGE_OPERATIONS = new Set(["answer", "intent", "chat", "vision", "copilot", "llm"]);
function parseUsageTime(value: string | number | null | undefined, fallback: number | null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function llmUsageReport({
  programId,
  from,
  until,
  bucket = "day",
  operation = null,
  limit = 50,
  offset = 0,
}: LlmUsageOptions = {}) {
  if (!programId) return { error: "programId required" };
  if (!USAGE_BUCKETS.has(bucket)) return { error: "bucket must be hour or day" };
  if (operation !== null && !USAGE_OPERATIONS.has(operation)) return { error: "invalid operation" };
  const end = parseUsageTime(until, now());
  const start = parseUsageTime(from, end === null ? null : end - 30 * 86400000);
  if (start === null || end === null || start >= end) return { error: "invalid date range" };
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const clauses = ["program_id = ?", "created_at >= ?", "created_at < ?"];
  const params: Array<string | number> = [programId, start, end];
  if (operation) {
    clauses.push("operation = ?");
    params.push(operation);
  }
  const where = clauses.join(" AND ");
  const d = bucket === "hour" ? "%Y-%m-%dT%H:00:00Z" : "%Y-%m-%dT00:00:00Z";
  const base = `FROM llm_usage WHERE ${where}`;
  const totals = query<UsageRow>(`SELECT COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests,
    COALESCE(SUM(total_tokens),0) total_tokens, COALESCE(SUM(prompt_tokens),0) prompt_tokens,
    COALESCE(SUM(cached_prompt_tokens),0) cached_prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
    SUM(cost_usd) cost_usd, AVG(latency_ms) latency_ms,
    SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) successes, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors,
    SUM(rate_limited) rate_limited, SUM(CASE WHEN result='grounded' THEN 1 ELSE 0 END) grounded_answers,
    SUM(CASE WHEN result='fallback' THEN 1 ELSE 0 END) fallbacks, SUM(CASE WHEN result='suppressed' THEN 1 ELSE 0 END) suppressed
    FROM llm_usage WHERE ${where}`).get(...params);
  const timeseries = query<UsageRow>(`SELECT strftime('${d}', created_at / 1000, 'unixepoch') bucket,
    COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests, COALESCE(SUM(total_tokens),0) total_tokens,
    SUM(cost_usd) cost_usd FROM llm_usage WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(...params);
  const grouped = (column: "operation" | "provider" | "model" | "channel") =>
    query<UsageRow>(`SELECT ${column} value, MAX(provider) provider, COUNT(DISTINCT COALESCE(request_id, 'event:' || id)) requests,
     COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(cached_prompt_tokens),0) cached_prompt_tokens,
     COALESCE(SUM(completion_tokens),0) completion_tokens, COALESCE(SUM(total_tokens),0) total_tokens,
     SUM(cost_usd) cost_usd, AVG(latency_ms) latency_ms FROM llm_usage WHERE ${where} GROUP BY ${column} ORDER BY requests DESC LIMIT 100`).all(
      ...params,
    );
  const totalActivity = Number(query<{ n: number }>(`SELECT COUNT(*) n ${base}`).get(...params).n);
  const recent =
    query<UsageRow>(`SELECT created_at, operation, provider, model, channel, request_id, event_id, status, result, http_status, attempt, retry_count, latency_ms, rate_limited
    ${base} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset);
  const metric = (row: UsageRow) => ({
    requests: Number(row.requests || 0),
    inputTokens: Number(row.prompt_tokens || 0),
    outputTokens: Number(row.completion_tokens || 0),
    cachedInputTokens: Number(row.cached_prompt_tokens || 0),
    costCents: row.cost_usd == null ? null : Number((row.cost_usd * 100).toFixed(2)),
  });
  const rowsFor = (column: "operation" | "provider" | "model" | "channel") =>
    grouped(column).map((row) => ({
      ...metric(row),
      name: row.value || "unknown",
      ...(column === "model" ? { provider: row.provider || "unknown" } : {}),
    }));
  const summary = metric(totals);
  return {
    programId,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    bucket,
    precision: totals.cost_usd == null ? "unavailable" : "exact",
    requests: summary.requests,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    costCents: summary.costCents,
    summary: {
      ...summary,
      latencyMs: totals.latency_ms == null ? null : Number(totals.latency_ms),
      errors: Number(totals.errors || 0),
      rateLimited: Number(totals.rate_limited || 0),
      groundedAnswers: Number(totals.grounded_answers || 0),
      fallbacks: Number(totals.fallbacks || 0),
      suppressed: Number(totals.suppressed || 0),
      rate_limited: Number(totals.rate_limited || 0),
      cost_usd: totals.cost_usd,
    },
    timeseries: timeseries.map((row) => ({ ...metric(row), at: `${row.bucket}` })),
    operation: rowsFor("operation"),
    provider: rowsFor("provider"),
    model: rowsFor("model"),
    topConsumers: rowsFor("channel").map((row) => ({ ...row, consumerId: row.name })),
    recent: recent.map(
      ({
        created_at,
        operation: op,
        provider,
        model,
        channel,
        request_id,
        status,
        latency_ms,
        rate_limited,
        retry_count,
      }) => ({
        at: new Date(created_at).toISOString(),
        operation: op,
        provider: provider || "unknown",
        model: model || "unknown",
        consumerId: channel || null,
        requestId: request_id || null,
        status: status || "unknown",
        latencyMs: latency_ms == null ? null : Number(latency_ms),
        rateLimited: !!rate_limited,
        retryCount: Number(retry_count || 0),
      }),
    ),
    recentActivity: recent.map(
      ({
        created_at,
        operation: op,
        provider,
        model,
        request_id,
        event_id,
        status,
        result,
        http_status,
        attempt,
        retry_count,
        latency_ms,
        rate_limited,
      }) => ({
        createdAt: created_at,
        operation: op,
        provider,
        model,
        requestId: request_id,
        eventId: event_id,
        status,
        result,
        httpStatus: http_status,
        attempt,
        retryCount: retry_count,
        latencyMs: latency_ms,
        rateLimited: !!rate_limited,
      }),
    ),
    pagination: {
      limit: safeLimit,
      offset: safeOffset,
      total: totalActivity,
      hasMore: safeOffset + recent.length < totalActivity,
    },
  };
}

function metricCounts(sinceMs = 7 * 24 * 60 * 60 * 1000, untilMs = null): MetricCountRow[] {
  return query<MetricCountRow>(
    "SELECT kind, COUNT(*) AS count FROM metrics WHERE created_at > ? AND created_at <= ? GROUP BY kind",
  ).all(now() - sinceMs, untilMs === null ? now() : untilMs);
}

function lastMetricAt(kind: string) {
  return query("SELECT MAX(created_at) AS at FROM metrics WHERE kind = ?").get(kind)?.at || null;
}

function metricDetails(kind: string, sinceMs = 7 * 24 * 60 * 60 * 1000) {
  return query(
    "SELECT detail, COUNT(*) AS count FROM metrics WHERE kind = ? AND detail IS NOT NULL AND created_at > ? GROUP BY detail ORDER BY count DESC",
  ).all(kind, now() - sinceMs);
}

function medianLatency(kind: string, sinceMs = 7 * 24 * 60 * 60 * 1000): number | null {
  const rows = query<LatencyRow>(
    "SELECT latency_ms FROM metrics WHERE kind = ? AND latency_ms IS NOT NULL AND created_at > ? ORDER BY latency_ms",
  ).all(kind, now() - sinceMs);
  if (rows.length === 0) return null;
  return rows[Math.floor(rows.length / 2)].latency_ms;
}

function countRecentRequests(userId: string, windowMs: number) {
  const row = query("SELECT COUNT(*) AS count FROM rate_limits WHERE user_id = ? AND created_at > ?").get(
    userId,
    now() - windowMs,
  );
  return row?.count || 0;
}

function recordRequest(userId: string) {
  query("INSERT INTO rate_limits (user_id, created_at) VALUES (?, ?)").run(userId, now());
}

function sweep() {
  const t = now();
  query("DELETE FROM answered_messages WHERE answered_at < ?").run(t - ANSWERED_TTL_MS);
  query("DELETE FROM thread_messages WHERE created_at < ?").run(t - THREAD_TTL_MS);
  query("DELETE FROM threads WHERE updated_at < ?").run(t - THREAD_TTL_MS);
  query("DELETE FROM user_topics WHERE created_at < ?").run(t - HISTORY_TTL_MS);
  query("DELETE FROM user_messages WHERE created_at < ?").run(t - USER_MESSAGE_TTL_MS);
  query("DELETE FROM answer_cache WHERE COALESCE(last_asked_at, created_at) < ?").run(t - CACHE_IDLE_MS);
  query("DELETE FROM rate_limits WHERE created_at < ?").run(t - 60 * 60 * 1000);

  try {
    handle().exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e: unknown) {
    log.debug("db", `wal checkpoint skipped: ${errorMessage(e)}`);
  }
}

function startSweeper() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (e: unknown) {
      log.error("db", "sweep failed:", errorMessage(e));
    }
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function close() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (db) db.close();
  db = null;
  ephemeralThreadMessages.clear();
}

function saveSourceText(name: string, text: string) {
  const t = now();
  query(
    "INSERT INTO source_cache (name, text, fetched_at, fail_count, last_success_at, last_error) VALUES (?, ?, ?, 0, ?, NULL)" +
      " ON CONFLICT(name) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at," +
      " fail_count = 0, last_success_at = excluded.last_success_at, last_error = NULL",
  ).run(name, text, t, t);
}

function loadSourceText(name: string) {
  const row = query("SELECT text, fetched_at FROM source_cache WHERE name = ?").get(name);
  if (!row) return null;
  return { text: row.text, fetchedAt: row.fetched_at };
}

function recordSourceFailure(name: string, error: unknown) {
  const t = now();
  query(
    "INSERT INTO source_cache (name, text, fetched_at, fail_count, last_error) VALUES (?, '', ?, 1, ?)" +
      " ON CONFLICT(name) DO UPDATE SET fail_count = fail_count + 1, last_error = excluded.last_error",
  ).run(name, t, String(error || "").slice(0, 500));
}

function getSourceHealth(names: unknown) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const placeholders = names.map(() => "?").join(",");
  return query(
    `SELECT name, fetched_at, fail_count, last_success_at, last_error FROM source_cache WHERE name IN (${placeholders})`,
  ).all(...names);
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch (_: unknown) {
    return null;
  }
}

function getDbPrograms() {
  const rows = query<ProgramDbRow>("SELECT * FROM programs ORDER BY id ASC").all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    posture: r.posture,
    scope: r.scope || "any",
    workspaceId: r.workspace_id || null,
    deploymentMode: r.deployment_mode || "dedicated_legacy",
    supportName: r.support_name || null,
    iconUrl: r.icon_url || null,
    replySignature: r.reply_signature || null,
    aiAnswers: r.ai_answers === null || r.ai_answers === undefined ? true : !!r.ai_answers,
    ticketsEnabled: r.tickets_enabled === null || r.tickets_enabled === undefined ? true : !!r.tickets_enabled,
    autoEscalate: r.auto_escalate === null || r.auto_escalate === undefined ? true : !!r.auto_escalate,
    sensitiveCategories: r.sensitive_categories ? JSON.parse(r.sensitive_categories) : [],
    supportActive: r.support_active === null || r.support_active === undefined ? true : !!r.support_active,
    autoAssign: !!r.auto_assign,
    helperPing: !!r.helper_ping_enabled,
    shadowMode: !!r.shadow_mode,
    incidentMode: r.incident_mode || "ANSWER_AND_TRACK",
    publicTicketsEnabled:
      r.public_tickets_enabled === null || r.public_tickets_enabled === undefined ? true : !!r.public_tickets_enabled,
    sharedSources: false,
    sla: {
      unassignedMs: r.sla_unassigned_ms || null,
      assignedMs: r.sla_assigned_ms || null,
      waitingMs: r.sla_waiting_ms || null,
      targetMs: r.sla_target_ms || null,
      notifyChannel: r.sla_notify_channel || null,
    },
    retention: {
      contextDays: r.retention_context_days || null,
      ticketsDays: r.retention_tickets_days || null,
      notesDays: r.retention_notes_days || null,
      tracesDays: r.retention_traces_days || null,
      analyticsDays: r.retention_analytics_days || null,
      auditDays: r.retention_audit_days || null,
    },
    helpChannel: r.help_channel,
    organizerChannel: r.organizer_channel || null,
    channels: r.channels ? JSON.parse(r.channels) : [],
    helperGroup: r.helper_group,
    sources: r.sources ? JSON.parse(r.sources) : null,
    milestones: r.milestones ? JSON.parse(r.milestones) : null,
    guides: r.guides ? JSON.parse(r.guides) : null,
    links: r.links ? JSON.parse(r.links) : null,
    pinnedRules: r.pinned_rules ? JSON.parse(r.pinned_rules) : [],
    categories: r.categories ? JSON.parse(r.categories) : null,
    ticketVisibility: r.ticket_visibility || null,
    behavior: r.behavior ? safeJson(r.behavior) : null,
    status: r.status || null,
    learning: r.learning === "review" ? "review" : "auto",
    updatedAt: r.updated_at,
  }));
}

function saveProgram(p: PersistedProgram) {
  const existing = query("SELECT 1 FROM programs WHERE id = ?").get(p.id);
  const nowTs = now();
  const channels = p.channels ? JSON.stringify(p.channels) : null;
  const sources = p.sources ? JSON.stringify(p.sources) : null;
  const milestones = p.milestones ? JSON.stringify(p.milestones) : null;
  const guides = p.guides ? JSON.stringify(p.guides) : null;
  const links = p.links ? JSON.stringify(p.links) : null;
  const categories = p.categories ? JSON.stringify(p.categories) : null;
  const ticketVisibility = p.ticketVisibility || null;
  const behavior =
    p.behavior && typeof p.behavior === "object"
      ? JSON.stringify(p.behavior)
      : typeof p.behavior === "string"
        ? p.behavior
        : null;
  const status = p.status && ["sandbox", "live", "paused"].includes(p.status) ? p.status : null;
  const learning = p.learning === "review" ? "review" : "auto";
  const sensitive = p.sensitiveCategories ? JSON.stringify(p.sensitiveCategories) : null;
  const VALID_INCIDENT_MODES = ["ANSWER_ONLY", "ANSWER_AND_TRACK", "NORMAL_TICKET"];
  const incidentMode = VALID_INCIDENT_MODES.includes(p.incidentMode || "") ? p.incidentMode : "ANSWER_AND_TRACK";
  const values = [
    p.name,
    p.posture || "active",
    p.scope || "any",
    p.workspaceId || null,
    p.deploymentMode || "dedicated_legacy",
    p.supportName || null,
    p.iconUrl || null,
    p.replySignature || null,
    p.aiAnswers === false ? 0 : 1,
    p.ticketsEnabled === false ? 0 : 1,
    p.autoEscalate === false ? 0 : 1,
    sensitive,
    p.supportActive === false ? 0 : 1,
    p.autoAssign === true ? 1 : 0,
    p.helperPing === true ? 1 : 0,
    p.shadowMode === true ? 1 : 0,
    incidentMode,
    p.publicTicketsEnabled === false ? 0 : 1,
    p.sla?.unassignedMs || null,
    p.sla?.assignedMs || null,
    p.sla?.waitingMs || null,
    p.sla?.targetMs || null,
    p.sla?.notifyChannel || null,
    p.retention?.contextDays || null,
    p.retention?.ticketsDays || null,
    p.retention?.notesDays || null,
    p.retention?.tracesDays || null,
    p.retention?.analyticsDays || null,
    p.retention?.auditDays || null,
    p.helpChannel || null,
    channels,
    p.helperGroup || null,
    sources,
    milestones,
    guides,
    links,
    categories,
    ticketVisibility,
    behavior,
    status,
    learning,
    nowTs,
  ];

  if (existing) {
    query(
      `UPDATE programs SET name = ?, posture = ?, scope = ?, workspace_id = ?,
         deployment_mode = ?, support_name = ?, icon_url = ?, reply_signature = ?,
         ai_answers = ?, tickets_enabled = ?, auto_escalate = ?,
         sensitive_categories = ?, support_active = ?, auto_assign = ?, helper_ping_enabled = ?, shadow_mode = ?, incident_mode = ?, public_tickets_enabled = ?,
         sla_unassigned_ms = ?, sla_assigned_ms = ?, sla_waiting_ms = ?, sla_target_ms = ?, sla_notify_channel = ?,
         retention_context_days = ?, retention_tickets_days = ?, retention_notes_days = ?, retention_traces_days = ?, retention_analytics_days = ?, retention_audit_days = ?,
         help_channel = ?, channels = ?, helper_group = ?,
         sources = ?, milestones = ?, guides = ?, links = ?, categories = ?, ticket_visibility = ?, behavior = ?, status = ?, learning = ?, updated_at = ? WHERE id = ?`,
    ).run(...values, p.id);
  } else {
    query(
      `INSERT INTO programs (id, name, posture, scope, workspace_id, deployment_mode, support_name, icon_url, reply_signature,
         ai_answers, tickets_enabled, auto_escalate, sensitive_categories, support_active, auto_assign, helper_ping_enabled, shadow_mode, incident_mode, public_tickets_enabled,
         sla_unassigned_ms, sla_assigned_ms, sla_waiting_ms, sla_target_ms, sla_notify_channel,
         retention_context_days, retention_tickets_days, retention_notes_days, retention_traces_days, retention_analytics_days, retention_audit_days,
         help_channel, channels, helper_group, sources, milestones, guides, links, categories, ticket_visibility, behavior, status, learning, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, ...values, nowTs);
  }
}

function deleteProgram(id: string | number) {
  return query("DELETE FROM programs WHERE id = ?").run(id).changes > 0;
}

function toJson(value: unknown) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function createTicket({
  programId,
  workspaceId = null,
  channel,
  threadTs,
  requesterId,
  question,
  category = null,
  priority = null,
  summary = null,
  createdAt = null,
  visibility = null,
}: CreateTicketOptions): number | null {
  // Idempotent events
  const t = createdAt === null || createdAt === undefined ? now() : Number(createdAt);
  try {
    const result = query(
      `INSERT OR IGNORE INTO tickets (program_id, workspace_id, channel, thread_ts, requester_id, question, category, category_source, priority, summary, visibility, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      programId,
      workspaceId,
      channel,
      threadTs,
      requesterId,
      question,
      category,
      category ? "human" : null,
      priority,
      summary,
      visibility,
      t,
      t,
    );
    if (result.changes > 0) return Number(result.lastInsertRowid);
  } catch (_: unknown) {}
  const existing = getTicketByThreadTs(threadTs, workspaceId, programId);
  if (existing) return existing.id;
  return null;
}

function getTicket(id: number): TicketRow | null {
  return query<TicketRow>("SELECT * FROM tickets WHERE id = ?").get(id) || null;
}

function getTicketByThreadTs(
  threadTs: string,
  workspaceId: string | null = null,
  programId: string | null = null,
): TicketRow | null {
  if (workspaceId) {
    if (programId) {
      return (
        query<TicketRow>(
          "SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? AND program_id = ? LIMIT 1",
        ).get(threadTs, workspaceId, programId) || null
      );
    }
    return (
      query<TicketRow>("SELECT * FROM tickets WHERE thread_ts = ? AND workspace_id = ? LIMIT 1").get(
        threadTs,
        workspaceId,
      ) || null
    );
  }
  if (programId) {
    return (
      query<TicketRow>("SELECT * FROM tickets WHERE thread_ts = ? AND program_id = ? LIMIT 1").get(
        threadTs,
        programId,
      ) || null
    );
  }
  return query<TicketRow>("SELECT * FROM tickets WHERE thread_ts = ? LIMIT 1").get(threadTs) || null;
}

function getTicketByChannelThreadTs(channel: string | null, threadTs: string, workspaceId = null, programId = null) {
  if (!channel || !threadTs) return null;
  const clauses = ["channel = ?", "thread_ts = ?"];
  const params = [channel, threadTs];
  if (workspaceId) {
    clauses.push("workspace_id = ?");
    params.push(workspaceId);
  }
  if (programId) {
    clauses.push("program_id = ?");
    params.push(programId);
  }
  return query(`SELECT * FROM tickets WHERE ${clauses.join(" AND ")} LIMIT 1`).get(...params) || null;
}

function enrichTicket(
  id: number,
  { requesterId = null, question = null, visibility = null }: Record<string, unknown> = {},
) {
  if (!id) return false;
  return (
    query(
      `UPDATE tickets SET requester_id = COALESCE(NULLIF(requester_id, ''), ?), question = COALESCE(NULLIF(question, ''), ?), visibility = COALESCE(visibility, ?), updated_at = ? WHERE id = ?`,
    ).run(requesterId, question, visibility, now(), id).changes > 0
  );
}

function updateTicketCardTs(id: number, cardTs: string) {
  return query("UPDATE tickets SET card_ts = ? WHERE id = ? AND card_ts IS NULL").run(cardTs, id).changes > 0;
}

function updatePublicAckTs(id: number, ackTs: string) {
  return (
    query("UPDATE tickets SET public_ack_ts = ? WHERE id = ? AND public_ack_ts IS NULL").run(ackTs, id).changes > 0
  );
}

function claimTicket(id: number, assigneeId: string) {
  return (
    query(
      "UPDATE tickets SET status = 'claimed', assignee_id = ?, claimed_at = ?, assigned_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'waiting_for_helper')",
    ).run(assigneeId, now(), now(), now(), id).changes > 0
  );
}

function assignTicket(id: number, assigneeId: string) {
  const t = now();
  return (
    query(
      "UPDATE tickets SET status = 'assigned', assignee_id = ?, assigned_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'claimed', 'assigned', 'waiting_for_helper', 'escalated', 'reopened')",
    ).run(assigneeId, t, t, id).changes > 0
  );
}

function unclaimTicket(id: number) {
  return (
    query("UPDATE tickets SET status = 'open', assignee_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?").run(
      now(),
      id,
    ).changes > 0
  );
}

function resolveTicket(id: number, resolution = "resolved", resolvedBy = null, resolvedAt = null) {
  const t = resolvedAt === null || resolvedAt === undefined ? now() : Number(resolvedAt);
  const updated = now();
  return (
    query(
      "UPDATE tickets SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ?, first_response_at = COALESCE(first_response_at, ?) WHERE id = ? AND status NOT IN ('resolved', 'closed')",
    ).run(resolution, resolvedBy, t, updated, t, id).changes > 0
  );
}

function reopenTicket(id: number, reopenedBy = null) {
  const t = now();
  return (
    query(
      "UPDATE tickets SET status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1, updated_at = ? WHERE id = ?",
    ).run(reopenedBy, t, t, id).changes > 0
  );
}

function reopenResolvedTicket(id: number, reopenedBy = null) {
  const t = now();
  return (
    query(
      "UPDATE tickets SET status = 'reopened', resolution = NULL, resolved_at = NULL, resolved_by = NULL, reopened_by = ?, reopened_at = ?, reopen_count = COALESCE(reopen_count, 0) + 1, updated_at = ? WHERE id = ? AND status IN ('resolved', 'closed')",
    ).run(reopenedBy, t, t, id).changes > 0
  );
}

function closeTicket(id: number, resolution = null, closedAt = null) {
  const t = closedAt === null || closedAt === undefined ? now() : Number(closedAt);
  return (
    query(
      "UPDATE tickets SET status = 'closed', resolution = COALESCE(?, resolution), resolved_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('resolved', 'closed')",
    ).run(resolution, t, now(), id).changes > 0
  );
}

function snoozeTicket(id: number, untilMs: number) {
  return (
    query("UPDATE tickets SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?").run(
      untilMs,
      now(),
      id,
    ).changes > 0
  );
}

function markDuplicateTicket(id: number, canonicalId: number) {
  return (
    query("UPDATE tickets SET status = 'duplicate', duplicate_of = ?, updated_at = ? WHERE id = ?").run(
      canonicalId,
      now(),
      id,
    ).changes > 0
  );
}

function escalateTicketStatus(id: number) {
  return query("UPDATE tickets SET status = 'escalated', updated_at = ? WHERE id = ?").run(now(), id).changes > 0;
}

function markTicketWaitingForHelper(id: number) {
  return (
    query(
      "UPDATE tickets SET status = 'waiting_for_helper', updated_at = ? WHERE id = ? AND status IN ('open', 'reopened', 'escalated')",
    ).run(now(), id).changes > 0
  );
}

function setTicketTriage(
  id: number,
  {
    category = null,
    categorySource = null,
    priority = null,
    summary = null,
    aiConfidence = null,
    aiDecision = null,
  }: Record<string, unknown> = {},
) {
  const decision = toJson(aiDecision);
  const source = category !== null && category !== undefined && categorySource === null ? "human" : categorySource;
  return (
    query(
      `UPDATE tickets SET category = COALESCE(?, category), category_source = COALESCE(?, category_source), priority = COALESCE(?, priority), summary = COALESCE(?, summary),
     ai_confidence = COALESCE(?, ai_confidence), ai_decision = COALESCE(?, ai_decision), updated_at = ? WHERE id = ?`,
    ).run(category, source, priority, summary, aiConfidence, decision, now(), id).changes > 0
  );
}

function setResolutionSummary(id: number, summary: string) {
  const clean = String(summary || "").trim();
  if (!clean) return false;
  const t = now();
  return (
    query(
      "UPDATE tickets SET resolution_summary = ?, resolution_summary_at = ?, updated_at = ? WHERE id = ? AND resolution_summary IS NULL",
    ).run(clean, t, t, id).changes > 0
  );
}

function getResolutionSummary(id: number) {
  return query("SELECT resolution_summary, resolution_summary_at FROM tickets WHERE id = ?").get(id) || null;
}

function recordFirstResponse(id: number, human = false, at = null) {
  const t = at === null || at === undefined ? now() : Number(at);
  if (human) {
    return (
      query(
        "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), first_human_response_at = COALESCE(first_human_response_at, ?), updated_at = ? WHERE id = ?",
      ).run(t, t, t, id).changes > 0
    );
  }
  return (
    query(
      "UPDATE tickets SET first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ? AND first_response_at IS NULL",
    ).run(t, t, id).changes > 0
  );
}

function getTicketsForProgram(programId: string, status = null): TicketRow[] {
  if (status) {
    return query<TicketRow>("SELECT * FROM tickets WHERE program_id = ? AND status = ? ORDER BY created_at DESC").all(
      programId,
      status,
    );
  }
  return query<TicketRow>("SELECT * FROM tickets WHERE program_id = ? ORDER BY created_at DESC").all(programId);
}

function searchTickets({
  programId,
  status = null,
  assigneeId = null,
  requesterId = null,
  category = null,
  priority = null,
  q = null,
  sinceMs = null,
  untilMs = null,
  limit = 50,
  offset = 0,
}: Record<string, unknown> = {}) {
  const clauses = ["program_id = ?"];
  const params = [programId];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (assigneeId) {
    clauses.push("assignee_id = ?");
    params.push(assigneeId);
  }
  if (requesterId) {
    clauses.push("requester_id = ?");
    params.push(requesterId);
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }
  if (priority) {
    clauses.push("priority = ?");
    params.push(priority);
  }
  if (sinceMs !== null && sinceMs !== undefined) {
    clauses.push("created_at > ?");
    params.push(sinceMs);
  }
  if (untilMs !== null && untilMs !== undefined) {
    clauses.push("created_at <= ?");
    params.push(untilMs);
  }
  if (q) {
    clauses.push("(question LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    params.push(
      `%${String(q).replace(/[\\%_]/g, (c: unknown) => `\\${c}`)}%`,
      `%${String(q).replace(/[\\%_]/g, (c: unknown) => `\\${c}`)}%`,
    );
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const total = query(`SELECT COUNT(*) AS n FROM tickets WHERE ${clauses.join(" AND ")}`).get(...params)?.n || 0;
  const rows = query(
    `SELECT * FROM tickets WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(...params, safeLimit, safeOffset);
  return { total, rows };
}

function claimProgramChannel({
  workspaceId = null,
  channelId,
  programId,
  kind = "help",
  claimedBy = null,
}: Record<string, unknown>) {
  // Database authority
  const ws = workspaceId || "default";
  const res = query(
    "INSERT OR IGNORE INTO program_channels (workspace_id, channel_id, program_id, kind, claimed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(ws, channelId, programId, kind, claimedBy, now());
  if (res.changes > 0) return { ok: true, programId };
  const owner = query("SELECT program_id, kind FROM program_channels WHERE workspace_id = ? AND channel_id = ?").get(
    ws,
    channelId,
  );
  if (owner && owner.program_id === programId) {
    if (owner.kind !== kind) {
      query("UPDATE program_channels SET kind = ? WHERE workspace_id = ? AND channel_id = ?").run(kind, ws, channelId);
    }
    return { ok: true, programId };
  }
  return { ok: false, ownerProgramId: owner ? owner.program_id : null };
}

function releaseProgramChannel({ workspaceId = null, channelId, programId = null }: Record<string, unknown>) {
  const ws = workspaceId || "default";
  if (programId) {
    return (
      query("DELETE FROM program_channels WHERE workspace_id = ? AND channel_id = ? AND program_id = ?").run(
        ws,
        channelId,
        programId,
      ).changes > 0
    );
  }
  return query("DELETE FROM program_channels WHERE workspace_id = ? AND channel_id = ?").run(ws, channelId).changes > 0;
}

function getChannelOwner(workspaceId: string | null = null, channelId: string): ChannelClaimRow | null {
  return (
    query<ChannelClaimRow>("SELECT * FROM program_channels WHERE workspace_id = ? AND channel_id = ?").get(
      workspaceId || "default",
      channelId,
    ) || null
  );
}

function listChannelClaims() {
  return query("SELECT workspace_id, channel_id, program_id, kind FROM program_channels").all();
}

function listProgramChannels(programId: string): ChannelClaimRow[] {
  return query<ChannelClaimRow>("SELECT * FROM program_channels WHERE program_id = ? ORDER BY created_at ASC").all(
    programId,
  );
}

function addTicketEvent({
  ticketId,
  programId,
  actorId = null,
  eventType,
  detail = null,
  createdAt = null,
}: Record<string, unknown>) {
  const d =
    detail === null || detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail);
  const res = query(
    "INSERT INTO ticket_events (ticket_id, program_id, actor_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    ticketId,
    programId,
    actorId,
    eventType,
    d,
    createdAt === null || createdAt === undefined ? now() : Number(createdAt),
  );
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listTicketEvents(ticketId: number, limit = 100): TicketEventRow[] {
  return query<TicketEventRow>("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?").all(
    ticketId,
    limit,
  );
}

function getHistoryImportProgress(programId: string, channelId: string): HistoryImportRow | null;
function getHistoryImportProgress(programId: string, channelId?: null): HistoryImportRow[];
function getHistoryImportProgress(
  programId: string,
  channelId: string | null = null,
): HistoryImportRow | HistoryImportRow[] | null {
  if (channelId) {
    return (
      query<HistoryImportRow>("SELECT * FROM history_import_progress WHERE program_id = ? AND channel_id = ?").get(
        programId,
        channelId,
      ) || null
    );
  }
  return query<HistoryImportRow>("SELECT * FROM history_import_progress WHERE program_id = ? ORDER BY channel_id").all(
    programId,
  );
}

function upsertHistoryImportProgress(programId: string, channelId: string, patch: HistoryImportPatch = {}) {
  const current = getHistoryImportProgress(programId, channelId);
  const t = patch.updatedAt === undefined ? now() : Number(patch.updatedAt);
  const values = {
    cursor: current?.cursor ?? null,
    newestTsDone: current?.newest_ts_done ?? null,
    status: current?.status || "pending",
    messagesScanned: current?.messages_scanned || 0,
    ticketsCreated: current?.tickets_created || 0,
    ticketsEnriched: current?.tickets_enriched || 0,
    resolved: current?.resolved || 0,
    closed: current?.closed || 0,
    queuedForJudge: current?.queued_for_judge || 0,
    lastError: current?.last_error || null,
    startedAt: current?.started_at || null,
    completedAt: current?.completed_at || null,
    rulesVersion: current?.rules_version || 1,
    ...patch,
  };
  query(
    `INSERT INTO history_import_progress (program_id, channel_id, cursor, newest_ts_done, status, messages_scanned, tickets_created, tickets_enriched, resolved, closed, queued_for_judge, last_error, started_at, completed_at, updated_at, rules_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(program_id, channel_id) DO UPDATE SET cursor = excluded.cursor, newest_ts_done = excluded.newest_ts_done, status = excluded.status,
       messages_scanned = excluded.messages_scanned, tickets_created = excluded.tickets_created, tickets_enriched = excluded.tickets_enriched,
       resolved = excluded.resolved, closed = excluded.closed, queued_for_judge = excluded.queued_for_judge, last_error = excluded.last_error,
       started_at = excluded.started_at, completed_at = excluded.completed_at, updated_at = excluded.updated_at, rules_version = excluded.rules_version`,
  ).run(
    programId,
    channelId,
    values.cursor,
    values.newestTsDone,
    values.status,
    values.messagesScanned,
    values.ticketsCreated,
    values.ticketsEnriched,
    values.resolved,
    values.closed,
    values.queuedForJudge,
    values.lastError,
    values.startedAt,
    values.completedAt,
    t,
    values.rulesVersion,
  );
  return getHistoryImportProgress(programId, channelId);
}

function addTicketNote({ ticketId, programId, authorId, body }: Record<string, unknown>) {
  const clean = String(body || "").trim();
  if (!clean) return null;
  const res = query(
    "INSERT INTO ticket_notes (ticket_id, program_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ticketId, programId, authorId, clean, now());
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listTicketNotes(ticketId: number, limit = 100) {
  return query(
    "SELECT id, ticket_id, program_id, author_id, body, created_at FROM ticket_notes WHERE ticket_id = ? ORDER BY created_at ASC LIMIT ?",
  ).all(ticketId, limit);
}

function recordAuditEvent({
  programId = null,
  actorId = null,
  action,
  entityType = null,
  entityId = null,
  metadata = null,
}: Record<string, unknown>) {
  const res = query(
    "INSERT INTO audit_events (program_id, actor_id, action, entity_type, entity_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(programId, actorId, action, entityType, entityId, metadata, now());
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

function listAuditEvents({ programId = null, limit = 100 }: Record<string, unknown> = {}): AuditEventRow[] {
  if (programId) {
    return query<AuditEventRow>("SELECT * FROM audit_events WHERE program_id = ? ORDER BY created_at DESC LIMIT ?").all(
      programId,
      limit,
    );
  }
  return query<AuditEventRow>("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit);
}

function syncHelper({ programId, userId, source = "manual", role = "helper" }: Record<string, unknown>) {
  query(
    `INSERT INTO program_helpers (program_id, user_id, helper_source, role, active, added_at, removed_at)
       VALUES (?, ?, ?, ?, 1, ?, NULL)
       ON CONFLICT(program_id, user_id) DO UPDATE SET helper_source = excluded.helper_source, role = excluded.role, active = 1, removed_at = NULL`,
  ).run(programId, userId, source, role, now());
}

function setHelperPingEligible({ programId, userId, eligible }: Record<string, unknown>) {
  return (
    query("UPDATE program_helpers SET ping_eligible = ? WHERE program_id = ? AND user_id = ?").run(
      eligible ? 1 : 0,
      programId,
      userId,
    ).changes > 0
  );
}

function removeHelper({ programId, userId }: Record<string, unknown>) {
  return (
    query(
      "UPDATE program_helpers SET active = 0, removed_at = ? WHERE program_id = ? AND user_id = ? AND active = 1",
    ).run(now(), programId, userId).changes > 0
  );
}

function listHelpers(programId: string, activeOnly = true) {
  if (activeOnly) {
    return query("SELECT * FROM program_helpers WHERE program_id = ? AND active = 1 ORDER BY added_at ASC").all(
      programId,
    );
  }
  return query("SELECT * FROM program_helpers WHERE program_id = ? ORDER BY added_at ASC").all(programId);
}

function isHelper(programId: string, userId: string) {
  if (!programId || !userId) return false;
  return !!query("SELECT 1 FROM program_helpers WHERE program_id = ? AND user_id = ? AND active = 1").get(
    programId,
    userId,
  );
}

function recordAnsweredThread({ question, channel, threadTs }: Record<string, unknown>) {
  if (!question || !channel || !threadTs) return;
  const cleanQ = String(question).trim();
  if (!cleanQ) return;
  try {
    query("INSERT INTO answered_threads (question, channel, thread_ts, created_at) VALUES (?, ?, ?, ?)").run(
      cleanQ,
      channel,
      threadTs,
      now(),
    );
  } catch (err: unknown) {
    log.debug("db", `recordAnsweredThread failed: ${errorMessage(err)}`);
  }
}

function getRecentAnsweredThreads(limit = 100) {
  try {
    return query(
      "SELECT id, question, channel, thread_ts, created_at FROM answered_threads ORDER BY created_at DESC LIMIT ?",
    ).all(limit);
  } catch (err: unknown) {
    log.debug("db", `getRecentAnsweredThreads failed: ${errorMessage(err)}`);
    return [];
  }
}

function getLearnedFactsWithThreads(limit = 100) {
  try {
    return query(
      "SELECT id, question, channel, source_ts FROM learned_facts WHERE source_ts IS NOT NULL AND channel IS NOT NULL ORDER BY created_at DESC LIMIT ?",
    ).all(limit);
  } catch (err: unknown) {
    log.debug("db", `getLearnedFactsWithThreads failed: ${errorMessage(err)}`);
    return [];
  }
}

export = {
  open,
  close,
  ensureSchema,
  now,
  handle,
  sweep,
  recordAnsweredThread,
  getRecentAnsweredThreads,
  getLearnedFactsWithThreads,
  startSweeper,
  claimMessage,
  wasAnswered,
  touchThread,
  getThread,
  addThreadMessage,
  getThreadMessages,
  recordUserMessage,
  recentUserMessages,
  recordUserTopic,
  userTopics,
  recordTopic,
  getTopics,
  recordGap,
  recordGapRejection,
  clearGapRejection,
  topGaps,
  unclassifiedGaps,
  setGapKind,
  gapCountsByKind,
  gapForThread,
  gapThreads,
  addLearnedFact,
  listLearnedFacts,
  listReviewableLearnedFacts,
  learnedFactsForOverlap,
  learnedFactForTicket,
  refreshLearnedFact,
  supersedeLearnedFact,
  getLearnedFactById,
  approvedFacts,
  setLearnedStatus,
  updateLearnedFact,
  candidateForTicket,
  deleteLearnedFact,
  deleteLearnedByStatus,
  deleteLearnedRange,
  pendingCountForQuestion,
  hasCapturedSource,
  recordFeedback,
  removeFeedback,
  feedbackTotals,
  muteThread,
  isThreadMuted,
  unmuteThread,
  markTakeover,
  isTakeover,
  clearTakeover,
  recordMetric,
  recordLlmUsage,
  llmUsageSummary,
  llmUsageReport,
  metricCounts,
  lastMetricAt,
  metricDetails,
  medianLatency,
  countRecentRequests,
  recordRequest,
  getDbPrograms,
  saveSourceText,
  loadSourceText,
  recordSourceFailure,
  getSourceHealth,
  saveProgram,
  deleteProgram,
  createTicket,
  getTicket,
  getTicketByThreadTs,
  getTicketByChannelThreadTs,
  enrichTicket,
  updateTicketCardTs,
  updatePublicAckTs,
  claimTicket,
  assignTicket,
  unclaimTicket,
  resolveTicket,
  reopenTicket,
  reopenResolvedTicket,
  closeTicket,
  snoozeTicket,
  markDuplicateTicket,
  escalateTicketStatus,
  markTicketWaitingForHelper,
  setTicketTriage,
  setResolutionSummary,
  getResolutionSummary,
  recordFirstResponse,
  getTicketsForProgram,
  searchTickets,
  claimProgramChannel,
  releaseProgramChannel,
  getChannelOwner,
  listProgramChannels,
  listChannelClaims,
  setHelperPingEligible,
  assignUnownedLearnedFacts,
  addTicketEvent,
  listTicketEvents,
  getHistoryImportProgress,
  upsertHistoryImportProgress,
  addTicketNote,
  listTicketNotes,
  recordAuditEvent,
  listAuditEvents,
  syncHelper,
  removeHelper,
  listHelpers,
  isHelper,
  MAX_THREAD_MESSAGES,
  MAX_USER_TOPICS,
  MAX_USER_MESSAGES,
  CACHE_FRESH_MS,
  CACHE_IDLE_MS,
};
