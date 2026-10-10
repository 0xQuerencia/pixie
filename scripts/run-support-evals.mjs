#!/usr/bin/env bun
// Support evals. Primitive cases hit retrieval, grounding and incident code directly; end-to-end cases drive the
// real test-question path (engagement plan, retrieval, lookup, claim verification) on an in-memory database with
// scripted model replies. Nothing here can reach Slack, ping a helper, open a ticket or touch trusted knowledge.
const { readFileSync } = require("node:fs");
const retrieve = require("../lib/retrieve");
const answerVerifier = require("../lib/answerVerifier");
const incidents = require("../lib/incidents");
const { runSupportEvals } = require("../lib/evalHarness");
const { runE2eEvals } = require("../lib/e2eEval");

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
const e2eFixture = JSON.parse(readFileSync(new URL("../evals/fixtures/e2e-support.json", import.meta.url), "utf8"));
const e2eResults = await runE2eEvals(e2eFixture);
for (const result of e2eResults) {
  console.log(`${result.passed ? "PASS" : "FAIL"} [${result.category}] ${result.name}`);
  for (const failure of result.failures) console.log(`  - ${failure}`);
}

const failed = [...results, ...e2eResults].filter((result) => !result.passed);
if (results.length === 0 || e2eResults.length === 0) {
  console.log("FAIL no eval cases ran");
  process.exit(1);
}
console.log(`${results.length + e2eResults.length - failed.length}/${results.length + e2eResults.length} eval cases passed`);
if (failed.length) process.exit(1);
