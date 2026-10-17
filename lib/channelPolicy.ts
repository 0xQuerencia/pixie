import programs = require("./programs");
import programModel = require("./programModel");
import type { Program } from "./types";

function isMainChannel(program: Program | null, channelId: string | null, workspaceId: string | null) {
  if (!program || !channelId) return false;
  if (program.helpChannel === channelId) return false;
  const claim = require("./db").getChannelOwner(workspaceId || program.workspaceId || "default", channelId);
  return Boolean(claim && claim.program_id === program.id && claim.kind !== "help" && claim.kind !== "organizer");
}

function isHelpChannel(program: Program | null, channelId: string | null, workspaceId: string | null) {
  if (!program || !channelId) return false;
  try {
    const claim = require("./db").getChannelOwner(workspaceId || "default", channelId);
    return Boolean(claim && claim.program_id === program.id && claim.kind === "help");
  } catch (_: unknown) {
    return false;
  }
}

function isOrganizerChannel(program: Program | null, channelId: string | null, workspaceId: string | null) {
  if (!program || !channelId) return false;
  try {
    const claim = require("./db").getChannelOwner(workspaceId || "default", channelId);
    return Boolean(claim && claim.program_id === program.id && claim.kind === "organizer");
  } catch (_: unknown) {
    return false;
  }
}

function organizerSettings(main: Record<string, unknown>) {
  return Object.freeze({
    ...main,
    ambientProgramReplies: false,
    ticketsEnabled: false,
    helperEscalationEnabled: false,
  });
}

function resolve(channelId: string, workspaceId: string | null = null, { isDm = false }: { isDm?: boolean } = {}) {
  // DM precedence
  const program = programs.forChannel(channelId, workspaceId);
  let role = "none";
  if (isDm) role = "dm";
  else if (isHelpChannel(program, channelId, workspaceId)) role = "help";
  else if (isOrganizerChannel(program, channelId, workspaceId)) role = "organizer";
  else if (isMainChannel(program, channelId, workspaceId)) role = "main";

  const behavior = programModel.behaviorFor(program || {});
  const status = programModel.statusFor(program || {});
  let settings =
    role === "help"
      ? behavior.help
      : role === "main"
        ? behavior.main
        : role === "organizer"
          ? organizerSettings(behavior.main)
          : null;

  if (settings && (status === "paused" || (program && program.lifecycle && program.lifecycle !== "active"))) {
    settings = Object.freeze({ ...settings, enabled: false });
  }
  return { program, role, settings, behavior, status };
}

function validate() {
  let claims = [];
  try {
    claims = require("./db").listChannelClaims?.() || [];
  } catch (_: unknown) {
    claims = [];
  }
  return programModel.validateChannelRoles({
    programs: programs.all(),
    legacyHelp: null,
    legacyMain: [],
    claims,
  });
}

export = { resolve, validate, isMainChannel, isOrganizerChannel };
