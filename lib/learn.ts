const db = require("./db");
const cache = require("./cache");
const log = require("./log");
const programs = require("./programs");
const retrieve = require("./retrieve");
const { config } = require("./config");
const llm = require("./llm");

interface Fact {
  id: number;
  question: string;
  answer: string;
  status: string;
  author_id?: string | null;
  source_ts?: string | null;
  channel?: string | null;
  program_id?: string | null;
  created_at?: number | null;
  last_supported_at?: number | null;
}

const PENDING = "pending";
const APPROVED = "approved";

const TEACH_SEPARATOR = "::";

const MIN_CAPTURE_LENGTH = 25;
const MAX_CAPTURE_LENGTH = 1500;
const MAX_CAPTURES_PER_QUESTION = 2;

const JUDGE_MAX_TOKENS = 5;
const JUDGE_TIMEOUT_MS = 10000;

const CORPUS_FACT_LIMIT = 50;
const REPORT_DRAFT_SOURCE_PREFIX = "gap-draft:";

function parseTeach(text: string): { question: string; answer: string } | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(TEACH_SEPARATOR);
  if (idx === -1) return null;
  const question = raw.slice(0, idx).trim();
  const answer = raw.slice(idx + TEACH_SEPARATOR.length).trim();
  if (!question || !answer) return null;
  if (question.includes("\n")) return null;
  if (/^(?:Here'?s a thinking process|Thinking Process)/i.test(question)) return null;
  return { question, answer };
}

function invalidateCorpus() {
  cache.clearCache();
  require("./knowledge").invalidate();
}

function teach({
  question,
  answer,
  authorId,
  threadTs = null,
  channel = null,
  programId = null,
}: {
  question: string;
  answer: string;
  authorId: string;
  threadTs?: string | null;
  channel?: string | null;
  programId?: string | null;
}): number | null {
  const id = db.addLearnedFact({
    question,
    answer,
    authorId,
    status: APPROVED,
    sourceTs: threadTs,
    channel,
    programId,
  });
  if (id) invalidateCorpus();
  return id;
}

function captureFromThread({
  question,
  answer,
  authorId,
  threadTs,
  channel,
  programId = null,
  autoApprove = false,
}: {
  question: string;
  answer: string;
  authorId: string;
  threadTs: string;
  channel: string;
  programId?: string | null;
  autoApprove?: boolean;
}): number | null {
  void autoApprove;
  const status = PENDING;
  const id = db.addLearnedFact({ question, answer, authorId, status, sourceTs: threadTs, channel, programId });
  return id;
}

function stripNoise(text: string): string {
  return String(text || "")
    .replace(/<[@#!][^>]+>/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

function isCaptureWorthy(text: string): boolean {
  const trimmed = (text || "").trim();
  if (trimmed.length < MIN_CAPTURE_LENGTH || trimmed.length > MAX_CAPTURE_LENGTH) return false;
  return stripNoise(trimmed).length >= MIN_CAPTURE_LENGTH;
}

function judgeMessages(question: string, replyText: string): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content:
        "You check whether a Slack message answers a question. Reply with EXACTLY one word: YES or NO.\n\n" +
        "YES only when the message gives the asker information that resolves their question — a fix, an " +
        "explanation, a link with context, a direct factual reply.\n\n" +
        "NO for everything else: someone continuing the conversation, asking their own question, " +
        "reacting, joking, agreeing, guessing, or talking about something unrelated. Most messages in a " +
        "thread are NO.\n\n" +
        "When in doubt, answer NO.",
    },
    { role: "user", content: `Question: ${question}\n\nMessage: ${replyText}` },
  ];
}

async function judgeAnswer(question: string, replyText: string): Promise<boolean> {
  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: config.intent.onRateLimited,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: judgeMessages(question, replyText),
      },
      "learn",
    );
    return text?.trim().toUpperCase().startsWith("YES") === true;
  } catch (e) {
    log.debug("learn", `capture judge failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function captureFromReply(_args: unknown): Promise<null> {
  void _args;
  return null;
}

function pending(limit = 25, programId: string | null = null): Fact[] {
  return db.listLearnedFacts(PENDING, limit, programId);
}

function approved(limit = 200, programId: string | null = null): Fact[] {
  return db.listLearnedFacts(APPROVED, limit, programId);
}

function approve(id: number): boolean {
  const fact = db.getLearnedFactById(id);
  if (!fact || (fact.status !== "candidate" && fact.status !== PENDING)) return false;
  if (!fact.program_id && String(fact.source_ts || "").startsWith(REPORT_DRAFT_SOURCE_PREFIX)) return false;
  const ok = db.setLearnedStatus(id, APPROVED);
  if (ok) invalidateCorpus();
  return ok;
}

function forget(id: number): boolean {
  const ok = db.deleteLearnedFact(id);
  if (ok) invalidateCorpus();
  return ok;
}

function forgetByStatus(status: string): number {
  const count = db.deleteLearnedByStatus(status);
  if (count > 0) invalidateCorpus();
  return count;
}

function forgetRange(fromId: number, toId: number): number {
  const count = db.deleteLearnedRange(fromId, toId);
  if (count > 0) invalidateCorpus();
  return count;
}

function corpusSection(programId: string | null = null): string {
  const facts = db.approvedFacts(CORPUS_FACT_LIMIT, programId);
  if (facts.length === 0) return "";
  return facts.map((f: Fact) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
}

function relevantFacts(
  question: string,
  programId: string | null = null,
  {
    maxFacts = retrieve.LEARNED_MAX_FACTS,
    maxChars = retrieve.LEARNED_BUDGET,
  }: { maxFacts?: number; maxChars?: number } = {},
): Fact[] {
  const questionTokens = retrieve.tokenize(question);
  if (questionTokens.length === 0) return [];
  const scored = [];
  for (const fact of db.approvedFacts(CORPUS_FACT_LIMIT, programId)) {
    const factTokens = new Set(retrieve.tokenize(`${fact.question} ${fact.answer}`));
    let overlap = 0;
    for (const token of questionTokens) if (factTokens.has(token)) overlap += 1;
    if (overlap > 0) scored.push({ fact, overlap });
  }
  scored.sort((a, b) => {
    const overlap = b.overlap - a.overlap;
    if (overlap !== 0) return overlap;
    return (b.fact.last_supported_at || b.fact.created_at || 0) - (a.fact.last_supported_at || a.fact.created_at || 0);
  });
  const picked = [];
  let used = 0;
  for (const { fact } of scored.slice(0, maxFacts)) {
    const rendered = `Q: ${fact.question}\nA: ${fact.answer}`;
    if (picked.length > 0 && used + 2 + rendered.length > maxChars) break;
    picked.push(fact);
    used += (picked.length > 1 ? 2 : 0) + rendered.length;
  }
  return picked;
}

function relevantCorpusSection(
  question: string,
  programId: string | null = null,
  opts: { maxFacts?: number; maxChars?: number } = {},
): string {
  const facts = relevantFacts(question, programId, opts);
  if (facts.length === 0) return "";
  return facts.map((f: Fact) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n");
}

function invalidateCorpusPublic() {
  invalidateCorpus();
}

export = {
  parseTeach,
  teach,
  captureFromThread,
  captureFromReply,
  judgeAnswer,
  isCaptureWorthy,
  pending,
  approved,
  approve,
  forget,
  forgetByStatus,
  forgetRange,
  corpusSection,
  relevantFacts,
  relevantCorpusSection,
  invalidateCorpus: invalidateCorpusPublic,
  PENDING,
  APPROVED,
  TEACH_SEPARATOR,
  MIN_CAPTURE_LENGTH,
  MAX_CAPTURE_LENGTH,
  MAX_CAPTURES_PER_QUESTION,
  JUDGE_MAX_TOKENS,
  JUDGE_TIMEOUT_MS,
  CORPUS_FACT_LIMIT,
};
