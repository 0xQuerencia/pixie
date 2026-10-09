const supportMemory = require("./supportMemory");

interface HandoffInput {
  programId: string;
  userId?: string | null;
  question: string;
  reason?: string | null;
  sources?: string[];
  attempts?: string[];
}

function unique(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .map((value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    ),
  ];
}

function build(input: HandoffInput): string {
  const sources = unique(input.sources || []).slice(0, 5);
  const attempts = unique(input.attempts || []).slice(0, 5);
  const memory = input.userId
    ? supportMemory
        .recall(input.programId, input.userId, 8)
        .filter(
          (row: { kind: string }) => row.kind === "attempt" || row.kind === "environment" || row.kind === "problem",
        )
        .map((row: { kind: string; value: string }) => `${row.kind}: ${row.value}`)
        .slice(0, 5)
    : [];

  return [
    `*Question:* ${String(input.question || "")
      .trim()
      .slice(0, 700)}`,
    input.reason ? `*Why Pixie handed off:* ${String(input.reason).slice(0, 400)}` : null,
    sources.length ? `*Sources checked:* ${sources.join(", ")}` : "*Sources checked:* no verified answer found",
    attempts.length ? `*Already tried:* ${attempts.join("; ")}` : null,
    memory.length ? `*Relevant support context:* ${memory.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export = { build };
