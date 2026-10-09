const VERDICTS = new Set(["supported", "unsupported", "needs_review"]);
type JsonRecord = Record<string, unknown>;
interface GroundingClaim {
  claim: string;
  supported: boolean;
  evidenceIds: string[];
}
interface ParsedVerdict {
  ok: boolean;
  verdict: string;
  claims: GroundingClaim[];
  errors: string[];
}
interface EvidenceRecord extends JsonRecord {
  id?: unknown;
  programId?: unknown;
  program_id?: unknown;
  supportsClaims?: unknown;
  supportedClaims?: unknown;
}
interface ValidateOptions {
  verdict?: unknown;
  evidence?: EvidenceRecord[];
  programId?: string;
  fixtureClaims?: unknown[];
  parse?: (raw: unknown) => ParsedVerdict;
}

function fail(errors: string[]): ParsedVerdict {
  return { ok: false, verdict: "unsupported", claims: [], errors };
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeJson(text: unknown): JsonRecord | null {
  const input = asString(text);
  if (!input) return null;

  const candidates: string[] = [];
  const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenced.exec(input))) candidates.push(match[1].trim());
  candidates.push(input);

  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== "{" && input[start] !== "[") continue;
    let depth = 0;
    let quote = false;
    let escaped = false;
    for (let end = start; end < input.length; end += 1) {
      const character = input[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') quote = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(input.slice(start, end + 1));
          break;
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (_error: unknown) {}
  }
  return null;
}

function parseGroundingVerdict(raw: unknown): ParsedVerdict {
  const value = typeof raw === "string" ? decodeJson(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(["verdict must be a JSON object"]);
  const record = value as JsonRecord;
  if (typeof record.verdict !== "string" || !VERDICTS.has(record.verdict))
    return fail(["verdict must be supported, unsupported, or needs_review"]);
  if (!Array.isArray(record.claims) || record.claims.length === 0) return fail(["claims must be a non-empty array"]);

  const claims: GroundingClaim[] = [];
  for (const [index, item] of record.claims.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail([`claims[${index}] must be an object`]);
    const claimRecord = item as JsonRecord;
    const claim = asString(claimRecord.claim);
    if (!claim) return fail([`claims[${index}].claim must be a non-empty string`]);
    if (typeof claimRecord.supported !== "boolean") return fail([`claims[${index}].supported must be boolean`]);
    if (!Array.isArray(claimRecord.evidenceIds) || claimRecord.evidenceIds.some((id) => !asString(id))) {
      return fail([`claims[${index}].evidenceIds must be an array of strings`]);
    }
    if (claimRecord.supported && claimRecord.evidenceIds.length === 0)
      return fail([`claims[${index}] supported claims need evidenceIds`]);
    claims.push({
      claim,
      supported: claimRecord.supported,
      evidenceIds: claimRecord.evidenceIds.map((id) => asString(id)),
    });
  }
  return { ok: true, verdict: record.verdict, claims, errors: [] };
}

function claimKey(value: unknown) {
  return asString(value).replace(/\s+/g, " ").toLowerCase();
}

function evidenceProgramId(evidence: EvidenceRecord | undefined) {
  return asString(evidence && (evidence.programId || evidence.program_id));
}

function validateClaimSupport({
  verdict,
  evidence = [],
  programId,
  fixtureClaims = [],
  parse = parseGroundingVerdict,
}: ValidateOptions = {}) {
  if (typeof parse !== "function")
    return { ok: false, supported: false, claims: [], errors: ["parse must be a function"] };
  const parsed: ParsedVerdict =
    verdict && typeof verdict === "object" && "ok" in verdict && verdict.ok === true
      ? (verdict as ParsedVerdict)
      : parse(verdict);
  if (!parsed.ok) return { ok: false, supported: false, claims: [], errors: parsed.errors };
  if (!asString(programId)) return { ok: false, supported: false, claims: [], errors: ["programId is required"] };
  if (!Array.isArray(evidence) || !Array.isArray(fixtureClaims))
    return { ok: false, supported: false, claims: [], errors: ["evidence and fixtureClaims must be arrays"] };

  // A model can mark every claim as individually supported while still
  // returning needs_review at the answer level. That verdict is explicitly
  // non-sendable for strict grounding: claim support cannot upgrade it.
  if (parsed.verdict !== "supported") {
    return {
      ok: true,
      supported: false,
      verdict: parsed.verdict,
      claims: parsed.claims.map((claim) => ({
        claim: claim.claim,
        supported: false,
        reason: `top-level verdict is ${parsed.verdict}`,
      })),
      errors: [`top-level verdict ${parsed.verdict} is not sendable`],
    };
  }

  const byId = new Map(evidence.map((item) => [asString(item && item.id), item]));
  const fixtures = new Set(fixtureClaims.map(claimKey));
  const results = parsed.claims.map((claim) => {
    const explicitFixture = fixtures.has(claimKey(claim.claim));
    const validEvidence = claim.evidenceIds.every((id) => {
      const item = byId.get(id);
      if (!item || evidenceProgramId(item) !== programId) return false;
      const supportedClaims = item.supportsClaims || item.supportedClaims || [];
      return (
        Array.isArray(supportedClaims) &&
        supportedClaims.some((supported) => claimKey(supported) === claimKey(claim.claim))
      );
    });
    const supported = claim.supported && (explicitFixture || (claim.evidenceIds.length > 0 && validEvidence));
    return { claim: claim.claim, supported, reason: supported ? "explicit evidence" : "no exact same-program support" };
  });
  const supported = parsed.verdict === "supported" && results.length > 0 && results.every((claim) => claim.supported);
  return { ok: true, supported, verdict: supported ? "supported" : "unsupported", claims: results, errors: [] };
}

function createGroundingValidator({ parse = parseGroundingVerdict }: { parse?: (raw: unknown) => ParsedVerdict } = {}) {
  if (typeof parse !== "function") throw new TypeError("parse must be a function");
  return {
    parse,
    validate(input: ValidateOptions = {}) {
      return validateClaimSupport({ ...input, parse });
    },
  };
}

export = { decodeJson, parseGroundingVerdict, validateClaimSupport, createGroundingValidator };
