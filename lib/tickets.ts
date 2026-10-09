import dbModule = require("./db");
import replyModule = require("./reply");
import logModule = require("./log");
import slackMessagesModule = require("./slackMessages");
import configModule = require("./config");
import programsModule = require("./programs");
import auditModule = require("./audit");
import helperRouteModule = require("./helperRoute");
import incidentsModule = require("./incidents");
import assignmentLifecycleModule = require("./assignmentLifecycle");
import ticketCategoryModule = require("./ticketCategory");
import resolutionPipelineModule = require("./resolutionPipeline");
import handoffContextModule = require("./handoffContext");
import policy = require("./tickets/policy");
import type { ChannelRole, Program, SlackClient, Ticket } from "./types";
import type {
  FinishResolveOptions,
  IncidentCheckOptions,
  ParsedTicketAction,
  SlackBlock,
  SlackError,
  TicketActionApp,
  TicketActionBody,
  TicketActionInput,
  TicketActionPayload,
  TicketActionResult,
  TicketCandidate,
  TicketPolicy,
  TicketDatabaseRow,
  TicketRoutingOptions,
  TicketUIProjection,
  EnsureSupportTicketOptions,
  ResolveTicketOptions,
} from "./tickets.types";

interface TicketEvent {
  event_type: string;
  actor_id?: string | null;
  detail?: string | null;
  [key: string]: unknown;
}

interface HelperRecord {
  user_id: string;
  [key: string]: unknown;
}

interface ProgramChannelRecord extends TicketDatabaseRow {
  channel_id: string;
}

interface DbQuery {
  all(...args: unknown[]): TicketEvent[];
  get(...args: unknown[]): TicketDatabaseRow | undefined;
  run(...args: unknown[]): unknown;
}

interface TicketDbModule {
  addTicketEvent(...args: unknown[]): unknown;
  addTicketNote(...args: unknown[]): number | null;
  assignTicket(...args: unknown[]): boolean;
  claimTicket(...args: unknown[]): boolean;
  closeTicket(...args: unknown[]): boolean;
  createTicket(...args: unknown[]): number | null;
  enrichTicket(...args: unknown[]): unknown;
  escalateTicketStatus(...args: unknown[]): boolean;
  getTicket(...args: unknown[]): Ticket;
  getTicketByChannelThreadTs(...args: unknown[]): Ticket | null;
  getTicketByThreadTs(...args: unknown[]): Ticket | null;
  getThread(...args: unknown[]): Record<string, unknown> | null;
  handle(...args: unknown[]): { query(...queryArgs: unknown[]): DbQuery };
  isHelper(...args: unknown[]): boolean;
  isTakeover(...args: unknown[]): boolean;
  isThreadMuted(...args: unknown[]): boolean;
  listHelpers(...args: unknown[]): HelperRecord[];
  listProgramChannels(...args: unknown[]): ProgramChannelRecord[];
  listTicketEvents(...args: unknown[]): TicketEvent[];
  markDuplicateTicket(...args: unknown[]): boolean;
  markTakeover(...args: unknown[]): unknown;
  markTicketWaitingForHelper(...args: unknown[]): boolean;
  recordFirstResponse(...args: unknown[]): unknown;
  recordMetric(...args: unknown[]): unknown;
  reopenResolvedTicket(...args: unknown[]): boolean;
  reopenTicket(...args: unknown[]): boolean;
  resolveTicket(...args: unknown[]): boolean;
  setTicketTriage(...args: unknown[]): unknown;
  snoozeTicket(...args: unknown[]): boolean;
  touchThread(...args: unknown[]): unknown;
  unclaimTicket(...args: unknown[]): boolean;
  updatePublicAckTs(...args: unknown[]): boolean;
  updateTicketCardTs(...args: unknown[]): boolean;
}

interface ReplyModule {
  discardPlaceholder(...args: unknown[]): Promise<unknown>;
  escapeSlack(text: string): string;
  finalize(...args: unknown[]): Promise<unknown>;
  plainDashes(text: string): string;
  plainDashesInBlocks(blocks: SlackBlock[]): SlackBlock[];
}

interface LogModule {
  debug(scope: string, ...args: unknown[]): void;
  error(scope: string, ...args: unknown[]): void;
  info(scope: string, ...args: unknown[]): void;
  warn(scope: string, ...args: unknown[]): void;
}

interface SlackMessagesModule {
  sendProgramMessage(...args: unknown[]): Promise<{ ts?: string }>;
}

interface ProgramsModule {
  forChannel(...args: unknown[]): Program | null;
  get(...args: unknown[]): Program | null;
  isHelpChannel(...args: unknown[]): boolean;
  isShadow(...args: unknown[]): boolean;
}

interface AuditModule {
  record(...args: unknown[]): unknown;
}

interface HelperRouteModule {
  helpersWhoPassed?: never;
  nextEligibleHelper?: never;
  openLoad?: never;
  recommend(...args: unknown[]): TicketCandidate[];
  recordReply(...args: unknown[]): unknown;
  recordResolution(...args: unknown[]): unknown;
}

interface IncidentsModule {
  matchActiveIncident(...args: unknown[]): (TicketDatabaseRow & { public_message?: string; title?: string }) | null;
  recordAffectedReport(...args: unknown[]): unknown;
}

interface AssignmentLifecycleModule {
  helpersWhoPassed(...args: unknown[]): Set<string>;
  nextEligibleHelper(...args: unknown[]): TicketCandidate | null;
  openOfferFor(...args: unknown[]): { to?: string | null } | null;
  recordClaim(...args: unknown[]): unknown;
  recordDecline(...args: unknown[]): TicketActionResult & { recorded?: boolean };
  recordOffer(...args: unknown[]): Record<string, unknown>;
  recordRelease(...args: unknown[]): unknown;
}

interface TicketCategoryModule {
  classify(...args: unknown[]): string | null;
  defaultTaxonomy(...args: unknown[]): Record<string, unknown>;
}

interface ResolutionPipelineModule {
  schedule(...args: unknown[]): void;
}

interface FinishResult extends TicketActionResult {
  updated?: Ticket;
  cardText?: string;
  ackText?: string;
}

const { config, isAdmin } = configModule;
const { ticketPolicy, resolveTicketRole } = policy;
const db: TicketDbModule = dbModule as never;
const reply = replyModule as ReplyModule;
const log = logModule as LogModule;
const slackMessages = slackMessagesModule as SlackMessagesModule;
const programs = programsModule as ProgramsModule;
const audit = auditModule as AuditModule;
const helperRoute: HelperRouteModule = helperRouteModule as never;
const incidents = incidentsModule as IncidentsModule;
const assignmentLifecycle: AssignmentLifecycleModule = assignmentLifecycleModule as never;
const ticketCategory = ticketCategoryModule as TicketCategoryModule;
const resolutionPipeline = resolutionPipelineModule as ResolutionPipelineModule;
const handoffContext = handoffContextModule as {
  build(input: {
    programId: string;
    userId?: string | null;
    question: string;
    reason?: string | null;
    sources?: string[];
    attempts?: string[];
  }): string;
};

interface HandoffDetails {
  handoffReason?: string | null;
  sources?: string[];
  attempts?: string[];
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

const CLAIMABLE = ["open", "waiting_for_helper", "reopened"];
const WORKABLE = ["claimed", "assigned"];
const CLOSED = ["resolved", "closed"];
const renderedTicketUI = new WeakMap();
const reconcilingTicketUI = new WeakMap();

const SUPPORT_RESOLVE_ACTION = "st_resolve";
const SUPPORT_REOPEN_ACTION = "st_reopen";
const STATUS_EMOJI: Record<string, string> = {
  claimed: ":hmmcat:",
  resolved: ":yesyes:",
  closed: ":ban:",
};

function isActorAllowed(programId: string, actorId: string | null, allowEmpty = true): boolean {
  if (!actorId) return false;
  try {
    if (isAdmin && isAdmin(actorId)) return true;
  } catch (e: unknown) {
    log.debug("tickets", `isAdmin check failed: ${errorMessage(e)}`);
  }
  try {
    const helpers = db.listHelpers(programId);
    if (helpers.length === 0) return !!allowEmpty;
    if (db.isHelper(programId, actorId)) return true;
  } catch (e: unknown) {
    log.debug("tickets", `helper check failed: ${errorMessage(e)}`);
  }
  return false;
}

function authorize(
  ticket: Ticket | null,
  {
    programId,
    workspaceId,
    actorId,
  }: { programId?: string | null; workspaceId?: string | null; actorId?: string | null },
): string | null {
  if (!ticket) return "ticket not found";
  if (programId && ticket.program_id !== programId) return "program mismatch";
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return "workspace mismatch";
  if (actorId && !isActorAllowed(ticket.program_id, actorId, true)) return "actor is not a helper of this program";
  return null;
}

function getOrganizerChannel(program: Program | null, workspaceId: string | null = null): string | null {
  if (!program) return null;
  const legacyProgram = program as Program & {
    organizer_channel?: string;
    organizer_channel_id?: string;
    workspace_id?: string | null;
  };
  const direct = program.organizerChannel || legacyProgram.organizer_channel || legacyProgram.organizer_channel_id;
  if (direct) return direct;
  if (program.id) {
    try {
      const channels = db.listProgramChannels(program.id);
      const ws = workspaceId || program.workspaceId || legacyProgram.workspace_id;
      const match = channels.find((c: TicketDatabaseRow) => c.kind === "organizer" && (!ws || c.workspace_id === ws));
      if (match) return match.channel_id;
      const anyOrg = channels.find((c: TicketDatabaseRow) => c.kind === "organizer");
      if (anyOrg) return anyOrg.channel_id;
    } catch (e) {
      log.debug("tickets", `getOrganizerChannel queries failed: ${errorMessage(e)}`);
    }
  }
  return null;
}

function getTicketCardDestination(program: Program | null, workspaceId: string | null = null): string | null {
  return getOrganizerChannel(program, workspaceId);
}

function recordTransition(
  ticket: Ticket,
  actorId: string | null,
  eventType: string,
  detail: unknown = null,
  createdAt: number | null = null,
): void {
  try {
    db.addTicketEvent({ ticketId: ticket.id, programId: ticket.program_id, actorId, eventType, detail, createdAt });
  } catch (e: unknown) {
    log.debug("tickets", `event record failed: ${errorMessage(e)}`);
  }
  try {
    audit.record({
      programId: ticket.program_id,
      actorId,
      action: `ticket.${eventType}`,
      entityType: "ticket",
      entityId: ticket.id,
      metadata: detail,
    });
  } catch (e: unknown) {
    log.debug("tickets", `audit record failed: ${errorMessage(e)}`);
  }
}

function startNewEpoch(ticket: Ticket | null): void {
  if (!ticket || !ticket.id || !ticket.program_id) return;
  try {
    const fresh = db.getTicket(ticket.id) || ticket;
    assignmentLifecycle.recordOffer({ ticket: fresh, to: null, source: "reopened" });
  } catch (e: unknown) {
    log.debug("tickets", `reopen epoch record failed for #${ticket.id}: ${errorMessage(e)}`);
  }
}

function buildTicketCardBlocks(
  ticket: Ticket,
  program: Program | null,
  candidates: TicketCandidate[] | null = null,
): SlackBlock[] {
  const statusEmoji = STATUS_EMOJI[ticket.status] || ":siren1:";
  const progName = program ? program.name : ticket.program_id || "program";
  const assigneeStr = ticket.assignee_id ? ` • Claimed by <@${ticket.assignee_id}>` : "";
  const statusStr = `*Status*: ${statusEmoji} \`${ticket.status}\`${assigneeStr}`;
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `[${progName}] Ticket ${ticketRef(ticket) || `#${ticket.id}`}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Question*: ${reply.escapeSlack(ticket.question)}\n*Requester*: <@${ticket.requester_id}> in <#${ticket.channel}>`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: statusStr },
    },
  ];
  if (CLAIMABLE.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🙋 Claim Ticket" },
          style: "primary",
          value: String(ticket.id),
          action_id: "claim_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🙅 Decline" },
          value: String(ticket.id),
          action_id: "decline_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Resolve" },
          value: String(ticket.id),
          action_id: "resolve_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Reply" },
          value: String(ticket.id),
          action_id: "reply_ticket_button",
        },
      ],
    });
  } else if (WORKABLE.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "↩️ Release" },
          value: String(ticket.id),
          action_id: "unclaim_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Resolve" },
          style: "primary",
          value: String(ticket.id),
          action_id: "resolve_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Close" },
          value: String(ticket.id),
          action_id: "close_ticket",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Reply" },
          value: String(ticket.id),
          action_id: "reply_ticket_button",
        },
      ],
    });
  } else if (CLOSED.includes(ticket.status)) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 Reopen" },
          value: String(ticket.id),
          action_id: "reopen_ticket",
        },
      ],
    });
  }
  if (ticket.status === CLAIMABLE[0] || WORKABLE.includes(ticket.status)) {
    let list = candidates;
    if (!list) {
      try {
        list = helperRoute.recommend({
          programId: ticket.program_id,
          category: ticket.category,
          limit: 5,
          ...routingOptions(program, ticket),
        });
        if (!list || list.length === 0) {
          const bot = (() => {
            try {
              return require("./config").config?.slack?.botUserId || null;
            } catch (_) {
              return null;
            }
          })();
          list = db
            .listHelpers(ticket.program_id, true)
            .filter((helper) => helper.user_id !== ticket.requester_id && helper.user_id !== bot)
            .map((helper) => ({
              userId: helper.user_id,
              reasons: ["program helper"],
            }));
        }
      } catch (e) {
        log.debug("tickets", `helper recommendation failed: ${errorMessage(e)}`);
        list = [];
      }
    }
    let passed = new Set();
    try {
      passed = assignmentLifecycle.helpersWhoPassed(ticket.program_id, ticket.id);
    } catch (e) {
      log.debug("tickets", `helpersWhoPassed lookup failed for #${ticket.id}: ${errorMessage(e)}`);
    }
    const botId = (() => {
      try {
        return require("./config").config?.slack?.botUserId || null;
      } catch (_) {
        return null;
      }
    })();
    const filtered = (list || []).filter(
      (r) =>
        r.userId !== ticket.assignee_id &&
        !passed.has(r.userId) &&
        r.userId !== ticket.requester_id &&
        r.userId !== botId,
    );
    if (filtered.length > 0) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "static_select",
            placeholder: { type: "plain_text", text: "🔁 Reassign to…" },
            action_id: "reassign_select",
            options: filtered.map((r) => ({
              text: { type: "plain_text", text: `@${r.userId} — ${r.reasons?.[0] || "program helper"}`.slice(0, 75) },
              value: `${ticket.id}:${r.userId}`,
            })),
          },
        ],
      });
    }
  }
  return blocks;
}

const TICKET_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  waiting_for_helper: "Waiting for a helper",
  assigned: "Assigned",
  claimed: "Claimed",
  escalated: "Escalated",
  reopened: "Reopened",
  resolved: "Resolved",
  closed: "Closed",
  duplicate: "Duplicate",
  spam: "Spam",
  snoozed: "Snoozed",
};

function friendlyStatusLabel(status: string): string {
  return TICKET_STATUS_LABELS[status] || status;
}

function ticketStatusLabel(ticket: Ticket | null): string | null {
  return TICKET_STATUS_LABELS[ticket?.status || ""] || (ticket && ticket.status);
}

function ticketRef(ticket: Ticket | null): string {
  const n = Number(ticket && ticket.id);
  return Number.isInteger(n) && n > 0 ? `#${n}` : "";
}

function docsLink(prog: Program | null): string | null {
  const links = (prog && prog.links) || {};
  return links.docs || links.site || null;
}

function supportTicketBlocks(ticket: Ticket, prog: Program | null): SlackBlock[] {
  if (CLOSED.includes(ticket.status)) {
    const by = ticket.resolved_by ? ` by <@${ticket.resolved_by}>` : "";
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `Resolved${by}! If you have more questions, feel free to open a new thread.` },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Reopen" },
            value: String(ticket.id),
            action_id: SUPPORT_REOPEN_ACTION,
          },
        ],
      },
    ];
  }
  const link = docsLink(prog);
  const tail = link ? ` In the meantime, take a look at the docs: ${link}` : "";
  return [
    { type: "section", text: { type: "mrkdwn", text: `Someone will be here to help you soon!${tail}` } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Mark as resolved" },
          value: String(ticket.id),
          action_id: SUPPORT_RESOLVE_ACTION,
        },
      ],
    },
  ];
}

function ticketUIProjection(
  ticket: Ticket,
  prog: Program | null,
  candidates: TicketCandidate[] | null = null,
): TicketUIProjection {
  return {
    card: {
      text: `[Ticket #${ticket.id}] ${friendlyStatusLabel(ticket.status)}`,
      blocks: buildTicketCardBlocks(ticket, prog, candidates),
    },
    thread: {
      text: CLOSED.includes(ticket.status) ? "Ticket resolved." : "Someone will be here to help you soon!",
      blocks: supportTicketBlocks(ticket, prog),
    },
    reaction: CLOSED.includes(ticket.status) ? config.ticketResolvedReaction : config.ticketOpenReaction,
  };
}

function projectionKey(ticket: Ticket, projection: TicketUIProjection): string {
  return JSON.stringify({
    id: ticket.id,
    status: ticket.status,
    assignee: ticket.assignee_id || null,
    resolvedBy: ticket.resolved_by || null,
    publicAck: ticket.public_ack_ts || null,
    cardTs: ticket.card_ts || null,
    cardText: projection.card.text || null,
    reaction: projection.reaction || null,
  });
}

async function reconcileTicketUI({
  client,
  ticket,
  program = null,
  cardText = null,
}: {
  client: SlackClient | null;
  ticket: Ticket;
  program?: Program | null;
  cardText?: string | null;
}): Promise<boolean | undefined> {
  if (!client || !ticket) return;
  let queues = reconcilingTicketUI.get(client as object);
  if (!queues) {
    queues = new Map();
    reconcilingTicketUI.set(client as object, queues);
  }
  const ticketKey = String(ticket.id);
  const previous = queues.get(ticketKey);
  const current = previous
    ? previous.catch(() => {}).then(() => reconcileTicketUIOnce({ client, ticket, program, cardText }))
    : reconcileTicketUIOnce({ client, ticket, program, cardText });
  queues.set(
    ticketKey,
    current.finally(() => {
      if (queues.get(ticketKey) === current) queues.delete(ticketKey);
    }),
  );
  return current;
}

async function reconcileTicketUIOnce({
  client,
  ticket,
  program = null,
  cardText = null,
}: {
  client: SlackClient | null;
  ticket: Ticket;
  program?: Program | null;
  cardText?: string | null;
}): Promise<boolean> {
  if (!client) return false;
  ticket = db.getTicket(ticket.id) || ticket;
  const prog = program || (ticket.program_id ? programs.get(ticket.program_id) : null);
  let candidates: TicketCandidate[] = [];
  try {
    candidates = helperRoute.recommend({
      programId: ticket.program_id,
      category: ticket.category,
      limit: 5,
      ...routingOptions(prog, ticket),
    });
  } catch (e) {
    log.debug("tickets", `helper recommendation failed: ${errorMessage(e)}`);
  }
  const projection = ticketUIProjection(ticket, prog, candidates);
  if (cardText) projection.card.text = cardText;
  const key = projectionKey(ticket, projection);
  let renderedByTicket = renderedTicketUI.get(client);
  if (!renderedByTicket) {
    renderedByTicket = new Map();
    renderedTicketUI.set(client, renderedByTicket);
  }
  const previous = renderedByTicket.get(String(ticket.id));
  if (previous === key) return true;

  const destinationProgram = prog || ({ id: ticket.program_id } as Program);
  const cardSynced = await syncSlack(
    {
      client,
      channel: getOrganizerChannel(destinationProgram, ticket.workspace_id),
      ts: ticket.card_ts,
      text: projection.card.text,
      blocks: projection.card.blocks,
    },
    ticket,
  );
  const latest = db.getTicket(ticket.id) || ticket;
  if (latest.status !== ticket.status || latest.assignee_id !== ticket.assignee_id) {
    return reconcileTicketUIOnce({ client, ticket: latest, program, cardText });
  }
  const supportSynced = await syncSupportTicketUI(client, latest, prog, ticketUIProjection(latest, prog));
  if (cardSynced && supportSynced) renderedByTicket.set(String(ticket.id), key);
  return cardSynced && supportSynced;
}

async function syncSupportTicketUI(
  client: SlackClient,
  ticket: Ticket,
  prog: Program | null,
  projection: TicketUIProjection | null = null,
): Promise<boolean> {
  const view = projection || ticketUIProjection(ticket, prog);
  let synced = true;
  if (client?.chat?.update && ticket.public_ack_ts) {
    try {
      await client.chat.update({
        channel: ticket.channel,
        ts: ticket.public_ack_ts,
        text: view.thread.text,
        blocks: reply.plainDashesInBlocks(view.thread.blocks),
      });
    } catch (e) {
      recordSlackSyncFailure("thread", ticket, e as SlackError);
      synced = false;
    }
  }
  return synced && (await syncTicketReactions(client, ticket, prog));
}

async function syncTicketReactions(
  client: SlackClient,
  ticket: Ticket,
  program: Program | null = null,
): Promise<boolean> {
  const open = config.ticketOpenReaction;
  const done = config.ticketResolvedReaction;
  if (!client?.reactions?.add || !ticket?.thread_ts || !ticket?.channel || (!open && !done)) return true;
  if (!ticketSurfaces(program || programs.get(ticket.program_id)).thread) return true;
  let synced = true;
  const closed = CLOSED.includes(ticket.status);
  const want = closed ? done : open;
  const drop = closed ? open : done;
  const at = { channel: ticket.channel, timestamp: ticket.thread_ts };
  if (want)
    await client.reactions.add({ ...at, name: want }).catch((e) => {
      synced = false;
      recordSlackSyncFailure("reaction", ticket, e);
    });
  if (drop && client.reactions.remove)
    await client.reactions.remove({ ...at, name: drop }).catch((e) => {
      synced = false;
      recordSlackSyncFailure("reaction", ticket, e);
    });
  return synced;
}

function isHelpChannelFor(prog: Program | null, channel: string | null, workspaceId: string | null = null): boolean {
  if (!prog || !channel) return false;
  if (prog.helpChannel === channel) return true;
  return programs.isHelpChannel(channel, workspaceId);
}

function policyFor(
  prog: Program | null,
  {
    channel = null,
    workspaceId = null,
    role = null,
  }: { channel?: string | null; workspaceId?: string | null; role?: string | null } = {},
): TicketPolicy | null {
  if (!prog) return null;
  return ticketPolicy({
    program: prog,
    role: resolveTicketRole({ program: prog, channel, workspaceId, role: role as ChannelRole | null }),
  }) as TicketPolicy & Record<string, boolean>;
}

interface RoutingTicket {
  channel: string;
  requester_id?: string | null;
  workspace_id?: string | null;
}

function routingOptions(prog: Program | null, ticket: RoutingTicket | null): TicketRoutingOptions {
  const pol = policyFor(prog, { channel: ticket && ticket.channel, workspaceId: ticket && ticket.workspace_id });
  return {
    expertiseRouting: pol ? pol.expertiseRouting : true,
    exclude: ticket && ticket.requester_id ? [ticket.requester_id] : [],
  };
}

function ticketCreationAllowed({
  prog,
  channel,
  workspaceId = null,
  paging = false,
  role = null,
  backfill = false,
}: {
  prog: Program | null;
  channel: string | null;
  workspaceId?: string | null;
  paging?: boolean;
  role?: string | null;
  backfill?: boolean;
}): boolean {
  if (!prog) return false;
  if (backfill) return channel ? isHelpChannelFor(prog, channel, workspaceId) : false;
  const pol = policyFor(prog, { channel, workspaceId, role });
  if (!pol || !pol.recordTicket) return false;
  if (!paging && !pol.createOnSupport) return false;
  const inHelp = channel ? isHelpChannelFor(prog, channel, workspaceId) : true;
  if (paging) {
    if (prog.publicTicketsEnabled === false && channel && inHelp && prog.ticketVisibility !== "dashboard") return false;
    return true;
  }
  if (prog.publicTicketsEnabled === false && prog.ticketVisibility !== "dashboard") return false;
  if (channel && !inHelp) return false;
  return true;
}

function ticketSurfaces(prog: Program | null): { thread: boolean; organizer: boolean } {
  const mode = (prog && prog.ticketVisibility) || "thread";
  return {
    thread: mode === "thread",
    organizer: mode === "thread" || mode === "organizer",
  };
}

function categoryRules(prog: Program | null): Record<string, unknown> | null {
  if (prog?.categories && typeof prog.categories === "object") return prog.categories;
  if (prog?.ticketsEnabled === false) return null;
  return ticketCategory.defaultTaxonomy();
}

function applyCategory(
  ticketId: number,
  { prog, channel, question }: { prog: Program | null; channel: string | null; question: string },
): string | null {
  const rules = categoryRules(prog);
  if (!ticketId || !prog || !rules) return null;
  try {
    const category = ticketCategory.classify({ question, channel, rules });
    if (category) db.setTicketTriage(ticketId, { category, categorySource: "classifier" });
    return category;
  } catch (e) {
    log.debug("tickets", `classify failed for #${ticketId}: ${errorMessage(e)}`);
    return null;
  }
}

function reclassifyOnFollowUp(
  ticket: Ticket,
  { prog, question, requesterId }: { prog: Program | null; question: string | null; requesterId: string },
): Ticket {
  if (!ticket || !prog || ticket.status === "resolved" || ticket.status === "closed") return ticket;
  if (!question || requesterId !== ticket.requester_id || question === ticket.question) return ticket;
  const followUps: string[] = [];
  for (const event of db.listTicketEvents(ticket.id)) {
    if (event.event_type !== "requester_followup") continue;
    try {
      const detail = JSON.parse(String(event.detail || "{}")) as { text?: string };
      if (detail.text) followUps.push(detail.text);
    } catch (_) {}
  }
  if (!followUps.includes(question)) {
    recordTransition(ticket, requesterId, "requester_followup", { text: question });
    followUps.push(question);
  }
  const rules = categoryRules(prog);
  if (!rules) return ticket;
  if (ticket.category_source === "human") return db.getTicket(ticket.id) || ticket;
  const category = ticketCategory.classify({ question, channel: null, rules: { ...rules, fallback: null } });
  if (category && category !== ticket.category)
    db.setTicketTriage(ticket.id, { category, categorySource: "classifier" });
  return db.getTicket(ticket.id) || ticket;
}

async function ensureSupportTicket(options: EnsureSupportTicketOptions): Promise<Ticket | null> {
  const {
    program,
    channel,
    threadTs,
    requesterId,
    question,
    client,
    workspaceId = null,
    paging = false,
    role = null,
    silent = false,
    backfill = false,
    createdAt = null,
    source = null,
  } = options;
  if (!threadTs) return null;
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  if (!prog) return null;
  const wsId = workspaceId || prog.workspaceId || prog.workspace_id || null;

  let ticket = backfill
    ? db.getTicketByChannelThreadTs(channel, threadTs, wsId, prog.id)
    : db.getTicketByThreadTs(threadTs, wsId, prog.id);
  if (!ticket) {
    const surfaces = ticketSurfaces(prog);
    if (!backfill && prog.posture === "passive" && (surfaces.thread || surfaces.organizer)) return null;
    if (!ticketCreationAllowed({ prog, channel, workspaceId: wsId, paging, role, backfill })) return null;
    const visibility =
      backfill || prog.publicTicketsEnabled === false ? "dashboard" : prog.ticketVisibility || "thread";
    const id = db.createTicket({
      programId: prog.id,
      workspaceId: wsId,
      channel,
      threadTs,
      requesterId,
      question,
      createdAt,
      visibility,
    });
    if (id) applyCategory(id, { prog, channel, question });
    ticket = id ? db.getTicket(id) : db.getTicketByThreadTs(threadTs, wsId, prog.id);
    if (ticket && !db.listTicketEvents(ticket.id).some((e) => e.event_type === "created")) {
      recordTransition(
        ticket,
        requesterId,
        "created",
        { channel, workspaceId: wsId, source: source || "support_question" },
        createdAt,
      );
    }
  }
  if (!ticket) return null;
  if (backfill && !ticket.visibility) db.enrichTicket(ticket.id, { requesterId, question, visibility: "dashboard" });
  if (silent) return db.getTicket(ticket.id);
  ticket = reclassifyOnFollowUp(ticket, { prog, question, requesterId });

  if (client && !ticket.public_ack_ts && ticketSurfaces(prog).thread) {
    try {
      const res = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel,
        threadTs,
        text: "Someone will be here to help you soon!",
        blocks: reply.plainDashesInBlocks(supportTicketBlocks(ticket, prog)),
      });
      if (res?.ts && db.updatePublicAckTs(ticket.id, res.ts)) {
        ticket.public_ack_ts = res.ts;
        db.recordFirstResponse(ticket.id, false);
      } else if (res?.ts) {
        await client.chat.delete({ channel, ts: res.ts }).catch(() => {});
      }
    } catch (e) {
      recordSlackSyncFailure("thread_post", ticket, e as SlackError);
      log.warn("tickets", `support ticket UI post failed for #${ticket.id}: ${errorMessage(e)}`);
    }
  }
  const fresh = db.getTicket(ticket.id);
  if (client) void syncTicketReactions(client, fresh, prog);
  if (client && !fresh.card_ts && ticketSurfaces(prog).organizer && getOrganizerChannel(prog, wsId)) {
    await postCard({
      prog,
      programId: prog.id,
      resolvedWorkspaceId: wsId,
      ticket: fresh,
      client,
      requesterId,
      question,
    });
  }
  return db.getTicket(ticket.id);
}

function hasOpenOffer(ticket: Ticket): boolean {
  return !!assignmentLifecycle.openOfferFor(ticket.program_id, ticket.id);
}

function hasHelperReplied(ticketId: number): boolean {
  return db.listTicketEvents(ticketId).some((event) => event.event_type === "helper_reply");
}

function helperMentionedIn(programId: string, text: string | null): boolean {
  if (!programId || !text) return false;
  const eligibility = require("./eligibility");
  const mentions = eligibility.otherMentions(text, config?.slack?.botUserId);
  return mentions.some((m: string) => {
    const id = (m.match(/<@([A-Z0-9]+)/) || [])[1];
    return id && db.isHelper(programId, id);
  });
}

function markWaitingForHelper({
  ticketId,
  client = null,
  program = null,
  question = null,
  role = null,
  explicit = false,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  ticketId: number;
  client?: SlackClient | null;
  program?: Program | null;
  question?: string | null;
  role?: string | null;
  explicit?: boolean;
} & HandoffDetails): Ticket | null {
  const ticket = db.getTicket(ticketId);
  if (!ticket || CLOSED.includes(ticket.status) || ticket.status === "snoozed") return ticket || null;
  if (db.isThreadMuted(ticket.thread_ts) || db.isTakeover(ticket.thread_ts)) return ticket;
  const prog = program || programs.get(ticket.program_id);
  const pol = policyFor(prog, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
  const autoBlocked = pol && !explicit && !pol.escalate;
  let updated = db.getTicket(ticketId);
  if (!autoBlocked && !WORKABLE.includes(updated.status) && updated.status !== "waiting_for_helper") {
    const changed = db.markTicketWaitingForHelper(ticketId);
    if (changed) recordTransition(db.getTicket(ticketId), null, "escalated", { by: "ai_no_answer" });
    updated = db.getTicket(ticketId);
  }
  const alreadyOffered = hasOpenOffer(updated);
  if (updated && !updated.assignee_id && !alreadyOffered) {
    try {
      assignmentLifecycle.recordOffer({ ticket: updated, to: null, source: "queue" });
    } catch (e) {
      log.debug("tickets", `pool offer record failed for #${ticketId}: ${errorMessage(e)}`);
    }
  }
  try {
    require("./shadowRouting").snapshotForTicket(updated);
  } catch (e) {
    log.warn("tickets", `shadow routing snapshot failed for #${ticketId}: ${errorMessage(e)}`);
  }
  if (!autoBlocked && prog && prog.autoAssign === true && !updated.assignee_id && !alreadyOffered) {
    try {
      const [top] = helperRoute.recommend({
        programId: ticket.program_id,
        category: updated.category,
        limit: 1,
        ...routingOptions(prog, updated),
      });
      if (top && db.assignTicket(ticketId, top.userId)) {
        updated = db.getTicket(ticketId);
        recordTransition(updated, null, "assigned", { to: top.userId, automatic: true });
        try {
          assignmentLifecycle.recordOffer({ ticket: updated, to: top.userId, source: "auto" });
        } catch (e) {
          log.debug("tickets", `auto offer record failed for #${ticketId}: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      log.warn("tickets", `auto-assign failed for #${ticketId}: ${errorMessage(e)}`);
    }
  }
  const mayPing = !autoBlocked && (pol ? pol.pingHelpers : prog && prog.helperPing === true);
  if (mayPing) {
    void pingRecommendedHelper({
      client,
      ticket: updated,
      program: prog,
      question,
      role,
      handoffReason,
      sources,
      attempts,
    }).catch((e) => {
      log.warn("tickets", `helper ping failed for #${ticketId}: ${errorMessage(e)}`);
    });
  }
  if (!autoBlocked && client && updated.card_ts)
    void syncCard(client, updated, `[Ticket #${updated.id}] Waiting for a helper`).catch(() => {});
  return updated;
}

async function handOffToHelper({
  client,
  program,
  channel,
  threadTs,
  question,
  ticket = null,
  requesterId = null,
  workspaceId = null,
  role = null,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  client: SlackClient;
  program: Program | null;
  channel: string;
  threadTs: string;
  question: string;
  ticket?: Ticket | null;
  requesterId?: string | null;
  workspaceId?: string | null;
  role?: string | null;
} & HandoffDetails): Promise<Ticket | string | null> {
  if (ticket)
    return markWaitingForHelper({
      ticketId: ticket.id,
      client,
      program,
      question,
      role,
      explicit: true,
      handoffReason,
      sources,
      attempts,
    });
  if (!program) return null;
  const pol = policyFor(program, { channel, workspaceId, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return null;
  return pingThreadHelper({
    client,
    program,
    channel,
    threadTs,
    question,
    requesterId,
    workspaceId,
    role,
    handoffReason,
    sources,
    attempts,
  });
}

async function pingThreadHelper({
  client,
  program,
  channel,
  threadTs,
  question,
  requesterId = null,
  workspaceId = null,
  role = null,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  client: SlackClient;
  program: Program | null;
  channel: string;
  threadTs: string;
  question: string;
  requesterId?: string | null;
  workspaceId?: string | null;
  role?: string | null;
} & HandoffDetails): Promise<string | null> {
  if (!client || !program || !threadTs || !channel) return null;
  const pol = policyFor(program, { channel, workspaceId, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return null;
  if (programs.isShadow(program)) return null;
  if (db.isThreadMuted(threadTs) || db.isTakeover(threadTs)) return null;
  if (db.getThread(threadTs)?.helper_pinged) return null;
  if (helperMentionedIn(program.id, question)) return null;

  const category = ticketCategory.classify({ question, channel, rules: program.categories });
  const opts = routingOptions(program, { channel, requester_id: requesterId });
  const candidates = helperRoute.recommend({ programId: program.id, category, limit: 5, ...opts });
  const [top] = candidates;
  const logDecision = (skipReason: string | null, posted = false, selected: string | null = null) =>
    logRoutingDecision({
      ticket: { channel, thread_ts: threadTs, program_id: program.id },
      program,
      category,
      candidates,
      selected,
      posted,
      skipReason,
    });
  if (!top) return (logDecision("no_eligible_helper"), null);

  db.touchThread(threadTs, channel, { helperPinged: true });

  const packet = handoffContext.build({
    programId: program.id,
    userId: requesterId,
    question,
    reason: handoffReason,
    sources,
    attempts,
  });
  const ask = `<@${top.userId}> — could you take a look at this one?\n${packet}`;
  await slackMessages.sendProgramMessage({
    client,
    program,
    channel,
    threadTs,
    text: reply.plainDashes(ask),
  });
  logDecision(null, true, top.userId);
  return top.userId;
}

function logRoutingDecision({
  ticket,
  program,
  category,
  candidates = [],
  selected = null,
  posted = false,
  skipReason = null,
}: {
  ticket: (Pick<Ticket, "channel" | "thread_ts" | "program_id"> & { id?: number }) | null;
  program: Program | null;
  category?: string | null;
  candidates?: TicketCandidate[];
  selected?: string | null;
  posted?: boolean;
  skipReason?: string | null;
}): void {
  const ranked = candidates
    .slice(0, 5)
    .map((c) => `${c.userId}:${c.score}`)
    .join(",");
  log.info(
    "routing",
    `program=${(program && program.id) || (ticket && ticket.program_id) || "?"} ` +
      `channel=${(ticket && ticket.channel) || "?"} thread_ts=${(ticket && ticket.thread_ts) || "?"} ` +
      `ticket_id=${ticket && ticket.id != null ? ticket.id : "?"} category=${category || "none"} ` +
      `candidates=[${ranked}] selected=${selected || "none"} posted=${posted} skip_reason=${skipReason || "none"}`,
  );
}

async function pingSpecificHelper({
  client,
  ticket,
  program,
  userId,
  question = null,
  source = "ping",
  candidates = [],
  role = null,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  client: SlackClient;
  ticket: Ticket | null;
  program: Program | null;
  userId: string;
  question?: string | null;
  source?: string;
  candidates?: TicketCandidate[];
  role?: string | null;
} & HandoffDetails): Promise<string | null> {
  const logDecision = (skipReason: string | null, posted = false) =>
    logRoutingDecision({
      ticket,
      program,
      category: ticket?.category,
      candidates,
      selected: userId,
      posted,
      skipReason,
    });

  if (!client || !ticket || !program || !userId) return (logDecision("missing_args"), null);
  const pol = policyFor(program, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
  if (pol ? !pol.pingHelpers : program.helperPing !== true) return (logDecision("helper_ping_disabled"), null);
  if (CLOSED.includes(ticket.status)) return (logDecision("ticket_closed"), null);
  if (programs.isShadow(program)) return (logDecision("shadow_mode"), null);
  try {
    const bot = require("./config").config?.slack?.botUserId;
    if (bot && userId === bot) return (logDecision("bot_user"), null);
  } catch (_) {}
  if (db.isThreadMuted(ticket.thread_ts)) return (logDecision("thread_muted"), null);
  if (userId && ticket.requester_id && userId === ticket.requester_id)
    return (logDecision("requester_is_candidate"), null);
  if (db.isTakeover(ticket.thread_ts)) return (logDecision("human_engaged"), null);
  if (hasHelperReplied(ticket.id)) return (logDecision("helper_already_replied"), null);
  if (helperMentionedIn(ticket.program_id, question) || helperMentionedIn(ticket.program_id, ticket.question)) {
    return (logDecision("requester_already_mentioned_helper"), null);
  }

  const offer = assignmentLifecycle.recordOffer({ ticket, to: userId, source });
  if (!offer.recorded) return (logDecision("dedupe_open_offer_exists"), null);

  const packet = handoffContext.build({
    programId: program.id,
    userId: ticket.requester_id,
    question: question || ticket.question,
    reason: handoffReason,
    sources,
    attempts,
  });
  const ask = `<@${userId}> — could you take a look at this one?\n${packet}`;
  await slackMessages.sendProgramMessage({
    client,
    program,
    channel: ticket.channel,
    threadTs: ticket.thread_ts,
    text: reply.plainDashes(ask),
  });
  logDecision(null, true);
  return userId;
}

async function pingRecommendedHelper({
  client,
  ticket,
  program,
  question = null,
  role = null,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  client: SlackClient | null;
  ticket: Ticket | null;
  program: Program | null;
  question?: string | null;
  role?: string | null;
} & HandoffDetails): Promise<string | null> {
  if (!client || !ticket || !program) return null;
  let userId = ticket.assignee_id || null;
  if (userId && ticket.requester_id && userId === ticket.requester_id) {
    logRoutingDecision({
      ticket,
      program,
      category: ticket.category,
      candidates: [],
      selected: userId,
      posted: false,
      skipReason: "assignee_is_requester",
    });
    return null;
  }
  let candidates: TicketCandidate[] = [];
  if (!userId) {
    candidates = helperRoute.recommend({
      programId: ticket.program_id,
      category: ticket.category,
      limit: 5,
      ...routingOptions(program, ticket),
    });
    const [top] = candidates;
    if (!top) {
      logRoutingDecision({ ticket, program, category: ticket.category, candidates, skipReason: "no_eligible_helper" });
      return null;
    }
    userId = top.userId;
  }
  return pingSpecificHelper({
    client,
    ticket,
    program,
    userId,
    question,
    source: "ping",
    candidates,
    role,
    handoffReason,
    sources,
    attempts,
  });
}

function recordSlackSyncFailure(surface: string, ticket: Ticket | null, err: SlackError): void {
  const code = (err && (err.code || (err.data && err.data.error))) || "unknown";
  log.warn("tickets", `slack ${surface} sync failed for #${ticket?.id ?? "?"}: ${code}`);
  try {
    db.recordMetric(
      "ticket_slack_sync_failure",
      null,
      `${surface}:${String(code).slice(0, 40)}`,
      ticket?.program_id || null,
    );
  } catch (e) {
    log.debug("tickets", `sync failure metric failed: ${errorMessage(e)}`);
  }
}

async function syncSlack(
  {
    client,
    channel,
    ts,
    text,
    blocks,
  }: { client: SlackClient; channel: string | null; ts: string | null; text: string; blocks: SlackBlock[] },
  ticket: Ticket | null = null,
): Promise<boolean> {
  if (!client?.chat?.update || !channel || !ts) return true;
  try {
    await client.chat.update({
      channel,
      ts,
      text: reply.plainDashes(text),
      blocks: reply.plainDashesInBlocks(blocks),
    });
    return true;
  } catch (e) {
    recordSlackSyncFailure("card", ticket, e as SlackError);
    return false;
  }
}

async function syncCard(client: SlackClient, ticket: Ticket, text: string): Promise<void> {
  await reconcileTicketUI({ client, ticket, cardText: text });
}

function resolveProg({
  program,
  channel,
  workspaceId,
}: {
  program: Program | null;
  channel: string;
  workspaceId: string | null;
}): { prog: Program | null; programId: string; resolvedWorkspaceId: string | null } {
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const programId = prog ? prog.id : "";
  const resolvedWorkspaceId = workspaceId || (prog ? prog.workspaceId || prog.workspace_id || null : null);
  return { prog, programId, resolvedWorkspaceId };
}

async function checkIncident(options: IncidentCheckOptions): Promise<TicketActionResult> {
  const {
    prog,
    programId,
    question,
    ticket,
    client,
    channel,
    threadTs,
    requesterId,
    resolvedWorkspaceId,
    placeholder,
    bypassIncidentMatch,
  } = options;
  if (bypassIncidentMatch) return { done: false };
  const incidentMode = prog?.incidentMode || "ANSWER_AND_TRACK";
  if (incidentMode === "NORMAL_TICKET" || !client) return { done: false };
  let matched = null;
  try {
    matched = incidents.matchActiveIncident({ programId, question });
  } catch (e) {
    log.debug("tickets", `incident match failed: ${errorMessage(e)}`);
  }
  if (!matched) return { done: false };
  const text = reply.plainDashes(
    matched.public_message ||
      `We're currently aware of an issue with "${matched.title}". The team is investigating — I'll update this thread when there's a confirmed resolution.`,
  );
  try {
    if (placeholder) {
      await reply.finalize(client, channel, threadTs, placeholder, text, { program: prog });
    } else {
      await slackMessages.sendProgramMessage({ client, program: prog, channel, threadTs, text });
    }
    if (incidentMode === "ANSWER_AND_TRACK") {
      incidents.recordAffectedReport({ incidentId: matched.id, programId, requesterId, channel, threadTs });
    }
    log.info("tickets", `posted active incident #${matched.id} note to the thread (${programId})`);
    return { done: true, ticket: ticket ? db.getTicket(ticket.id) : null };
  } catch (e) {
    log.warn("tickets", `incident-aware reply failed, falling back to a normal escalation: ${errorMessage(e)}`);
    return { done: false };
  }
}

async function postCard({
  prog,
  programId,
  resolvedWorkspaceId,
  ticket,
  client,
  requesterId,
  question,
}: {
  prog: Program | null;
  programId: string;
  resolvedWorkspaceId: string | null;
  ticket: Ticket;
  client: SlackClient;
  requesterId: string;
  question: string;
}): Promise<Ticket> {
  const organizerChannel = getOrganizerChannel(prog, resolvedWorkspaceId);
  if (!organizerChannel) {
    log.error(
      "tickets",
      `no organizer channel configured for program ${programId} — ticket #${ticket.id} card not posted`,
    );
    return ticket;
  }
  if (client && client.chat && (client.chat as { postMessage?: unknown }).postMessage) {
    try {
      let candidates: TicketCandidate[] = [];
      try {
        candidates = helperRoute.recommend({
          programId,
          category: ticket.category,
          limit: 5,
          ...routingOptions(prog, ticket),
        });
      } catch (e) {
        log.debug("tickets", `helper recommendation failed: ${errorMessage(e)}`);
      }
      const cardBlocks = reply.plainDashesInBlocks(buildTicketCardBlocks(ticket, prog, candidates));
      const res = await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: organizerChannel,
        text: reply.plainDashes(
          `[Ticket #${ticket.id}] <@${requesterId}> asked: "${reply.escapeSlack(question).slice(0, 100)}"`,
        ),
        blocks: cardBlocks,
      });
      if (res?.ts) {
        if (db.updateTicketCardTs(ticket.id, res.ts)) {
          ticket.card_ts = res.ts;
        } else if (client.chat.delete) {
          await client.chat
            .delete({ channel: organizerChannel, ts: res.ts })
            .catch((e) => recordSlackSyncFailure("card_duplicate_delete", ticket, e as SlackError));
        }
      }
    } catch (e) {
      recordSlackSyncFailure("card_post", ticket, e as SlackError);
      log.error(
        "tickets",
        `failed to post ticket card to organizer channel ${organizerChannel} for program ${programId}: ${errorMessage(e)}`,
      );
    }
  }
  return ticket;
}

async function escalateTicket({
  program,
  channel,
  threadTs,
  requesterId,
  question,
  client,
  workspaceId = null,
  placeholder = null,
  bypassIncidentMatch = false,
  role = null,
  handoffReason = null,
  sources = [],
  attempts = [],
}: {
  program: Program | null;
  channel: string;
  threadTs: string;
  requesterId: string;
  question: string;
  client: SlackClient;
  workspaceId?: string | null;
  placeholder?: string | null;
  bypassIncidentMatch?: boolean;
  role?: string | null;
} & HandoffDetails): Promise<Ticket | null> {
  const { prog, programId, resolvedWorkspaceId } = resolveProg({ program, channel, workspaceId });
  const existing = db.getTicketByThreadTs(threadTs, resolvedWorkspaceId, prog?.id || null);

  const inc = await checkIncident({
    prog,
    programId,
    question,
    ticket: existing,
    client,
    channel,
    threadTs,
    requesterId,
    resolvedWorkspaceId,
    placeholder,
    bypassIncidentMatch,
  });
  if (inc.done) return inc.ticket || existing || null;

  const ticket = await ensureSupportTicket({
    program: prog,
    channel,
    threadTs,
    requesterId,
    question,
    client,
    workspaceId: resolvedWorkspaceId,
    paging: true,
    role,
  });
  if (!ticket) {
    if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
    return null;
  }

  const promoted = CLOSED.includes(ticket.status)
    ? ticket
    : markWaitingForHelper({
        ticketId: ticket.id,
        client,
        program: prog,
        question,
        role,
        explicit: true,
        handoffReason,
        sources,
        attempts,
      });
  if (placeholder) await reply.discardPlaceholder(client, channel, placeholder);
  log.info("tickets", `escalated ticket #${ticket.id} for ${programId} in ${channel}`);
  return promoted || ticket;
}

function getOrCreateOpenTicket({
  program,
  channel,
  threadTs,
  requesterId,
  question,
  workspaceId = null,
  role = null,
}: {
  program: Program | null;
  channel: string;
  threadTs: string;
  requesterId: string;
  question: string;
  workspaceId?: string | null;
  role?: string | null;
}): Ticket | null {
  if (!threadTs) return null;
  const prog = program || (channel ? programs.forChannel(channel, workspaceId) : null);
  const resolvedWorkspaceId = workspaceId || (prog ? prog.workspaceId || prog.workspace_id || null : null);
  const existing = db.getTicketByThreadTs(threadTs, resolvedWorkspaceId);
  if (existing) return existing;
  if (!ticketCreationAllowed({ prog, channel, workspaceId: resolvedWorkspaceId, role })) return null;
  if (!prog) return null;
  const id = db.createTicket({
    programId: prog.id,
    workspaceId: resolvedWorkspaceId,
    channel,
    threadTs,
    requesterId,
    question,
    visibility: prog.publicTicketsEnabled === false ? "dashboard" : prog.ticketVisibility || "thread",
  });
  if (!id) return db.getTicketByThreadTs(threadTs, resolvedWorkspaceId, prog.id);
  applyCategory(id, { prog, channel, question });
  const ticket = db.getTicket(id);
  if (!db.listTicketEvents(id).some((e) => e.event_type === "created")) {
    recordTransition(ticket, requesterId, "created", {
      channel,
      workspaceId: resolvedWorkspaceId,
      source: "eligible_question",
    });
  }
  return db.getTicket(id) || ticket;
}

function creditThreadReply(ticket: Ticket, userId: string): void {
  try {
    const already = db
      .listTicketEvents(ticket.id)
      .some((event) => event.event_type === "helper_reply" && event.actor_id === userId);
    if (already) return;
    recordTransition(ticket, userId, "helper_reply", { via: "thread" });
    db.recordFirstResponse(ticket.id, true);
    helperRoute.recordReply({ programId: ticket.program_id, userId, category: ticket.category });
  } catch (e) {
    log.debug("tickets", `thread reply credit failed for #${ticket.id}: ${errorMessage(e)}`);
  }
}

function noteHelperEngaged({
  channel,
  threadTs,
  userId,
  parentUserId,
  workspaceId,
}: {
  channel: string;
  threadTs: string;
  userId: string;
  parentUserId?: string | null;
  workspaceId?: string | null;
}): void {
  if (!parentUserId || parentUserId === userId) return;
  try {
    const prog = programs.forChannel(channel, workspaceId);
    if (!prog || !isActorAllowed(prog.id, userId, false)) return;
    if (!db.isTakeover(threadTs)) db.markTakeover(threadTs, channel, userId);
  } catch (e) {
    log.debug("tickets", `helper engagement mark failed: ${errorMessage(e)}`);
  }
}

function noteThreadActivity({
  channel,
  threadTs,
  userId,
  text = null,
  workspaceId = null,
  client = null,
  parentUserId = null,
}: {
  channel: string;
  threadTs: string;
  userId: string;
  text?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  parentUserId?: string | null;
}): Ticket | null {
  if (!threadTs || !userId) return null;
  noteHelperEngaged({ channel, threadTs, userId, parentUserId, workspaceId });
  let ticket = db.getTicketByThreadTs(threadTs, workspaceId);
  if (!ticket) return null;
  const prog = programs.get(ticket.program_id);
  ticket = reclassifyOnFollowUp(ticket, { prog, question: text, requesterId: userId });
  if (userId !== ticket.requester_id && isActorAllowed(ticket.program_id, userId, false)) {
    creditThreadReply(ticket, userId);
  }
  let updated = ticket;
  if (CLOSED.includes(ticket.status)) {
    if (userId !== ticket.requester_id) return ticket;
    if (!db.reopenResolvedTicket(ticket.id, userId)) return db.getTicket(ticket.id);
    updated = db.getTicket(ticket.id);
    recordTransition(updated, userId, "reopened", { by: "requester" });
    startNewEpoch(updated);
    log.info("tickets", `reopened ticket #${ticket.id} on requester activity`);
    const currentProg = programs.get(ticket.program_id);
    void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
    if (client?.chat?.postMessage && !programs.isShadow(currentProg)) {
      void slackMessages
        .sendProgramMessage({
          client,
          program: currentProg,
          channel: updated.channel,
          threadTs: updated.thread_ts,
          text: reply.plainDashes(`Ticket reopened by <@${userId}>.`),
        })
        .catch((e) => log.debug("tickets", `reopen notice failed for #${updated.id}: ${errorMessage(e)}`));
    }
  }
  try {
    require("./resolutionWatcher").schedule({ ticketId: updated.id, client, program: prog });
  } catch (e) {
    log.debug("tickets", `resolution watcher schedule failed for #${updated.id}: ${errorMessage(e)}`);
  }
  return updated;
}

function claimTicket({
  ticketId,
  actorId,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId: string;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.claimTicket(ticketId, actorId);
  if (!ok) return { error: "ticket is not open" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "claimed");
  try {
    assignmentLifecycle.recordClaim({ ticket: updated, userId: actorId });
  } catch (e) {
    log.debug("tickets", `claim lifecycle record failed for #${ticketId}: ${errorMessage(e)}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts)
    void syncCard(client, updated, `[Ticket #${updated.id}] Claimed by <@${actorId}>`).catch(() => {});
  return { ok: true, ticket: updated };
}

function unclaimTicket({
  ticketId,
  actorId = null,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  if (!WORKABLE.includes(ticket.status) || !ticket.assignee_id) {
    return { error: "ticket is not claimed" };
  }
  const releasedBy = ticket.assignee_id;
  const ok = db.unclaimTicket(ticketId);
  if (!ok) return { error: "ticket could not be unclaimed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "unclaimed");
  try {
    assignmentLifecycle.recordRelease({ ticket: updated, userId: releasedBy });
    assignmentLifecycle.recordOffer({ ticket: updated, to: null, source: "released" });
  } catch (e) {
    log.debug("tickets", `release lifecycle record failed for #${ticketId}: ${errorMessage(e)}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts)
    void syncCard(client, updated, `[Ticket #${updated.id}] Released to the queue`).catch(() => {});
  return { ok: true, ticket: updated };
}

function declineAssignment({
  ticketId,
  actorId = null,
  reason = null,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
  role = null,
}: {
  ticketId: number;
  actorId?: string | null;
  reason?: unknown;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
  role?: string | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  if (!actorId) return { error: "actorId required" };
  if (CLOSED.includes(ticket.status)) return { error: "ticket is already closed" };
  if (ticket.assignee_id === actorId) {
    return { error: "you have claimed this ticket — release it instead of declining" };
  }
  const wasTargetedAtDecliner = assignmentLifecycle.openOfferFor(ticket.program_id, ticketId)?.to === actorId;
  const res = assignmentLifecycle.recordDecline({ ticket, userId: actorId, reason });
  if (!res.recorded) return { ok: true, ticket, deduped: true };
  recordTransition(ticket, actorId, "assignment_declined", reason ? { reason: String(reason).slice(0, 40) } : null);
  if (client && ticket.card_ts)
    void syncCard(client, db.getTicket(ticketId), `[Ticket #${ticket.id}] <@${actorId}> passed`).catch(() => {});

  if (wasTargetedAtDecliner && client) {
    const prog = program || programs.get(ticket.program_id);
    const pol = policyFor(prog, { channel: ticket.channel, workspaceId: ticket.workspace_id, role });
    if (pol ? pol.pingHelpers : prog && prog.helperPing === true) {
      const next = assignmentLifecycle.nextEligibleHelper({
        programId: ticket.program_id,
        ticketId,
        category: ticket.category,
        exclude: ticket.requester_id ? [ticket.requester_id] : [],
        expertiseRouting: pol ? pol.expertiseRouting : true,
      });
      if (next) {
        void pingSpecificHelper({
          client,
          ticket: db.getTicket(ticketId),
          program: prog,
          userId: next.userId,
          source: "reassign_ping",
          role,
        }).catch((e) => {
          log.warn("tickets", `reassign ping failed for #${ticketId}: ${errorMessage(e)}`);
        });
      }
    }
  }
  return { ok: true, ticket };
}

function resolveTicketWorker(ticket: Ticket | null, resolvingActorId: string | null = null): string | null {
  if (!ticket || !ticket.program_id || !ticket.id) return null;
  const helpers = new Set(db.listHelpers(ticket.program_id, false).map((helper) => helper.user_id));
  const activeHelpers = new Set(db.listHelpers(ticket.program_id, true).map((helper) => helper.user_id));
  const replies = db
    .handle()
    .query(
      `SELECT actor_id FROM ticket_events
     WHERE ticket_id = ? AND event_type = 'helper_reply' AND actor_id IS NOT NULL
     ORDER BY created_at DESC, id DESC`,
    )
    .all(ticket.id);
  const latestHelperReply = replies.find((event) => !!event.actor_id && helpers.has(event.actor_id));
  if (latestHelperReply?.actor_id) return latestHelperReply.actor_id;
  if (ticket.assignee_id) return ticket.assignee_id;
  return resolvingActorId && activeHelpers.has(resolvingActorId) ? resolvingActorId : null;
}

function finishResolve(options: FinishResolveOptions): FinishResult {
  const {
    ticket,
    actorId,
    resolution,
    source = null,
    resolutionMeta = null,
    client = null,
    resolvedAt = null,
    creditId = null,
  } = options;
  const resText = resolution || (actorId ? `resolved by <@${actorId}>` : "resolved");
  const ok = db.resolveTicket(ticket.id, resText, actorId || null, resolvedAt);
  if (!ok) return { error: "ticket could not be resolved" };
  const updated = db.getTicket(ticket.id);
  const detail = source || resolutionMeta ? { ...(source ? { source } : {}), ...(resolutionMeta || {}) } : null;
  recordTransition(updated, actorId, "resolved", detail, resolvedAt);
  let workerId = null;
  try {
    workerId = creditId || resolveTicketWorker(ticket, actorId);
    db.handle()
      .query("UPDATE tickets SET resolved_credit_id = ?, resolved_by = COALESCE(resolved_by, ?) WHERE id = ?")
      .run(workerId, actorId ? null : workerId, ticket.id);
    if (workerId)
      helperRoute.recordResolution({ programId: ticket.program_id, userId: workerId, category: ticket.category });
  } catch (e) {
    log.warn("tickets", `recordResolution failed: ${errorMessage(e)}`);
  }
  if (source !== "backfill") resolutionPipeline.schedule({ ticket: updated, client, actorId, workerId });
  return {
    updated,
    cardText: `[Ticket #${updated.id}] Resolved`,
    ackText: `✅ Resolved${actorId ? ` by <@${actorId}>` : ""}.`,
  };
}

function resolveTicket(options: ResolveTicketOptions): TicketActionResult {
  const {
    ticketId,
    actorId = null,
    resolution = null,
    source = null,
    resolutionMeta = null,
    programId = null,
    workspaceId = null,
    client = null,
    program = null,
    resolvedAt = null,
    creditId = null,
  } = options;
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const d = finishResolve({ ticket, actorId, resolution, source, resolutionMeta, client, resolvedAt, creditId });
  if (d.error || !d.updated) return d;
  const prog = program || programs.get(ticket.program_id);
  if (source !== "backfill") void reconcileTicketUI({ client, ticket: d.updated, program: prog, cardText: d.cardText });
  return { ok: true, ticket: d.updated };
}

function publicResolveTicket({
  ticketId,
  actorId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  if (CLOSED.includes(ticket.status)) return { ok: true, ticket, deduped: true };
  const isRequester = actorId && actorId === ticket.requester_id;
  const isHelper = actorId && isActorAllowed(ticket.program_id, actorId, false);
  if (!isRequester && !isHelper) return { error: "not_authorized" };
  const d = finishResolve({ ticket, actorId, resolution: null, client });
  if (d.error || !d.updated) return d;
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: d.updated, program: prog, cardText: d.cardText });
  return { ok: true, ticket: d.updated };
}

async function publicReopenTicket({
  ticketId,
  actorId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): Promise<TicketActionResult> {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return { error: "ticket not found" };
  if (workspaceId && ticket.workspace_id && ticket.workspace_id !== workspaceId) return { error: "workspace mismatch" };
  const isRequester = actorId && actorId === ticket.requester_id;
  const isHelper = actorId && isActorAllowed(ticket.program_id, actorId, false);
  if (!isRequester && !isHelper) return { error: "not_authorized" };
  if (!CLOSED.includes(ticket.status)) return { ok: true, ticket, deduped: true };
  const ok = db.reopenResolvedTicket(ticketId, actorId || null);
  if (!ok) return { ok: true, ticket: db.getTicket(ticketId), deduped: true };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened", { by: isRequester ? "requester" : "helper" });
  startNewEpoch(updated);
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
  if (client?.chat?.postMessage) {
    try {
      await slackMessages.sendProgramMessage({
        client,
        program: prog,
        channel: updated.channel,
        threadTs: updated.thread_ts,
        text: reply.plainDashes(`Ticket reopened${actorId ? ` by <@${actorId}>` : ""}.`),
      });
    } catch (e) {
      log.debug("tickets", `reopen notice failed for #${updated.id}: ${errorMessage(e)}`);
    }
  }
  return { ok: true, ticket: updated };
}

function assignTicket({
  ticketId,
  actorId = null,
  assigneeId,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  assigneeId: string;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  if (!assigneeId) return { error: "assigneeId required" };
  let helpers: HelperRecord[] = [];
  try {
    helpers = db.listHelpers(ticket.program_id);
  } catch (e) {
    log.debug("tickets", `listHelpers failed during assign: ${errorMessage(e)}`);
  }
  const memberIds = new Set(helpers.map((h) => h.user_id));
  let actorOk = true;
  let assigneeOk = true;
  try {
    if (actorId && helpers.length > 0 && !memberIds.has(actorId) && !(isAdmin && isAdmin(actorId))) actorOk = false;
  } catch (e) {
    log.debug("tickets", `actor isAdmin check failed during assign: ${errorMessage(e)}`);
  }
  try {
    if (helpers.length > 0 && !memberIds.has(assigneeId) && !(isAdmin && isAdmin(assigneeId))) assigneeOk = false;
  } catch (e) {
    log.debug("tickets", `assignee isAdmin check failed during assign: ${errorMessage(e)}`);
  }
  if (!actorOk) return { error: "actor is not a helper of this program" };
  if (!assigneeOk) return { error: "assignee is not a helper of this program" };
  const ok = db.assignTicket(ticketId, assigneeId);
  if (!ok) return { error: "ticket is not assignable" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "assigned", { to: assigneeId });
  try {
    assignmentLifecycle.recordOffer({
      ticket: updated,
      to: assigneeId,
      source: actorId ? "reassign" : "auto",
      actorId,
    });
  } catch (e) {
    log.debug("tickets", `assign offer record failed for #${ticketId}: ${errorMessage(e)}`);
  }
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts)
    void syncCard(client, updated, `[Ticket #${updated.id}] Assigned to <@${assigneeId}>`).catch(() => {});
  return { ok: true, ticket: updated };
}

function snoozeTicket({
  ticketId,
  actorId = null,
  until,
  programId = null,
  workspaceId = null,
}: {
  ticketId: number;
  actorId?: string | null;
  until: number;
  programId?: string | null;
  workspaceId?: string | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const untilNum = Number(until);
  if (!until || !Number.isFinite(untilNum) || untilNum <= Date.now()) {
    return { error: "valid future until required" };
  }
  const ok = db.snoozeTicket(ticketId, untilNum);
  if (!ok) return { error: "ticket could not be snoozed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "snoozed", { until: untilNum });
  return { ok: true, ticket: updated };
}

function duplicateTicket({
  ticketId,
  actorId = null,
  canonicalId,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  canonicalId: number;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const canon = Number(canonicalId);
  if (!canonicalId || !Number.isInteger(canon) || canon === ticketId)
    return { error: "valid canonicalId required (must differ from the ticket)" };
  const target = db.getTicket(canon);
  if (!target || target.program_id !== ticket.program_id)
    return { error: "canonical ticket must exist in the same program" };
  const ok = db.markDuplicateTicket(ticketId, canon);
  if (!ok) return { error: "ticket could not be marked duplicate" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "duplicate", { of: canon });
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts)
    void syncCard(client, updated, `[Ticket #${updated.id}] Duplicate of #${canon}`).catch(() => {});
  return { ok: true, ticket: updated };
}

function escalateStatusTicket({
  ticketId,
  actorId = null,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.escalateTicketStatus(ticketId);
  if (!ok) return { error: "ticket could not be escalated" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "escalated");
  const prog = program || programs.get(ticket.program_id);
  if (client && updated.card_ts) void syncCard(client, updated, `[Ticket #${updated.id}] Escalated`).catch(() => {});
  return { ok: true, ticket: updated };
}

function reopenTicket({
  ticketId,
  actorId = null,
  source = null,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  source?: string | null;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.reopenTicket(ticketId, actorId || null);
  if (!ok) return { error: "ticket could not be reopened" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "reopened", source ? { source } : null);
  startNewEpoch(updated);
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Reopened` });
  return { ok: true, ticket: updated };
}

function closeTicket({
  ticketId,
  actorId = null,
  programId = null,
  workspaceId = null,
  client = null,
  program = null,
}: {
  ticketId: number;
  actorId?: string | null;
  programId?: string | null;
  workspaceId?: string | null;
  client?: SlackClient | null;
  program?: Program | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId });
  if (err) return { error: err };
  const ok = db.closeTicket(ticketId);
  if (!ok) return { error: "ticket could not be closed" };
  const updated = db.getTicket(ticketId);
  recordTransition(updated, actorId, "closed");
  const prog = program || programs.get(ticket.program_id);
  void reconcileTicketUI({ client, ticket: updated, program: prog, cardText: `[Ticket #${updated.id}] Closed` });
  return { ok: true, ticket: updated };
}

async function replyToTicket({
  ticketId,
  authorId,
  text,
  client,
  programId = null,
  workspaceId = null,
  program = null,
  source = null,
  requireOpen = false,
}: {
  ticketId: number;
  authorId: string;
  text: string;
  client: SlackClient;
  programId?: string | null;
  workspaceId?: string | null;
  program?: Program | null;
  source?: string | null;
  requireOpen?: boolean;
}): Promise<TicketActionResult> {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId: authorId });
  if (err) return { error: err };
  if (requireOpen && ![...CLAIMABLE, ...WORKABLE, "escalated"].includes(ticket.status))
    return { error: "ticket is not open" };
  const clean = String(text || "").trim();
  if (!clean) return { error: "reply text required" };
  const prog = program || programs.get(ticket.program_id);
  if (programs.isShadow(prog)) {
    return { error: "program is in shadow mode — cut over before replying from here" };
  }
  if (!client || !client.chat || typeof client.chat.postMessage !== "function") {
    return { error: "slack client unavailable" };
  }
  const attribution = source === "dashboard" && authorId ? `\n\n_sent by <@${authorId}> via the dashboard_` : "";
  let ts = null;
  try {
    const res = await slackMessages.sendProgramMessage({
      client,
      program: prog,
      channel: ticket.channel,
      threadTs: ticket.thread_ts,
      text: `${reply.plainDashes(clean)}${attribution}`,
    });
    ts = res?.ts || null;
  } catch (e) {
    log.error("tickets", `dashboard reply failed for #${ticketId}: ${errorMessage(e)}`);
    return { error: errorMessage(e) };
  }
  db.recordFirstResponse(ticketId, true);
  try {
    helperRoute.recordReply({ programId: ticket.program_id, userId: authorId, category: ticket.category });
  } catch (e) {
    log.debug("tickets", `reply expertise record failed for #${ticketId}: ${errorMessage(e)}`);
  }
  const refreshed = db.getTicket(ticketId);
  recordTransition(refreshed, authorId, "helper_reply", { ts, text: clean });
  try {
    require("./resolutionWatcher").schedule({ ticketId, client, program: prog });
  } catch (e) {
    log.debug("tickets", `resolution watcher schedule failed for #${ticketId}: ${errorMessage(e)}`);
  }
  return { ok: true, ts, ticket: refreshed };
}

function addInternalNote({
  ticketId,
  authorId,
  body,
  programId = null,
  workspaceId = null,
}: {
  ticketId: number;
  authorId: string;
  body: string;
  programId?: string | null;
  workspaceId?: string | null;
}): TicketActionResult {
  const ticket = db.getTicket(ticketId);
  const err = authorize(ticket, { programId, workspaceId, actorId: authorId });
  if (err) return { error: err };
  const clean = String(body || "").trim();
  if (!clean) return { error: "note body required" };
  const id = db.addTicketNote({ ticketId, programId: ticket.program_id, authorId, body: clean });
  if (!id) return { error: "could not save note" };
  recordTransition(ticket, authorId, "note_added", { noteId: id });
  return { ok: true, noteId: id };
}

function parseTicketAction(action: TicketActionInput, body: TicketActionBody): ParsedTicketAction {
  const raw = action?.selected_option?.value || action?.value || "";
  const [idStr, extra] = String(raw).split(":");
  return {
    ticketId: Number(idStr),
    actorId: body?.user?.id || null,
    workspaceId: body?.team?.id || body?.team_id || null,
    assigneeId: extra || null,
    triggerId: body?.trigger_id || null,
  };
}

function registerActions(app: TicketActionApp): void {
  app.action("claim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    await claimTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("unclaim_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await unclaimTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("decline_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await declineAssignment({ ticketId, actorId, workspaceId, client });
    const channel = body.channel?.id;
    let text = null;
    if (res.ok) text = `Noted — you passed on ticket #${ticketId}. It stays open for the others.`;
    else if (res.error && res.error.startsWith("you have claimed this ticket")) {
      text = "You've claimed this one — use Release if you can't continue.";
    }
    if (!channel || !text || !client?.chat) return;
    try {
      await client.chat.postEphemeral({ channel, user: actorId, text });
    } catch (e) {
      log.debug("tickets", `decline ack failed for #${ticketId}: ${errorMessage(e)}`);
    }
  });

  app.action("resolve_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await resolveTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("reopen_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await reopenTicket({ ticketId, actorId, workspaceId, client });
  });

  app.action("close_ticket", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId) return;
    await closeTicket({ ticketId, actorId, workspaceId, client });
  });

  const onPublicResolve = async ({ action, body, ack, client }: TicketActionPayload) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await publicResolveTicket({ ticketId, actorId, workspaceId, client });
    if (res.error === "not_authorized") {
      try {
        await client.chat.postEphemeral({
          channel: body.channel?.id as string,
          user: actorId,
          text: "Only the person who asked, or a helper, can resolve this one.",
        });
      } catch (e) {
        log.debug("tickets", `ephemeral notice failed: ${errorMessage(e)}`);
      }
    }
  };
  app.action(SUPPORT_RESOLVE_ACTION, onPublicResolve);
  app.action("public_resolve_ticket", onPublicResolve);

  app.action(SUPPORT_REOPEN_ACTION, async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId } = parseTicketAction(action, body);
    if (!ticketId || !actorId) return;
    const res = await publicReopenTicket({ ticketId, actorId, workspaceId, client });
    if (res.error === "not_authorized") {
      try {
        await client.chat.postEphemeral({
          channel: body.channel?.id as string,
          user: actorId,
          text: "Only the person who asked, or a helper, can reopen this one.",
        });
      } catch (e) {
        log.debug("tickets", `ephemeral notice failed: ${errorMessage(e)}`);
      }
    }
  });

  app.action("reassign_select", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, actorId, workspaceId, assigneeId } = parseTicketAction(action, body);
    if (!ticketId || !assigneeId) return;
    await assignTicket({ ticketId, actorId, assigneeId, workspaceId, client });
  });

  app.action("reply_ticket_button", async ({ action, body, ack, client }) => {
    await ack();
    const { ticketId, triggerId } = parseTicketAction(action, body);
    if (!ticketId || !triggerId) return;
    try {
      await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          callback_id: "ticket_reply_modal_submit",
          private_metadata: JSON.stringify({ ticketId }),
          title: { type: "plain_text", text: `Reply to #${ticketId}`.slice(0, 24) },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "reply_block",
              label: { type: "plain_text", text: "Message to the requester" },
              element: { type: "plain_text_input", action_id: "reply_text", multiline: true },
            },
          ],
        },
      });
    } catch (e) {
      log.warn("tickets", `failed to open reply modal for #${ticketId}: ${errorMessage(e)}`);
    }
  });

  app.view("ticket_reply_modal_submit", async ({ ack, body, view, client }) => {
    let ticketId = null;
    try {
      ({ ticketId } = JSON.parse(view.private_metadata || "{}"));
    } catch (e) {
      log.debug("tickets", `failed to parse view metadata: ${errorMessage(e)}`);
      await ack({ response_action: "errors", errors: { reply_block: "could not read ticket — reopen and try again" } });
      return;
    }
    const text = view.state.values.reply_block?.reply_text?.value || "";
    const userId = body.user?.id as string;
    const workspaceId = body.team?.id || null;
    const res = await replyToTicket({ ticketId: Number(ticketId), authorId: userId, text, client, workspaceId });
    if (res.error) {
      await ack({ response_action: "errors", errors: { reply_block: res.error.slice(0, 100) } });
      return;
    }
    await ack();
  });
}

export = {
  buildTicketCardBlocks,
  escalateTicket,
  ensureSupportTicket,
  supportTicketBlocks,
  syncSupportTicketUI,
  reconcileTicketUI,
  markWaitingForHelper,
  pingRecommendedHelper,
  handOffToHelper,
  pingThreadHelper,
  noteThreadActivity,
  getOrganizerChannel,
  getTicketCardDestination,
  claimTicket,
  unclaimTicket,
  declineAssignment,
  resolveTicket,
  publicResolveTicket,
  publicReopenTicket,
  SUPPORT_RESOLVE_ACTION,
  SUPPORT_REOPEN_ACTION,
  ticketRef,
  friendlyStatusLabel,
  ticketStatusLabel,
  getOrCreateOpenTicket,
  TICKET_STATUS_LABELS,
  assignTicket,
  snoozeTicket,
  duplicateTicket,
  escalateStatusTicket,
  reopenTicket,
  closeTicket,
  replyToTicket,
  addInternalNote,
  registerActions,
  isActorAllowed,
  authorize,
  resolveTicketWorker,
  parseTicketAction,
  ticketPolicy,
  resolveTicketRole,
};
