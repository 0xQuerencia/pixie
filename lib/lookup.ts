const crypto = require("node:crypto");
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
const claimVerifier = require("./claimVerifier");
const retrieve = require("./retrieve");
import type { Program, ProgramSource } from "./types";
import type { AnswerVerification, ClaimEvidence } from "./types";

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
  verification?: AnswerVerification;
}
interface AnswerOptions {
  onText?: ((text: string) => void) | null;
  inHelpChannel?: boolean;
  program?: ProgramLike | string | null;
  channel?: string | null;
  allowWebSearch?: boolean;
  isPing?: boolean;
  skipCache?: boolean;
  kind?: "program" | "general";
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
  const milestones = record
    ? record.sharedSources === false
      ? record.milestones || []
      : record.milestones || programs.shared().milestones
    : programs.shared().milestones;

  const direct = program.directAnswer(question, new Date(), milestones, record);
  return direct ? { ...direct, direct: true } : direct;
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

function numericClaimsGrounded(answerText: string, corpusText: string) {
  if (!corpusText) return true;
  const claims = claimVerifier.numericSignatures(String(answerText || ""));
  if (claims.size === 0) return true;
  const corpus = claimVerifier.numericSignatures(corpusText);
  return [...claims].every((claim: string) => corpus.has(claim));
}

function sourceSectionsFromCorpus(prog: ProgramLike | string | null, corpus: string) {
  const names = new Set(
    programSources(prog)
      .map((source) => source.name)
      .filter(Boolean),
  );
  const headers = [...String(corpus || "").matchAll(/^###\s+(.+?)\s*$/gm)].filter((match) => names.has(match[1]));
  return headers.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index || String(corpus).length : String(corpus).length;
    return [match[1], String(corpus).slice(start, end).trim()] as [string, string];
  });
}

function evidenceIdFor(kind: string, sourceName: string, text: string) {
  return `${sourceName}#${crypto.createHash("sha1").update(`${kind}\n${sourceName}\n${text}`).digest("hex").slice(0, 16)}`;
}

function contextEvidenceFromText(context: string, programId: string, prog: ProgramLike | string | null = null) {
  const allowed = new Set([
    ...programSources(prog).map((source) => source.name),
    "About pixie",
    "Program timeline",
    "Learned answers",
  ]);
  const matches = [...String(context || "").matchAll(/^###\s+(.+?)\s*$/gm)];
  return matches.flatMap((match, index) => {
    if (!allowed.has(match[1])) return [];
    const start = (match.index || 0) + match[0].length;
    const end =
      index + 1 < matches.length ? matches[index + 1].index || String(context).length : String(context).length;
    const text = String(context).slice(start, end).trim();
    const learned = match[1] === "Learned answers";
    return {
      id: evidenceIdFor(learned ? "learned" : "source", match[1], text),
      programId,
      sourceName: match[1],
      heading: null,
      text,
      authority: learned ? "learned" : "source",
      kind: learned ? "learned" : "source",
      ...(learned ? { status: "approved", approved: true } : {}),
    } as ClaimEvidence;
  });
}

function selectedContext(question: string, programId: string | null) {
  const legacyContext = knowledge.getContext(question, programId);
  if (!programId) return { context: legacyContext, evidence: contextEvidenceFromText(legacyContext, "shared", null) };

  try {
    const sections = knowledge.generatedSections(programId, question) || [];
    const generated = sections.filter(([name]: [string, string]) => name !== "Learned answers");
    const learned = sections.filter(([name]: [string, string]) => name === "Learned answers");
    const sourceSections = sourceSectionsFromCorpus(programId, knowledge.getCorpus(programId));
    const detailed = retrieve.selectContextDetailed({
      generated,
      learned,
      index: knowledge.getIndex(programId),
      sources: sourceSections,
      question,
      programId,
    });
    const generatedEvidence = generated
      .filter(([, text]: [string, string]) => text && detailed.context.includes(String(text).slice(0, 120)))
      .map(([sourceName, text]: [string, string]) => ({
        id: evidenceIdFor("generated", sourceName, text),
        programId,
        sourceName,
        heading: null,
        text: String(text),
        authority: "source",
        kind: "source",
      }));
    const selectedEvidence = detailed.evidence.map((item: ClaimEvidence) =>
      item.kind === "learned" || item.authority === "learned" ? { ...item, status: "approved", approved: true } : item,
    );
    return { context: detailed.context || legacyContext, evidence: [...generatedEvidence, ...selectedEvidence] };
  } catch (error: unknown) {
    log.debug("lookup", `detailed retrieval unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return { context: legacyContext, evidence: contextEvidenceFromText(legacyContext, programId, programId) };
  }
}

function corpusEvidence(result: AnswerResult, prog: ProgramLike | string | null, corpus: string): ClaimEvidence[] {
  const programId = idOf(prog) || "shared";
  if (!programId || !corpus) return [];
  const sourceName = String(result.source || "").trim();
  if (!sourceName) return [];
  const configured = configuredSource(result, prog);
  const names = new Set([sourceName.toLowerCase(), configured?.name.toLowerCase()]);
  const sections = sourceSectionsFromCorpus(prog, corpus).filter(([name]) => names.has(name.toLowerCase()));
  const texts = sections.length
    ? sections.map(([name, text]) => [name, text] as [string, string])
    : (() => {
        const prefix = configured?.name || sourceName;
        const match = corpus.trimStart();
        const text = match.toLowerCase().startsWith(prefix.toLowerCase())
          ? match
              .slice(prefix.length)
              .replace(/^\s*[:\n-]?\s*/, "")
              .trim()
          : "";
        return text ? [[prefix, text] as [string, string]] : [];
      })();
  return texts.map(([name, text]) => ({
    id: evidenceIdFor("source", name, text),
    programId,
    sourceName: name,
    heading: null,
    text,
    authority: "source",
    kind: "source",
  }));
}

function materialClaimCount(result: AnswerResult | null) {
  return claimVerifier.extractMaterialClaims(String(result?.answer || "")).length;
}

function learnedSource(result: AnswerResult, evidence: ClaimEvidence[]) {
  const source = String(result.source || "")
    .trim()
    .toLowerCase();
  return evidence.some(
    (item) =>
      String(item.sourceName || "")
        .trim()
        .toLowerCase() === source && String(item.authority || item.kind || "").toLowerCase() === "learned",
  );
}

function configuredSource(result: AnswerResult, prog: ProgramLike | string | null) {
  const reportedSource = result.source ? result.source.trim().toLowerCase() : "";
  if (!reportedSource) return null;
  return (
    programSources(prog).find((candidate) => {
      if (!candidate?.name) return false;
      if (candidate.name.toLowerCase() === reportedSource) return true;
      return knowledge.sourceContainsCitation(candidate, reportedSource);
    }) || null
  );
}

function evidenceMatchesReportedSource(
  result: AnswerResult,
  evidence: ClaimEvidence[],
  prog: ProgramLike | string | null,
  verification?: AnswerVerification,
) {
  const matching = reportedEvidence(result, evidence, prog);
  const matchingIds = new Set(matching.map((item) => item.id));
  if (matchingIds.size === 0) return false;
  if (!verification) return true;
  return verification.claims.every((claim) => {
    if (!claim.supported) return true;
    return claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => matchingIds.has(id));
  });
}

function reportedEvidence(result: AnswerResult, evidence: ClaimEvidence[], prog: ProgramLike | string | null) {
  const source = configuredSource(result, prog);
  const reported = result.source?.trim().toLowerCase() || "";
  return evidence.filter((item) => {
    const sourceName = String(item.sourceName || "")
      .trim()
      .toLowerCase();
    if (source) return sourceName === source.name.toLowerCase() || sourceName === reported;
    return (
      (result.direct === true && sourceName === reported) ||
      (String(item.authority || item.kind || "").toLowerCase() === "learned" && sourceName === reported) ||
      generatedSource(result, [item])
    );
  });
}

function generatedSource(result: AnswerResult, evidence: ClaimEvidence[]) {
  const reported = String(result.source || "")
    .trim()
    .toLowerCase();
  if (!reported) return false;
  return evidence.some((item) => {
    const name = String(item.sourceName || "")
      .trim()
      .toLowerCase();
    return (
      name === reported &&
      String(item.kind || item.authority || "").toLowerCase() === "source" &&
      ["about pixie", "program timeline"].includes(name)
    );
  });
}

function verificationFor(
  result: AnswerResult,
  prog: ProgramLike | string | null,
  question: string,
  corpus: string,
  evidence: ClaimEvidence[],
): AnswerVerification {
  const programId = idOf(prog) || "shared";
  const preferred = reportedEvidence(result, evidence, prog);
  const preferredIds = new Set(preferred.map((item) => item.id));
  const orderedEvidence = [...preferred, ...evidence.filter((item) => !preferredIds.has(item.id))];
  const checked = claimVerifier.verifyAnswerSync({
    programId,
    answer: result.answer || "",
    evidence: orderedEvidence,
  });
  if (materialClaimCount(result) > 0 && !evidenceMatchesReportedSource(result, evidence, prog, checked)) {
    return {
      ...checked,
      verdict: "unsupported",
      sendable: false,
      errors: [...new Set([...checked.errors, "source_evidence_mismatch"])],
    };
  }
  void question;
  return checked;
}

function exactClaimAllowed(result: AnswerResult | null, prog: ProgramLike | string | null, question = "", corpus = "") {
  if (!result || !result.answer) return false;
  prog = typeof prog === "string" ? programs.get(prog) : prog;

  const evidence = Array.isArray(result.evidence)
    ? (result.evidence as ClaimEvidence[])
    : corpusEvidence(result, prog, corpus);
  const verification = verificationFor(result, prog, question, corpus, evidence);
  const source = configuredSource(result, prog);
  const generated =
    (result.direct === true && evidence.some((item) => item.sourceName === result.source)) ||
    generatedSource(result, evidence);
  const learned = learnedSource(result, evidence);

  if (isAuthoritativeOnlyTopic(question, result) && evidence.length === 0) return false;
  if (result.source && !source && !generated && !learned) return false;
  if (!result.source) return false;
  if (source) {
    const freshness = knowledge.sourceEligibility(source);
    if (!freshness.exactClaimsAllowed) return false;
  }
  if (!verification.sendable) return false;
  return numericClaimsGrounded(result.answer || "", evidence.map((item) => item.text).join("\n"));
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
  const evidence = Array.isArray(result.evidence)
    ? (result.evidence as ClaimEvidence[])
    : corpusEvidence(result, prog, corpus);
  return { ...result, evidence, verification: verificationFor(result, prog, question, corpus, evidence) };
}

async function applyGroundingBoundaryAsync(
  result: AnswerResult | null,
  prog: ProgramLike | string | null,
  question = "",
  corpus = "",
  evidence: ClaimEvidence[] = [],
  { allowUngroundedChat = false }: { allowUngroundedChat?: boolean } = {},
) {
  if (!result) return result;
  const programId = idOf(prog);
  const preferred = reportedEvidence(result, evidence, prog);
  const preferredIds = new Set(preferred.map((item) => item.id));
  const orderedEvidence = [...preferred, ...evidence.filter((item) => !preferredIds.has(item.id))];
  const checked = await claimVerifier.verifyAnswer({
    programId: programId || "shared",
    answer: result.answer || "",
    evidence: orderedEvidence,
  });
  const enriched = { ...result, evidence, verification: checked };
  const source = configuredSource(result, prog);
  const generated =
    (result.direct === true && evidence.some((item) => item.sourceName === result.source)) ||
    generatedSource(result, evidence);
  const learned = learnedSource(result, evidence);
  if (isAuthoritativeOnlyTopic(question, result) && evidence.length === 0) return null;
  if (result.source && !source && !generated && !learned) return null;
  if (source) {
    const freshness = knowledge.sourceEligibility(source);
    if (!freshness.exactClaimsAllowed) return null;
  }
  if (!programId) {
    if (!result.source && !allowUngroundedChat) return null;
    if (!checked.sendable && !allowUngroundedChat) return null;
    return enriched;
  }
  if (!result.source && !allowUngroundedChat) {
    if (checked.claims.length === 0) {
      return {
        ...enriched,
        answer: "",
        unclear: true,
        verification: {
          ...checked,
          verdict: "unsupported",
          sendable: false,
          errors: [...new Set([...checked.errors, "source_required"])],
        },
      };
    }
    return null;
  }
  if (materialClaimCount(result) > 0 && !checked.sendable) {
    if (allowUngroundedChat && !result.source && !isAuthoritativeOnlyTopic(question, result)) return enriched;
    return null;
  }
  if (
    materialClaimCount(result) > 0 &&
    result.source &&
    !evidenceMatchesReportedSource(result, evidence, prog, checked)
  )
    return null;
  return enriched;
}

async function verifiedCacheHit(
  question: string,
  contextPrompt: string,
  prog: ProgramLike | string | null = null,
  skipCache = false,
) {
  const hit = cacheHit(question, contextPrompt, cacheScope(prog), skipCache);
  if (!hit) return null;
  const programId = idOf(prog);
  const details = selectedContext(retrievalQuery(question, contextPrompt, prog), programId);
  return applyGroundingBoundaryAsync(hit, prog, question, details.context, details.evidence);
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
  const hit = await verifiedCacheHit(question, contextPrompt, prog, skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) {
    const stagedDetails = selectedContext(retrievalQuery(question, contextPrompt, prog), programId);
    return applyGroundingBoundaryAsync(staged, prog, question, stagedDetails.context, stagedDetails.evidence);
  }

  const query = retrievalQuery(question, contextPrompt, prog);
  const details = selectedContext(query, programId);
  const corpus = details.context;
  let result = await answer.getGroundedAnswer(question, corpus, contextPrompt, prog, channel, { isPing });
  if (result) {
    result = await applyGroundingBoundaryAsync(result, prog, question, corpus, details.evidence);
  }
  if (result) {
    if (!contextPrompt && !skipCache && result.verification?.sendable) cache.put(question, result, cacheScope(prog));
    return result;
  }
  const direct = dateFallback(question, contextPrompt, prog);
  const checkedDirect = await applyGroundingBoundaryAsync(direct, prog, question, corpus, details.evidence);
  if (checkedDirect && !contextPrompt && !skipCache && checkedDirect.verification?.sendable)
    cache.put(question, checkedDirect, cacheScope(prog));
  return checkedDirect;
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
    kind = "program",
  }: AnswerOptions = {},
) {
  const programId = idOf(prog);
  const hit = await verifiedCacheHit(question, contextPrompt, prog, skipCache);
  if (hit) return hit;

  const staged = await runCodeStages(question);
  if (staged) {
    const stagedDetails = selectedContext(retrievalQuery(question, contextPrompt, prog), programId);
    return applyGroundingBoundaryAsync(staged, prog, question, stagedDetails.context, stagedDetails.evidence, {
      allowUngroundedChat: kind === "general",
    });
  }

  const query = retrievalQuery(question, contextPrompt, prog);
  const details = selectedContext(query, programId);
  const corpus = details.context;
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
    if (direct) result = direct;

    if (!direct)
      result =
        (await webFallback({
          question,
          contextPrompt,
          corpus,
          prog,
          channel,
          isPing,
          inHelpChannel,
          allowWebSearch,
        })) || result;
  }

  result = await applyGroundingBoundaryAsync(result, prog, question, corpus, details.evidence, {
    allowUngroundedChat: kind === "general",
  });
  if (result?.source && !contextPrompt && !skipCache && result.verification?.sendable)
    cache.put(question, result, cacheScope(prog));
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

async function knownAnswer({
  question,
  contextPrompt,
  mode,
  program: prog = null,
  skipCache = false,
}: KnownAnswerOptions) {
  if (contextPrompt) return null;
  if (link.extractUrl(question)) return null;
  if (mode === DOCS_ONLY) return null;
  return verifiedCacheHit(question, contextPrompt, prog, skipCache);
}

export = {
  idOf,
  cacheHit,
  verifiedCacheHit,
  dateFallback,
  retrievalQuery,
  lookupAnswer,
  answerOrChat,
  knownAnswer,
  exactClaimAllowed,
  applyGroundingBoundary,
  applyGroundingBoundaryAsync,
  isAuthoritativeOnlyTopic,
  numericClaimsGrounded,
};
