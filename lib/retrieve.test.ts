const { test } = require("node:test");
const assert = require("node:assert/strict");
const retrieve = require("./retrieve");
const { tokenize } = retrieve;

const DOCS = `## Exporting sprites

Export your sprite as a PNG at native size. Do not upscale it before uploading, the game handles scaling itself.

## Restoration energy

Restoration energy, or RE, is earned by shipping approved sidequests. Each region needs a threshold of RE before it unlocks.

## Hackatime

Hackatime tracks coding time through the WakaTime extension. Point it at your Hackatime API key and dashboard URL.`;

const FAQ = `Q: When does Acme launch?
A: The launch date has not been announced.

Q: What do I win?
A: Prizes ship to your door once your project is approved.`;

test("chunkSection splits on headings and keeps the heading with the body", () => {
  const chunks = retrieve.chunkSection("Acme Docs", DOCS);

  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c: { heading: string }) => c.heading),
    ["Exporting sprites", "Restoration energy", "Hackatime"],
  );
  assert.match(chunks[0].text, /Exporting sprites/);
  assert.match(chunks[0].text, /native size/);
  assert.equal(chunks[0].source, "Acme Docs");
});

test("chunkSection returns nothing for empty input", () => {
  assert.deepEqual(retrieve.chunkSection("Empty", ""), []);
  assert.deepEqual(retrieve.chunkSection("Empty", "   \n\n  "), []);
  assert.deepEqual(retrieve.chunkSection("Empty", undefined), []);
});

test("chunkSection splits an oversized paragraph on sentence ends", () => {
  const long = Array.from(
    { length: 60 },
    (_: undefined, i: number) => `Sentence number ${i} explains a detail about the thing.`,
  ).join(" ");
  const chunks = retrieve.chunkSection("Long", long);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= retrieve.MAX_CHUNK, `chunk of ${chunk.text.length} exceeds the cap`);
    assert.match(chunk.text.trim(), /\.$/);
  }
});

test("chunkSection keeps every chunk under the cap for real doc shapes", () => {
  for (const chunk of retrieve.chunkSections([
    ["Acme Docs", DOCS],
    ["Acme FAQ", FAQ],
  ])) {
    assert.ok(chunk.text.length <= retrieve.MAX_CHUNK);
  }
});

const SOURCES = [
  ["Acme Docs", DOCS],
  ["Acme FAQ", FAQ],
];
const index = retrieve.buildIndex(retrieve.chunkSections(SOURCES));

test("selectChunks ranks the matching passage first", () => {
  const [top] = retrieve.selectChunks(index, "how do i export a sprite");
  assert.match(top.text, /native size/);
});

test("selectChunks matches a question phrased differently from the docs", () => {
  const [top] = retrieve.selectChunks(index, "what is RE and how do i earn it");
  assert.match(top.text, /Restoration energy/);
});

test("scoreDetailed reranks a paraphrase while retaining source metadata", () => {
  const local = retrieve.buildIndex(
    retrieve.chunkSections([["Grant rules", "Unused grants may be returned before activation."]]),
  );
  const [top] = retrieve.scoreDetailed(local, "Can I get my money back if I never activated the grant?");
  assert.equal(top.chunk.source, "Grant rules");
  assert.ok(top.semantic > 0);
  assert.ok(top.total >= top.lexical);
});

test("policy retrieval does not admit a semantic-only referral match", () => {
  const local = retrieve.buildIndex(
    retrieve.chunkSections([
      ["Refund policy", "Refunds are allowed before activation."],
      ["Referral guide", "Referral codes expire in 48 hours after being generated."],
    ]),
  );
  const scores = retrieve.scoreDetailed(local, "When is the refund deadline?");

  assert.equal(scores.length, 1);
  assert.match(scores[0].chunk.text, /Refunds are allowed/);
  assert.equal(
    scores.some((entry) => /Referral codes expire/.test(entry.chunk.text)),
    false,
  );
});

test("selectChunks returns nothing when no term matches", () => {
  assert.deepEqual(retrieve.selectChunks(index, "zzzz qqqq"), []);
  assert.deepEqual(retrieve.selectChunks(index, ""), []);
});

test("selectChunks respects the character budget", () => {
  const chunks = retrieve.selectChunks(index, "sprite export restoration energy hackatime", 300);
  const total = chunks.reduce((sum: number, c: { text: string }) => sum + c.text.length, 0);
  assert.ok(total <= 300, `selected ${total} chars against a 300 budget`);
});

test("selectChunks skips an oversized top chunk and keeps a later eligible chunk", () => {
  const BIG = "gizmo ".repeat(40) + "widget contraption apparatus mechanism instrument.";
  const SMALL = "gizmo mentioned once, short.";

  const localIndex = retrieve.buildIndex(
    retrieve.chunkSections([
      ["Big", BIG],
      ["Small", SMALL],
    ]),
  );

  const ranked = retrieve.score(localIndex, retrieve.tokenize("gizmo"));
  assert.equal(ranked.length, 2);
  const [top, second] = ranked;
  assert.ok(top.value >= second.value, "test setup: Big must rank at or above Small");

  const budget = second.chunk.text.length + 5;
  assert.ok(budget < top.chunk.text.length, "test setup: top chunk must not fit in the budget");

  const selected = retrieve.selectChunks(localIndex, "gizmo", budget);
  assert.equal(selected.length, 1);
  assert.match(selected[0].text, /short/);
});

const GENERATED = [
  ["About pixie", "Q: Who are you?\nA: I'm pixie."],
  ["Program timeline", "Acme launches at some point."],
];

test("selectContext always includes every generated section", () => {
  const context = retrieve.selectContext({
    generated: GENERATED,
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
  });

  assert.match(context, /### About pixie/);
  assert.match(context, /### Program timeline/);
  assert.match(context, /native size/);
});

test("selectContext drops the source passages a question doesn't need", () => {
  const context = retrieve.selectContext({
    generated: GENERATED,
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
  });

  assert.doesNotMatch(context, /Prizes ship to your door/);
  assert.ok(context.length < [...GENERATED, ...SOURCES].map(([, t]: string[]) => t).join("").length);
});

test("selectContext labels passages with the source they came from", () => {
  const context = retrieve.selectContext({
    generated: [],
    index,
    sources: SOURCES,
    question: "when does acme launch",
  });

  assert.match(context, /### Acme FAQ/);
});

test("selectContext uses the capped corpus fallback for a general unknown question", () => {
  const context = retrieve.selectContext({
    generated: GENERATED,
    index,
    sources: SOURCES,
    question: "zzzz qqqq",
  });

  assert.match(context, /native size/);
  assert.match(context, /Prizes ship to your door/);
  assert.match(context, /### About pixie/);
});

test("selectContext does not restore hardware material for an unmatched software query", () => {
  const sources = [["Hardware guide", "Hardware projects require PCB schematics and wiring diagrams."]];
  const localIndex = retrieve.buildIndex(retrieve.chunkSections(sources));
  const context = retrieve.selectContext({
    generated: [],
    index: localIndex,
    sources,
    question: "What software requirements apply to my project?",
  });

  assert.doesNotMatch(context, /PCB schematics|wiring diagrams/);
  assert.doesNotMatch(context, /### Hardware guide/);
});

test("selectContext does not restore a generic AI allowance for a hardware policy query", () => {
  const sources = [["AI policy", "You can use AI tools like ChatGPT for up to 30% of your project's software code."]];
  const localIndex = retrieve.buildIndex(retrieve.chunkSections(sources));
  const context = retrieve.selectContext({
    generated: [],
    index: localIndex,
    sources,
    question: "Can AI generate my PCB design for hardware?",
  });

  assert.doesNotMatch(context, /30%/);
  assert.doesNotMatch(context, /### AI policy/);
});

test("selectContext excludes a mixed-domain chunk from an unambiguous software query", () => {
  const sources = [
    [
      "Mixed guide",
      "## Hardware and Software Requirements\nFor hardware projects, include PCB schematics. For software projects, include a README.",
    ],
  ];
  const localIndex = retrieve.buildIndex(retrieve.chunkSections(sources));
  const context = retrieve.selectContext({
    generated: [],
    index: localIndex,
    sources,
    question: "What README is required for my software project?",
  });

  assert.doesNotMatch(context, /PCB schematics|### Mixed guide/);
});

test("selectContextDetailed reports selected source and learned evidence with stable IDs", () => {
  const sources = [["Refund policy", "## Refund policy\nRefunds are allowed before activation."]];
  const localIndex = retrieve.buildIndex(retrieve.chunkSections(sources));
  const options = {
    generated: [],
    learned: [["Learned answers", "Q: Can I get a refund?\nA: Ask a human helper for review."]],
    index: localIndex,
    sources,
    question: "What is the refund policy?",
    programId: "acme",
  };
  const first = retrieve.selectContextDetailed(options);
  const second = retrieve.selectContextDetailed(options);
  const sourceEvidence = first.evidence.find((entry) => entry.authority === "source");
  const learnedEvidence = first.evidence.find((entry) => entry.kind === "learned");

  assert.match(first.context, /Refunds are allowed/);
  assert.match(first.context, /Ask a human helper/);
  assert.ok(sourceEvidence);
  assert.equal(sourceEvidence.programId, "acme");
  assert.equal(sourceEvidence.sourceName, "Refund policy");
  assert.ok(sourceEvidence.text && first.context.includes(sourceEvidence.text));
  assert.ok(learnedEvidence);
  assert.equal(learnedEvidence.kind, "learned");
  assert.equal(learnedEvidence.authority, "learned");
  assert.equal(learnedEvidence.programId, "acme");
  assert.ok(learnedEvidence.text && first.context.includes(learnedEvidence.text));
  assert.deepEqual(first.evidence, second.evidence);
});

test("selectContext with generatedLast puts retrieved passages before generated boilerplate", () => {
  const bigGenerated = [["Learned answers", "x".repeat(5000)]];
  const ordered = retrieve.selectContext({
    generated: bigGenerated,
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
    generatedLast: true,
  });
  const firstRetrieved = ordered.indexOf("native size");
  const boilerplate = ordered.indexOf("### Learned answers");
  assert.ok(firstRetrieved !== -1 && boilerplate !== -1);
  assert.ok(firstRetrieved < boilerplate, "evidence must precede boilerplate");

  const defawlt = retrieve.selectContext({
    generated: bigGenerated,
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
  });
  assert.ok(defawlt.indexOf("### Learned answers") < defawlt.indexOf("native size"), "default order unchanged");
});

test("tokenize folds regular plurals so rates matches rate", () => {
  assert.deepEqual(tokenize("rates"), tokenize("rate"));
  assert.deepEqual(tokenize("pixels"), tokenize("pixel"));
  assert.deepEqual(tokenize("journals"), tokenize("journal"));
});

test("tokenize folds -es and -ies plurals", () => {
  assert.deepEqual(tokenize("batches"), tokenize("batch"));
  assert.deepEqual(tokenize("policies"), tokenize("policy"));
});

test("tokenize leaves short words and double-s words alone", () => {
  assert.deepEqual(tokenize("class"), ["class"]);
  assert.deepEqual(tokenize("pass"), ["pass"]);
  assert.deepEqual(tokenize("gas"), ["gas"]);
});

test("tokenize leaves ambiguous -uses plurals unfolded", () => {
  assert.deepEqual(tokenize("bonus"), ["bonus"]);
  assert.deepEqual(tokenize("status"), ["status"]);
});

test("tokenize splits hyphenated words so components match", () => {
  const tokens = tokenize("already-approved ai-generated");
  assert.ok(tokens.includes("already"));
  assert.ok(tokens.includes("approved"));
  assert.ok(tokens.includes("ai"));
  assert.ok(tokens.includes("generated"));
});

test("tokenize expands old to include age", () => {
  const tokens = tokenize("how old can i be");
  assert.ok(tokens.includes("old"));
  assert.ok(tokens.includes("age"));
});

test("tokenize expands expiration and resubmission synonyms", () => {
  const expTokens = tokenize("referral code expiration");
  assert.ok(expTokens.includes("expiration"));
  assert.ok(expTokens.includes("expire"));

  const resubTokens = tokenize("resubmission after changes");
  assert.ok(resubTokens.includes("resubmit"));

  const retTokens = tokenize("returned project");
  assert.ok(retTokens.includes("return"));
});

test("detectDomain accurately classifies software, hardware, and general text", () => {
  assert.equal(retrieve.detectDomain("A web app built with React, deployed on Vercel with a github repo"), "software");
  assert.equal(
    retrieve.detectDomain("Design a custom PCB with KiCad, route traces, and export Gerber files"),
    "hardware",
  );
  assert.equal(retrieve.detectDomain("General community guidelines and age requirements for participants"), "general");
});

test("chunkSection assigns domain metadata and avoids clumping distinct paragraphs", () => {
  const mixedDoc = `## Project Guidelines

For software projects, your repository must have a clear README explaining how to run and experience the application.

For hardware projects, the repository must include PCB schematics, wiring diagrams, and CAD models in STEP format.`;

  const chunks = retrieve.chunkSection("Guidelines", mixedDoc);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].domain, "software");
  assert.equal(chunks[1].domain, "hardware");
  assert.match(chunks[0].text, /For software projects/);
  assert.doesNotMatch(chunks[0].text, /PCB schematics/);
  assert.match(chunks[1].text, /For hardware projects/);
  assert.doesNotMatch(chunks[1].text, /For software projects/);
});

test("chunkSection preserves introductory lead-ins ending with colons", () => {
  const docWithLeadIn = `## Hardware Requirements

For hardware projects, the repo must contain everything needed to build it from scratch. This means, at minimum:

* PCB schematics and wiring diagrams
* CAD files in STEP format
* Bill of materials with part numbers`;

  const chunks = retrieve.chunkSection("Hardware Guide", docWithLeadIn);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /This means, at minimum:/);
  assert.match(chunks[0].text, /PCB schematics and wiring diagrams/);
  assert.equal(chunks[0].domain, "hardware");
});

const DOMAIN_DOCS = [
  [
    "Submission Guidelines",
    `## Software Requirements
For software projects, your repository must contain a README explaining what the project is, how to set it up or run it, and how it can be experienced. Software projects must have public open-source code on GitHub and a working playable URL.

## Hardware Requirements
For hardware projects, the repository must contain PCB schematics, wiring diagrams, CAD files in STEP format, and a bill of materials with specific part names.`,
  ],
];
const domainIndex = retrieve.buildIndex(retrieve.chunkSections(DOMAIN_DOCS));

test("software README query retrieves software README and NEVER receives hardware wiring-diagram / PCB advice", () => {
  const query = "what are the readme requirements for my software project?";
  const selected = retrieve.selectChunks(domainIndex, query);

  assert.ok(selected.length > 0);
  for (const chunk of selected) {
    assert.match(chunk.text, /software/i);
    assert.doesNotMatch(chunk.text, /wiring diagram/i);
    assert.doesNotMatch(chunk.text, /\bpcb\b/i);
  }

  const scores = retrieve.score(domainIndex, retrieve.tokenize(query));
  const hardwareMatch = scores.find((s: { chunk: { text: string } }) => /wiring diagram|\bpcb\b/i.test(s.chunk.text));
  assert.equal(hardwareMatch, undefined, "hardware chunk must have score 0 and be filtered out");
});

test("hardware requirements query retrieves hardware chunks and does not retrieve software chunks", () => {
  const query = "what are the wiring diagram and pcb schematic requirements for hardware?";
  const selected = retrieve.selectChunks(domainIndex, query);

  assert.ok(selected.length > 0);
  for (const chunk of selected) {
    assert.match(chunk.text, /hardware/i);
    assert.doesNotMatch(chunk.text, /playable url/i);
  }
});

const RETURNED_DOCS = [
  [
    "Review Guide",
    `## Spot-Check Verdicts and Returned Submissions
A returned submission (Needs Changes verdict) is not a penalty, fine, or final rejection. If your project is returned, you will receive reviewer feedback on what needs to be changed, and you can make adjustments and resubmit your project for review.

## Override Hours and Deflation
Reviewers may deflate approved hours when there is doubt about claimed hours or evidence does not support them. The unified database requires aggressive deflation when hours appear inflated.`,
  ],
];
const returnedIndex = retrieve.buildIndex(retrieve.chunkSections(RETURNED_DOCS));

test("returned-submission query retrieves feedback/resubmitting and excludes reduced-hours/deflation rules", () => {
  const query = "what happens if my submission is returned, is it a penalty or can i resubmit?";
  const selected = retrieve.selectChunks(returnedIndex, query);

  assert.ok(selected.length > 0);
  assert.match(selected[0].text, /not a penalty/i);
  assert.match(selected[0].text, /feedback/i);
  assert.match(selected[0].text, /resubmit/i);

  for (const chunk of selected) {
    assert.doesNotMatch(chunk.text, /deflate approved hours/i);
    assert.doesNotMatch(chunk.text, /aggressive deflation/i);
  }

  const scores = retrieve.score(returnedIndex, retrieve.tokenize(query));
  const deflationMatch = scores.find((s: { chunk: { text: string } }) => /deflate/i.test(s.chunk.text));
  assert.equal(
    deflationMatch,
    undefined,
    "deflation chunk must be filtered out when asking about returned submissions",
  );
});

const HIERARCHY_DOCS = [
  [
    "AI Policy",
    `## General AI Allowance
You can use AI tools like ChatGPT or GitHub Copilot for up to 30% of your project's code for syntax assistance, debugging, and boilerplate code.

## Hardware CAD and PCB AI Prohibition
The 30% AI rule does not apply to hardware design. For hardware projects, all CAD assemblies, 3D models (.step files), and PCB designs/schematics must be 100% original, custom designs by you, not generated by AI (0% AI). Submitting fully AI-generated design files will result in rejection and may lead to a permanent ban.

## README AI Prohibition
Your project's README cannot be built by AI. You must write your own README by yourself.`,
  ],
];
const hierarchyIndex = retrieve.buildIndex(retrieve.chunkSections(HIERARCHY_DOCS));

test("hardware AI query strictly ranks 0% AI CAD/PCB prohibition over generic software AI allowance", () => {
  const query = "can i use ai to generate my pcb and cad files for hardware?";
  const scores = retrieve.score(hierarchyIndex, retrieve.tokenize(query));

  assert.ok(scores.length > 0);
  assert.match(scores[0].chunk.text, /100% original/i);
  assert.match(scores[0].chunk.text, /not generated by ai/i);

  const genericMatch = scores.find((s: { chunk: { text: string } }) =>
    /up to 30% of your project's code/i.test(s.chunk.text),
  );
  assert.equal(
    genericMatch,
    undefined,
    "generic 30% AI allowance must receive score 0 and be filtered out for hardware CAD/PCB queries",
  );
});

test("README AI query strictly ranks README AI prohibition over generic code AI allowance", () => {
  const query = "can i use ai to write my project readme?";
  const scores = retrieve.score(hierarchyIndex, retrieve.tokenize(query));

  assert.ok(scores.length > 0);
  assert.match(scores[0].chunk.text, /README cannot be built by AI/i);

  const genericMatch = scores.find((s: { chunk: { text: string } }) =>
    /up to 30% of your project's code/i.test(s.chunk.text),
  );
  assert.equal(genericMatch, undefined, "generic 30% code AI allowance must receive score 0 when asking about README");
});

const AI_POLICY_DOCS = [
  [
    "YSWS Submission Guidelines",
    `## AI Usage Rules and 30% Limit
At most, your project may only be built by AI up to 30% of the total code. AI code is limited to a hard ceiling of 30%. Submitting a fully AI-generated project is strictly prohibited.

## Disclosing AI Usage
You must disclose where and how AI was used in your project submission notes and README. Reviewers verify the AI percentage.

## Consequences of Exceeding the AI Limit or Hiding AI
If you exceed the 30% AI limit, reviewers will reject your project or reduce/deflate your payout and approved hours.
If you hide or do not disclose your AI usage, your project will be rejected and your payout penalized. Hiding AI usage is treated as dishonesty and fraud, which can lead to disciplinary action or a permanent ban from Hack Club programs.

## Hardware and Firmware AI Rules
The 30% AI rule does not apply to hardware design. For hardware projects, all CAD assemblies, 3D models (.step files), and PCB designs/schematics must be 100% original, custom designs by you — not generated by AI (0% AI).
For firmware (microcontroller code), AI is permitted only under the standard software code limit of up to 30% with honest disclosure, but AI cannot generate your entire firmware.`,
  ],
];
const aiIndex = retrieve.buildIndex(retrieve.chunkSections(AI_POLICY_DOCS));

test("30% AI policy: retrieves code cap, disclosure, fully AI ban, and consequences", () => {
  const q1 = retrieve.selectChunks(aiIndex, "how much ai can i use and can a project be fully ai generated?");
  assert.ok(q1.length > 0);
  assert.match(q1[0].text, /30%/);
  assert.match(q1[0].text, /fully AI-generated project is strictly prohibited/i);

  const q2 = retrieve.selectChunks(aiIndex, "do i have to disclose ai usage in my submission?");
  assert.ok(q2.length > 0);
  assert.match(q2[0].text, /disclose where and how AI was used/i);

  const q3 = retrieve.selectChunks(aiIndex, "what happens if i exceed the ai limit or hide ai?");
  assert.ok(q3.length > 0);
  const combinedQ3 = q3.map((c: { text: string }) => c.text).join("\n\n");
  assert.match(combinedQ3, /reject your project or reduce\/deflate your payout/i);
  assert.match(combinedQ3, /dishonesty and fraud.*permanent ban/i);

  const q4 = retrieve.selectChunks(aiIndex, "can ai generate firmware for microcontrollers?");
  assert.ok(q4.length > 0);
  assert.match(q4[0].text, /standard software code limit of up to 30%/i);
});

const REFERRAL_DOCS = [
  [
    "Referral Guide",
    `## Referral Codes and Expiration
Referral codes expire in 48 hours (2 days) after being generated. Submitter referral links and codes must be redeemed within the 48-hour expiration window before they become invalid.`,
  ],
  [
    "General Rules",
    `## Community Guidelines
Be respectful, share your work, and help others build cool things.`,
  ],
];
const referralIndex = retrieve.buildIndex(retrieve.chunkSections(REFERRAL_DOCS));

test("referral-code query retrieves 48-hour / 2-day expiration across various phrasings", () => {
  const phrasings = [
    "when does my referral code expire?",
    "how long do referral codes last?",
    "what is the referral code expiration window?",
    "how many days before a referral link expires?",
  ];

  for (const query of phrasings) {
    const selected = retrieve.selectChunks(referralIndex, query);
    assert.ok(selected.length > 0, `failed to retrieve for query: ${query}`);
    assert.match(selected[0].text, /48\s*hours?/i, `missing 48 hours for: ${query}`);
    assert.match(selected[0].text, /2\s*days?/i, `missing 2 days for: ${query}`);
    assert.match(selected[0].text, /expire/i, `missing expire for: ${query}`);
  }
});

test("chunk size and budget constants pin the retrieval contract", () => {
  assert.equal(retrieve.MIN_CHUNK, 100);
  assert.equal(retrieve.MAX_CHUNK, 900);
  assert.equal(retrieve.DEFAULT_BUDGET, 2500);
});

test("budget constants pin the per-section and total contract", () => {
  assert.equal(retrieve.IDENTITY_BUDGET, 2500);
  assert.equal(retrieve.TIMELINE_BUDGET, 1200);
  assert.equal(retrieve.LEARNED_BUDGET, 1500);
  assert.equal(retrieve.LEARNED_MAX_FACTS, 5);
  assert.equal(retrieve.TOTAL_CONTEXT_BUDGET, 8000);
});

test("selectContext never exceeds the total budget, even with unbounded generated sections", () => {
  const huge = [
    ["About pixie", `identity ${"i".repeat(5000)}`],
    ["Program timeline", `timeline ${"t".repeat(3000)}`],
    ["Learned answers", `taught ${"l".repeat(14000)}`],
  ];
  const context = retrieve.selectContext({
    generated: huge,
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
  });

  assert.ok(context.length <= retrieve.TOTAL_CONTEXT_BUDGET, `context is ${context.length} chars`);
  assert.match(context, /### About pixie/);
  assert.match(context, /### Program timeline/);
  assert.match(context, /### Learned answers/);
  assert.match(context, /native size/);
});

test("selectContext keeps retrieved evidence when the learned section alone would blow the budget", () => {
  const context = retrieve.selectContext({
    generated: [],
    learned: [["Learned answers", `Q: unrelated\nA: ${"z".repeat(14000)}`]],
    index,
    sources: SOURCES,
    question: "how do i export a sprite",
  });

  assert.ok(context.length <= retrieve.TOTAL_CONTEXT_BUDGET, `context is ${context.length} chars`);
  assert.match(context, /native size/);
  assert.match(context, /### Learned answers/);
});

test("selectContext fallback stays within the total budget when nothing matches", () => {
  const context = retrieve.selectContext({
    generated: [["About pixie", `identity ${"i".repeat(5000)}`]],
    learned: [["Learned answers", `taught ${"l".repeat(5000)}`]],
    index,
    sources: [["Big Docs", `docs ${"d".repeat(20000)}`]],
    question: "zzzz qqqq",
  });

  assert.ok(context.length <= retrieve.TOTAL_CONTEXT_BUDGET, `context is ${context.length} chars`);
});

test("chunkSection merges tiny neighbours and never emits an empty chunk", () => {
  const chunks = retrieve.chunkSection(
    "Tiny",
    "hi\n\nthere\n\nthis is a longer paragraph that pushes past the minimum chunk size threshold for merging",
  );
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(c.text.trim().length > 0);
  const whole = "hi\n\nthere";
  const small = retrieve.chunkSection("Tiny", whole);
  assert.equal(small.length, 1);
});

test("BM25 length norm prefers the shorter chunk when term frequency ties", () => {
  const short = "gizmo widget";
  const long = `gizmo widget ${"filler padding words ".repeat(30)}`;
  const idx = retrieve.buildIndex(
    retrieve.chunkSections([
      ["S", short],
      ["L", long],
    ]),
  );
  const ranked = retrieve.score(idx, retrieve.tokenize("gizmo widget"));
  assert.equal(ranked.length, 2);
  assert.match(ranked[0].chunk.text, /gizmo widget/);
  assert.ok(ranked[0].chunk.text.length <= ranked[1].chunk.text.length);
});

test("BM25 idf stays positive for a term in every chunk", () => {
  const idx = retrieve.buildIndex(
    retrieve.chunkSections([
      ["A", "gizmo alpha ".repeat(20)],
      ["B", "gizmo beta ".repeat(20)],
    ]),
  );
  const ranked = retrieve.score(idx, retrieve.tokenize("gizmo"));
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((r: { value: number }) => r.value > 0));
});

test("selectContext exclude drops a banned source from chunks and fallback", () => {
  const localIndex = retrieve.buildIndex(
    retrieve.chunkSections([
      ["Shop", "gizmo price 700 px in the shop catalogue"],
      ["Docs", "gizmo repair guide for broken widgets"],
    ]),
  );
  const excluded = new Set(["Shop"]);
  const ctx = retrieve.selectContext({
    generated: [],
    index: localIndex,
    sources: [
      ["Shop", "gizmo price 700 px"],
      ["Docs", "gizmo repair guide"],
    ],
    question: "gizmo shop price",
    exclude: excluded,
  });
  assert.doesNotMatch(ctx, /Shop/);
  const fallback = retrieve.selectContext({
    generated: [],
    index: localIndex,
    sources: [
      ["Shop", "unrelated shop text"],
      ["Docs", "unrelated docs text"],
    ],
    question: "zzzz qqqq",
    exclude: excluded,
  });
  assert.doesNotMatch(fallback, /### Shop/);
  assert.match(fallback, /### Docs/);
});

test("selectContext passes generated sections through unranked and first", () => {
  const gen = [
    ["About pixie", "identity text here"],
    ["Program timeline", "timeline text here"],
  ];
  const localIndex = retrieve.buildIndex(retrieve.chunkSections([["Docs", "some docs about gizmos and widgets"]]));
  const ctx = retrieve.selectContext({
    generated: gen,
    index: localIndex,
    sources: [["Docs", "some docs"]],
    question: "zzzz qqqq",
  });
  assert.ok(ctx.indexOf("### About pixie") < ctx.indexOf("### Docs") || ctx.includes("### Docs") === false);
  assert.match(ctx, /identity text here/);
});
export {};
