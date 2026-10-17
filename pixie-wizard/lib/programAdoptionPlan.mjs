const SLACK_USER = /^[UW][A-Z0-9]{6,20}$/;
const SLACK_CHANNEL = /^[CG][A-Z0-9]{8,14}$/;
const ROLES = new Set(["helper", "organizer", "owner"]);
const SOURCES = new Set(["creator", "organizer_channel", "usergroup", "manual"]);
const LIFECYCLES = new Set(["draft", "testing", "approved", "active", "paused", "archived"]);

function text(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function channelClaims(core) {
  const claims = new Map();
  const add = (id, kind) => {
    if (!id || !SLACK_CHANNEL.test(id) || claims.has(id)) return;
    claims.set(id, kind);
  };
  add(core.helpChannel, "help");
  add(core.organizerChannel, "organizer");
  for (const id of core.channels || []) add(id, "discussion");
  return [...claims].map(([channel_id, kind]) => ({ channel_id, kind }));
}

export function buildAdoptionPlan(core, helpers, options = {}) {
  const blockers = [];
  const warnings = [];
  const id = text(core?.id, 80);
  if (!id) blockers.push("Core program has no id");
  const workspaceId = text(options.workspaceId || core?.workspaceId, 80);
  if (!workspaceId) blockers.push("no workspace id: pass --workspace or set the program's workspace in Core");
  const ownerHcaId = text(options.ownerHcaId, 120);
  if (!ownerHcaId) blockers.push("no owner: pass --owner-hca <Hack Club Auth id> (never stored in the repo)");

  const cleanHelpers = [];
  const seen = new Set();
  for (const row of helpers || []) {
    const slack = text(row.user_id || row.slack_user_id, 40);
    if (!SLACK_USER.test(slack) || seen.has(slack)) continue;
    if (row.active === 0 || row.active === false) continue;
    seen.add(slack);
    cleanHelpers.push({
      slack_user_id: slack,
      role: ROLES.has(row.role) ? row.role : "helper",
      helper_source: SOURCES.has(row.helper_source) ? row.helper_source : "manual",
      eligible_for_pings: row.ping_eligible === 0 || row.ping_eligible === false ? false : true,
    });
  }
  const ownerSlack = text(options.ownerSlackId, 40) || cleanHelpers.find((helper) => helper.role === "owner")?.slack_user_id || null;
  if (options.ownerSlackId && !SLACK_USER.test(options.ownerSlackId)) blockers.push("--owner-slack is not a Slack user id");
  if (ownerSlack && !seen.has(ownerSlack)) {
    cleanHelpers.push({ slack_user_id: ownerSlack, role: "owner", helper_source: "creator", eligible_for_pings: true });
  }
  if (!cleanHelpers.some((helper) => helper.role === "owner" || helper.role === "organizer")) {
    warnings.push("no owner or organizer helper found; run program-restore-helpers first or pass --owner-slack");
  }

  const channels = channelClaims(core || {});
  if (!channels.some((channel) => channel.kind === "help")) {
    warnings.push("no help channel is mapped in Core: this program cannot be activated until one is");
  }
  if (core?.ticketsEnabled !== false && !channels.some((channel) => channel.kind === "organizer")) {
    warnings.push("tickets are enabled but no organizer channel is mapped: activation will be blocked");
  }

  const lifecycle = LIFECYCLES.has(core?.lifecycle) ? core.lifecycle : "draft";
  const settings = {};
  if (core?.helperPing === true) settings.helperPing = true;
  if (core?.autoAssign === true) settings.autoAssign = true;
  if (core?.sharedSources === false) settings.sharedSources = false;
  if (core?.ticketVisibility) settings.ticketVisibility = core.ticketVisibility;

  return {
    blockers,
    warnings,
    program: {
      id,
      workspace_id: workspaceId,
      program_name: text(core?.name, 120),
      support_name: text(core?.supportName, 120) || null,
      icon_url: text(core?.iconUrl, 500) || null,
      reply_signature: text(core?.replySignature, 200) || null,
      owner_hca_id: ownerHcaId,
      owner_slack_id: ownerSlack,
      lifecycle,
      ai_answers: core?.aiAnswers !== false,
      tickets_enabled: core?.ticketsEnabled !== false,
      auto_escalate: core?.autoEscalate !== false,
      posture: ["active", "passive", "muted"].includes(core?.posture) ? core.posture : "active",
      scope: core?.scope === "any" ? "any" : "program",
      incident_mode: ["ANSWER_ONLY", "ANSWER_AND_TRACK", "NORMAL_TICKET"].includes(core?.incidentMode) ? core.incidentMode : "ANSWER_AND_TRACK",
      public_tickets_enabled: core?.publicTicketsEnabled !== false,
      sensitive_categories: Array.isArray(core?.sensitiveCategories) ? core.sensitiveCategories : [],
      sources: Array.isArray(core?.sources) ? core.sources.filter((source) => !("docId" in source)) : [],
      milestones: Array.isArray(core?.milestones) ? core.milestones : [],
      settings,
    },
    channels,
    helpers: cleanHelpers,
  };
}

export async function applyAdoptionPlan(client, plan) {
  const p = plan.program;
  const existing = (await client.query("select workspace_id, owner_hca_id from hosted_programs where id = $1", [p.id])).rows[0];
  if (existing && existing.workspace_id !== p.workspace_id) throw new Error(`${p.id} already exists in workspace ${existing.workspace_id}`);
  const conflicts = (
    await client.query(
      "select channel_id, program_id from hosted_program_channels where workspace_id = $1 and channel_id = any($2) and program_id <> $3",
      [p.workspace_id, plan.channels.map((channel) => channel.channel_id), p.id],
    )
  ).rows;
  if (conflicts.length) throw new Error(`channels already claimed by another program: ${conflicts.map((row) => `${row.channel_id}->${row.program_id}`).join(", ")}`);
  await client.query(
    `insert into hosted_programs (id, workspace_id, program_name, support_name, icon_url, reply_signature, owner_hca_id, owner_slack_id, deployment_mode, status,
       lifecycle, ai_answers, tickets_enabled, auto_escalate, posture, scope, incident_mode, public_tickets_enabled, sensitive_categories, sources, milestones, settings,
       core_sync_state, core_synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'hosted_shared','active',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'synced',now())
     on conflict (id) do update set program_name = excluded.program_name, support_name = excluded.support_name, icon_url = excluded.icon_url,
       reply_signature = excluded.reply_signature, owner_slack_id = coalesce(hosted_programs.owner_slack_id, excluded.owner_slack_id),
       lifecycle = excluded.lifecycle, ai_answers = excluded.ai_answers, tickets_enabled = excluded.tickets_enabled, auto_escalate = excluded.auto_escalate,
       posture = excluded.posture, scope = excluded.scope, incident_mode = excluded.incident_mode, public_tickets_enabled = excluded.public_tickets_enabled,
       sensitive_categories = excluded.sensitive_categories, sources = excluded.sources, milestones = excluded.milestones, settings = excluded.settings,
       core_sync_state = 'synced', core_sync_error = null, core_synced_at = now(), updated_at = now()`,
    [
      p.id, p.workspace_id, p.program_name, p.support_name, p.icon_url, p.reply_signature, p.owner_hca_id, p.owner_slack_id, p.lifecycle,
      p.ai_answers, p.tickets_enabled, p.auto_escalate, p.posture, p.scope, p.incident_mode, p.public_tickets_enabled,
      JSON.stringify(p.sensitive_categories), JSON.stringify(p.sources), JSON.stringify(p.milestones), JSON.stringify(p.settings),
    ],
  );
  for (const channel of plan.channels) {
    await client.query(
      `insert into hosted_program_channels (workspace_id, channel_id, program_id, kind, claimed_by_hca_id) values ($1,$2,$3,$4,$5)
       on conflict (workspace_id, channel_id) do update set kind = excluded.kind where hosted_program_channels.program_id = excluded.program_id`,
      [p.workspace_id, channel.channel_id, p.id, channel.kind, p.owner_hca_id],
    );
  }
  for (const helper of plan.helpers) {
    await client.query(
      `insert into hosted_program_helpers (program_id, slack_user_id, role, helper_source, active) values ($1,$2,$3,$4,true)
       on conflict (program_id, slack_user_id) do update set role = excluded.role, helper_source = excluded.helper_source, active = true, removed_at = null`,
      [p.id, helper.slack_user_id, helper.role, helper.helper_source],
    );
  }
  await client.query(
    "insert into hosted_audit_events (program_id, actor_hca_id, action, entity_type, entity_id, metadata) values ($1,$2,'program.adopted','program',$1,$3)",
    [p.id, p.owner_hca_id, JSON.stringify({ channels: plan.channels.length, helpers: plan.helpers.length, lifecycle: p.lifecycle })],
  );
}
