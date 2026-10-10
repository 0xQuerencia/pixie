import { requireProgramMembership } from "@/lib/programAccess";
import { PageHeader, Section } from "@/app/_components/DashboardShell";
import { AnswerInspector } from "./AnswerInspector";

export default async function AnswerInspectorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireProgramMembership(id);

  return (
    <>
      <PageHeader
        title="Answer Inspector"
        description="Run a side-effect-free probe to see what Pixie retrieved, what it could verify, and why it would reply, stay quiet, or escalate."
      />
      <Section
        bordered
        title="Debug a question"
        description="This uses the same test-question path as the sandbox and never posts to Slack or changes a ticket."
      >
        <AnswerInspector programId={id} />
      </Section>
    </>
  );
}
