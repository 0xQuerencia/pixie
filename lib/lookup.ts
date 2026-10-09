const knowledge = require("./knowledge");
const answer = require("./answer");
const cache = require("./cache");
const program = require("./program");
const programs = require("./programs");
const link = require("./link");
const db = require("./db");
const log = require("./log");
const firecrawl = require("./firecrawl");
const validator = require("./validator");
const answerVerifier = require("./answerVerifier");
import type { Program, ProgramSource } from "./types";

type ProgramLike = Partial<Program> & { id?: string };
type SourceLike = Partial<ProgramSource> & {
  siteUrl?: string;
  hidden?: boolean;
  dynamic?: boolean;
  content?: unknown;
  paths?: string[];
};
interface AnswerResult {
  source?: string | null;
  answer?: string;
  direct?: boolean;
  groundingVerdict?: unknown;
  evidence?: unknown[];
  fixtureClaims?: unknown[];
}
interface AnswerOptions {
  onText?: ((text: string) => void) | null;
  inHelpChannel?: boolean;
  program?: ProgramLike | string | null;
  channel?: string | null;
  allowWebSearch?: boolean;
  isPing?: boolean;
  skipCache?: boolean;
}
interface WebResult {
  title?: string;
  url?: string;
  markdown?: string;
}

type AnswerMode = "docs-only" | "help-only" | "always";
const DOCS_ONLY: AnswerMode = "docs-only";

function idOf(program: ProgramLike | string | null | undefined) {
  if (!program) return null;
  return typeof program === "string" ? program : program.id || null;
}

function cacheScope(program: ProgramLike | string | null | undefined) {
  const id = idOf(program);
  return id;
}

function programSources(record: ProgramLike | string | null | undefined): SourceLike[] {
  const resolved: ProgramLike | null =
    (typeof record === "string" ? (programs.get(record) as ProgramLike) : record) || null;
  const shared = resolved && resolved.sharedSources === false ? [] : programs.shared().sources || [];
  return [...(resolved?.sources || []), ...shared];
}

function cacheHit(question: string, contextPrompt: string, programId: string | null = null, skipCache = false) {
  if (contextPrompt || skipCache) return null;
  const hit = cache.get(question, programId);
  if (!hit) return null;
  log.debug("respond", "cache hit");
  db.recordMetric("cache_hit");
  return hit;
}

function dateFallback(question: string, contextPrompt: string, prog: ProgramLike | string | null = null) {
  const record = typeof prog === "string" ? programs.get(prog) : prog;
  const programId = idOf(record || prog);
  const milestones = record
    ? record.sharedSources === false
      ? record.milestones || []
      : record.milestones || programs.shared().milestones
    : programs.shared().milestones;

  const direct = program.directAnswer(question, new Date(), milestones, record);
  if (direct && !contextPrompt) cache.put(question, direct, programId);
  return direct;
}

async function repoValidatorAnswer(question: string) {
  const isCheckQuery = /\b(?:check|inspect|validate|review|audit|ready for submission|submission check)\b/i.test(
    question,
  );
  const parsed = validator.parseGithubUrl(question);
  if (parsed && (isCheckQuery || /^\s*https?:\/\/github\.com\/[^\s]+\s*$/i.test(question))) {
    const report = await validator.validateRepository(parsed.url);
    if (report && report.ok) {
      db.recordMetric("answer_validator");
      return {
        source: "Repo Validator",
        direct: true,
        answer: validator.formatValidationReport(report),
      };
    }
  }
  return null;
}

async function runCodeStages(question: string) {
  const validated = await repoValidatorAnswer(question);
  if (validated) return validated;

  return null;
}

const AUTHORITATIVE_ONLY_RES = [
  /\b(?:first|second|third|1st|2nd|3rd)\s+pass\b/i,
  /\bfraud\s*review\b/i,
  /\breview\w*\s+(?:queue|status|state)\b/i,
  /\breview\w*\b[^.!?\n]{0,40}\b(?:how\s+long|eta|timing|take|takes|taking|taken|duration|when|available|availability|waiting|wait|pending|stuck|slow)\b/i,
  /\b(?:how\s+long|eta|when)\b[^.!?\n]{0,25}\breview\w*\b/i,
  /\bwhy\b[^.!?\n]{0,40}\b(?:review\w*|approved|passed|waiting|pending|stuck)\b/i,
  /\bwill\s+(?:my|this|it|the\s+project)\b[^.!?\n]{0,25}\b(?:pass|fail|get\s+(?:approved|rejected))\b/i,
  /\bdeflat\w*\b/i,
  /\bcount(?:s|ed|ing)?\s+(?:as|toward|towards|for|into)\b/i,
  /\b(?:does|do|is|are|would|will)\b[^.!?\n]{0,40}\bcount\b/i,
  /\b(?:research|learning|tutorial)\s+time\b/i,
  /\buncommitted\b[^.!?\n]{0,20}\bsession/i,
  /\bwhat\s+evidence\b/i,
  /\bhand[- ]?drawn\b|\bhandwritten\b/i,
  /\bai\s+(?:limit|percentage|cap|allowance|policy)\b/i,
  /\bhow\s+much\s+ai\b/i,
  /\bfraud\b/i,
  /\b(?:banned?|appeal\w*|penalt\w*|violat\w*)\b/i,
  /\bpayout\w*\b[^.!?\n]{0,25}\b(?:when|how\s+much|exact|amount|timing)\b/i,
  /\b(?:when|how\s+long)\b[^.!?\n]{0,25}\bpayout\w*\b/i,
  /\bshipping\s+(?:time|eta|when|status)\b/i,
  /\bwhen\b[^.!?\n]{0,20}\b(?:ship|shipped|arrive|arrives)\b/i,
  /\bcustoms\b/i,
  /\bgrant\w*\b[^.!?\n]{0,25}\b(?:status|when|amount)\b/i,
  /\border\s+status\b|\btracking\s+number\b/i,
  /\b(?:policy|rule|rules|eligible|eligibility|allowed|prohibited|forbidden|tax|expense|locally)\b/i,
];

function isAuthoritativeOnlyTopic(question: string, result: AnswerResult | null) {
  if (result?.direct) return false;
  const text = String(question || "");
  return AUTHORITATIVE_ONLY_RES.some((re) => re.test(text));
}

const NUMERIC_CLAIM_RE =
  /\$\s?\d[\d,.]*|\b\d[\d,.]*\s?%|\b\d[\d,.]*\s?(?:percent|px|pixels?|hours?|hrs?|days?|weeks?|months?|dollars?)\b/gi;

function normalizeForMatch(text: string) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function numericClaimsGrounded(answerText: string, corpusText: string) {
  if (!corpusText) return true;
  const claims = String(answerText || "").match(NUMERIC_CLAIM_RE) || [];
  if (claims.length === 0) return true;
  const corpusNorm = normalizeForMatch(corpusText);
  return claims.every((claim) => corpusNorm.includes(normalizeForMatch(claim)));
}

function exactClaimAllowed(result: AnswerResult | null, prog: ProgramLike | string | null, question = "", corpus = "") {
  if (!result) return false;
  prog = typeof prog === "string" ? programs.get(prog) : prog;
  let structuredSupport = false;
  if (result.groundingVerdict || result.evidence) {
    const programId = idOf(prog);
    if (!programId) return false;
    const checked = answerVerifier.verify({
      verdict: result.groundingVerdict,
      evidence: result.evidence,
      programId,
      fixtureClaims: result.fixtureClaims || [],
    });
    if (!checked.sendable) return false;
    structuredSupport = true;
  }

  const sources = programSources(prog);
  const reportedSource = result.source ? result.source.trim().toLowerCase() : "";
  const source = sources.find((candidate) => {
    if (!candidate?.name || !reportedSource) return false;
    if (candidate.name.toLowerCase() === reportedSource) return true;
    return knowledge.sourceContainsCitation(candidate, reportedSource);
  });
  if (!source) return !isAuthoritativeOnlyTopic(question, result);
  const freshness = knowledge.sourceEligibility(source);
  if (!(freshness.exactClaimsAllowed || (structuredSupport && freshness.authority !== "dynamic"))) return false;
  return numericClaimsGrounded(result.answer || "", corpus);
}

function applyGroundingBoundary(
  result: AnswerResult | null,
  prog: ProgramLike | string | null,
  question = "",
  corpus = "",
) {
  if (!result) return result;
  const allowed = exactClaimAllowed(result, prog, question, corpus);
  if (!allowed) {
    log.warn(
      "grounding",
      `rejected program=${idOf(prog) || "none"} source=${result.source || "NONE"} answer_chars=${result.answer?.length || 0} authoritative_only=${isAuthoritativeOnlyTopic(question, result)}`,
    );
    return null;
  }
  return result;
}

function retrievalQuery(question: string, contextPrompt = "", prog: ProgramLike | string | null = null) {
  let q = (question || "").trim();
  if (!contextPrompt || !contextPrompt.trim()) return q;

  const resolved = typeof prog === "string" ? (programs.get(prog) as ProgramLike) : prog;
  const rawProgName = resolved?.name || resolved?.id || "";
  const progName = /sandbox|test|staging/i.test(rawProgName) ? "" : rawProgName;

  const isFollowUp =
    /\b(it|that|this|they|them|how|what|why|steps|more|work|works|start|join|rules)\b/i.test(q) &&
    q.split(/\s+/).length <= 8;

  if (isFollowUp) {
    if (progName && !new RegExp(`\\b${progName}\\b`, "i").test(q)) {
      q = `${q} ${progName}`;
    }
    const userMatches = [...contextPrompt.matchAll(/User:\s*([^\n]+)/gi)];
    if (userMatches.length > 0) {
      const lastUserQ = userMatches[userMatches.length - 1][1].trim();
      if (lastUserQ && lastUserQ.toLowerCase() !== (question || "").trim().toLowerCase()) {
        q = `${q} ${lastUserQ}`;
      }
    }
  }

  return q;
}

async function lookupAnswer(
  question: string,
  contextPrompt = "",
  prog: ProgramLike | string | null = null,
  channel: string | null = null,
  { isPing = false, skipCache = false }: Pick<AnswerOptions, "isPing" | "skipCache"> = {},
) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const corpus = knowledge.getContext(query, programId);
  let result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel, { isPing });
  if (result) {
    result = applyGroundingBoundary(result, prog, question, corpus);
  }
  if (result) {
    if (!contextPrompt) cache.put(question, result, cacheScope(prog));
    return result;
  }
  return dateFallback(question, contextPrompt, prog);
}

async function answerOrChat(
  question: string,
  contextPrompt = "",
  {
    onText = null,
    inHelpChannel = false,
    program: prog = null,
    channel = null,
    allowWebSearch = false,
    isPing = false,
    skipCache = false,
  }: AnswerOptions = {},
) {
  const programId = idOf(prog);
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) return staged;

  const query = retrievalQuery(question, contextPrompt, prog);
  const corpus = knowledge.getContext(query, programId);
  let result = onText
    ? await answer.getAnswerOrChatStream(question, corpus, contextPrompt, {
        onText,
        inHelpChannel,
        program: prog,
        channel,
        isPing,
      })
    : await answer.getAnswerOrChat(question, corpus, contextPrompt, inHelpChannel, prog, channel, { isPing });

  if (!result?.source) {
    const direct = dateFallback(question, contextPrompt, prog);
    if (direct) return direct;

    result =
      (await webFallback({ question, contextPrompt, corpus, prog, channel, isPing, inHelpChannel, allowWebSearch })) ||
      result;
  }

  result = applyGroundingBoundary(result, prog, question, corpus);
  if (result?.source && !contextPrompt) cache.put(question, result, cacheScope(prog));
  return result;
}

async function webFallback({
  question,
  contextPrompt,
  corpus,
  prog,
  channel,
  isPing,
  inHelpChannel,
  allowWebSearch,
}: {
  question: string;
  contextPrompt: string;
  corpus: string;
  prog: ProgramLike | string | null;
  channel: string | null;
  isPing: boolean;
  inHelpChannel: boolean;
  allowWebSearch: boolean;
}) {
  if (!allowWebSearch) return null;
  const webResults = await firecrawl.searchWeb(question).catch(() => null);
  if (!webResults || webResults.length === 0) return null;
  const webSnippet = webResults.map((r: WebResult) => `Title: ${r.title}\nURL: ${r.url}\n${r.markdown}`).join("\n\n");
  const webContextPrompt = `${contextPrompt}\n\n=== WEB RESEARCH ===\n${webSnippet}`;
  return answer
    .getGroundedAnswer(question, corpus, webContextPrompt, prog, channel, { isPing, inHelpChannel })
    .catch(() => null);
}

interface KnownAnswerOptions {
  question: string;
  contextPrompt: string;
  mode: AnswerMode;
  program?: ProgramLike | string | null;
  skipCache?: boolean;
}

function knownAnswer({ question, contextPrompt, mode, program: prog = null, skipCache = false }: KnownAnswerOptions) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  if (mode === DOCS_ONLY) return null;
  return cacheHit(question, contextPrompt, idOf(prog), skipCache);
}

export = {
  idOf,
  cacheHit,
  dateFallback,
  retrievalQuery,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
  exactClaimAllowed,
  applyGroundingBoundary,
  isAuthoritativeOnlyTopic,
  numericClaimsGrounded,
};
