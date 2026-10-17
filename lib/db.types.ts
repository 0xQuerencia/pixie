export interface ThreadRow {
  thread_ts: string;
  channel: string | null;
  seeded: number;
  pixie_spoke: number;
  helper_pinged: number;
  updated_at: number;
  [key: string]: unknown;
}

export type TicketRow = Ticket;

export interface ProgramRow {
  id: string;
  name: string;
  workspace_id: string | null;
  behavior: string | null;
  status: string | null;
  lifecycle: string;
  [key: string]: unknown;
}

export interface ChannelClaimRow {
  workspace_id: string;
  channel_id: string;
  program_id: string;
  kind: string;
  claimed_by: string | null;
  created_at: number;
  [key: string]: unknown;
}

export interface TicketEventRow {
  id: number;
  ticket_id: number;
  program_id: string;
  actor_id: string | null;
  event_type: string;
  detail: string | null;
  created_at: number;
  [key: string]: unknown;
}

export interface AuditEventRow {
  id: number;
  program_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: string | null;
  created_at: number;
  [key: string]: unknown;
}

export interface LearnedFactRow {
  id: number;
  program_id: string;
  question: string;
  answer: string;
  status: string;
  category: string | null;
  created_at: number;
  updated_at: number | null;
  [key: string]: unknown;
}

export interface LearnedRow {
  id: number;
  question: string;
  answer: string;
  author_id?: string | null;
  created_at?: number | string | null;
  ask_count?: number;
}
import type { Ticket } from "./types";
