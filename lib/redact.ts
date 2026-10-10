const SECRET_KEYS =
  "authorization|proxy-authorization|cookie|set-cookie|token|session(?:[_-]?id)?|sid|connect\\.sid|csrf|xsrf|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|private[_-]?key";

const PATTERNS: [RegExp, string][] = [
  [
    new RegExp(`(["'])(${SECRET_KEYS})\\1\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,}\\]]+)`, "gi"),
    "$1$2$1:[redacted]",
  ],
  [/\b(?:authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, "[redacted auth header]"],
  [/\b(?:cookies?|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "[redacted cookie]"],
  [
    new RegExp(`\\b(${SECRET_KEYS})\\s*(?:is|[:=])\\s*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&]+)`, "gi"),
    "$1=[redacted]",
  ],
  [new RegExp(`([?&#](?:${SECRET_KEYS})=)[^&#\\s]+`, "gi"), "$1[redacted]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b(?:xox[a-z]-|gh[pousr]_|github_pat_|sk-|AKIA)[A-Za-z0-9._~+/=-]+/gi, "[redacted token]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted token]"],
];

// Mask credential-shaped text
function redactSecrets(value: unknown): string {
  return PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(value ?? ""));
}

const INTERNAL_RE = /\b(?:system\s+prompt|chain[-\s]+of[-\s]+thought|hidden\s+instructions?)\b[^.!?]*/gi;

// Mask prompt and reasoning mentions
function redactInternalContent(value: unknown): string {
  return String(value ?? "").replace(INTERNAL_RE, "[redacted internal content]");
}

export = { redactSecrets, redactInternalContent };
