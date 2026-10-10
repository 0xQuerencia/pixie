"use client";

import { useState } from "react";
import { askTestQuestion } from "@/app/wizard/hostedActions";
import type { TestQuestionResult } from "@/lib/pixieCore";
import { btnPrimary, inputClass, labelClass } from "@/app/wizard/_components/formStyles";
import { Select } from "@/app/_components/Select";

const ACTION_LABEL: Record<TestQuestionResult["expectedAction"], string> = {
  reply: "Reply",
  silence: "Stay silent",
  "ticket+helper": "Open a ticket and ping a helper",
  uncertain: "Say it cannot verify that",
};

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-panel-2 p-3">
      <p className={labelClass}>{label}</p>
      <p className="mt-1 text-sm text-text">{value}</p>
    </div>
  );
}

export function AnswerInspector({ programId }: { programId: string }) {
  const [question, setQuestion] = useState("");
  const [role, setRole] = useState<"help" | "main">("help");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestQuestionResult | null>(null);

  const inspect = async () => {
    const value = question.trim();
    if (!value || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await askTestQuestion({ programId, question: value, role });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(response.data as TestQuestionResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The answer inspector failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="pixie-panel-raised space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
          <div>
            <label htmlFor="inspectorRole" className={labelClass}>
              Ask as
            </label>
            <Select
              id="inspectorRole"
              name="inspectorRole"
              defaultValue={role}
              ariaLabel="Channel role"
              options={[
                { value: "help", label: "Help channel" },
                { value: "main", label: "Main channel" },
              ]}
              onValueChange={(value) => setRole(value === "main" ? "main" : "help")}
            />
          </div>
          <div>
            <label htmlFor="inspectorQuestion" className={labelClass}>
              Question to inspect
            </label>
            <input
              id="inspectorQuestion"
              className={inputClass}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") inspect();
              }}
              placeholder="How do I submit my project?"
              maxLength={1000}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary} disabled={!question.trim() || pending} onClick={inspect}>
            {pending ? "Inspecting…" : "Inspect answer"}
          </button>
          <p className="text-xs text-text-muted">
            Sandbox probe only — no Slack message, ticket, or helper ping is created.
          </p>
        </div>
        {error && <p className="rounded-md border border-brand/40 bg-brand/10 p-3 text-sm text-brand">{error}</p>}
      </div>

      {result && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Expected action" value={ACTION_LABEL[result.expectedAction]} />
            <Metric
              label="Intent / engagement"
              value={`${result.intent || "unknown"} · ${result.engaged ? "engaged" : "not engaged"}`}
            />
            <Metric label="Grounding" value={result.grounded ? "Sendable supported answer" : "Not sendable"} />
            <Metric label="Role" value={result.role} />
          </div>

          <section className="pixie-panel-raised space-y-3 p-4 sm:p-5">
            <div>
              <h2 className="font-display text-base text-text">Decision</h2>
              <p className="mt-1 text-sm leading-relaxed text-text-muted">
                {result.why || result.reason || "No decision reason returned."}
              </p>
            </div>
            {result.answerPreview && (
              <div className="border-t border-line pt-3">
                <p className={labelClass}>Answer preview</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text">{result.answerPreview}</p>
              </div>
            )}
          </section>

          <section className="pixie-panel-raised p-4 sm:p-5">
            <h2 className="font-display text-base text-text">Retrieval sources and scores</h2>
            {!result.retrieval?.length ? (
              <p className="mt-3 text-sm text-text-muted">No eligible source chunks were found.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="border-b border-line text-text-muted">
                    <tr>
                      <th className="pb-2 pr-3 font-normal">Source / heading</th>
                      <th className="pb-2 pr-3 font-normal">Lexical</th>
                      <th className="pb-2 pr-3 font-normal">Semantic</th>
                      <th className="pb-2 font-normal">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {result.retrieval.map((row, index) => (
                      <tr key={`${row.source}-${row.heading}-${index}`}>
                        <td className="max-w-[22rem] py-2 pr-3 text-text">
                          <span className="font-medium">{row.source || "Unknown source"}</span>
                          {row.heading && <span className="ml-2 text-text-muted">{row.heading}</span>}
                        </td>
                        <td className="py-2 pr-3 font-mono text-text-muted">{row.lexical.toFixed(3)}</td>
                        <td className="py-2 pr-3 font-mono text-text-muted">{row.semantic.toFixed(3)}</td>
                        <td className="py-2 font-mono text-text">{row.total.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="pixie-panel-raised p-4 sm:p-5">
            <h2 className="font-display text-base text-text">Grounding claim reasons</h2>
            <p className="mt-1 text-xs text-text-muted">
              Verdict: {result.grounding?.verdict || (result.grounded ? "supported" : "unsupported")}
            </p>
            <div className="mt-3 space-y-2 text-sm">
              {(result.grounding?.claims || []).length === 0 ? (
                <p className="text-text-muted">
                  No structured claims were returned; the answer stayed behind the ordinary source boundary.
                </p>
              ) : (
                result.grounding?.claims?.map((claim, index) => (
                  <div key={`${claim.claim}-${index}`} className="rounded border border-line bg-panel-2 p-3">
                    <p className="text-text">{claim.claim}</p>
                    <p className={`mt-1 text-xs ${claim.supported ? "text-mint" : "text-danger"}`}>
                      {claim.supported ? "Supported" : "Rejected"} · {claim.reason || "No reason returned"}
                    </p>
                  </div>
                ))
              )}
              {!!result.grounding?.errors?.length && (
                <p className="text-xs text-danger">{result.grounding.errors.join("; ")}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
