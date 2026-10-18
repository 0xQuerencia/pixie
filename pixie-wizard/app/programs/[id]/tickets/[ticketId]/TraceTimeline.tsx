import type { CoreTracePayload, CoreTraceRow } from "@/lib/pixieCore";
import { Chip, EmptyState, Mono, Notice, Section } from "@/app/_components/DashboardShell";
import { shortTime } from "@/app/_components/format";

export interface TraceGroup {
  requestId: string;
  rows: CoreTraceRow[];
}

export function groupTraceRows(rows: CoreTraceRow[]): TraceGroup[] {
  const grouped = new Map<string, CoreTraceRow[]>();
  for (const row of rows) {
    const requestId = row.requestId || "unassigned";
    grouped.set(requestId, [...(grouped.get(requestId) || []), row]);
  }
  return [...grouped.entries()]
    .map(([requestId, groupedRows]) => ({
      requestId,
      rows: [...groupedRows].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id),
    }))
    .sort((a, b) => {
      const firstA = a.rows[0];
      const firstB = b.rows[0];
      return firstA.createdAt - firstB.createdAt || firstA.id - firstB.id;
    });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ");
}

function scores(source: Record<string, unknown>): string | null {
  const values = [
    ["lexical", number(source.lexical)],
    ["semantic", number(source.semantic)],
    ["total", number(source.total)],
  ].filter((entry): entry is [string, number] => entry[1] !== null);
  return values.length > 0 ? values.map(([label, value]) => `${label} ${value.toFixed(3)}`).join(" · ") : null;
}

function RetrievalDetails({ payload }: { payload: CoreTracePayload }) {
  const entries = Array.isArray(payload.sources)
    ? payload.sources
    : Array.isArray(payload.results)
      ? payload.results
      : [];
  const question = text(payload.question);
  return (
    <div className="space-y-2">
      {question && <p className="text-[13px] text-text-muted">Question: {question}</p>}
      {entries.length > 0 && (
        <ul className="space-y-1.5">
          {entries.map((entry, index) => {
            const source = record(entry);
            if (!source) return null;
            const name = text(source.source) || text(source.id) || `result ${index + 1}`;
            const heading = text(source.heading);
            return (
              <li key={`${name}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                <span className="text-text">{name}</span>
                {heading && <span className="text-text-muted">{heading}</span>}
                {scores(source) && <Mono className="text-brand">{scores(source)}</Mono>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GroundingDetails({ payload }: { payload: CoreTracePayload }) {
  const claims = Array.isArray(payload.claims) ? payload.claims : [];
  return (
    <div className="space-y-2 text-[12px]">
      {text(payload.verdict) && <Chip>{text(payload.verdict)}</Chip>}
      {claims.length > 0 && (
        <ul className="space-y-1.5">
          {claims.map((claimValue, index) => {
            const claim = record(claimValue);
            if (!claim) return null;
            const supported = claim.supported === true;
            return (
              <li key={index} className="border-b border-line pb-1.5 last:border-b-0 last:pb-0">
                <span className={`font-mono ${supported ? "text-mint" : "text-danger"}`}>
                  {supported ? "supported" : "unsupported"}
                </span>{" "}
                <span className="text-text">{text(claim.claim) || "claim unavailable"}</span>
                {text(claim.reason) && <span className="text-text-muted"> — {text(claim.reason)}</span>}
                {strings(claim.evidenceIds).length > 0 && (
                  <span className="mt-0.5 block font-mono text-[11px] text-text-muted">
                    evidence: {strings(claim.evidenceIds).join(", ")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SelectedEvidenceDetails({ payload }: { payload: CoreTracePayload }) {
  const ids = strings(payload.evidenceIds);
  return ids.length > 0 ? (
    <p className="font-mono text-[12px] text-text-muted">Evidence: {ids.join(", ")}</p>
  ) : (
    <p className="text-[12px] text-text-muted">No evidence was selected.</p>
  );
}

function ActionDetails({ payload }: { payload: CoreTracePayload }) {
  const action = text(payload.action) || text(payload.expectedAction) || text(payload.finalAction);
  const reason = text(payload.reason);
  return (
    <p className="text-[12px] text-text-muted">
      {action && <span className="font-mono text-text">{action}</span>}
      {action && reason && " — "}
      {reason}
      {typeof payload.sent === "boolean" && ` · ${payload.sent ? "sent to Slack" : "not sent"}`}
    </p>
  );
}

function HandoffDetails({ payload }: { payload: CoreTracePayload }) {
  const reason = text(payload.reason);
  const sources = strings(payload.sources);
  return (
    <div className="space-y-1 text-[12px] text-text-muted">
      {reason && <p>{reason}</p>}
      {sources.length > 0 && <p className="font-mono">Sources: {sources.join(", ")}</p>}
    </div>
  );
}

function BasicDetails({ payload }: { payload: CoreTracePayload }) {
  const values = [
    ["intent", text(payload.intent)],
    ["classifier", text(payload.classifier)],
    ["role", text(payload.role)],
    ["scope", text(payload.scope)],
    ["model", text(payload.model)],
    ["router", text(payload.router)],
    ["latency", number(payload.latencyMs) === null ? null : `${number(payload.latencyMs)}ms`],
    ["answer chars", number(payload.answerChars) === null ? null : String(number(payload.answerChars))],
    [
      "recent channel msgs",
      number(payload.recentChannelMessages) === null ? null : String(number(payload.recentChannelMessages)),
    ],
    ["jev", text(record(payload.jev)?.reason) ?? text(record(payload.jev)?.action)],
  ].filter((entry): entry is [string, string] => entry[1] !== null);
  return values.length > 0 ? (
    <p className="font-mono text-[12px] text-text-muted">
      {values.map(([key, value]) => `${key}: ${value}`).join(" · ")}
    </p>
  ) : null;
}

function TraceDetails({ row }: { row: CoreTraceRow }) {
  if (row.stage === "retrieval") return <RetrievalDetails payload={row.payload} />;
  if (row.stage === "selected_evidence") return <SelectedEvidenceDetails payload={row.payload} />;
  if (row.stage === "grounding") return <GroundingDetails payload={row.payload} />;
  if (row.stage === "decision" || row.stage === "final" || row.stage === "final_action") {
    return <ActionDetails payload={row.payload} />;
  }
  if (row.stage === "handoff") return <HandoffDetails payload={row.payload} />;
  return <BasicDetails payload={row.payload} />;
}

export function TraceTimeline({ traces, tracesError = false }: { traces: CoreTraceRow[]; tracesError?: boolean }) {
  const groups = groupTraceRows(traces);
  return (
    <Section title="Pixie decision trace" description="Recorded at the time. Read-only historical trace data." bordered>
      {tracesError ? (
        <Notice tone="error">
          The recorded decision trace could not be read. The ticket data above is still available.
        </Notice>
      ) : groups.length === 0 ? (
        <EmptyState title="No recorded decision trace." hint="This ticket has no retained trace rows." />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.requestId} className="space-y-3">
              <p className="flex flex-wrap items-baseline gap-2 border-b border-line pb-2 text-[11px] text-text-muted">
                <span className="pixie-eyebrow text-text-muted">Request</span>
                <Mono>{group.requestId}</Mono>
              </p>
              <ol className="space-y-3">
                {group.rows.map((row) => (
                  <li key={row.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-x-3">
                    <div className="relative flex justify-center">
                      <span className="mt-[7px] size-1.5 shrink-0 rounded-[1px] bg-brand" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-[12px] text-text">{stageLabel(row.stage)}</span>
                        <Mono className="text-[11px] text-text-muted">{shortTime(row.createdAt)}</Mono>
                      </p>
                      <div className="mt-1">
                        <TraceDetails row={row} />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
