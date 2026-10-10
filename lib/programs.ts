import fs = require("node:fs");
import path = require("node:path");
import configModule = require("./config");
import db = require("./db");
import log = require("./log");
import ticketCategory = require("./ticketCategory");
import type { Program, ProgramSource } from "./types";

const { config } = configModule;

interface RawProgramConfig {
  id?: string;
  name?: string;
  posture?: string;
  scope?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  deploymentMode?: string;
  deployment_mode?: string;
  supportName?: string | null;
  support_name?: string | null;
  iconUrl?: string | null;
  icon_url?: string | null;
  replySignature?: string | null;
  reply_signature?: string | null;
  aiAnswers?: boolean;
  ai_answers?: boolean;
  ticketsEnabled?: boolean;
  autoEscalate?: boolean;
  sensitiveCategories?: string[];
  sensitive_categories?: string[];
  supportActive?: boolean;
  autoAssign?: boolean;
  auto_assign?: number;
  helperPing?: boolean;
  helper_ping_enabled?: number;
  categories?: Record<string, unknown> | null;
  learning?: string;
  learning_mode?: string;
  ticketVisibility?: string;
  ticket_visibility?: string;
  shadowMode?: boolean;
  shadow_mode?: number;
  incidentMode?: string;
  incident_mode?: string;
  publicTicketsEnabled?: boolean;
  public_tickets_enabled?: number;
  helpChannel?: string | null;
  help_channel?: string | null;
  organizerChannel?: string | null;
  organizer_channel?: string | null;
  organizer_channel_id?: string | null;
  helperChannel?: string | null;
  channels?: string[];
  helperGroup?: string | null;
  helper_group?: string | null;
  sources?: ProgramSource[];
  milestones?: unknown[];
  pinnedRules?: string[];
  links?: Record<string, string>;
  behavior?: Record<string, unknown> | null;
  status?: string | null;
  [key: string]: unknown;
}

type ProgramRecord = Program & { [key: string]: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRawProgram(value: unknown): value is RawProgramConfig {
  return isRecord(value) && (value.id === undefined || typeof value.id === "string");
}

// Config precedence
const PROGRAMS_FILE = path.join(__dirname, "..", "config", "programs.json");
const SOURCES_FILE = path.join(__dirname, "..", "config", "sources.json");

const DEFAULT_WORKSPACE = "default";
const SHARED_PROGRAM_ID = "shared";

let cachedPrograms: ProgramRecord[] | null = null;

let cachedEnvRaw: string | null = null;
let cachedEnvPrograms: ProgramRecord[] | null = null;

function readJsonFile(filePath: string, fallback: unknown = null): unknown {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e: unknown) {
    log.warn("programs", `failed to read ${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

function readSourcesJson(): ProgramSource[] {
  const data = readJsonFile(SOURCES_FILE, []);
  return Array.isArray(data) ? (data as ProgramSource[]) : [];
}

function alt(p: RawProgramConfig | ProgramRecord, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof p[k] === "string" && p[k]) return p[k];
  }
  return undefined;
}

function normalizeProgram(p: RawProgramConfig): ProgramRecord {
  const ticketsEnabled = p.ticketsEnabled === false ? false : true;
  return {
    id: p.id || "",
    name: p.name || p.id || "",
    posture: (p.posture || "active") as Program["posture"],
    scope: p.scope === "program" ? "program" : "any",
    workspaceId: alt(p, "workspaceId", "workspace_id") || null,
    deploymentMode: alt(p, "deploymentMode", "deployment_mode") || "dedicated_legacy",
    supportName: alt(p, "supportName", "support_name") || null,
    iconUrl: alt(p, "iconUrl", "icon_url") || null,
    replySignature: alt(p, "replySignature", "reply_signature") || null,
    aiAnswers: p.aiAnswers === false || p.ai_answers === false ? false : true,
    ticketsEnabled,
    autoEscalate: p.autoEscalate === false ? false : true,
    sensitiveCategories: Array.isArray(p.sensitiveCategories || p.sensitive_categories)
      ? ((p.sensitiveCategories || p.sensitive_categories) as string[])
      : [],
    supportActive: p.supportActive === false ? false : true,
    autoAssign: p.autoAssign === true || p.auto_assign === 1,
    helperPing: p.helperPing === true || p.helper_ping_enabled === 1,
    categories:
      p.categories && typeof p.categories === "object"
        ? (p.categories as Record<string, unknown>)
        : ticketsEnabled
          ? ticketCategory.defaultTaxonomy()
          : null,
    // Deprecated compatibility setting; runtime learning always stays review-safe.
    learning: p.learning === "review" || p.learning_mode === "review" ? "review" : "auto",
    ticketVisibility: ["thread", "organizer", "dashboard"].includes(p.ticketVisibility || p.ticket_visibility || "")
      ? ((p.ticketVisibility || p.ticket_visibility) as Program["ticketVisibility"])
      : "thread",
    shadowMode: p.shadowMode === true || p.shadow_mode === 1,
    incidentMode: alt(p, "incidentMode", "incident_mode") || "ANSWER_AND_TRACK",
    publicTicketsEnabled: p.publicTicketsEnabled === false || p.public_tickets_enabled === 0 ? false : true,
    helpChannel: alt(p, "helpChannel", "help_channel") || null,
    organizerChannel: alt(p, "organizerChannel", "organizer_channel", "organizer_channel_id", "helperChannel") || null,
    channels: Array.isArray(p.channels) ? p.channels : [],
    helperGroup: alt(p, "helperGroup", "helper_group") || null,
    sources: Array.isArray(p.sources) ? p.sources : [],
    sharedSources: p.sharedSources === true,
    milestones: Array.isArray(p.milestones) ? p.milestones : [],
    pinnedRules: Array.isArray(p.pinnedRules)
      ? p.pinnedRules.filter((r): r is string => typeof r === "string" && Boolean(r.trim()))
      : [],
    links: p.links || {},
    behavior: p.behavior && typeof p.behavior === "object" ? p.behavior : null,
    status: p.status && ["sandbox", "live", "paused"].includes(p.status) ? (p.status as Program["status"]) : null,
  };
}

function loadEnvPrograms(): ProgramRecord[] | null {
  const raw = (process.env.PIXIE_PROGRAMS_JSON || "").trim();
  if (!raw) return null;
  if (cachedEnvRaw === raw) return cachedEnvPrograms;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    log.warn(
      "programs",
      `PIXIE_PROGRAMS_JSON is not valid JSON (${err instanceof Error ? err.message : String(err)}) — falling back to files`,
    );
    cachedEnvRaw = raw;
    cachedEnvPrograms = null;
    return null;
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.programs)
      ? parsed.programs
      : null;
  if (!list) {
    log.warn("programs", "PIXIE_PROGRAMS_JSON must be an array or { programs: [...] } — falling back to files");
    cachedEnvRaw = raw;
    cachedEnvPrograms = null;
    return null;
  }

  const usable = list.filter((p): p is RawProgramConfig => isRawProgram(p) && Boolean(p.id?.trim()));
  if (usable.length !== list.length) {
    log.warn("programs", `ignored ${list.length - usable.length} program(s) in PIXIE_PROGRAMS_JSON with no id`);
  }

  cachedEnvRaw = raw;
  cachedEnvPrograms = usable.length > 0 ? usable.map(normalizeProgram) : null;
  return cachedEnvPrograms;
}

function loadFilePrograms(): ProgramRecord[] | null {
  const fileData = readJsonFile(PROGRAMS_FILE, null);
  if (!Array.isArray(fileData) || fileData.length === 0) {
    return null;
  }
  return fileData.map((entry) => normalizeProgram(entry as RawProgramConfig));
}

function loadConfiguredPrograms(): ProgramRecord[] | null {
  return loadEnvPrograms() || loadFilePrograms();
}

function mergeSources(
  configured: ProgramSource[] | null | undefined,
  persisted: ProgramSource[] | null | undefined,
): ProgramSource[] {
  const merged = [];
  const seen = new Set();
  for (const source of [...(configured || []), ...(persisted || [])]) {
    if (!source?.name) continue;
    const key = JSON.stringify([source.name, source.type || null, source.url || null, source.content || null]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

function all(): ProgramRecord[] {
  if (cachedPrograms) return cachedPrograms;

  const fileProgs = loadConfiguredPrograms();
  let dbProgs: ProgramRecord[] = [];
  try {
    dbProgs = db.getDbPrograms() as ProgramRecord[];
  } catch (e: unknown) {
    log.warn("programs", `db program load failed: ${e instanceof Error ? e.message : String(e)}`);
    dbProgs = [];
  }

  const map = new Map<string, ProgramRecord>();
  if (fileProgs) {
    for (const p of fileProgs) {
      map.set(p.id, p);
    }
  }
  for (const p of dbProgs) {
    const configured = map.get(p.id);
    map.set(
      p.id,
      configured
        ? {
            ...configured,
            ...p,
            sources: mergeSources(configured.sources, p.sources),
            milestones: p.milestones || configured.milestones || [],
            links: p.links || configured.links || {},
            pinnedRules: p.pinnedRules || configured.pinnedRules || [],
            categories:
              p.categories ||
              configured.categories ||
              (p.ticketsEnabled !== false ? ticketCategory.defaultTaxonomy() : null),
            learning: p.learning || configured.learning || "auto",
            channels: p.channels?.length ? p.channels : configured.channels || [],
            helpChannel: p.helpChannel || configured.helpChannel || null,
            organizerChannel: p.organizerChannel || configured.organizerChannel || null,
            behavior: p.behavior || configured.behavior || null,
            status: p.status || configured.status || null,
          }
        : p,
    );
  }

  cachedPrograms = Array.from(map.values());
  return cachedPrograms;
}

function invalidate() {
  cachedPrograms = null;
  cachedEnvRaw = null;
  cachedEnvPrograms = null;
}

function emptyShared(): ProgramRecord {
  return {
    id: SHARED_PROGRAM_ID,
    name: "Shared knowledge",
    posture: "active",
    scope: "any",
    helpChannel: null,
    channels: [],
    helperGroup: null,
    sources: [],
    milestones: [],
    sharedSources: true,
    links: {},
  } as ProgramRecord;
}

function shared(): ProgramRecord {
  const envProgs = loadEnvPrograms();
  if (envProgs) {
    const fromEnv = envProgs.find((p) => p.id === SHARED_PROGRAM_ID);
    return fromEnv ? { ...fromEnv, scope: "any" } : emptyShared();
  }

  return {
    ...emptyShared(),
    sources: readSourcesJson(),
    milestones: [],
  };
}

function get(id: string | null | undefined): ProgramRecord | null {
  if (!id || id === SHARED_PROGRAM_ID) return shared();
  return all().find((p) => p.id === id) || null;
}

function hostedClaim(workspaceId: string | null, channelId: string): { program_id: string; kind: string } | null {
  try {
    return db.getChannelOwner(workspaceId || DEFAULT_WORKSPACE, channelId) as {
      program_id: string;
      kind: string;
    } | null;
  } catch (e: unknown) {
    log.debug("programs", `claim lookup failed (${channelId}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function claimedProgram(claim: { program_id: string } | null) {
  if (!claim || !claim.program_id) return null;
  return get(claim.program_id) || null;
}

function servesChannel(program: ProgramRecord, channelId: string, workspaceId: string | null) {
  if (workspaceId && program.workspaceId && program.workspaceId !== workspaceId) return false;
  return program.helpChannel === channelId || (program.channels && program.channels.includes(channelId));
}

function forChannel(channelId: string | null, workspaceId: string | null = null): ProgramRecord {
  // Hosted claims
  if (!channelId) return shared();

  const claimed = claimedProgram(hostedClaim(workspaceId, channelId));
  if (claimed) return claimed;

  const progs = all();
  const match = progs.find((p) => servesChannel(p, channelId, workspaceId));
  if (match) return match;

  return shared();
}

function isHelpChannel(channelId: string | null, workspaceId: string | null = null) {
  if (!channelId) return false;
  if (workspaceId) {
    const claim = hostedClaim(workspaceId, channelId);
    if (claim) return claim.kind === "help";
  }
  const progs = all();
  if (progs.some((p) => p.helpChannel === channelId)) return true;
  if (config?.slack?.helpChannel === channelId) return true;
  return false;
}

function helpChannelName(programId = null) {
  const p = programId ? get(programId) : all()[0] || null;
  if (p && p.helpChannel) return p.helpChannel;
  if (config?.slack?.helpChannel) return config.slack.helpChannel;
  return null;
}

function posture(programId: string | null) {
  const p = get(programId);
  return p ? p.posture || "active" : "active";
}

function deploymentMode(programId: string | null) {
  const p = get(programId);
  return p ? p.deploymentMode || "dedicated_legacy" : "dedicated_legacy";
}

function isShadow(program: string | ProgramRecord | null) {
  const p = typeof program === "string" ? get(program) : program;
  return !!p && p.shadowMode === true;
}

function isSupportActive(programId: string | null) {
  const p = get(programId);
  if (!p) return true;
  return p.supportActive !== false;
}

function ticketsEnabled(programId: string | null) {
  const p = get(programId);
  if (!p) return true;
  return p.ticketsEnabled !== false;
}

function aiAnswersEnabled(programId: string | null) {
  const p = get(programId);
  if (!p) return true;
  return p.aiAnswers !== false;
}

function scope(programId: string | null): "program" | "any" {
  const p = get(programId);
  return p && p.scope === "program" ? "program" : "any";
}

function isProgramScoped(program: string | ProgramRecord | null) {
  if (!program) return false;
  if (typeof program === "string") return scope(program) === "program";
  return program.scope === "program";
}

function saveProgram(prog: ProgramRecord) {
  db.saveProgram(prog);
  invalidate();
}

function removeProgram(id: string) {
  db.deleteProgram(id);
  invalidate();
}

function channelRow(
  channelId: string,
  {
    programId,
    programName,
    isHelp,
    posture = "active",
  }: { programId: string; programName: string; isHelp: boolean; posture?: string },
) {
  return {
    channelId,
    programId,
    programName,
    isHelpChannel: isHelp,
    isTicketDestination: isHelp,
    posture,
    replyEnabled: posture !== "muted",
    type: isHelp ? "help" : "discussion",
  };
}

function getChannelsList() {
  const progs = all();
  const channelsMap = new Map();

  for (const p of progs) {
    if (p.helpChannel) {
      channelsMap.set(
        p.helpChannel,
        channelRow(p.helpChannel, {
          programId: p.id,
          programName: p.name,
          isHelp: true,
          posture: p.posture || "active",
        }),
      );
    }
    if (Array.isArray(p.channels)) {
      for (const ch of p.channels) {
        if (!channelsMap.has(ch)) {
          channelsMap.set(
            ch,
            channelRow(ch, {
              programId: p.id,
              programName: p.name,
              isHelp: ch === p.helpChannel,
              posture: p.posture || "active",
            }),
          );
        }
      }
    }
  }

  return Array.from(channelsMap.values());
}

function withChannel(channels: string[] | null | undefined, channelId: string): string[] {
  return Array.from(new Set([...(Array.isArray(channels) ? channels : []), channelId]));
}

function stolenByAnother(programId: string, workspaceId: string | null, channelId: string) {
  if (!workspaceId) return false;
  const owner = hostedClaim(workspaceId, channelId);
  return !!owner && owner.program_id !== programId;
}

function persistChannels(program: ProgramRecord, channels: string[], helpChannel: string | null) {
  saveProgram({ ...program, channels, helpChannel });
}

function addChannelToProgram(programId: string, channelId: string, isHelp = false, workspaceId: string | null = null) {
  const p = get(programId) || all()[0] || null;
  if (!p) return false;
  if (stolenByAnother(p.id, workspaceId, channelId)) return false;

  persistChannels(p, withChannel(p.channels, channelId), isHelp ? channelId : p.helpChannel);
  if (workspaceId) {
    try {
      db.claimProgramChannel({ workspaceId, channelId, programId: p.id, kind: isHelp ? "help" : "discussion" });
    } catch (e: unknown) {
      log.warn("programs", `channel claim failed (${channelId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

function removeChannelFromProgram(programId: string, channelId: string) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(
    p,
    (Array.isArray(p.channels) ? p.channels : []).filter((c) => c !== channelId),
    p.helpChannel === channelId ? null : p.helpChannel,
  );
  return true;
}

function setChannelTicketDestination(programId: string, channelId: string) {
  const p = get(programId);
  if (!p) return false;

  persistChannels(p, withChannel(p.channels, channelId), channelId);
  return true;
}

export = {
  all,
  get,
  shared,
  forChannel,
  isHelpChannel,
  helpChannelName,
  posture,
  deploymentMode,
  isShadow,
  isSupportActive,
  ticketsEnabled,
  aiAnswersEnabled,
  scope,
  isProgramScoped,
  saveProgram,
  removeProgram,
  getChannelsList,
  addChannelToProgram,
  removeChannelFromProgram,
  setChannelTicketDestination,
  invalidate,
};
