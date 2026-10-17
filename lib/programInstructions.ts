const MAX_ITEMS = 25;
const MAX_ITEM_LENGTH = 400;
const POLICIES = ["strict", "balanced"] as const;

interface Instructions {
  mayAnswer: string[];
  mustEscalate: string[];
  neverDo: string[];
  answerPolicy: (typeof POLICIES)[number];
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) =>
      item
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .trim()
        .slice(0, MAX_ITEM_LENGTH),
    )
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function normalize(value: unknown): Instructions | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const policy = POLICIES.find((item) => item === record.answerPolicy) || "strict";
  return {
    mayAnswer: cleanList(record.mayAnswer),
    mustEscalate: cleanList(record.mustEscalate),
    neverDo: cleanList(record.neverDo),
    answerPolicy: policy,
  };
}

function validate(value: unknown): string | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "instructions must be an object";
  const record = value as Record<string, unknown>;
  for (const key of ["mayAnswer", "mustEscalate", "neverDo"]) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
      return `instructions.${key} must be a list of strings`;
    if (list.length > MAX_ITEMS) return `instructions.${key} has more than ${MAX_ITEMS} items`;
    if (list.some((item) => item.length > MAX_ITEM_LENGTH))
      return `instructions.${key} item is longer than ${MAX_ITEM_LENGTH} characters`;
  }
  if (record.answerPolicy !== undefined && !POLICIES.some((item) => item === record.answerPolicy))
    return "instructions.answerPolicy must be strict or balanced";
  return null;
}

export = { normalize, validate, POLICIES };
