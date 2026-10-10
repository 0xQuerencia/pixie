// Side-effect-free end-to-end support evals: real engagement-plan, retrieval, lookup and claim verification on an
// in-memory database, with scripted model replies. No Slack client exists here, so nothing can be posted or pinged.
const SIDE_EFFECT_TABLES = [
  "tickets",
  "ticket_events",
  "learned_facts",
  "answer_cache",
  "support_memory",
  "answer_traces",
];
const USER_ID = "U-eval";

interface E2eProgram {
  name?: string;
  workspaceId?: string;
  sources: Array<{ name: string; type: string; content: string }>;
}
interface E2eExpect {
  action?: string;
  grounded?: boolean;
  answered?: boolean;
  promptIncludes?: string[];
  promptExcludes?: string[];
  answerIncludes?: string;
  posted?: boolean;
  postIncludes?: string[];
  postExcludes?: string[];
}
interface E2eCase {
  name: string;
  category: string;
  program: string;
  question: string;
  path?: "probe" | "lookup" | "respond";
  cachePoison?: { source: string; answer: string };
  engagement?: { engage: boolean; intent?: string };
  addressed?: boolean;
  model?: string;
  contextPrompt?: string;
  learnedFacts?: Array<{ question: string; answer: string; status: string; autoLearned?: boolean }>;
  memory?: Array<{ kind: string; value: string }>;
  expect: E2eExpect;
}
interface E2eFixture {
  programs: Record<string, E2eProgram>;
  cases: E2eCase[];
}
interface E2eResult {
  name: string;
  category: string;
  passed: boolean;
  failures: string[];
}

const NO_ANSWER = "SOURCE: NONE\nANSWER: UNCLEAR";

function countRows(db: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of SIDE_EFFECT_TABLES) {
    try {
      counts[table] = Number(db.handle().query(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

function seedPrograms(fixture: E2eFixture, db: any, programs: any, knowledge: any) {
  for (const [id, spec] of Object.entries(fixture.programs)) {
    db.saveProgram({
      id,
      name: spec.name || id,
      workspaceId: spec.workspaceId || `W-${id}`,
      helpChannel: `C-${id}`,
      channels: [`C-${id}`],
      sources: spec.sources,
    });
    for (const source of spec.sources)
      db.saveSourceText(knowledge.sourceCacheKey(source) || source.name, source.content);
  }
  programs.invalidate();
  knowledge.invalidate();
}

function checkPrompt(prompts: string[], expect: E2eExpect, failures: string[]) {
  const joined = prompts.join("\n");
  for (const text of expect.promptIncludes || []) if (!joined.includes(text)) failures.push(`prompt missing "${text}"`);
  for (const text of expect.promptExcludes || []) if (joined.includes(text)) failures.push(`prompt leaked "${text}"`);
}

async function runCase(item: E2eCase, fixture: E2eFixture): Promise<E2eResult> {
  const db = require("./db");
  const programs = require("./programs");
  const knowledge = require("./knowledge");
  const llm = require("./llm");
  const engagementModule = require("./pipeline/engagement");
  const supportMemory = require("./supportMemory");
  const api = require("./web/api");
  const lookup = require("./lookup");
  const cache = require("./cache");

  db.close();
  db.open(":memory:");
  seedPrograms(fixture, db, programs, knowledge);
  for (const fact of item.learnedFacts || []) {
    db.addLearnedFact({
      question: fact.question,
      answer: fact.answer,
      status: fact.status,
      autoLearned: fact.autoLearned === true,
      programId: item.program,
      sourceTs: `eval-${item.name}`,
    });
  }
  for (const row of item.memory || []) {
    supportMemory.remember({ programId: item.program, userId: USER_ID, kind: row.kind, value: row.value });
  }
  knowledge.invalidate();
  cache.clearCache();

  const before = countRows(db);
  const prompts: string[] = [];
  const originalComplete = llm.complete;
  const originalClassify = engagementModule.classify;
  llm.complete = async (request: { messages?: Array<{ content: string }> }, operation: string) => {
    if (operation === "answer") {
      prompts.push(request.messages?.[0]?.content || "");
      return { text: item.model || NO_ANSWER, finishReason: "stop" };
    }
    return { text: "", finishReason: "stop" };
  };
  engagementModule.classify = async () => ({
    engage: item.engagement ? item.engagement.engage : true,
    intent: item.engagement?.intent || "support_question",
    error: null,
    source: "eval",
  });

  const failures: string[] = [];
  try {
    if ((item.path || "probe") === "probe") {
      const res = await api.internalTestQuestion(item.program, {
        question: item.question,
        role: "help",
        addressed: item.addressed === true,
      });
      if (res.error) failures.push(`probe error: ${res.error}`);
      if (item.expect.action && res.expectedAction !== item.expect.action)
        failures.push(`action ${res.expectedAction} != ${item.expect.action}`);
      if (item.expect.grounded !== undefined && res.grounded !== item.expect.grounded)
        failures.push(`grounded ${res.grounded} != ${item.expect.grounded}`);
      if (item.expect.answerIncludes && !String(res.answerPreview || "").includes(item.expect.answerIncludes))
        failures.push(`answer missing "${item.expect.answerIncludes}"`);
    } else if (item.path === "respond") {
      const posts: string[] = [];
      const record = (payload: { text?: string; blocks?: unknown }) => {
        posts.push(`${payload.text || ""} ${payload.blocks ? JSON.stringify(payload.blocks) : ""}`);
        return { ts: `eval-msg-${posts.length}` };
      };
      const client = {
        chat: {
          postMessage: async (payload: { text?: string; blocks?: unknown }) => record(payload),
          update: async (payload: { text?: string; blocks?: unknown }) => record(payload) && {},
          delete: async () => ({ ok: true }),
        },
        reactions: { add: async () => ({}) },
      };
      if (item.cachePoison) cache.put(item.question, item.cachePoison, item.program);
      await require("./respond").respond({
        client,
        channel: `C-${item.program}`,
        threadTs: `eval-thread-${item.name.length}`,
        userId: USER_ID,
        question: item.question,
        mode: require("./respond").HELP_ONLY,
      });
      const joined = posts.join("\n");
      if (item.expect.posted !== undefined && posts.length > 0 !== item.expect.posted)
        failures.push(`posted ${posts.length > 0} != ${item.expect.posted}`);
      for (const text of item.expect.postIncludes || [])
        if (!joined.includes(text)) failures.push(`post missing "${text}"`);
      for (const text of item.expect.postExcludes || [])
        if (joined.includes(text)) failures.push(`post leaked "${text}"`);
    } else {
      const program = programs.get(item.program);
      const answerOnlyContext = supportMemory.formatAttemptedSteps(item.program, USER_ID, { maxAgeDays: 30 });
      const result = await lookup.answerOrChat(item.question, item.contextPrompt || "", {
        program,
        kind: "program",
        skipCache: true,
        noTelemetry: true,
        answerOnlyContext,
      });
      const answered = Boolean(result?.verification?.sendable);
      if (item.expect.answered !== undefined && answered !== item.expect.answered)
        failures.push(`answered ${answered} != ${item.expect.answered}`);
    }
    checkPrompt(prompts, item.expect, failures);
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    llm.complete = originalComplete;
    engagementModule.classify = originalClassify;
  }

  const after = countRows(db);
  const guarded = item.path === "respond" ? ["learned_facts", "support_memory"] : SIDE_EFFECT_TABLES;
  for (const table of guarded) {
    if (after[table] !== before[table]) failures.push(`side effect: ${table} ${before[table]} -> ${after[table]}`);
  }
  return { name: item.name, category: item.category, passed: failures.length === 0, failures };
}

async function runE2eEvals(fixture: E2eFixture): Promise<E2eResult[]> {
  const results: E2eResult[] = [];
  for (const item of fixture.cases) results.push(await runCase(item, fixture));
  return results;
}

export = { runE2eEvals };
