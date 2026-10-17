import Link from "next/link";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTraces } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";

export default async function TracesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ decision?: string; q?: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);
  const query = await searchParams;
  const decision = typeof query.decision === "string" ? query.decision.slice(0, 40) : "";
  const q = typeof query.q === "string" ? query.q.slice(0, 200) : "";
  const result = await coreTraces(id, { limit: 100, decision, q }).catch(() => null);
  return <><PageHeader title="Traces" description="Inspect live Slack decisions, evidence, answers, and intentional silence." actions={<Link href={`/programs/${id}/monitor`} className="pixie-button pixie-button-quiet">Back to Monitor</Link>} />
    <Section title="Live Slack traces" description="Read-only trace data scoped to this program." bordered>
      {!result ? <CoreError message="Traces are unavailable because Pixie Core did not return them." /> : <><form method="get" className="mb-6 flex flex-wrap gap-3"><select name="decision" defaultValue={decision} className="pixie-input"><option value="">All decisions</option><option value="reply">reply</option><option value="escalate">escalate</option><option value="ignored">ignored</option></select><input name="q" defaultValue={q} className="pixie-input" placeholder="Search traces" /><button className="pixie-button pixie-button-primary">Filter</button></form><div className="space-y-3">{result.traces.map((trace) => <Link key={trace.id} href={`/programs/${id}/monitor/traces/${trace.id}`} className="block border-b border-line py-3 hover:text-brand"><span className="font-mono text-xs text-text-muted">#{trace.id} · {trace.stage}</span><span className="ml-3 text-sm">{String(trace.payload.decision || trace.payload.action || "trace")}</span><p className="mt-1 truncate text-xs text-text-muted">{String(trace.payload.question || trace.payload.reason || "")}</p></Link>)}</div></>}
    </Section></>;
}
