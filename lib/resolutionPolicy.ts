// Deterministic rules around the resolution judge: what a message means and how much proof a category needs
type FollowUp = "ack" | "confirm" | "persists" | "other";

const PERSISTS_RE =
  /\b(?:still(?! (?:works?|working|good|fine|great)\b)|again|not working|isn'?t working|doesn'?t work|didn'?t work|won'?t|can'?t|cannot|same (?:error|issue|problem)|nope|no luck|failed|broken|stuck|worse|(?:is|came|comes|are) back)\b/i;
const CONFIRM_RE =
  /\b(?:works?|worked|working now|fixed|solved|resolved|sorted|all good|that did it|figured it out|no longer|anymore|gone)\b/i;
const ACK_WORDS = new Set([
  "thanks",
  "thank",
  "you",
  "thx",
  "ty",
  "tysm",
  "ok",
  "okay",
  "cool",
  "great",
  "awesome",
  "nice",
  "perfect",
  "got",
  "it",
  "appreciate",
  "cheers",
  "much",
  "so",
  "very",
  "a",
  "lot",
]);

function followUpKind(text: unknown): FollowUp {
  const body = String(text || "")
    .replace(/\b(thanks?|thank you|thx|ty)\s+again\b/gi, "$1")
    .replace(/\b(?:i )?(?:can'?t|cannot) (?:thank|say thanks)[^.!?]*/gi, " thanks ")
    .replace(/<@[A-Z0-9]+>/g, " ")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .trim();
  if (!body) return "other";
  const persists = PERSISTS_RE.test(body);
  const confirms = CONFIRM_RE.test(body);
  if (persists && confirms) return "other";
  if (persists) return "persists";
  if (confirms) return /\bstill (?:works?|working)\b/i.test(body) ? "other" : "confirm";
  const words = body
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length > 0 && words.length <= 8 && words.every((word) => ACK_WORDS.has(word)) ? "ack" : "other";
}

interface ClosurePolicy {
  auto: boolean;
  minConfidence: number;
  evidenceRoles: string[];
  ackOk: boolean;
  needsHelper: boolean;
  lastWord: boolean;
}

const INFORMATIONAL = new Set(["advice_how_to", "other"]);
const HIGH_IMPACT = new Set(["fulfillment_shipping", "account_access"]);

// How much proof closes a ticket: informational is light, high-impact needs a human and an explicit confirmation
function closurePolicy({
  category,
  sensitive = false,
}: {
  category?: string | null;
  sensitive?: boolean;
}): ClosurePolicy {
  if (sensitive) {
    return { auto: false, minConfidence: 1, evidenceRoles: [], ackOk: false, needsHelper: true, lastWord: false };
  }
  if (!category || INFORMATIONAL.has(category)) {
    return {
      auto: true,
      minConfidence: 0.8,
      evidenceRoles: ["requester", "helper"],
      ackOk: true,
      needsHelper: false,
      lastWord: true,
    };
  }
  return {
    auto: true,
    minConfidence: 0.9,
    evidenceRoles: ["requester"],
    ackOk: false,
    needsHelper: HIGH_IMPACT.has(category),
    lastWord: false,
  };
}

export = { followUpKind, closurePolicy };
