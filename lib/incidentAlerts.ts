// Organizer alerts for incident candidates
import db = require("./db");
import log = require("./log");
import maintenance = require("./maintenance");
import programs = require("./programs");
import channelPolicy = require("./channelPolicy");
import slackMessages = require("./slackMessages");
import incidents = require("./incidents");
import type { SlackClient } from "./types";

type Row = Record<string, any>;

const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 5 * 60 * 1000;
const CLAIM_TTL_MS = 5 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const UPDATE_MIN_GROWTH = 4;
const UPDATE_MIN_INTERVAL_MS = 30 * 60 * 1000;
const EXCERPT_MAX = 140;
const REF_SAMPLE = 8;

interface AlertOutcome {
  incidentId: number;
  result: "sent" | "skipped" | "failed" | "gave_up";
  kind?: "new" | "update";
  reason?: string;
}

// Untrusted ticket text must not ping anyone or leak contact details
function excerpt(text: unknown): string {
  const cleaned = String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    .replace(/@\w+/g, "")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_MAX);
  return cleaned.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function composeAlert(incident: Row, ticketIds: number[], kind: "new" | "update", requesters: number): string {
  const head =
    kind === "new"
      ? `:rotating_light: Possible incident for ${programs.get(incident.program_id)?.name || incident.program_id}`
      : `:information_source: Incident update (candidate #${incident.id})`;
  const refs = ticketIds
    .slice(0, REF_SAMPLE)
    .map((id) => `#${id}`)
    .join(", ");
  const more = ticketIds.length > REF_SAMPLE ? ` and ${ticketIds.length - REF_SAMPLE} more` : "";
  return [
    head,
    `Suspected issue (reported wording): "${excerpt(incident.title)}"`,
    `Evidence: ${ticketIds.length} distinct tickets from ${requesters} people (${refs}${more}). Pixie has not confirmed an outage.`,
    "Next step: check whether the service is actually affected, then confirm or dismiss the candidate in the Wizard incidents view. Pixie will not tell users about it until you confirm.",
  ].join("\n");
}

function noteBlocked(incident: Row, reason: string): void {
  if (incident.alert_error === reason) return;
  db.handle().query("UPDATE program_incidents SET alert_error = ? WHERE id = ?").run(reason, incident.id);
  incidents.recordIncidentAudit(incident, "incident.alert_skipped", null, { reason });
}

function destination(programId: string): { channel: string } | { reason: string } {
  const program = programs.get(programId);
  if (!program) return { reason: "unknown_program" };
  if (program.shadowMode === true) return { reason: "shadow_mode" };
  const channel = require("./tickets").getOrganizerChannel(program, program.workspaceId || null);
  if (!channel) return { reason: "no_organizer_channel" };
  const policy = channelPolicy.resolve(channel, program.workspaceId || null);
  if (policy.role !== "organizer" || policy.program?.id !== program.id) return { reason: "channel_not_organizer" };
  if (!policy.settings || (policy.settings as { enabled?: boolean }).enabled === false)
    return { reason: "program_inactive" };
  return { channel };
}

function claimable(incident: Row, now: number): boolean {
  return Number(incident.alert_claimed_at || 0) <= now - CLAIM_TTL_MS && Number(incident.alert_next_at || 0) <= now;
}

function dueKind(incident: Row, tickets: number, now: number): "new" | "update" | null {
  if (!claimable(incident, now)) return null;
  if (!incident.alerted_at) return now - Number(incident.created_at) > STALE_MS ? null : "new";
  return updateDue(incident, tickets, now) ? "update" : null;
}

function updateDue(incident: Row, tickets: number, now: number): boolean {
  if (now - Number(incident.alerted_at) < UPDATE_MIN_INTERVAL_MS) return false;
  return tickets >= Number(incident.alert_ticket_count || 0) + UPDATE_MIN_GROWTH;
}

function claim(incident: Row, now: number): boolean {
  return (
    db
      .handle()
      .query(
        "UPDATE program_incidents SET alert_claimed_at = ? WHERE id = ? AND (alert_claimed_at IS NULL OR alert_claimed_at <= ?)",
      )
      .run(now, incident.id, now - CLAIM_TTL_MS).changes > 0
  );
}

async function alertOne(client: SlackClient, incident: Row, now: number): Promise<AlertOutcome | null> {
  const programId = String(incident.program_id);
  const tickets = incidents.incidentTickets(Number(incident.id), programId) as Row[];
  const kind = dueKind(incident, tickets.length, now);
  if (!kind) return null;

  const dest = destination(programId);
  if ("reason" in dest) {
    noteBlocked(incident, dest.reason);
    return { incidentId: incident.id, result: "skipped", reason: dest.reason };
  }
  if (!claim(incident, now)) return null;

  const requesters = new Set(tickets.map((t) => String(t.requester_id || ""))).size;
  const program = programs.get(programId);
  try {
    const sent = await slackMessages.sendProgramMessage({
      client,
      program,
      channel: dest.channel,
      text: composeAlert(
        incident,
        tickets.map((t) => Number(t.id)),
        kind,
        requesters,
      ),
      retryAmbiguous: false,
    });
    if (sent?.shadowed) {
      db.handle().query("UPDATE program_incidents SET alert_claimed_at = NULL WHERE id = ?").run(incident.id);
      return { incidentId: incident.id, result: "skipped", reason: "shadow_mode" };
    }
    db.handle()
      .query(
        `UPDATE program_incidents SET alerted_at = ?, alert_ticket_count = ?, alert_claimed_at = NULL,
         alert_attempts = 0, alert_next_at = NULL, alert_error = NULL WHERE id = ?`,
      )
      .run(now, tickets.length, incident.id);
    incidents.recordIncidentAudit(incident, "incident.organizer_alerted", null, {
      kind,
      tickets: tickets.length,
      requesters,
      channel: dest.channel,
    });
    return { incidentId: incident.id, result: "sent", kind };
  } catch (e: unknown) {
    const reason = String(e instanceof Error ? e.message : e).slice(0, 120);
    const attempts = Number(incident.alert_attempts || 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    db.handle()
      .query(
        "UPDATE program_incidents SET alert_claimed_at = NULL, alert_attempts = ?, alert_next_at = ?, alert_error = ? WHERE id = ?",
      )
      .run(attempts, giveUp ? now + STALE_MS * 365 : now + RETRY_BASE_MS * attempts, reason, incident.id);
    incidents.recordIncidentAudit(incident, "incident.alert_failed", null, { kind, attempts, reason, giveUp });
    return { incidentId: incident.id, result: giveUp ? "gave_up" : "failed", kind, reason };
  }
}

// One program's pending alerts; safe to call from every radar sweep
async function dispatch({
  client,
  programId,
  now = Date.now(),
}: {
  client?: SlackClient | null;
  programId: string;
  now?: number;
}): Promise<AlertOutcome[]> {
  if (!client || !programId || maintenance.enabled()) return [];
  const live = db
    .handle()
    .query("SELECT * FROM program_incidents WHERE program_id = ? AND status = 'candidate' ORDER BY id ASC LIMIT 20")
    .all(programId) as Row[];
  const out: AlertOutcome[] = [];
  for (const incident of live) {
    try {
      const outcome = await alertOne(client, incident, now);
      if (outcome) out.push(outcome);
    } catch (e: unknown) {
      log.warn("incidentAlerts", `alert failed for incident ${incident.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

export = { dispatch, composeAlert, excerpt, MAX_ATTEMPTS, UPDATE_MIN_GROWTH };
