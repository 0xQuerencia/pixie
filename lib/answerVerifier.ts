const grounding = require("./grounding");
const claimVerifier = require("./claimVerifier");

interface Evidence {
  id?: string;
  programId?: string;
  program_id?: string;
  supportsClaims?: string[];
  supportedClaims?: string[];
  kind?: string;
  authority?: string;
  status?: string;
  approved?: boolean;
}

interface VerifyInput {
  programId: string;
  verdict: unknown;
  evidence?: Evidence[];
  fixtureClaims?: unknown[];
  allowFixtures?: boolean;
}

/**
 * Final structured-grounding sendability check. A malformed or review verdict
 * is never treated as permission to send an answer.
 */
function verify(input: VerifyInput) {
  const checked = grounding.validateClaimSupport({
    verdict: input.verdict,
    evidence: input.evidence || [],
    fixtureClaims: input.fixtureClaims || [],
    allowFixtures: input.allowFixtures === true,
    programId: input.programId,
  });
  const claims = Array.isArray(checked.claims) ? checked.claims : [];
  const unsupported = claims.filter((claim: { supported?: boolean }) => claim.supported !== true);
  const sendable = Boolean(
    checked.ok && checked.verdict === "supported" && checked.supported && claims.length && unsupported.length === 0,
  );
  return {
    sendable,
    verdict: sendable ? "supported" : "unsupported",
    claims,
    unsupported,
    errors: checked.errors || [],
  };
}

export = { verify, verifyAnswer: claimVerifier.verifyAnswer, verifyAnswerSync: claimVerifier.verifyAnswerSync };
