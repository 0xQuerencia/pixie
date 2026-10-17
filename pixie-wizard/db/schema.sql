-- Pixie Wizard control-plane schema — plain PostgreSQL (Railway), no
-- Supabase-specific features. Consolidated from the old Supabase migrations
-- 002 (hosted_programs) and 005 (program_description); migrations 001/003
-- (pixie_trials, railway_account_pool) are dropped entirely — they backed
-- the legacy dedicated/self-host trial flow, which has been removed from
-- the app. Migration 004's RLS-deny-by-default is not carried forward: this
-- database has no PostgREST/anon/authenticated layer any more, only one
-- full-access application role connecting over Railway's private network,
-- so a table-owner role would bypass RLS anyway — real tenant isolation
-- lives in the application code's WHERE clauses and ownership checks
-- (lib/hostedPrograms.ts, lib/programClaim.ts, app/wizard/hostedActions.ts),
-- not in database policies. Every statement is idempotent.

create extension if not exists pgcrypto;

create table if not exists hosted_programs (
  id text primary key,
  workspace_id text not null default 'default',
  program_name text not null,
  program_description text,
  support_name text,
  icon_url text,
  reply_signature text,
  owner_hca_id text not null,
  owner_slack_id text,
  deployment_mode text not null default 'hosted_shared'
    check (deployment_mode = 'hosted_shared'),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'archived')),
  lifecycle text not null default 'draft'
    check (lifecycle in ('draft', 'testing', 'approved', 'active', 'paused', 'archived')),
  ai_answers boolean not null default true,
  tickets_enabled boolean not null default true,
  auto_escalate boolean not null default true,
  posture text not null default 'active'
    check (posture in ('active', 'passive', 'muted')),
  scope text not null default 'program'
    check (scope in ('any', 'program')),
  sensitive_categories jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  guides jsonb not null default '[]'::jsonb,
  milestones jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  core_sync_state text not null default 'pending'
    check (core_sync_state in ('pending', 'synced', 'failed')),
  core_sync_error text,
  core_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One owner row per workspace+slug is enough to make double-submit Activate
-- collapse instead of duplicating; the partial index keeps archived slugs
-- reusable without letting two live programs share one.
create unique index if not exists hosted_programs_live_slug_unique
  on hosted_programs (workspace_id, id)
  where status = 'active';

create index if not exists hosted_programs_owner_idx
  on hosted_programs (owner_hca_id, status);

-- How an ACTIVE Core incident affects a new matching question — mirrors
-- Core's programs.incident_mode (lib/schema.js). Added after the table
-- already existed in deployed databases; see the visible_on_profile
-- pattern above for why this is a separate alter, not part of the create.
alter table hosted_programs add column if not exists incident_mode text not null default 'ANSWER_AND_TRACK'
  check (incident_mode in ('ANSWER_ONLY', 'ANSWER_AND_TRACK', 'NORMAL_TICKET'));

alter table hosted_programs add column if not exists lifecycle text not null default 'draft'
  check (lifecycle in ('draft', 'testing', 'approved', 'active', 'paused', 'archived'));


-- Mirrors Core's programs.public_tickets_enabled (lib/schema.js): an
-- independent kill switch for auto-opening tickets from this program's
-- public help channel, toggleable here or live via /pixie-program tickets
-- on|off run in that channel.
alter table hosted_programs add column if not exists public_tickets_enabled boolean not null default true;

alter table hosted_programs add column if not exists reply_signature text;

-- Explicit channel claims. The unique (workspace, channel) primary key is
-- the atomic anti-hijack guard: claiming an owned channel fails the insert,
-- and the claimant learns the owning program instead of stealing the channel.
create table if not exists hosted_program_channels (
  workspace_id text not null,
  channel_id text not null,
  program_id text not null references hosted_programs(id) on delete cascade,
  kind text not null default 'help'
    check (kind in ('help', 'organizer', 'discussion', 'announcement')),
  claimed_by_hca_id text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, channel_id)
);

create index if not exists hosted_program_channels_program_idx
  on hosted_program_channels (program_id);

-- Helper membership with provenance. Reconciliation removes as well as adds;
-- active=false with removed_at marks a departure without deleting history.
create table if not exists hosted_program_helpers (
  program_id text not null references hosted_programs(id) on delete cascade,
  slack_user_id text not null,
  helper_source text not null default 'manual'
    check (helper_source in ('creator', 'organizer_channel', 'usergroup', 'manual')),
  role text not null default 'helper'
    check (role in ('helper', 'organizer', 'owner')),
  active boolean not null default true,
  -- Lets an owner hide an individual helper from the public program profile
  -- roster without touching their actual permissions — a display choice,
  -- not an authorization one.
  visible_on_profile boolean not null default true,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (program_id, slack_user_id)
);

-- CREATE TABLE IF NOT EXISTS above is a no-op against a database that
-- already has this table from before visible_on_profile existed — this is
-- the statement that actually adds it to an existing deployment.
alter table hosted_program_helpers add column if not exists visible_on_profile boolean not null default true;

-- Append-only audit. No update/delete path; retention archives, never rewrites.
create table if not exists hosted_audit_events (
  id uuid primary key default gen_random_uuid(),
  program_id text references hosted_programs(id) on delete set null,
  actor_hca_id text,
  actor_slack_id text,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hosted_audit_events_program_idx
  on hosted_audit_events (program_id, created_at desc);

-- Stable identities known to the control plane. Program membership remains in
-- hosted_program_helpers; this table is only the directory identity anchor.
create table if not exists wizard_people (
  hca_id text primary key,
  email text not null,
  display_name text not null,
  slack_user_id text,
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  added_by_hca_id text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wizard_people_email_idx on wizard_people (lower(email));
create unique index if not exists wizard_people_slack_idx on wizard_people (slack_user_id) where slack_user_id is not null;

-- Workspace billing entitlement. Runtime usage remains owned by Core; this
-- table only records the Wizard's tenant-scoped entitlement and limits.
create table if not exists wizard_entitlements (
  program_id text not null references hosted_programs(id) on delete cascade,
  workspace_id text not null,
  plan text not null check (plan in ('starter', 'growth', 'scale')),
  status text not null default 'active' check (status in ('active', 'past_due', 'suspended')),
  included_cents integer not null check (included_cents >= 0),
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (program_id, effective_from),
  check (effective_until is null or effective_until > effective_from)
);

create index if not exists wizard_entitlements_program_effective_idx
  on wizard_entitlements (program_id, effective_from desc);

create table if not exists wizard_global_access (
  hca_id text primary key references wizard_people(hca_id) on delete cascade,
  role text not null check (role in ('superadmin')),
  granted_by_hca_id text,
  granted_at timestamptz not null default now()
);

-- Mirrors migrations 003/004 so fresh databases (and the in-memory pools used
-- locally and in tests) have the same columns as migrated deployments.
alter table hosted_programs add column if not exists behavior jsonb not null default '{}'::jsonb;
alter table hosted_programs add column if not exists runtime_status text not null default 'sandbox'
  check (runtime_status in ('sandbox', 'live', 'paused'));

alter table hosted_program_helpers add column if not exists eligible_for_pings boolean not null default true;
