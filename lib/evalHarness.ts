import type { Program } from "./types";

interface SupportEvalCase {
  name: string;
  input: unknown;
  expected: Record<string, unknown>;
}

interface SupportEvalResult {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matches((actual as Record<string, unknown>)[key], value),
    );
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((value) => actual.some((item) => matches(item, value)));
  }
  return actual === expected;
}

function runSupportEvals(
  cases: SupportEvalCase[],
  runner: (input: unknown, item: SupportEvalCase) => Record<string, unknown>,
): SupportEvalResult[] {
  return cases.map((item) => {
    const details = runner(item.input, item);
    const passed = matches(details, item.expected);
    return { name: item.name, passed, details };
  });
}

export = { runSupportEvals, matches };
