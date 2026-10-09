#!/usr/bin/env bun
// Deterministic support evals: these cases exercise the same retrieval,
// grounding, and incident primitives used by the live pipeline. They never
// open a ticket, call Slack, or mutate a program corpus.
const { readFileSync } = require("node:fs");
const retrieve = require("../lib/retrieve");
const answerVerifier = require("../lib/answerVerifier");
const incidents = require("../lib/incidents");
const { runSupportEvals } = require("../lib/evalHarness");

const cases = JSON.parse(readFileSync(new URL("../evals/fixtures/standalone-reliability.json", import.meta.url), "utf8"));
const results = runSupportEvals(cases, (input) => {
  if (input.kind === "retrieval") {
    const index = retrieve.buildIndex(retrieve.chunkSections(input.sections));
    const [top] = retrieve.scoreDetailed(index, input.question);
    return { source: top?.chunk?.source || null, score: top?.total || 0 };
  }
  if (input.kind === "grounding") {
    return answerVerifier.verify({ programId: "fixture", verdict: input.verdict, evidence: input.evidence });
  }
  if (input.kind === "incidents") {
    const groups = incidents.incidentClusterQuestions(input.questions);
    const group = groups.find((items) => items.includes(input.questions[0])) || [];
    return { groupContains: group };
  }
  return {};
});

for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.name}`);
  if (!result.passed) console.log(JSON.stringify(result.details));
}
const failed = results.filter((result) => !result.passed);
if (failed.length) process.exit(1);
