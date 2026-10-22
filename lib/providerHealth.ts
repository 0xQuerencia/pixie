// Shared circuit state for outbound model providers
const THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30 * 1000;
const MAX_COOLDOWN_MS = 5 * 60 * 1000;
const NOTICE_TTL_MS = 15 * 60 * 1000;
const MAX_NOTICES = 500;

type Severity = "hard" | "transient" | "ignore";
interface Circuit {
  fails: number;
  opens: number;
  openUntil: number;
  probing: boolean;
}
interface HttpLike {
  response?: { status?: number };
  status?: number;
  code?: string;
  message?: string;
  jevErrorKind?: string;
}

const circuits = new Map<string, Circuit>();
// Per thread: when it was told, and which providers it was told about
const notices = new Map<string, { at: number; blame: Set<string> }>();

const HARD_STATUS = new Set([401, 402, 403, 404]);
const NETWORK_CODES = /^(?:ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_CANCELED|UND_ERR\w*)$/;

class ProviderUnavailableError extends Error {
  code = "PROVIDER_UNAVAILABLE";
  provider: string;
  constructor(provider: string) {
    super(`provider unavailable: ${provider}`);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
  }
}

function httpSeverity(error: unknown): Severity {
  const err = (error || {}) as HttpLike;
  if (err.code === "PROVIDER_UNAVAILABLE") return "ignore";
  const status = err.response?.status ?? err.status;
  if (typeof status === "number") {
    if (HARD_STATUS.has(status)) return "hard";
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "transient";
    return "ignore";
  }
  if (err.code === "ECONNABORTED" || (err.code && NETWORK_CODES.test(err.code))) return "transient";
  if (/timed? ?out|timeout|aborted|socket hang up/i.test(err.message || "")) return "transient";
  return "ignore";
}

function isProviderFailure(error: unknown): boolean {
  return (error as HttpLike)?.code === "PROVIDER_UNAVAILABLE" || httpSeverity(error) !== "ignore";
}

function isOpen(key: string): boolean {
  const c = circuits.get(key);
  return Boolean(c && c.fails >= THRESHOLD && Date.now() < c.openUntil);
}

function canAttempt(key: string): boolean {
  const c = circuits.get(key);
  if (!c || c.fails < THRESHOLD) return true;
  if (Date.now() < c.openUntil || c.probing) return false;
  c.probing = true;
  return true;
}

function recordSuccess(key: string): void {
  const c = circuits.get(key);
  if (!c) return;
  circuits.delete(key);
  for (const [thread, notice] of notices) {
    if (notice.blame.delete(key) && notice.blame.size === 0) notices.delete(thread);
  }
}

function recordFailure(key: string, severity: Severity): void {
  const c = circuits.get(key) || { fails: 0, opens: 0, openUntil: 0, probing: false };
  circuits.set(key, c);
  c.probing = false;
  if (severity === "ignore") return;
  c.fails = severity === "hard" ? Math.max(c.fails + 1, THRESHOLD) : c.fails + 1;
  if (c.fails < THRESHOLD) return;
  c.opens += 1;
  c.openUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (c.opens - 1));
}

async function guard<T>(
  key: string,
  call: () => Promise<T>,
  severityOf: (error: unknown) => Severity = httpSeverity,
): Promise<T> {
  if (!canAttempt(key)) throw new ProviderUnavailableError(key);
  try {
    const result = await call();
    recordSuccess(key);
    return result;
  } catch (error: unknown) {
    recordFailure(key, severityOf(error));
    if (error && typeof error === "object" && !("provider" in error)) (error as { provider?: string }).provider = key;
    throw error;
  }
}

function noticeDue(threadKey: string): boolean {
  const notice = notices.get(threadKey);
  return notice === undefined || Date.now() - notice.at >= NOTICE_TTL_MS;
}

function markNotified(threadKey: string, blame: string[] = []): void {
  if (notices.size >= MAX_NOTICES) notices.delete(notices.keys().next().value as string);
  notices.set(threadKey, { at: Date.now(), blame: new Set(blame) });
}

function openKeys(): string[] {
  return [...circuits.keys()].filter(isOpen);
}

function reset(): void {
  circuits.clear();
  notices.clear();
}

export = {
  THRESHOLD,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  NOTICE_TTL_MS,
  ProviderUnavailableError,
  httpSeverity,
  isProviderFailure,
  isOpen,
  openKeys,
  guard,
  noticeDue,
  markNotified,
  reset,
};
