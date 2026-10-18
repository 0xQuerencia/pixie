import type { ChannelRole } from "../types";

const PROGRAM_INTENTS = new Set(["support_question", "direct_program_question", "ambiguous_followup"]);
const GENERAL_INTENTS = new Set(["addressed_general_request", "addressed_smalltalk"]);
const CHAT_INTENTS = new Set([...GENERAL_INTENTS, "human_conversation", "unrelated_chatter"]);
interface EngagementSettings {
  enabled?: boolean;
  mentionReplies?: boolean;
  generalMentionChat?: boolean;
  ambientProgramReplies?: boolean;
  escalateUnknown?: boolean;
  helperEscalationEnabled?: boolean;
}
interface EngagementResult {
  intent?: string | null;
  engage?: boolean;
  error?: string | null;
}
interface PlanOptions {
  role: ChannelRole;
  settings?: EngagementSettings | null;
  addressed?: boolean;
  addressedHow?: string;
  engagement?: EngagementResult | null;
}
type MessageKind = "program" | "general";
type FinalAction =
  "reply" | "reply_chat" | "uncertain" | "escalate" | "escalate_and_uncertain" | "escalate_and_reply_chat" | "silence";
interface FinalActionOptions {
  role: ChannelRole;
  settings?: EngagementSettings | null;
  addressed?: boolean;
  kind?: MessageKind;
  grounded?: boolean;
  hasAnswer?: boolean;
  unclear?: boolean;
  noEscalate?: boolean;
  requireGrounded?: boolean;
}

function planEngagement({ role, settings, addressed = false, addressedHow = "mention", engagement }: PlanOptions) {
  const e = engagement || {};
  if (role === "none") return { proceed: false, reason: "unclaimed_channel" };

  if (role === "dm") {
    return { proceed: true, kind: CHAT_INTENTS.has(e.intent ?? "") ? "general" : "program", reason: "dm" };
  }

  if (!settings || settings.enabled === false) return { proceed: false, reason: `${role}_disabled` };

  if (role === "main" || role === "organizer") {
    if (addressed) {
      if (settings.mentionReplies === false) return { proceed: false, reason: "mention_replies_off" };
      if (addressedHow === "thread" && (e.intent === "human_conversation" || e.intent === "unrelated_chatter")) {
        return { proceed: false, reason: "thread_chatter" };
      }
      if (CHAT_INTENTS.has(e.intent ?? "") && settings.generalMentionChat === false) {
        return { proceed: false, reason: "general_chat_off" };
      }
      if (e.error) return { proceed: true, kind: "program", reason: "addressed_classifier_error" };
      if (CHAT_INTENTS.has(e.intent ?? "") && settings.generalMentionChat !== false) {
        return { proceed: true, kind: "general", reason: "addressed_general" };
      }
      return { proceed: true, kind: "program", reason: "addressed_program" };
    }
    if (settings.ambientProgramReplies === false) return { proceed: false, reason: "ambient_off" };
    if (e.error) return { proceed: false, reason: "classifier_error_silent" };
    if (e.engage && PROGRAM_INTENTS.has(e.intent ?? ""))
      return { proceed: true, kind: "program", reason: "ambient_program_question" };
    if (e.engage && !e.intent) return { proceed: true, kind: "program", noEscalate: true, reason: "ambient_engage" };
    return { proceed: false, reason: "ambient_chatter" };
  }

  if (addressed) {
    if (addressedHow === "thread" && (e.intent === "human_conversation" || e.intent === "unrelated_chatter")) {
      return { proceed: false, reason: "thread_chatter" };
    }
    if (e.error) return { proceed: true, kind: "program", support: true, reason: "addressed_classifier_error" };
    if (CHAT_INTENTS.has(e.intent ?? ""))
      return { proceed: true, kind: "general", support: false, reason: "addressed_general" };
    return { proceed: true, kind: "program", support: true, reason: "addressed_support" };
  }
  if (e.error) return { proceed: true, kind: "program", support: true, reason: "classifier_error_support" };
  if (e.engage) return { proceed: true, kind: "program", support: true, reason: "help_support" };
  return { proceed: false, reason: "help_chatter" };
}

function finalAction({
  role,
  settings,
  addressed = false,
  kind = "program",
  grounded = false,
  hasAnswer = false,
  unclear = false,
  noEscalate = false,
  requireGrounded = false,
}: FinalActionOptions): FinalAction {
  if (grounded) return "reply";
  if (noEscalate && !addressed && role !== "help") return "silence";

  if (kind === "general" && hasAnswer && !unclear) return "reply_chat";

  // Program answers are never sent ungrounded
  const talk =
    kind !== "program" &&
    addressed &&
    hasAnswer &&
    !unclear &&
    !requireGrounded &&
    settings?.generalMentionChat !== false;

  if (role === "dm") return talk ? "reply_chat" : "uncertain";

  if (role === "help") {
    const s = settings || {};
    if (s.escalateUnknown !== false) {
      if (talk) return "escalate_and_reply_chat";
      return addressed ? "escalate_and_uncertain" : "escalate";
    }
    if (talk) return "reply_chat";
    return addressed ? "uncertain" : "silence";
  }

  const s = settings || {};
  if (talk) return s.helperEscalationEnabled ? "escalate_and_reply_chat" : "reply_chat";
  if (addressed) return s.helperEscalationEnabled ? "escalate_and_uncertain" : "uncertain";
  if (s.helperEscalationEnabled) return "escalate";
  return "silence";
}

export = { planEngagement, finalAction, PROGRAM_INTENTS, GENERAL_INTENTS, CHAT_INTENTS };
