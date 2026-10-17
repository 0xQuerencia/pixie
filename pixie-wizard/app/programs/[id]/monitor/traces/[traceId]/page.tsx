import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProgramMembership } from "@/lib/programAccess";
import { coreTrace } from "@/lib/pixieCore";
import { PageHeader, Section, CoreError } from "@/app/_components/DashboardShell";

export default async function TraceDetailPage({ params }: { params: Promise<{ id: string; traceId: string }> }) {
  const { id, traceId } = await params;
  await requireProgramMembership(id);
  const numericId = Number(traceId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) notFound();
  const result = await coreTrace(id, numericId).catch(() => null);
  return <><PageHeader title="Trace detail" description="The stored decision record for one live Slack question." actions={<Link href={`/programs/${id}/monitor/traces`} className="pixie-button pixie-button-quiet">Back to traces</Link>} /><Section bordered>{!result ? <CoreError message="This trace is unavailable or does not belong to this program." /> : <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-text">{JSON.stringify(result.trace, null, 2)}</pre>}</Section></>;
}
