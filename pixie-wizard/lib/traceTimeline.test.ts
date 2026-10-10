import { expect, test } from "bun:test";
import { groupTraceRows } from "../app/programs/[id]/tickets/[ticketId]/TraceTimeline";
import type { CoreTraceRow } from "./pixieCore";

const trace = (row: Partial<CoreTraceRow>): CoreTraceRow => ({
  id: 1,
  stage: "decision",
  payload: {},
  createdAt: 100,
  requestId: "request-a",
  ...row,
});

test("trace timeline groups stored rows by request and keeps stage order", () => {
  const groups = groupTraceRows([
    trace({ id: 3, stage: "final", createdAt: 300 }),
    trace({ id: 1, stage: "engagement", createdAt: 100 }),
    trace({ id: 2, stage: "decision", createdAt: 200 }),
    trace({ id: 4, requestId: "request-b", stage: "handoff", createdAt: 150 }),
    trace({ id: 5, requestId: "request-a", stage: "decision", createdAt: 250 }),
  ]);

  expect(groups.map((group) => group.requestId)).toEqual(["request-a", "request-b"]);
  expect(groups[0].rows.map((row) => `${row.stage}:${row.id}`)).toEqual([
    "engagement:1",
    "decision:2",
    "decision:5",
    "final:3",
  ]);
  expect(groups[1].rows.map((row) => row.stage)).toEqual(["handoff"]);
});
