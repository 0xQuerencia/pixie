// Migration ordering

const SCHEMA = `
-- Base tables are created before migrations add hosted and tenant-scoped columns.
CREATE TABLE IF NOT EXISTS answered_messages (
  ts          TEXT PRIMARY KEY,
  channel     TEXT,
  answered_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_ts  TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  user_id    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_ts, id);

-- Marks a thread as one pixie has spoken in, so thread replies can be gated
-- without an intent call. Also carries the "seeded real Slack history" flag.
CREATE TABLE IF NOT EXISTS threads (
  thread_ts   TEXT PRIMARY KEY,
  channel     TEXT,
  seeded      INTEGER NOT NULL DEFAULT 0,
  pixie_spoke INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Bounded, program-and-user scoped conversation context. These rows are never
-- part of retrieval or the trusted knowledge corpus.
CREATE TABLE IF NOT EXISTS support_memory (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  value             TEXT NOT NULL,
  normalized_value  TEXT NOT NULL,
  source_thread_ts  TEXT,
  source_ticket_id  INTEGER,
  confidence        REAL NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_memory_scope
  ON support_memory(program_id, user_id, expires_at DESC, created_at DESC);

-- The last handful of things each person said, verbatim. The intent gate reads
-- these: "it still doesnt work" is chat after a joke and a cry for help after
-- twenty minutes of debugging, and the message alone cannot tell you which.
-- Swept aggressively — this is short-term context, not history.
CREATE TABLE IF NOT EXISTS user_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  channel    TEXT,
  thread_ts  TEXT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_messages_user ON user_messages(user_id, id DESC);

CREATE TABLE IF NOT EXISTS user_topics (
  user_id     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  program_id  TEXT,
  was_helpful INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic, program_id)
);

CREATE TABLE IF NOT EXISTS schema_data_migrations (
  version    TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS answer_cache (
  question_hash TEXT PRIMARY KEY,
  program_id    TEXT,
  question      TEXT NOT NULL,
  source        TEXT,
  answer        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  message_ts TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  vote       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_ts, user_id)
);

-- Questions that got no grounded answer. This is the docs to-do list, and the
-- anchor for auto-capture: message_ts lets a later human reply in the same
-- thread be matched back to the question pixie missed.
CREATE TABLE IF NOT EXISTS doc_gaps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  user_id    TEXT,
  channel    TEXT,
  message_ts TEXT,
  created_at INTEGER NOT NULL
);
-- NOTE: the index on message_ts lives in POST_MIGRATION_SCHEMA, not here — on a
-- database created before that column existed, this block runs before the
-- migration adds it, and indexing a missing column aborts the whole schema.

-- Answers pixie was taught, or captured from a helper replying to a question
-- it missed. Approved rows are appended to the corpus, so this is the one
-- table whose contents change what pixie says.
CREATE TABLE IF NOT EXISTS learned_facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  author_id  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  source_ts  TEXT,
  channel    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learned_status ON learned_facts(status, created_at);
-- One capture per source message, so a chatty thread can't queue five
-- near-identical pending rows off the same question.
CREATE UNIQUE INDEX IF NOT EXISTS idx_learned_source ON learned_facts(source_ts) WHERE source_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS active_guides (
  thread_ts    TEXT PRIMARY KEY,
  guide_id     TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  user_id      TEXT,
  started_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS muted_threads (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  thread_ts    TEXT PRIMARY KEY,
  channel      TEXT,
  muted_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_kind ON metrics(kind, created_at);

-- Metadata-only model usage. Never add prompts, completions, or message text to
-- this table: it is deliberately safe to expose as an aggregate to the admin UI.
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  provider TEXT,
  program_id TEXT,
  channel TEXT,
  request_id TEXT,
  event_id TEXT,
  model TEXT,
  status TEXT NOT NULL,
  result TEXT,
  http_status INTEGER,
  rate_limited INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  cached_prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  error_kind TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_group ON llm_usage(operation, program_id, channel, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_user ON rate_limits(user_id, created_at);

CREATE TABLE IF NOT EXISTS source_cache (
  name       TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS programs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  posture      TEXT DEFAULT 'active',
  scope        TEXT DEFAULT 'any',
  help_channel TEXT,
  channels     TEXT,
  helper_group TEXT,
  sources      TEXT,
  milestones   TEXT,
  guides       TEXT,
  links        TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_source_cache (
  draft_program_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (draft_program_id, source_key)
);

CREATE TABLE IF NOT EXISTS tickets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id   TEXT NOT NULL,
  channel      TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  card_ts      TEXT,
  requester_id TEXT NOT NULL,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  assignee_id  TEXT,
  resolution   TEXT,
  created_at   INTEGER NOT NULL,
  claimed_at   INTEGER,
  resolved_at  INTEGER
);

CREATE TABLE IF NOT EXISTS answered_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Structured operational traces used by the Wizard inspector. Payloads are
-- sanitized before insertion and expire independently of ticket history.
CREATE TABLE IF NOT EXISTS answer_traces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id    TEXT NOT NULL,
  ticket_id     INTEGER,
  thread_ts     TEXT,
  request_id    TEXT,
  stage         TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_traces_ticket
  ON answer_traces(program_id, ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_answer_traces_thread
  ON answer_traces(program_id, thread_ts, created_at ASC);
`;

const MIGRATIONS = [
  ["doc_gaps", "message_ts", "ALTER TABLE doc_gaps ADD COLUMN message_ts TEXT"],

  [
    "answered_messages",
    "workspace_id",
    "ALTER TABLE answered_messages ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'",
  ],
  ["answered_messages", "channel", "ALTER TABLE answered_messages ADD COLUMN channel TEXT NOT NULL DEFAULT ''"],

  ["support_memory", "normalized_value", "ALTER TABLE support_memory ADD COLUMN normalized_value TEXT"],
  ["support_memory", "updated_at", "ALTER TABLE support_memory ADD COLUMN updated_at INTEGER"],

  ["answer_cache", "ask_count", "ALTER TABLE answer_cache ADD COLUMN ask_count INTEGER NOT NULL DEFAULT 1"],
  ["answer_cache", "program_id", "ALTER TABLE answer_cache ADD COLUMN program_id TEXT"],
  ["answer_cache", "last_asked_at", "ALTER TABLE answer_cache ADD COLUMN last_asked_at INTEGER"],
  ["answer_cache", "refreshed_at", "ALTER TABLE answer_cache ADD COLUMN refreshed_at INTEGER"],

  ["doc_gaps", "kind", "ALTER TABLE doc_gaps ADD COLUMN kind TEXT"],
  ["metrics", "detail", "ALTER TABLE metrics ADD COLUMN detail TEXT"],

  ["active_guides", "message_ts", "ALTER TABLE active_guides ADD COLUMN message_ts TEXT"],

  ["programs", "scope", "ALTER TABLE programs ADD COLUMN scope TEXT DEFAULT 'any'"],
  ["learned_facts", "program_id", "ALTER TABLE learned_facts ADD COLUMN program_id TEXT"],
  ["doc_gaps", "program_id", "ALTER TABLE doc_gaps ADD COLUMN program_id TEXT"],
  ["user_topics", "program_id", "ALTER TABLE user_topics ADD COLUMN program_id TEXT"],

  [
    "gap_rejections",
    "table",
    "CREATE TABLE IF NOT EXISTS gap_rejections (question TEXT NOT NULL PRIMARY KEY, created_at INTEGER NOT NULL)",
  ],
  [
    "answered_threads",
    "table",
    "CREATE TABLE IF NOT EXISTS answered_threads (id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, created_at INTEGER NOT NULL)",
  ],

  ["programs", "workspace_id", "ALTER TABLE programs ADD COLUMN workspace_id TEXT"],
  ["programs", "deployment_mode", "ALTER TABLE programs ADD COLUMN deployment_mode TEXT DEFAULT 'dedicated_legacy'"],
  ["programs", "support_name", "ALTER TABLE programs ADD COLUMN support_name TEXT"],
  ["programs", "icon_url", "ALTER TABLE programs ADD COLUMN icon_url TEXT"],

  ["programs", "reply_signature", "ALTER TABLE programs ADD COLUMN reply_signature TEXT"],
  ["programs", "ai_answers", "ALTER TABLE programs ADD COLUMN ai_answers INTEGER NOT NULL DEFAULT 1"],
  ["programs", "tickets_enabled", "ALTER TABLE programs ADD COLUMN tickets_enabled INTEGER NOT NULL DEFAULT 1"],
  ["programs", "auto_escalate", "ALTER TABLE programs ADD COLUMN auto_escalate INTEGER NOT NULL DEFAULT 1"],
  ["programs", "sensitive_categories", "ALTER TABLE programs ADD COLUMN sensitive_categories TEXT"],
  ["programs", "support_active", "ALTER TABLE programs ADD COLUMN support_active INTEGER NOT NULL DEFAULT 1"],
  ["programs", "created_at", "ALTER TABLE programs ADD COLUMN created_at INTEGER"],

  [
    "program_channels",
    "table",
    "CREATE TABLE IF NOT EXISTS program_channels (workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, program_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'help', claimed_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, channel_id))",
  ],
  ["tickets", "workspace_id", "ALTER TABLE tickets ADD COLUMN workspace_id TEXT"],
  ["tickets", "category", "ALTER TABLE tickets ADD COLUMN category TEXT"],
  ["tickets", "category_source", "ALTER TABLE tickets ADD COLUMN category_source TEXT"],
  ["tickets", "priority", "ALTER TABLE tickets ADD COLUMN priority TEXT"],
  ["tickets", "summary", "ALTER TABLE tickets ADD COLUMN summary TEXT"],
  ["tickets", "resolution_summary", "ALTER TABLE tickets ADD COLUMN resolution_summary TEXT"],
  ["tickets", "resolution_summary_at", "ALTER TABLE tickets ADD COLUMN resolution_summary_at INTEGER"],
  ["tickets", "ai_confidence", "ALTER TABLE tickets ADD COLUMN ai_confidence REAL"],
  ["tickets", "ai_decision", "ALTER TABLE tickets ADD COLUMN ai_decision TEXT"],
  ["tickets", "duplicate_of", "ALTER TABLE tickets ADD COLUMN duplicate_of INTEGER"],
  ["tickets", "first_response_at", "ALTER TABLE tickets ADD COLUMN first_response_at INTEGER"],
  ["tickets", "first_human_response_at", "ALTER TABLE tickets ADD COLUMN first_human_response_at INTEGER"],
  ["tickets", "visibility", "ALTER TABLE tickets ADD COLUMN visibility TEXT"],
  ["tickets", "assigned_at", "ALTER TABLE tickets ADD COLUMN assigned_at INTEGER"],
  ["tickets", "reopened_at", "ALTER TABLE tickets ADD COLUMN reopened_at INTEGER"],
  ["tickets", "reopen_count", "ALTER TABLE tickets ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0"],
  ["tickets", "snoozed_until", "ALTER TABLE tickets ADD COLUMN snoozed_until INTEGER"],
  ["tickets", "updated_at", "ALTER TABLE tickets ADD COLUMN updated_at INTEGER"],

  [
    "ticket_events",
    "table",
    "CREATE TABLE IF NOT EXISTS ticket_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, actor_id TEXT, event_type TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)",
  ],
  [
    "ticket_notes",
    "table",
    "CREATE TABLE IF NOT EXISTS ticket_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, author_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)",
  ],

  [
    "audit_events",
    "table",
    "CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, metadata TEXT, created_at INTEGER NOT NULL)",
  ],

  [
    "program_helpers",
    "table",
    "CREATE TABLE IF NOT EXISTS program_helpers (program_id TEXT NOT NULL, user_id TEXT NOT NULL, helper_source TEXT NOT NULL DEFAULT 'manual', role TEXT NOT NULL DEFAULT 'helper', active INTEGER NOT NULL DEFAULT 1, added_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY (program_id, user_id))",
  ],

  ["learned_facts", "category", "ALTER TABLE learned_facts ADD COLUMN category TEXT"],
  ["learned_facts", "ticket_id", "ALTER TABLE learned_facts ADD COLUMN ticket_id INTEGER"],
  ["learned_facts", "resolver_id", "ALTER TABLE learned_facts ADD COLUMN resolver_id TEXT"],
  ["learned_facts", "verified_at", "ALTER TABLE learned_facts ADD COLUMN verified_at INTEGER"],
  ["learned_facts", "superseded_by", "ALTER TABLE learned_facts ADD COLUMN superseded_by INTEGER"],
  ["learned_facts", "superseded_at", "ALTER TABLE learned_facts ADD COLUMN superseded_at INTEGER"],
  ["learned_facts", "support_count", "ALTER TABLE learned_facts ADD COLUMN support_count INTEGER NOT NULL DEFAULT 1"],
  ["learned_facts", "last_supported_at", "ALTER TABLE learned_facts ADD COLUMN last_supported_at INTEGER"],
  ["learned_facts", "auto_learned", "ALTER TABLE learned_facts ADD COLUMN auto_learned INTEGER NOT NULL DEFAULT 0"],

  [
    "program_macros",
    "table",
    "CREATE TABLE IF NOT EXISTS program_macros (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, trigger TEXT NOT NULL, name TEXT NOT NULL, description TEXT, content TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, allowed_roles TEXT, on_send_transition TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (program_id, trigger))",
  ],

  [
    "helper_expertise",
    "table",
    "CREATE TABLE IF NOT EXISTS helper_expertise (program_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL, solved_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (program_id, user_id, tag))",
  ],
  ["programs", "auto_assign", "ALTER TABLE programs ADD COLUMN auto_assign INTEGER NOT NULL DEFAULT 0"],
  ["programs", "shadow_mode", "ALTER TABLE programs ADD COLUMN shadow_mode INTEGER NOT NULL DEFAULT 0"],

  [
    "program_incidents",
    "table",
    "CREATE TABLE IF NOT EXISTS program_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate', reason TEXT, confidence REAL, started_at INTEGER NOT NULL, created_at INTEGER NOT NULL, confirmed_at INTEGER, resolved_at INTEGER)",
  ],
  [
    "incident_tickets",
    "table",
    "CREATE TABLE IF NOT EXISTS incident_tickets (incident_id INTEGER NOT NULL, ticket_id INTEGER NOT NULL, program_id TEXT NOT NULL, linked_at INTEGER NOT NULL, PRIMARY KEY (incident_id, ticket_id))",
  ],

  ["programs", "sla_unassigned_ms", "ALTER TABLE programs ADD COLUMN sla_unassigned_ms INTEGER"],
  ["programs", "sla_assigned_ms", "ALTER TABLE programs ADD COLUMN sla_assigned_ms INTEGER"],
  ["programs", "sla_waiting_ms", "ALTER TABLE programs ADD COLUMN sla_waiting_ms INTEGER"],
  ["programs", "sla_target_ms", "ALTER TABLE programs ADD COLUMN sla_target_ms INTEGER"],
  ["programs", "sla_notify_channel", "ALTER TABLE programs ADD COLUMN sla_notify_channel TEXT"],

  ["programs", "retention_context_days", "ALTER TABLE programs ADD COLUMN retention_context_days INTEGER"],
  ["programs", "retention_tickets_days", "ALTER TABLE programs ADD COLUMN retention_tickets_days INTEGER"],
  ["programs", "retention_notes_days", "ALTER TABLE programs ADD COLUMN retention_notes_days INTEGER"],
  ["programs", "retention_traces_days", "ALTER TABLE programs ADD COLUMN retention_traces_days INTEGER"],
  ["programs", "retention_analytics_days", "ALTER TABLE programs ADD COLUMN retention_analytics_days INTEGER"],
  ["programs", "retention_audit_days", "ALTER TABLE programs ADD COLUMN retention_audit_days INTEGER"],

  ["metrics", "program_id", "ALTER TABLE metrics ADD COLUMN program_id TEXT"],

  [
    "job_leases",
    "table",
    "CREATE TABLE IF NOT EXISTS job_leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ],
  [
    "history_import_progress",
    "table",
    "CREATE TABLE IF NOT EXISTS history_import_progress (program_id TEXT NOT NULL, channel_id TEXT NOT NULL, cursor TEXT, newest_ts_done TEXT, status TEXT NOT NULL DEFAULT 'pending', messages_scanned INTEGER NOT NULL DEFAULT 0, tickets_created INTEGER NOT NULL DEFAULT 0, tickets_enriched INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, queued_for_judge INTEGER NOT NULL DEFAULT 0, last_error TEXT, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (program_id, channel_id))",
  ],
  [
    "history_import_progress",
    "rules_version",
    "ALTER TABLE history_import_progress ADD COLUMN rules_version INTEGER NOT NULL DEFAULT 1",
  ],

  [
    "thread_takeover",
    "table",
    "CREATE TABLE IF NOT EXISTS thread_takeover (workspace_id TEXT NOT NULL DEFAULT 'default', thread_ts TEXT PRIMARY KEY, channel TEXT, by_user TEXT, created_at INTEGER NOT NULL)",
  ],
  ["threads", "workspace_id", "ALTER TABLE threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'"],
  [
    "muted_threads",
    "workspace_id",
    "ALTER TABLE muted_threads ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'",
  ],
  [
    "thread_takeover",
    "workspace_id",
    "ALTER TABLE thread_takeover ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'",
  ],
  [
    "sla_notifications",
    "table",
    "CREATE TABLE IF NOT EXISTS sla_notifications (program_id TEXT NOT NULL, ticket_id INTEGER NOT NULL, rule TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (program_id, ticket_id, rule))",
  ],

  [
    "radar_signals",
    "table",
    "CREATE TABLE IF NOT EXISTS radar_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', title TEXT NOT NULL, summary TEXT, evidence TEXT, fingerprint TEXT NOT NULL, first_detected_at INTEGER NOT NULL, last_detected_at INTEGER NOT NULL, acknowledged_at INTEGER, acknowledged_by TEXT, resolved_at INTEGER, suppressed_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  ],

  ["program_incidents", "description", "ALTER TABLE program_incidents ADD COLUMN description TEXT"],
  ["program_incidents", "declared_by", "ALTER TABLE program_incidents ADD COLUMN declared_by TEXT"],
  ["program_incidents", "public_message", "ALTER TABLE program_incidents ADD COLUMN public_message TEXT"],

  [
    "programs",
    "incident_mode",
    "ALTER TABLE programs ADD COLUMN incident_mode TEXT NOT NULL DEFAULT 'ANSWER_AND_TRACK'",
  ],

  [
    "incident_reports",
    "table",
    "CREATE TABLE IF NOT EXISTS incident_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER NOT NULL, program_id TEXT NOT NULL, ticket_id INTEGER, requester_id TEXT, channel TEXT NOT NULL, thread_ts TEXT NOT NULL, created_at INTEGER NOT NULL, notified_at INTEGER)",
  ],

  ["source_cache", "last_error", "ALTER TABLE source_cache ADD COLUMN last_error TEXT"],
  ["source_cache", "fail_count", "ALTER TABLE source_cache ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0"],
  ["source_cache", "last_success_at", "ALTER TABLE source_cache ADD COLUMN last_success_at INTEGER"],

  [
    "programs",
    "public_tickets_enabled",
    "ALTER TABLE programs ADD COLUMN public_tickets_enabled INTEGER NOT NULL DEFAULT 1",
  ],

  ["tickets", "public_ack_ts", "ALTER TABLE tickets ADD COLUMN public_ack_ts TEXT"],

  ["tickets", "resolved_by", "ALTER TABLE tickets ADD COLUMN resolved_by TEXT"],
  ["tickets", "resolved_credit_id", "ALTER TABLE tickets ADD COLUMN resolved_credit_id TEXT"],
  ["tickets", "reopened_by", "ALTER TABLE tickets ADD COLUMN reopened_by TEXT"],

  ["programs", "helper_offer_timeout_ms", "ALTER TABLE programs ADD COLUMN helper_offer_timeout_ms INTEGER"],
  ["llm_usage", "provider", "ALTER TABLE llm_usage ADD COLUMN provider TEXT"],
  ["llm_usage", "event_id", "ALTER TABLE llm_usage ADD COLUMN event_id TEXT"],
  ["llm_usage", "result", "ALTER TABLE llm_usage ADD COLUMN result TEXT"],
  ["llm_usage", "rate_limited", "ALTER TABLE llm_usage ADD COLUMN rate_limited INTEGER NOT NULL DEFAULT 0"],
  ["llm_usage", "latency_ms", "ALTER TABLE llm_usage ADD COLUMN latency_ms INTEGER"],
  ["llm_usage", "cached_prompt_tokens", "ALTER TABLE llm_usage ADD COLUMN cached_prompt_tokens INTEGER"],

  ["helper_expertise", "reply_count", "ALTER TABLE helper_expertise ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0"],

  ["programs", "helper_ping_enabled", "ALTER TABLE programs ADD COLUMN helper_ping_enabled INTEGER NOT NULL DEFAULT 0"],

  ["programs", "categories", "ALTER TABLE programs ADD COLUMN categories TEXT"],

  ["threads", "helper_pinged", "ALTER TABLE threads ADD COLUMN helper_pinged INTEGER NOT NULL DEFAULT 0"],

  ["programs", "ticket_visibility", "ALTER TABLE programs ADD COLUMN ticket_visibility TEXT"],

  ["programs", "behavior", "ALTER TABLE programs ADD COLUMN behavior TEXT"],
  ["programs", "status", "ALTER TABLE programs ADD COLUMN status TEXT"],
  ["programs", "learning", "ALTER TABLE programs ADD COLUMN learning TEXT NOT NULL DEFAULT 'auto'"],
  ["programs", "live_test", "ALTER TABLE programs ADD COLUMN live_test TEXT NOT NULL DEFAULT 'pending'"],
  ["programs", "live_test_note", "ALTER TABLE programs ADD COLUMN live_test_note TEXT"],

  [
    "program_helpers",
    "ping_eligible",
    "ALTER TABLE program_helpers ADD COLUMN ping_eligible INTEGER NOT NULL DEFAULT 1",
  ],
  [
    "ticket_metrics_migrations",
    "table",
    "CREATE TABLE IF NOT EXISTS ticket_metrics_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  ],

  [
    "programs",
    "lifecycle",
    "ALTER TABLE programs ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'draft'; UPDATE programs SET lifecycle = CASE status WHEN 'live' THEN 'active' WHEN 'sandbox' THEN 'draft' WHEN 'paused' THEN 'paused' ELSE lifecycle END WHERE status IS NOT NULL",
  ],
  [
    "program_source_state",
    "table",
    "CREATE TABLE IF NOT EXISTS program_source_state (program_id TEXT NOT NULL, source_key TEXT NOT NULL, text TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT NULL, PRIMARY KEY (program_id, source_key))",
  ],
  [
    "program_docs",
    "table",
    "CREATE TABLE IF NOT EXISTS program_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, section TEXT NOT NULL CHECK (section IN ('overview', 'eligibility', 'how_it_works', 'participation', 'submission', 'grants', 'review', 'rewards', 'deadlines', 'common_problems', 'faq', 'support')), title TEXT NOT NULL, body TEXT NOT NULL, trust TEXT NOT NULL CHECK (trust IN ('official', 'supporting')), origin TEXT NOT NULL CHECK (origin IN ('manual', 'url', 'github', 'slack')), source_ref TEXT NULL, active INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, supersedes_id INTEGER NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reviewed_by TEXT NULL, reviewed_at INTEGER NULL)",
  ],
  [
    "program_eval_cases",
    "table",
    "CREATE TABLE IF NOT EXISTS program_eval_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, expect TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('manual', 'archive')), active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)",
  ],
  [
    "program_eval_runs",
    "table",
    "CREATE TABLE IF NOT EXISTS program_eval_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, program_id TEXT NOT NULL, content_hash TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NULL, total INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')), results TEXT NOT NULL, triggered_by TEXT NULL)",
  ],
];

const POST_MIGRATION_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_doc_gaps_ts ON doc_gaps(message_ts);
CREATE INDEX IF NOT EXISTS idx_doc_gaps_kind ON doc_gaps(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_cache_idle ON answer_cache(last_asked_at);
CREATE INDEX IF NOT EXISTS idx_cache_popular ON answer_cache(ask_count DESC, refreshed_at);
CREATE INDEX IF NOT EXISTS idx_active_guides_message_ts ON active_guides(message_ts);
CREATE INDEX IF NOT EXISTS idx_learned_program ON learned_facts(program_id);
CREATE INDEX IF NOT EXISTS idx_doc_gaps_program ON doc_gaps(program_id);
CREATE INDEX IF NOT EXISTS idx_tickets_thread ON tickets(thread_ts);
CREATE INDEX IF NOT EXISTS idx_tickets_program_status ON tickets(program_id, status);
CREATE INDEX IF NOT EXISTS idx_answered_threads_ts ON answered_threads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answered_threads_channel ON answered_threads(channel, thread_ts);
CREATE INDEX IF NOT EXISTS idx_programs_workspace ON programs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_program_channels_program ON program_channels(program_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_workspace_thread ON tickets(workspace_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_tickets_program_assignee_status ON tickets(program_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_program_created ON tickets(program_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_program_resolved ON tickets(program_id, status, resolved_at);
CREATE INDEX IF NOT EXISTS idx_tickets_credit ON tickets(program_id, resolved_credit_id, status, resolved_at);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_program_created ON audit_events(program_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_helpers_program_active ON program_helpers(program_id, active);
CREATE INDEX IF NOT EXISTS idx_learned_ticket ON learned_facts(ticket_id);
CREATE INDEX IF NOT EXISTS idx_learned_category ON learned_facts(program_id, status, category);
CREATE INDEX IF NOT EXISTS idx_learned_overlap ON learned_facts(program_id, category, status, created_at);
CREATE INDEX IF NOT EXISTS idx_macros_program ON program_macros(program_id, enabled);
CREATE INDEX IF NOT EXISTS idx_expertise_program ON helper_expertise(program_id, tag);
CREATE INDEX IF NOT EXISTS idx_incidents_program_status ON program_incidents(program_id, status);
CREATE INDEX IF NOT EXISTS idx_incident_tickets_ticket ON incident_tickets(ticket_id);
CREATE INDEX IF NOT EXISTS idx_metrics_program ON metrics(program_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sla_notifications_program ON sla_notifications(program_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_program_type_fingerprint ON radar_signals(program_id, type, fingerprint);
CREATE INDEX IF NOT EXISTS idx_radar_program_status ON radar_signals(program_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_incident_reports_incident ON incident_reports(incident_id, notified_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_program_time ON llm_usage(program_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_request ON llm_usage(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_memory_expiry ON support_memory(expires_at);
UPDATE support_memory
   SET normalized_value = lower(trim(value))
 WHERE normalized_value IS NULL OR normalized_value = '';
UPDATE support_memory
   SET updated_at = created_at
 WHERE updated_at IS NULL;
DELETE FROM support_memory
 WHERE id NOT IN (
   SELECT MAX(id)
     FROM support_memory
    GROUP BY program_id, user_id, kind, normalized_value
 );
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_memory_logical_key
  ON support_memory(program_id, user_id, kind, normalized_value);
CREATE INDEX IF NOT EXISTS idx_answer_traces_expiry ON answer_traces(expires_at);
CREATE INDEX IF NOT EXISTS idx_program_docs_program_active ON program_docs(program_id, active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_docs_program_section ON program_docs(program_id, section, active);
CREATE INDEX IF NOT EXISTS idx_program_source_state_program ON program_source_state(program_id, source_key);
CREATE INDEX IF NOT EXISTS idx_program_eval_cases_program_active ON program_eval_cases(program_id, active, id);
CREATE INDEX IF NOT EXISTS idx_program_eval_runs_program_started ON program_eval_runs(program_id, started_at DESC);
`;

export = { SCHEMA, MIGRATIONS, POST_MIGRATION_SCHEMA };
