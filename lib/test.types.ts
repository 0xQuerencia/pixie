import type { Ticket } from "./types";
import type { SlackBlock } from "./tickets.types";

export interface TestRow {
  id: number;
  status: string;
  category: string | null;
  category_source: string | null;
  event_type: string;
  actor_id: string | null;
  detail: string | null;
  program_id: string;
  thread_ts: string;
  channel: string;
  user_id: string;
  action: string;
  c: number;
  lastInsertRowid: number;
  notified_at: number | null;
  auto_assign: number;
  answer: string;
  resolver_id: string | null;
  resolution_summary: string;
  updated_at: number;
  created_at: number;
  [key: string]: unknown;
}

export interface TestQuery {
  all(...args: unknown[]): TestRow[];
  get(...args: unknown[]): TestRow;
  run(...args: unknown[]): TestRow;
}

export interface TestDb {
  addTicketEvent(...args: unknown[]): unknown;
  approvedFacts(...args: unknown[]): Array<{ question: string; answer: string }>;
  assignTicket(...args: unknown[]): boolean;
  claimMessage(...args: unknown[]): unknown;
  claimProgramChannel(...args: unknown[]): unknown;
  close(...args: unknown[]): unknown;
  createTicket(...args: unknown[]): number;
  getHistoryImportProgress(...args: unknown[]): TestRow | null;
  getResolutionSummary(...args: unknown[]): { resolution_summary: string } | null;
  getTicket(...args: unknown[]): Ticket;
  getTicketByThreadTs(...args: unknown[]): Ticket | null;
  getTicketsForProgram(...args: unknown[]): Ticket[];
  handle(...args: unknown[]): { query(...queryArgs: unknown[]): TestQuery };
  isHelper(...args: unknown[]): boolean;
  isTakeover(...args: unknown[]): boolean;
  listAuditEvents(...args: unknown[]): TestRow[];
  listHelpers(...args: unknown[]): TestRow[];
  listReviewableLearnedFacts(...args: unknown[]): TestRow[];
  listTicketEvents(...args: unknown[]): TestRow[];
  listTicketNotes(...args: unknown[]): TestRow[];
  learnedFactForTicket(...args: unknown[]): TestRow | null;
  markTakeover(...args: unknown[]): unknown;
  markTicketWaitingForHelper(...args: unknown[]): boolean;
  muteThread(...args: unknown[]): unknown;
  open(...args: unknown[]): unknown;
  recordFirstResponse(...args: unknown[]): unknown;
  removeHelper(...args: unknown[]): unknown;
  resolveTicket(...args: unknown[]): boolean;
  saveProgram(...args: unknown[]): unknown;
  setHelperPingEligible(...args: unknown[]): boolean;
  setResolutionSummary(...args: unknown[]): unknown;
  snoozeTicket(...args: unknown[]): boolean;
  syncHelper(...args: unknown[]): unknown;
  updateTicketCardTs(...args: unknown[]): boolean;
  upsertHistoryImportProgress(...args: unknown[]): unknown;
}

export interface TestActionResult {
  ok?: boolean;
  error?: string;
  ticket?: Ticket | null;
  updated?: Ticket;
  [key: string]: unknown;
}

export interface TestTickets {
  addInternalNote(...args: unknown[]): TestActionResult;
  assignTicket(...args: unknown[]): TestActionResult;
  buildTicketCardBlocks(...args: unknown[]): SlackBlock[];
  claimTicket(...args: unknown[]): TestActionResult;
  closeTicket(...args: unknown[]): TestActionResult;
  declineAssignment(...args: unknown[]): TestActionResult;
  ensureSupportTicket(...args: unknown[]): Promise<Ticket | null>;
  escalateTicket(...args: unknown[]): Promise<Ticket | null>;
  getOrCreateOpenTicket(...args: unknown[]): Ticket | null;
  getOrganizerChannel(...args: unknown[]): string | null;
  handOffToHelper(...args: unknown[]): Promise<Ticket | string | null>;
  markWaitingForHelper(...args: unknown[]): Ticket | null;
  noteThreadActivity(...args: unknown[]): Ticket | null;
  pingRecommendedHelper(...args: unknown[]): Promise<string | null>;
  publicReopenTicket(...args: unknown[]): Promise<TestActionResult>;
  publicResolveTicket(...args: unknown[]): TestActionResult;
  reconcileTicketUI(...args: unknown[]): Promise<boolean | undefined>;
  registerActions(...args: unknown[]): void;
  reopenTicket(...args: unknown[]): TestActionResult;
  replyToTicket(...args: unknown[]): Promise<TestActionResult>;
  resolveTicket(...args: unknown[]): TestActionResult;
  resolveTicketWorker(...args: unknown[]): string | null;
  snoozeTicket(...args: unknown[]): TestActionResult;
  unclaimTicket(...args: unknown[]): TestActionResult;
}

export interface TestIncident {
  id: number;
  status: string;
  title: string;
  description?: string | null;
  declared_by?: string | null;
  confirmed_at?: number | null;
  reason?: string;
  confidence?: number;
  deduped?: boolean;
  linked?: number;
  incidentId?: number;
  ticketId?: number;
  question?: string;
  similarity?: number;
  resolved_at?: number | null;
  draft?: string;
  ticketCount?: number;
  [key: string]: unknown;
}

export interface TestIncidentApi {
  affectedReports(...args: unknown[]): Array<{ thread_ts: string; notified_at: number | null }>;
  createIncident(...args: unknown[]): { ok?: boolean; error?: string; incident: TestIncident };
  declareIncident(...args: unknown[]): { ok?: boolean; error?: string; incident: TestIncident };
  detectBursts(...args: unknown[]): { candidates: TestIncident[]; suppressed: TestIncident[]; error?: string };
  getIncident(...args: unknown[]): TestIncident | null;
  incidentTickets(...args: unknown[]): TestIncident[];
  incidentClusterQuestions(...args: unknown[]): string[][];
  listIncidents(...args: unknown[]): TestIncident[];
  draftAnnouncement(...args: unknown[]): { ok?: boolean; error?: string; draft?: string; ticketCount?: number };
  linkTicket(...args: unknown[]): { ok?: boolean; error?: string };
  matchActiveIncident(...args: unknown[]): TestIncident | null;
  notifyAffectedUsers(...args: unknown[]): Promise<{ ok?: boolean; error?: string; notified: number; failed: number }>;
  recordAffectedReport(...args: unknown[]): unknown;
  setIncidentStatus(...args: unknown[]): { ok?: boolean; error?: string; incident: TestIncident };
  suggestDuplicates(...args: unknown[]): {
    candidates: Array<{ ticketId: number; question: string; similarity: number }>;
    error?: string;
  };
  unlinkTicket(...args: unknown[]): { ok?: boolean; error?: string };
  timeline(
    ...args: unknown[]
  ): Array<{ action: string; actorId: string | null; at: number; metadata: Record<string, unknown> | null }>;
}

export interface TestMacro {
  id: number;
  trigger: string;
  name: string;
  content: string;
  on_send_transition?: string | null;
  [key: string]: unknown;
}

export interface TestMacroApi {
  create(...args: unknown[]): { ok: boolean; error?: string; macro: TestMacro };
  interpolate(...args: unknown[]): string;
  list(...args: unknown[]): TestMacro[];
  normalizeTrigger(...args: unknown[]): string | null;
  send(...args: unknown[]): Promise<TestActionResult>;
  sendBulk(...args: unknown[]): Promise<TestActionResult>;
  suggest(...args: unknown[]): TestMacro[];
  valuesFor(...args: unknown[]): Record<string, string>;
  waitingTicketIds(...args: unknown[]): number[];
}

export interface TestMacroWebApi {
  internalMacroCreate(...args: unknown[]): { ok?: boolean; error?: string; macro: TestMacro };
  internalMacroUpdate(...args: unknown[]): { ok?: boolean; error?: string; macro: TestMacro };
  internalMacroSend(...args: unknown[]): Promise<TestActionResult>;
  internalMacroSuggest(...args: unknown[]): TestMacro[];
  internalMacroTemplates(...args: unknown[]): { templates: TestMacro[]; placeholders: Array<{ name: string }> };
  internalMacrosList(...args: unknown[]): TestMacro[];
  setSlackClient(client: unknown): void;
}

export interface TestLlm {
  complete: (...args: unknown[]) => Promise<{ text: string }>;
}

export interface TestResolutionPipeline {
  onResolved(...args: unknown[]): Promise<unknown>;
  schedule(...args: unknown[]): void;
  steps: Array<{ name: string; run: (...args: unknown[]) => Promise<unknown> }>;
}

export interface TestMemory {
  proposeFromTicket(
    ...args: unknown[]
  ): Promise<TestActionResult & { candidate: TestRow; aiExtracted?: boolean; duplicate?: boolean }>;
  approveCandidate(...args: unknown[]): TestActionResult & { fact: TestRow };
  rejectCandidate(...args: unknown[]): TestActionResult;
  validateExtraction(
    ...args: unknown[]
  ): { problem: string; solution: string; category?: string; cause?: string } | null;
  listCandidates(...args: unknown[]): TestRow[];
  CANDIDATE: string;
}

export interface TestResolutionWatcher {
  stop(...args: unknown[]): void;
  schedule(...args: unknown[]): void;
  enqueueForJudge(...args: unknown[]): void;
  drainBacklog(...args: unknown[]): Promise<{ judged?: number; reason?: string }>;
  judgeTicket(...args: unknown[]): Promise<{ result?: { ok?: boolean }; reason?: string }>;
  sweepStale(...args: unknown[]): Promise<{ judged: number }>;
}

export interface TestBackfill {
  importProgram(...args: unknown[]): Promise<unknown>;
  getProgress(...args: unknown[]): TestRow;
  stop(...args: unknown[]): void;
}
