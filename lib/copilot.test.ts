process.env.PIXIE_DB_PATH = ":memory:";

interface VerdictRow {
  sentence: string;
  verdict: string;
}
interface CandidateRow {
  ticketId: number;
}

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const programs = require("./programs");
const knowledge = require("./knowledge");
const lookup = require("./lookup");
const copilot = require("./copilot");
const api = require("./web/api");
const claimVerifier = require("./claimVerifier");
const { readSource } = require("./test-source");

before(() => {
  db.close();
  db.open(":memory:");
});

after(() => {
  programs.invalidate();
  knowledge.invalidate();
});

const BLOB = JSON.stringify([
  {
    id: "cp-hwy",
    name: "Highway",
    helpChannel: "C-HWY",
    channels: ["C-HWY"],
    sources: [
      {
        name: "CP Highway Docs",
        type: "text",
        content: "Highway ships with tracking. PCBs from PCBWay are allowed for Highway builds.",
      },
    ],
  },
]);

function verifiedDraft(answer: string) {
  const evidence = [
    {
      id: "cp-evidence",
      programId: "cp-hwy",
      sourceName: "CP Highway Docs",
      text: BLOB.includes(answer) ? answer : "Yes, PCBs from PCBWay are allowed for Highway builds.",
      authority: "source",
      kind: "source",
    },
  ];
  return {
    source: "CP Highway Docs",
    answer,
    evidence,
    verification: claimVerifier.verifyAnswerSync({ programId: "cp-hwy", answer, evidence }),
  };
}

async function withCorpus(fn: () => unknown) {
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  const axios = require("axios");
  const realGet = axios.get;
  process.env.PIXIE_PROGRAMS_JSON = BLOB;
  programs.invalidate();
  knowledge.invalidate();
  axios.get = async () => {
    throw new Error("network disabled in test");
  };
  try {
    await knowledge.refreshCorpus();
    return await fn();
  } finally {
    axios.get = realGet;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
    knowledge.invalidate();
  }
}

test("factCheck marks supported claims and flags the rest", async () => {
  await withCorpus(async () => {
    const prog = programs.get("cp-hwy");
    const res = await copilot.factCheck({
      program: prog,
      text: "PCBs from PCBWay are allowed for Highway builds. The moon is made of cheese.",
    });
    const byVerdict = Object.fromEntries(res.verdicts.map((v: VerdictRow) => [v.sentence.slice(0, 20), v.verdict]));
    const supported = res.verdicts.find((v: VerdictRow) => v.verdict === "supported");
    const unsupported = res.verdicts.find((v: VerdictRow) => v.verdict === "unsupported");
    assert.ok(supported, JSON.stringify(byVerdict));
    assert.ok(unsupported, JSON.stringify(byVerdict));
    assert.ok(supported.evidence.length > 0);
    assert.equal(res.counts.supported, 1);
    assert.equal(res.counts.unsupported, 1);
  });
});

test("findSimilar ranks resolved tickets in-program by wording overlap", () => {
  const a = db.createTicket({
    programId: "cp-hwy",
    workspaceId: "T1",
    channel: "C-HWY",
    threadTs: "cp-t1",
    requesterId: "U1",
    question: "pcbway pcb order allowed",
  });
  db.resolveTicket(a, "yes, allowed");
  const b = db.createTicket({
    programId: "cp-hwy",
    workspaceId: "T1",
    channel: "C-HWY",
    threadTs: "cp-t2",
    requesterId: "U2",
    question: "what color is the sky",
  });
  db.resolveTicket(b, "blue");
  db.syncHelper({ programId: "cp-other", userId: "U9", source: "manual" });
  const c = db.createTicket({
    programId: "cp-other",
    workspaceId: "T1",
    channel: "CX",
    threadTs: "cp-t3",
    requesterId: "U3",
    question: "pcbway pcb order allowed",
  });
  db.resolveTicket(c, "other program answer");

  const res = copilot.findSimilar({ programId: "cp-hwy", question: "can I order my pcb from pcbway" });
  assert.ok(res.candidates.length >= 1);
  assert.equal(res.candidates[0].ticketId, a);
  assert.ok(!res.candidates.some((x: CandidateRow) => x.ticketId === c), "other programs never leak");
  assert.ok(res.candidates[0].similarity > 0);
});

test("improveReply preserves facts and surfaces token changes", async () => {
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: "Sure — the deadline is October 31, good luck!" });
  try {
    const res = await copilot.improveReply({ text: "deadline october 31" });
    assert.match(res.improved, /October 31/);
    assert.ok(Array.isArray(res.notes));
  } finally {
    llm.complete = real;
  }

  const down = require("./llm");
  const real2 = down.complete;
  down.complete = async () => {
    throw new Error("all providers down");
  };
  try {
    const res = await copilot.improveReply({ text: "deadline october 31" });
    assert.equal(res.improved, "deadline october 31");
    assert.match(res.notes[0], /unavailable/);
  } finally {
    down.complete = real2;
  }
});

test("draftReply reports grounding honestly and never sends", async () => {
  const real = lookup.answerOrChat;
  lookup.answerOrChat = async () => verifiedDraft("Yes — allowed.");
  try {
    const res = await copilot.draftReply({ program: { id: "cp-hwy", name: "Highway" }, question: "pcbway?" });
    assert.equal(res.grounded, true);
    assert.equal(res.draft, "Yes — allowed.");
  } finally {
    lookup.answerOrChat = real;
  }
  const real2 = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: null, answer: null });
  try {
    const res = await copilot.draftReply({ program: { id: "cp-hwy", name: "Highway" }, question: "anything?" });
    assert.equal(res.grounded, false);
    assert.equal(res.draft, null);
  } finally {
    lookup.answerOrChat = real2;
  }
});

test("copilot API enforces program scope, actors, and budgets", async () => {
  db.saveProgram({ id: "cp-hwy", name: "Highway", helpChannel: "C-HWY", channels: ["C-HWY"] });
  programs.invalidate();
  db.syncHelper({ programId: "cp-hwy", userId: "U-helper", source: "manual" });
  assert.match(
    (await api.internalCopilot("draft", { programId: "nope", actorId: "U-helper", question: "q" })).error,
    /unknown program/,
  );
  assert.match(
    (await api.internalCopilot("draft", { programId: "cp-hwy", actorId: "U-stranger", question: "q" })).error,
    /not a helper/,
  );
  assert.match(
    (await api.internalCopilot("bogus", { programId: "cp-hwy", actorId: "U-helper" })).error,
    /unknown copilot action/,
  );
  assert.match(
    (await api.internalCopilot("draft", { programId: "cp-hwy", actorId: "U-helper" })).error,
    /question required/,
  );

  for (let i = 0; i < 25; i++) {
    copilot.checkBudget("U-flood-test");
  }
  db.syncHelper({ programId: "cp-hwy", userId: "U-flood-test", source: "manual" });
  const limited = await api.internalCopilot("ask", { programId: "cp-hwy", actorId: "U-flood-test", question: "q" });
  assert.match(limited.error, /rate limited/);
});

test("copilot never sends — read-only helper surface", async () => {
  const fs = require("fs");
  const path = require("path");
  const src = readSource("copilot.js");
  assert.equal(src.includes("postMessage"), false);
  assert.equal(src.includes("postEphemeral"), false);
  assert.equal(src.includes('require("./tickets")'), false);
  assert.equal(src.includes('require("./slackMessages")'), false);
  assert.equal(/INSERT\s+INTO/i.test(src), false);
  assert.equal(/DELETE\s+FROM/i.test(src), false);
  assert.ok(!copilot.send && !copilot.post && !copilot.replyToTicket && !copilot.publish);
  assert.ok(typeof copilot.draftReply === "function");
  assert.ok(typeof copilot.improveReply === "function");
  assert.ok(typeof copilot.summarizeThread === "function");
  assert.ok(typeof copilot.factCheck === "function");
  assert.ok(typeof copilot.findSimilar === "function");
  assert.ok(typeof copilot.ask === "function");

  const before = db.handle().query("SELECT COUNT(*) AS n FROM tickets").get().n;
  const real = lookup.answerOrChat;
  lookup.answerOrChat = async () => verifiedDraft("draft text");
  try {
    const res = await copilot.draftReply({ program: { id: "cp-hwy", name: "Highway" }, question: "pcbway?" });
    assert.equal(res.draft, "draft text");
    assert.equal(res.programId, "cp-hwy");
  } finally {
    lookup.answerOrChat = real;
  }
  const afterCount = db.handle().query("SELECT COUNT(*) AS n FROM tickets").get().n;
  assert.equal(afterCount, before);
});

test("copilot scopes every helper to its program", async () => {
  const a = db.createTicket({
    programId: "cp-hwy",
    workspaceId: "T1",
    channel: "C-HWY",
    threadTs: "char-cp-t1",
    requesterId: "U1",
    question: "char pcbway order scope",
  });
  db.resolveTicket(a, "allowed");
  const other = db.createTicket({
    programId: "cp-scope-other",
    workspaceId: "T1",
    channel: "CX",
    threadTs: "char-cp-t2",
    requesterId: "U2",
    question: "char pcbway order scope",
  });
  db.resolveTicket(other, "other answer");
  const res = copilot.findSimilar({ programId: "cp-hwy", question: "char pcbway order scope" });
  assert.ok(res.candidates.some((c: CandidateRow) => c.ticketId === a));
  assert.ok(!res.candidates.some((c: CandidateRow) => c.ticketId === other));
  assert.equal(res.programId, "cp-hwy");
  assert.equal(copilot.findSimilar({ programId: null, question: "q" }).error, "programId and question required");

  const real = lookup.answerOrChat;
  lookup.answerOrChat = async () => ({ source: null, answer: null });
  try {
    const d = await copilot.draftReply({ program: { id: "cp-hwy" }, question: "q" });
    assert.equal(d.programId, "cp-hwy");
    assert.equal(d.grounded, false);
    const q = await copilot.ask({ program: { id: "cp-hwy" }, question: "q" });
    assert.equal(q.programId, "cp-hwy");
  } finally {
    lookup.answerOrChat = real;
  }
  const llm = require("./llm");
  const realComplete = llm.complete;
  llm.complete = async () => {
    throw new Error("down");
  };
  try {
    const s = await copilot.summarizeThread({
      program: { id: "cp-hwy" },
      ticket: null,
      threadTs: null,
      messages: [{ role: "user", user_id: "U1", content: "hello" }],
    });
    assert.equal(s.programId, "cp-hwy");
    assert.equal(s.aiPolished, false);
  } finally {
    llm.complete = realComplete;
  }
  assert.equal(copilot.checkBudget("char-cp-fresh-actor"), null);
  for (let i = 0; i < 25; i++) copilot.checkBudget("char-cp-fresh-actor");
  assert.match(copilot.checkBudget("char-cp-fresh-actor").error, /rate limited/);
  assert.equal(copilot.checkBudget("char-cp-other-actor"), null);
});

test("copilot factualTokens + improveReply guard shape", async () => {
  const toks = copilot.factualTokens('due October 31 see https://example.com/x and "quoted"');
  assert.ok(toks.has("31"));
  assert.ok([...toks].some((t) => t.includes("https://example.com/x")));
  assert.ok([...toks].some((t) => t.includes("quoted")));
  assert.equal(copilot.factualTokens("").size, 0);
  const empty = await copilot.improveReply({ text: "   " });
  assert.match(empty.error, /reply text required/);
  const llm = require("./llm");
  const real = llm.complete;
  llm.complete = async () => ({ text: "" });
  try {
    const kept = await copilot.improveReply({ text: "hello there" });
    assert.equal(kept.improved, "hello there");
    assert.equal(kept.changed, false);
  } finally {
    llm.complete = real;
  }
});
export {};
