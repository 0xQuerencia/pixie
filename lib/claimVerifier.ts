const llm = require("./llm");
const { config } = require("./config");
import type { AnswerVerification, ClaimEvidence, VerifiedClaim } from "./types";

type JudgeClaim = {
  claim: string;
  supported: boolean;
  evidenceIds: string[];
  reason: string;
};

type JudgeInput = {
  programId: string;
  answer: string;
  evidence: ClaimEvidence[];
  claims: VerifiedClaim[];
};

type Judge = (input: JudgeInput) => unknown | Promise<unknown>;

interface VerifyInput {
  programId: string;
  answer: string;
  evidence?: ClaimEvidence[];
  judge?: Judge | null;
  allowFixtures?: boolean;
  fixtureClaims?: unknown[];
}

const JUDGE_TIMEOUT_MS = 6000;
const MATERIAL_RE = new RegExp(
  [
    "\\d",
    "\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|first|second|third|fourth|fifth|last)\\b",
    "\\b(?:deadline|due|expires?|expiration|before|after|within|until|by|eligib(?:le|ility)|permission|allowed|prohibited|forbidden|banned|must|may|can|cannot|can't|should(?:n't| not)?|required|need(?:s)? to|approval|approved|approve|rejected|reject(?:ed)?|denied|deny|grant\\w*|payout\\w*|refund\\w*|limit\\w*|cap\\w*|rule\\w*|capped|submit|submission|apply|application|send|email|upload|attach|use)\\b",
    "\\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\\b",
  ].join("|"),
  "i",
);

const ESCALATION_RE =
  /^(?:hi|hello|hey|thanks?|thank you|sorry|apologies|i(?:'m| am) not sure|i do not know|i don't know|ask (?:a|the )?(?:helper|human|team)|(?:a )?helper can|please escalate|escalat(?:e|ed|ion)|i cannot verify)[^.!?]*[.!?]?$/i;
const CLARIFICATION_RE =
  /^(?:please\s+)?(?:can|could|would|will|do)\s+(?:you|u)\s+(?:clarify|be more specific|rephrase|explain what)\b/i;
const NEGATION_RE =
  /\b(?:not|no|never|cannot|can't|isn't|aren't|don't|doesn't|didn't|shouldn't|mustn't|prohibited|forbidden|banned|disallowed|ineligible|rejected|denied|without)\b/i;
const NUMBER_WORDS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
]);
const NUMBER_VALUES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "but",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "is",
  "it",
  "may",
  "might",
  "must",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "their",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "would",
]);
const UNIT_ALIASES: Record<string, string> = {
  "%": "percent",
  percent: "percent",
  px: "pixels",
  pixel: "pixels",
  pixels: "pixels",
  sec: "seconds",
  secs: "seconds",
  s: "seconds",
  second: "seconds",
  seconds: "seconds",
  ms: "milliseconds",
  millisecond: "milliseconds",
  milliseconds: "milliseconds",
  min: "minutes",
  mins: "minutes",
  m: "minutes",
  minute: "minutes",
  minutes: "minutes",
  hr: "hours",
  hrs: "hours",
  h: "hours",
  hour: "hours",
  hours: "hours",
  d: "days",
  day: "days",
  days: "days",
  week: "weeks",
  weeks: "weeks",
  month: "months",
  months: "months",
  year: "years",
  years: "years",
  dollar: "currency",
  dollars: "currency",
  credit: "credits",
  credits: "credits",
  point: "points",
  points: "points",
};
const TOKEN_ALIASES: Record<string, string> = {
  allowed: "allow",
  allows: "allow",
  permit: "allow",
  permits: "allow",
  permitted: "allow",
  permission: "allow",
  prohibited: "prohibit",
  forbidden: "prohibit",
  banned: "prohibit",
  disallowed: "prohibit",
  eligible: "eligib",
  eligibility: "eligib",
  required: "require",
  requires: "require",
  submitted: "submit",
  submission: "submit",
  applications: "apply",
  application: "apply",
  approved: "approve",
  approval: "approve",
  rejected: "reject",
  rejection: "reject",
  denied: "deny",
  denial: "deny",
};
const DATE_RE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi;
const DIGIT_RE =
  /(?:[$€£¥]\s*)?\d[\d,.]*(?:\.\d+)?\s*[-–]?\s*(?:%|percent|px|pixels?|ms|milliseconds?|s|seconds?|secs?|m|minutes?|mins?|h|hours?|hrs?|d|days?|weeks?|months?|years?|dollars?|credits?|points?)?/gi;
const WORD_NUMBER_RE = new RegExp(
  `\\b(?:${[...NUMBER_WORDS].join("|")})(?:[-\\s]+(?:${[...NUMBER_WORDS].join("|")}|and)){0,10}(?:(?:\\s+|-)(?:percent|dollars?|credits?|points?|seconds?|minutes?|hours?|days?|weeks?|months?|years?))?\\b`,
  "gi",
);

function textOf(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeText(value: unknown) {
  return textOf(value).toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function splitSentences(value: unknown): string[] {
  const text = textOf(value);
  if (!text) return [];
  return (text.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [])
    .map((sentence) => sentence.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function isMaterialClaim(sentence: string) {
  const clean = textOf(sentence);
  if (!clean || ESCALATION_RE.test(clean) || CLARIFICATION_RE.test(clean)) return false;
  return MATERIAL_RE.test(clean);
}

function extractMaterialClaims(answer: string) {
  return splitSentences(answer).filter(isMaterialClaim);
}

function parseNumberWords(words: string[]) {
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === "hundred") {
      current = (current || 1) * 100;
    } else if (word === "thousand" || word === "million") {
      const factor = word === "thousand" ? 1000 : 1000000;
      total += (current || 1) * factor;
      current = 0;
    } else {
      current += NUMBER_VALUES[word] || 0;
    }
  }
  return total + current;
}

function unitFor(raw: string, numberEnd: number) {
  const suffix = raw
    .slice(numberEnd)
    .toLowerCase()
    .replace(/[\s-]+/g, "")
    .replace(/[.,]$/, "");
  if (/^[$€£¥]/.test(raw.trim())) return "currency";
  for (const [key, value] of Object.entries(UNIT_ALIASES).sort(([a], [b]) => b.length - a.length)) {
    if (suffix.startsWith(key)) return value;
  }
  return "number";
}

function numericSignatures(text: string) {
  const values = new Set<string>();
  for (const match of normalizeText(text).matchAll(DIGIT_RE)) {
    const raw = match[0];
    const numberMatch = raw.match(/[\d][\d,.]*(?:\.\d+)?/);
    if (!numberMatch) continue;
    const value = Number(numberMatch[0].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    values.add(`${value}|${unitFor(raw, raw.indexOf(numberMatch[0]) + numberMatch[0].length)}`);
  }
  for (const match of normalizeText(text).matchAll(WORD_NUMBER_RE)) {
    const raw = match[0];
    const words = raw.match(/[a-z]+/g) || [];
    const numberWords = words.filter((word) => NUMBER_WORDS.has(word));
    if (numberWords.length === 0) continue;
    const value = parseNumberWords(numberWords);
    const numberEnd = raw.search(
      /(?:\s+|-)(?:percent|dollars?|credits?|points?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i,
    );
    const unit = numberEnd === -1 ? "number" : unitFor(raw, numberEnd);
    values.add(`${value}|${unit}`);
  }
  for (const match of normalizeText(text).matchAll(DATE_RE)) {
    values.add(`date|${match[0].replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ")}`);
  }
  return values;
}

function canonicalToken(token: string) {
  if (TOKEN_ALIASES[token]) return TOKEN_ALIASES[token];
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function contentTokens(value: string) {
  return (normalizeText(value).match(/[a-z]+(?:'[a-z]+)?/g) || [])
    .filter((token) => !STOP_WORDS.has(token) && !NUMBER_WORDS.has(token))
    .map(canonicalToken);
}

function coverage(claim: string, evidence: string) {
  const claimTokens = [...new Set(contentTokens(claim))];
  const evidenceTokens = new Set(contentTokens(evidence));
  if (claimTokens.length === 0) return 0;
  const matched = claimTokens.filter((token) => evidenceTokens.has(token)).length;
  if (claimTokens.length <= 3) return matched === claimTokens.length ? 1 : matched / claimTokens.length;
  return matched / claimTokens.length;
}

function negative(value: string) {
  return NEGATION_RE.test(normalizeText(value));
}

function evidenceId(item: ClaimEvidence) {
  return textOf(item?.id);
}

function evidenceProgramId(item: ClaimEvidence) {
  return textOf(item?.programId || item?.program_id);
}

function evidenceAllowed(item: ClaimEvidence, programId: string) {
  if (!item || evidenceProgramId(item) !== programId) return false;
  if (item.selected === false) return false;
  if (!textOf(item.sourceName)) return false;
  const status = textOf(item.status).toLowerCase();
  if (["candidate", "pending", "unapproved", "rejected", "superseded"].includes(status)) return false;
  if (item.approved === false) return false;
  const kind = textOf(item.kind).toLowerCase();
  const authority = textOf(item.authority).toLowerCase();
  if (!kind && !authority) return false;
  if (kind && !["source", "learned"].includes(kind)) return false;
  if (authority && !["source", "learned"].includes(authority)) return false;
  if (kind === "learned" || authority === "learned") {
    if (status !== "approved" || item.approved !== true) return false;
  }
  return Boolean(evidenceId(item) && textOf(item.text));
}

function reason(value: string) {
  return textOf(value).replace(/\s+/g, " ").slice(0, 200) || "unsupported";
}

function claimKey(value: string) {
  return normalizeText(value).replace(/[.!?]+$/, "");
}

function fixtureMatch(claim: string, fixtureClaims: unknown[]) {
  const key = claimKey(claim);
  return fixtureClaims.some((item) => claimKey(textOf(item)) === key);
}

function deterministicClaim(claim: string, evidence: ClaimEvidence[], programId: string): VerifiedClaim {
  const usable = evidence.filter((item) => evidenceAllowed(item, programId));
  const supporting: ClaimEvidence[] = [];
  const contradictory: ClaimEvidence[] = [];
  const claimNumbers = numericSignatures(claim);

  for (const item of usable) {
    const text = textOf(item.text);
    const sentences = splitSentences(text);
    const best = sentences
      .map((sentence) => ({ sentence, score: coverage(claim, sentence) }))
      .sort((a, b) => b.score - a.score)[0];
    const hasNumbers = [...claimNumbers].every((token) => numericSignatures(text).has(token));
    const matching = best && best.score >= 0.75 && hasNumbers;
    if (matching && negative(claim) === negative(best.sentence)) supporting.push(item);
    if (matching && negative(claim) !== negative(best.sentence)) contradictory.push(item);

    const hasContradictingSentence = sentences.some(
      (sentence) => coverage(claim, sentence) >= 0.75 && negative(claim) !== negative(sentence),
    );
    if (hasContradictingSentence && !contradictory.includes(item)) contradictory.push(item);
  }

  if (contradictory.length > 0) {
    return { claim, supported: false, evidenceIds: [], reason: "conflicting evidence" };
  }
  if (supporting.length === 0) {
    return {
      claim,
      supported: false,
      evidenceIds: [],
      reason: "no single same-program evidence record supports the claim",
    };
  }
  const sourceSupport = supporting.find(
    (item) => textOf(item.authority || item.kind || "source").toLowerCase() === "source",
  );
  const selected = sourceSupport || supporting[0];
  return {
    claim,
    supported: true,
    evidenceIds: [evidenceId(selected)],
    reason: "selected evidence supports the claim",
  };
}

function deterministicVerify(input: VerifyInput): AnswerVerification {
  const claims = extractMaterialClaims(textOf(input.answer));
  if (claims.length === 0) {
    return { verdict: "supported", sendable: Boolean(textOf(input.answer)), claims: [], errors: [] };
  }

  const programId = textOf(input.programId);
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const fixtures = Array.isArray(input.fixtureClaims) ? input.fixtureClaims : [];
  const allFixtureClaims = input.allowFixtures === true && claims.every((claim) => fixtureMatch(claim, fixtures));
  const errors = new Set<string>();
  if (!programId) errors.add("program_required");
  if (evidence.length === 0 && !allFixtureClaims) errors.add("no_evidence");
  if (evidence.some((item) => evidenceProgramId(item) && evidenceProgramId(item) !== programId))
    errors.add("cross_program_evidence");
  if (evidence.some((item) => !evidenceAllowed(item, programId)) && !allFixtureClaims) errors.add("invalid_evidence");

  const results = claims.map((claim) => {
    if (input.allowFixtures === true && fixtureMatch(claim, fixtures)) {
      return { claim, supported: true, evidenceIds: [], reason: "explicit fixture claim" };
    }
    return deterministicClaim(claim, evidence, programId);
  });
  if (results.some((claim) => !claim.supported)) errors.add("unsupported_claim");
  const sendable = results.length > 0 && results.every((claim) => claim.supported) && errors.size === 0;
  return {
    verdict: sendable ? "supported" : "unsupported",
    sendable,
    claims: results,
    errors: [...errors],
  };
}

function parseJudge(raw: unknown): { verdict: string; claims: JudgeClaim[] } | null {
  const value =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch (_error: unknown) {
            return null;
          }
        })()
      : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "verdict" || key === "claims")) return null;
  if (typeof record.verdict !== "string" || !["supported", "unsupported", "needs_review"].includes(record.verdict))
    return null;
  if (!Array.isArray(record.claims) || record.claims.length === 0) return null;
  const claims: JudgeClaim[] = [];
  for (const item of record.claims) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const claim = item as Record<string, unknown>;
    if (Object.keys(claim).some((key) => !["claim", "supported", "evidenceIds", "reason"].includes(key))) return null;
    if (
      typeof claim.claim !== "string" ||
      typeof claim.supported !== "boolean" ||
      !Array.isArray(claim.evidenceIds) ||
      claim.evidenceIds.some((id) => typeof id !== "string") ||
      typeof claim.reason !== "string" ||
      claim.reason.length > 200
    )
      return null;
    claims.push({
      claim: claim.claim.trim(),
      supported: claim.supported,
      evidenceIds: claim.evidenceIds.map((id) => id.trim()),
      reason: reason(claim.reason),
    });
  }
  return { verdict: record.verdict, claims };
}

function defaultJudge(input: JudgeInput) {
  const tier = config.intent;
  const apiKey = typeof tier.apiKey === "function" ? tier.apiKey() : tier.apiKey;
  if (!apiKey) return null;
  return llm
    .complete(
      {
        baseUrl: tier.baseUrl,
        apiKey: tier.apiKey,
        model: tier.model,
        fallback: tier.fallback,
        onRateLimited: tier.onRateLimited,
        maxTokens: 500,
        temperature: 0,
        thinking: { type: "disabled" },
        timeout: JUDGE_TIMEOUT_MS,
        messages: [
          {
            role: "system",
            content:
              'Return strict JSON only: {"verdict":"supported|unsupported|needs_review","claims":[{"claim":"...","supported":true,"evidenceIds":["..."],"reason":"short"}]}. Do not provide reasoning outside reason.',
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      },
      "claim-judge",
    )
    .then((result: { text?: string }) => result?.text || "");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      const error = new Error("claim judge timeout");
      error.name = "ClaimJudgeTimeout";
      reject(error);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function applyJudge(base: AnswerVerification, input: VerifyInput): Promise<AnswerVerification> {
  if (!base.sendable || base.claims.length === 0 || process.env.PIXIE_CLAIM_JUDGE === "off") return base;
  const judge = input.judge === undefined ? defaultJudge : input.judge;
  if (!judge) return base;

  let raw: unknown;
  try {
    raw = await withTimeout(
      Promise.resolve(
        judge({
          programId: textOf(input.programId),
          answer: textOf(input.answer),
          evidence: Array.isArray(input.evidence) ? input.evidence : [],
          claims: base.claims,
        }),
      ),
      JUDGE_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    const code = error instanceof Error && error.name === "ClaimJudgeTimeout" ? "judge_timeout" : "judge_error";
    return { ...base, verdict: "unsupported", sendable: false, errors: [...new Set([...base.errors, code])] };
  }

  if (input.judge === undefined && raw === null) return base;
  const parsed = parseJudge(raw);
  if (!parsed)
    return {
      ...base,
      verdict: "unsupported",
      sendable: false,
      errors: [...new Set([...base.errors, "judge_malformed"])],
    };
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const byId = new Map(evidence.map((item) => [evidenceId(item), item]));
  const expected = new Map(base.claims.map((claim) => [claimKey(claim.claim), claim]));
  const seen = new Set<string>();
  let invalidEvidence = false;
  for (const claim of parsed.claims) {
    const deterministic = expected.get(claimKey(claim.claim));
    if (!deterministic || seen.has(claimKey(claim.claim))) {
      return {
        ...base,
        verdict: "unsupported",
        sendable: false,
        errors: [...new Set([...base.errors, "judge_claim_mismatch"])],
      };
    }
    seen.add(claimKey(claim.claim));
    for (const id of claim.evidenceIds) {
      const item = byId.get(id);
      if (!item)
        return {
          ...base,
          verdict: "unsupported",
          sendable: false,
          errors: [...new Set([...base.errors, "judge_unknown_evidence"])],
        };
      if (evidenceProgramId(item) !== textOf(input.programId)) {
        invalidEvidence = true;
        break;
      }
      if (!evidenceAllowed(item, textOf(input.programId))) invalidEvidence = true;
    }
    if (claim.supported && claim.evidenceIds.length === 0) {
      return {
        ...base,
        verdict: "unsupported",
        sendable: false,
        errors: [...new Set([...base.errors, "judge_missing_evidence"])],
      };
    }
    if (invalidEvidence) break;
  }
  if (invalidEvidence || seen.size !== expected.size) {
    return {
      ...base,
      verdict: "unsupported",
      sendable: false,
      errors: [...new Set([...base.errors, invalidEvidence ? "judge_cross_program" : "judge_claim_mismatch"])],
    };
  }
  if (parsed.verdict !== "supported" || parsed.claims.some((claim) => !claim.supported)) {
    return {
      verdict: "unsupported",
      sendable: false,
      claims: base.claims.map((claim) => {
        return {
          ...claim,
          supported: false,
          reason: "judge rejected the claim",
        };
      }),
      errors: [
        ...new Set([...base.errors, parsed.verdict === "needs_review" ? "judge_needs_review" : "judge_unsupported"]),
      ],
    };
  }
  return {
    verdict: "supported",
    sendable: true,
    claims: base.claims.map((claim) => {
      return {
        ...claim,
        reason: "judge confirmed the selected evidence",
      };
    }),
    errors: base.errors,
  };
}

async function verifyAnswer(input: VerifyInput): Promise<AnswerVerification> {
  const base = deterministicVerify(input);
  return applyJudge(base, input);
}

function verifyAnswerSync(input: VerifyInput): AnswerVerification {
  return deterministicVerify(input);
}

export = {
  JUDGE_TIMEOUT_MS,
  extractMaterialClaims,
  numericSignatures,
  verifyAnswer,
  verifyAnswerSync,
};
