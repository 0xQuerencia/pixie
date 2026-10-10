import type { WebClient } from "@slack/web-api";

export type SlackClient = WebClient;

export type Posture = "active" | "passive" | "muted";
export type TicketVisibility = "thread" | "organizer" | "dashboard";
export type ProgramStatus = "sandbox" | "live" | "paused";
export type ChannelRole = "main" | "help" | "organizer" | "dm" | "none";

export interface ProviderTier {
  apiKey: () => string | undefined;
  baseUrl: string;
  model: string;
  fallback?: ProviderTier | null;
  onRateLimited?: (key: string | undefined, ms?: number) => void;
}

export interface Program {
  id: string;
  name: string;
  posture: Posture;
  scope: "program" | "any";
  workspaceId: string | null;
  deploymentMode: string;
  supportName: string | null;
  iconUrl: string | null;
  replySignature: string | null;
  aiAnswers: boolean;
  ticketsEnabled: boolean;
  autoEscalate: boolean;
  sensitiveCategories: string[];
  supportActive: boolean;
  autoAssign: boolean;
  helperPing: boolean;
  categories: Record<string, unknown> | null;
  // Compatibility only; both values stay review-safe.
  learning: "auto" | "review";
  ticketVisibility: TicketVisibility;
  shadowMode: boolean;
  incidentMode: string;
  publicTicketsEnabled: boolean;
  helpChannel: string | null;
  organizerChannel: string | null;
  channels: string[];
  helperGroup: string | null;
  sources: ProgramSource[];
  sharedSources: boolean;
  milestones: unknown[];
  guides?: string[];
  pinnedRules: string[];
  links: Record<string, string>;
  behavior: Record<string, unknown> | null;
  status: ProgramStatus | null;
  requireGroundedAnswer?: boolean;
  organizer_channel?: string;
  organizer_channel_id?: string;
  workspace_id?: string | null;
  [key: string]: unknown;
}

export type BehaviorSettings = Record<string, boolean>;
export interface ProgramBehavior {
  main: BehaviorSettings;
  help: BehaviorSettings;
}

export interface ProgramSource {
  name: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ClaimEvidence {
  id: string;
  programId?: string | null;
  program_id?: string | null;
  sourceName?: string | null;
  heading?: string | null;
  text: string;
  authority?: string | null;
  kind?: string | null;
  status?: string | null;
  approved?: boolean;
  selected?: boolean;
  [key: string]: unknown;
}

export interface VerifiedClaim {
  claim: string;
  supported: boolean;
  evidenceIds: string[];
  reason: string;
}

export interface AnswerVerification {
  verdict: "supported" | "unsupported";
  sendable: boolean;
  claims: VerifiedClaim[];
  errors: string[];
}

export type TicketStatus =
  "open" | "claimed" | "waiting_for_helper" | "waiting_for_user" | "resolved" | "closed" | (string & {});

export interface Ticket {
  id: number;
  program_id: string;
  channel: string;
  thread_ts: string;
  card_ts: string | null;
  requester_id: string;
  question: string;
  status: TicketStatus;
  assignee_id: string | null;
  resolution: string | null;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  workspace_id?: string | null;
  category?: string | null;
  category_source?: string | null;
  priority?: string | null;
  summary?: string | null;
  resolution_summary?: string | null;
  resolution_summary_at?: number | null;
  ai_confidence?: number | null;
  ai_decision?: string | null;
  duplicate_of?: number | null;
  first_response_at?: number | null;
  first_human_response_at?: number | null;
  visibility?: TicketVisibility | null;
  assigned_at?: number | null;
  reopened_at?: number | null;
  reopen_count?: number;
  snoozed_until?: number | null;
  updated_at?: number | null;
  public_ack_ts?: string | null;
  resolved_by?: string | null;
  resolved_credit_id?: string | null;
  reopened_by?: string | null;
  [key: string]: unknown;
}
