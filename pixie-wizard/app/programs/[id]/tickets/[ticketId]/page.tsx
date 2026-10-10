import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreDashboardTicketDetail, coreMacrosList, type CoreTraceRow } from "@/lib/pixieCore";
import { resolveIdentities, labelFor } from "@/lib/identity";
import { PageHeader, Section, CoreError, StatusBadge, Chip, EmptyState, Mono } from "@/app/_components/DashboardShell";
import { shortTime } from "@/app/_components/format";
import { labelClass } from "@/app/wizard/_components/formStyles";
import { TicketActions, TicketComposer } from "./TicketActions";
import { CopilotPanel } from "./CopilotPanel";
import { TraceTimeline } from "./TraceTimeline";
import { MacroSendForm, type MacroRow } from "../../macros/MacroForms";

type TicketDetail = {
  ticket: {
    id: number;
    program_id: string;
    channel: string;
    thread_ts: string;
    requester_id: string;
    question: string;
    summary: string | null;
    category: string | null;
    priority: string | null;
    status: string;
    assignee_id: string | null;
    resolved_by: string | null;
    ai_confidence: number | null;
    ai_decision: string | null;
    created_at: number;
    updated_at: number;
    resolved_at: number | null;
    resolutionSummary?: string | null;
  };
  events: Array<{
    id: number;
    event_type?: string;
    kind?: string;
    actor_id: string | null;
    detail?: string | null;
    note?: string | null;
    created_at: number;
  }>;
  notes: Array<{ id: number; author_id: string; body: string; created_at: number }>;
  traces?: CoreTraceRow[];
  tracesError?: boolean;
};

// A timeline needs two things a status badge can't give: a node to hang the
// connector on, and a label that reads as prose rather than a pill. Same
// semantic map the shell's StatusBadge uses underneath — mint for what Pixie
// settled, tang for what is waiting on a person, danger for what went wrong,
// muted for the rest.
type Tone = { text: string; mark: string };

const EVENT_TONE: Record<string, Tone> = {
  created: { text: "text-text-muted", mark: "bg-line-strong" },
  ai_answered: { text: "text-mint", mark: "bg-mint" },
  answered: { text: "text-mint", mark: "bg-mint" },
  resolved: { text: "text-mint", mark: "bg-mint" },
  note_added: { text: "text-mint", mark: "bg-mint" },
  claimed: { text: "text-tang", mark: "bg-tang" },
  assigned: { text: "text-tang", mark: "bg-tang" },
  escalated: { text: "text-tang", mark: "bg-tang" },
  reopened: { text: "text-tang", mark: "bg-tang" },
  failed: { text: "text-danger", mark: "bg-danger" },
  error: { text: "text-danger", mark: "bg-danger" },
};

const MUTED_TONE: Tone = { text: "text-text-muted", mark: "bg-line-strong" };

function toneForEvent(type: string | undefined): Tone {
  return EVENT_TONE[type ?? ""] ?? MUTED_TONE;
}

// `answered_from_knowledge` is the one state that is the product's headline,
// so it is the one chip that gets the lime treatment.
const DECISION_TONE: Record<string, string> = {
  answered_from_knowledge: "pixie-chip-lime",
  answer_rejected: "text-danger",
  low_confidence: "text-tang",
};

function eventLabel(e: { event_type?: string; kind?: string }): string {
  return (e.event_type || e.kind || "event").replace(/_/g, " ");
}

export default async function TicketPage({ params }: { params: Promise<{ id: string; ticketId: string }> }) {
  const { id, ticketId } = await params;
  await requireProgramMembership(id);

  let detail: TicketDetail | null = null;
  let loadError: string | null = null;
  try {
    detail = (await coreDashboardTicketDetail(id, Number(ticketId))) as TicketDetail;
  } catch (err) {
    loadError = err instanceof Error ? err.message : "This ticket could not be loaded.";
  }

  if (loadError || !detail) {
    return (
      <>
        <Crumb programId={id} ticketId={ticketId} />
        <CoreError message={loadError ?? "Ticket not found."} />
      </>
    );
  }

  const { ticket } = detail;
  const events = Array.isArray(detail.events) ? detail.events : [];
  const notes = Array.isArray(detail.notes) ? detail.notes : [];
  const traces = Array.isArray(detail.traces) ? detail.traces : [];

  let macros: MacroRow[] = [];
  try {
    macros = (await coreMacrosList(id)) as MacroRow[];
  } catch {
    macros = [];
  }
  const enabledMacros = macros.filter((m) => m.enabled);

  const identities = await resolveIdentities([
    ticket.requester_id,
    ticket.assignee_id,
    ticket.resolved_by,
    ...events.map((e) => e.actor_id),
    ...notes.map((n) => n.author_id),
  ]);

  const decision = ticket.ai_decision ? ticket.ai_decision.replace(/_/g, " ") : null;

  return (
    <>
      <Crumb programId={id} ticketId={String(ticket.id)} />

      <PageHeader
        title={ticket.question}
        description={ticket.summary ?? undefined}
        actions={<StatusBadge status={ticket.status.replace(/_/g, " ")} />}
      />

      <Section title="Details" bordered>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Requester">{labelFor(identities, ticket.requester_id)}</Fact>
          <Fact label="Assignee">{labelFor(identities, ticket.assignee_id)}</Fact>
          <Fact label="Resolved by">{ticket.resolved_by ? labelFor(identities, ticket.resolved_by) : <Dash />}</Fact>
          <Fact label="Category">{ticket.category ? <Chip>{ticket.category}</Chip> : <Dash />}</Fact>
          <Fact label="Priority">
            {ticket.priority ? (
              <span
                className={`pixie-chip ${
                  ticket.priority === "urgent" ? "text-danger" : ticket.priority === "high" ? "text-tang" : ""
                }`}
              >
                {ticket.priority}
              </span>
            ) : (
              <Dash />
            )}
          </Fact>
          <Fact label="Pixie">
            {typeof ticket.ai_confidence === "number" || decision ? (
              <span className="flex flex-wrap items-center gap-2">
                {typeof ticket.ai_confidence === "number" && (
                  <Mono className="text-[13px] text-text tabular-nums">{Math.round(ticket.ai_confidence * 100)}%</Mono>
                )}
                {decision && (
                  <span className={`pixie-chip ${DECISION_TONE[ticket.ai_decision ?? ""] ?? ""}`}>{decision}</span>
                )}
              </span>
            ) : (
              <Dash />
            )}
          </Fact>
          <Fact label="Channel">
            <Mono className="text-[13px] text-text">#{ticket.channel}</Mono>
          </Fact>
          <Fact label="Opened">
            <Mono className="text-[13px] text-text">{shortTime(ticket.created_at)}</Mono>
          </Fact>
          <Fact label="Updated">
            <Mono className="text-[13px] text-text">{shortTime(ticket.updated_at)}</Mono>
          </Fact>
          <Fact label="Resolved">
            {ticket.resolved_at ? (
              <Mono className="text-[13px] text-mint">{shortTime(ticket.resolved_at)}</Mono>
            ) : (
              <Dash />
            )}
          </Fact>
        </div>
        <p className="mt-4 flex items-baseline gap-3 border-t border-line pt-3">
          <span className={labelClass}>Thread</span>
          <Mono className="truncate text-[11px] text-text-muted">{ticket.thread_ts}</Mono>
        </p>
      </Section>

      {ticket.status === "resolved" && ticket.resolutionSummary && (
        <Section title="Summary" bordered>
          <p className="max-w-3xl text-[14px] leading-relaxed text-text">{ticket.resolutionSummary}</p>
        </Section>
      )}

      {/* `minmax(0,1fr)` on the stacked column too: a grid item's default
          min-width is its content's, so one wide control inside the rail would
          otherwise push the whole column past the viewport on a phone. */}
      <div className="mt-8 grid items-start gap-6 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-8">
        <div className="min-w-0 space-y-8">
          <TicketComposer programId={id} ticketId={ticket.id} />

          <Section title="Timeline">
            {events.length === 0 ? (
              <EmptyState title="No events yet." />
            ) : (
              <ol>
                {events.map((e, i) => {
                  const tone = toneForEvent(e.event_type || e.kind);
                  return (
                    <li key={e.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                      <div className="relative flex justify-center">
                        <span className={`mt-[7px] size-1.5 shrink-0 rounded-[1px] ${tone.mark}`} aria-hidden />
                        {i < events.length - 1 && <span className="absolute bottom-0 top-3 w-px bg-line" aria-hidden />}
                      </div>
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className={`font-mono text-[12px] ${tone.text}`}>{eventLabel(e)}</span>
                          {e.actor_id && (
                            <span className="text-[13px] text-text-muted">{labelFor(identities, e.actor_id)}</span>
                          )}
                          <span className="font-mono text-[11px] text-text-muted">{shortTime(e.created_at)}</span>
                        </p>
                        {(e.detail || e.note) && (
                          <p className="mt-1 text-[13px] text-text-muted">{e.detail || e.note}</p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <TraceTimeline traces={traces} tracesError={detail.tracesError === true} />

          <Section title="Internal notes">
            {notes.length === 0 ? (
              <EmptyState title="No notes yet." hint="Notes stay on the ticket and never reach the asker." />
            ) : (
              <ul className="space-y-3">
                {notes.map((n) => (
                  <li key={n.id} className="pixie-panel-raised p-3">
                    <p className="text-[13px] text-text">{n.body}</p>
                    <p className="mt-1.5 text-[11px] text-text-muted">
                      {labelFor(identities, n.author_id)} · <Mono>{shortTime(n.created_at)}</Mono>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        <div className="min-w-0 space-y-6 lg:sticky lg:top-6">
          <TicketActions programId={id} ticketId={ticket.id} />
          {enabledMacros.length > 0 && <MacroSendForm programId={id} ticketId={ticket.id} macros={enabledMacros} />}
          <CopilotPanel programId={id} ticketId={ticket.id} question={ticket.question} threadTs={ticket.thread_ts} />
        </div>
      </div>
    </>
  );
}

// One field in the details grid: an operational label over a value, so the
// facts read as a table of record rather than a sentence.
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      <div className="text-[13px] text-text">{children}</div>
    </div>
  );
}

function Dash() {
  return <span className="text-text-muted">—</span>;
}

function Crumb({ programId, ticketId }: { programId: string; ticketId: string }) {
  return (
    <p className="mb-5 font-mono text-[12px] text-text-muted">
      <Link href={`/programs/${programId}/tickets`} className="transition-colors hover:text-brand">
        Tickets
      </Link>
      <span className="px-1.5 text-line-strong" aria-hidden>
        /
      </span>
      #{ticketId}
    </p>
  );
}
