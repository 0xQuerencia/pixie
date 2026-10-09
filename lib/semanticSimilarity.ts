/**
 * Small, deterministic paraphrase signal for reranking support chunks.
 *
 * This is deliberately not an answer generator and it never supplies text to
 * the model. Exact retrieval, source ownership, and grounding remain the
 * authority; callers may only use this score to order already-indexed chunks.
 */

const ALIAS_GROUPS: Record<string, string[]> = {
  refund: ["return", "returned", "reimburse", "repaid", "repay", "moneyback", "money-back"],
  activate: ["activation", "activated", "redeem", "redeemed", "claim", "claimed"],
  broken: ["fail", "failed", "failing", "failure", "error", "crash", "crashing", "down", "offline"],
  service: ["site", "website", "webpage", "portal", "app", "dashboard"],
  login: ["signin", "sign-in", "auth", "authentication", "account-access", "accountaccess"],
  shipping: ["delivery", "package", "tracking", "shipment", "shipped", "arrive", "arrived"],
  submit: ["submission", "resubmit", "resubmission", "review"],
  reject: ["rejected", "denied", "declined"],
  payout: ["payment", "paid", "money", "funds"],
  deadline: ["due", "date", "cutoff", "expiration", "expire", "expires"],
  allowed: ["permit", "permitted", "okay", "ok", "can"],
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "get",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "should",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function normalizeToken(token: string): string {
  let value = String(token || "")
    .toLowerCase()
    .trim();
  if (value.endsWith("ies") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (value.endsWith("ing") && value.length > 5) value = value.slice(0, -3);
  else if (value.endsWith("ed") && value.length > 4) value = value.slice(0, -2);
  else if (value.endsWith("s") && value.length > 4) value = value.slice(0, -1);
  return value;
}

function rawTokens(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeToken)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function expandedTokens(text: string): Set<string> {
  const out = new Set<string>();
  const tokens = rawTokens(text);
  const normalizedAliases = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(ALIAS_GROUPS)) {
    normalizedAliases.set(normalizeToken(canonical), normalizeToken(canonical));
    for (const alias of aliases) normalizedAliases.set(normalizeToken(alias), normalizeToken(canonical));
  }

  for (const token of tokens) {
    const canonical = normalizedAliases.get(token);
    out.add(canonical || token);
  }

  const normalizedText = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  if (/\bmoney\s+back\b/.test(normalizedText)) out.add("refund");
  if (/\bsign(?:-|\s)?in\b/.test(normalizedText)) out.add("login");
  if (/\b(?:won't|wont|cannot|can't|cant)\s+(?:load|open|access|reach|work)\b/.test(normalizedText)) {
    out.add("broken");
  }
  return out;
}

function tokenSimilarity(left: string, right: string): number {
  const a = expandedTokens(left);
  const b = expandedTokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  const jaccard = common / (a.size + b.size - common);
  const containment = common / Math.min(a.size, b.size);
  return Math.max(jaccard, containment * 0.82);
}

function trigrams(text: string): Set<string> {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 2; i += 1) out.add(normalized.slice(i, i + 3));
  return out;
}

function charSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const tri of a) if (b.has(tri)) common += 1;
  return (2 * common) / (a.size + b.size);
}

function score(left: string, right: string): number {
  const token = tokenSimilarity(left, right);
  const chars = charSimilarity(left, right);
  return Math.max(0, Math.min(1, token * 0.82 + chars * 0.18));
}

export = { score, tokenSimilarity, charSimilarity, expandedTokens };
