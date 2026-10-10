"use client";

import { useActionState, useState } from "react";
import { hostedKnowledgePropose, hostedCandidateReview, hostedFaqPropose } from "@/app/wizard/hostedActions";
import type { ActionState } from "@/lib/types";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";
import { Notice, StatusDot, Chip } from "@/app/_components/DashboardShell";
import { IconCheck, IconPlus, IconSparkle } from "@/app/_components/icons";
import { refreshKnowledgeSources } from "./knowledgeActions";

const initialState: ActionState = { error: null };

export function RefreshSourcesButton({ programId }: { programId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="pixie-button pixie-button-quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage(null);
          const result = await refreshKnowledgeSources(programId);
          setBusy(false);
          setMessage(result.ok ? "Syncing…" : (result.error ?? "Refresh failed."));
        }}
      >
        {busy ? "Starting…" : "Re-sync"}
      </button>
      {message && <span className="text-xs text-text-muted">{message}</span>}
    </span>
  );
}

// One honest sentence per failed action, in the same notice every other Core
// problem uses. Never a quiet inline tint: a rejected review that reads as
// ordinary copy is a review that looks like it worked.
function ErrorLine({ state }: { state: ActionState }) {
  if (!state.error) return null;
  return (
    <div className="mt-3">
      <Notice tone="error">{state.error}</Notice>
    </div>
  );
}

// The one-line composer that opens the review queue, in the onboarding's shape:
// a marked eyebrow naming the action, a sentence saying what it does, then the
// field. It sits on the panel floor so the queue below it starts from a clear
// edge rather than a floating form.
export function ProposeTicketForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedKnowledgePropose, initialState);
  const fieldId = `propose-ticket-${programId}`;
  return (
    <div className="pixie-panel-raised p-4">
      <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
        <span className="pixie-mark" aria-hidden="true" />
        Learn from a resolved ticket
      </p>
      <p className="mt-1.5 text-[13px] text-text-muted">
        Point Pixie at a ticket you already closed and she learns the answer from it.
      </p>
      <form action={formAction} className="mt-3.5">
        <input type="hidden" name="programId" value={programId} />
        <label className={labelClass} htmlFor={fieldId}>
          Ticket number
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={fieldId}
            name="ticketId"
            placeholder="Ticket # to learn from"
            className={`${inputClass} max-w-xs font-mono`}
          />
          <button type="submit" className={btnPrimary}>
            <IconPlus size={16} />
            Propose
          </button>
        </div>
        <ErrorLine state={state} />
      </form>
    </div>
  );
}

// A question waiting on a person, and the draft answer that would ground every
// future reply if they approve it. The question is the subject, so it carries
// the weight; the answer is the draft under it; the editor is a third, quieter
// layer behind a rule.
export type Fact = {
  id: number;
  question: string;
  answer: string;
  status?: string;
  ticket_id: number | null;
  category: string | null;
  author_id?: string | null;
  created_at?: number;
  auto_learned?: number;
};

export function CandidateCard({
  programId,
  candidate,
  authorLabel,
  createdLabel,
}: {
  programId: string;
  candidate: Fact;
  authorLabel?: string;
  createdLabel?: string;
}) {
  const [state, formAction] = useActionState(hostedCandidateReview, initialState);
  const fieldId = `candidate-answer-${candidate.id}`;
  const awaitingReview = candidate.status !== "approved";
  return (
    <article className="pixie-panel-raised min-w-0 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-xs tabular-nums text-text-muted">#{candidate.id}</span>
        {candidate.auto_learned && candidate.ticket_id ? (
          <span className="text-[12px] text-brand">auto-learned from ticket #{candidate.ticket_id}</span>
        ) : candidate.ticket_id ? (
          <span className="text-[12px] text-text-muted">from ticket #{candidate.ticket_id}</span>
        ) : null}
        {candidate.category ? <Chip>{candidate.category}</Chip> : null}
        {authorLabel ? <span className="text-[12px] text-text-muted">by {authorLabel}</span> : null}
        {createdLabel ? <span className="font-mono text-[11px] text-text-muted">{createdLabel}</span> : null}
        {candidate.status === "approved" && <StatusDot status="resolved">approved</StatusDot>}
        {awaitingReview && (
          <span className="ml-auto">
            <StatusDot status="candidate">awaiting review</StatusDot>
          </span>
        )}
      </div>

      {/* The question and its draft answer, quoted off the card's left edge: this
          is the knowledge waiting to be approved, and the editor below the rule
          is the form that changes it. */}
      <div className="mt-3.5 border-l-2 border-line-strong pl-3.5">
        <p className="text-[15px] font-semibold leading-snug text-text">{candidate.question}</p>
        <p className="mt-2 text-[14px] leading-relaxed text-text/90">{candidate.answer}</p>
      </div>

      <form action={formAction} className="mt-3.5 border-t border-line pt-3.5">
        <input type="hidden" name="programId" value={programId} />
        <input type="hidden" name="candidateId" value={candidate.id} />
        <label className={labelClass} htmlFor={fieldId}>
          Edit answer
        </label>
        {awaitingReview && (
          <textarea
            id={fieldId}
            name="editAnswer"
            rows={2}
            defaultValue={candidate.answer}
            aria-label="Edit answer"
            className={`${inputClass} resize-y`}
          />
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {awaitingReview && (
            <button type="submit" name="reviewAction" value="approve" className={btnPrimary}>
              <IconCheck size={16} />
              Approve
            </button>
          )}
          <button type="submit" name="reviewAction" value="reject" className={btnQuiet}>
            {awaitingReview ? "Reject" : "Retire"}
          </button>
        </div>
        <ErrorLine state={state} />
      </form>
    </article>
  );
}

export function FaqProposeButton({ programId, question }: { programId: string; question: string }) {
  const [state, formAction] = useActionState(hostedFaqPropose, initialState);
  return (
    <form action={formAction}>
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="faqQuestion" value={question} />
      <button type="submit" className={`${btnQuiet} w-full sm:w-auto`}>
        <IconSparkle size={16} />
        Generate FAQ draft
      </button>
      <ErrorLine state={state} />
    </form>
  );
}
