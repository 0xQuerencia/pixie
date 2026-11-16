const db = require("./db");
const log = require("./log");
interface ThreadCandidate {
  question: string;
  channel: string;
  threadTs: string;
}
interface RelatedThread {
  threadTs: string;
  channel: string;
  matchedQuestion: string;
  score: number;
  permalink: string | null;
}
interface RelatedOptions {
  currentThreadTs?: string | null;
  channel?: string | null;
  result?: { direct?: boolean } | null;
  threshold?: number;
}

const STOP_WORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "aren't",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "can't",
  "cannot",
  "could",
  "couldn't",
  "did",
  "didn't",
  "do",
  "does",
  "doesn't",
  "doing",
  "don't",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "hadn't",
  "has",
  "hasn't",
  "have",
  "haven't",
  "having",
  "he",
  "he'd",
  "he'll",
  "he's",
  "her",
  "here",
  "here's",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "how's",
  "i",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "if",
  "in",
  "into",
  "is",
  "isn't",
  "it",
  "it's",
  "its",
  "itself",
  "let's",
  "me",
  "more",
  "most",
  "mustn't",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "ought",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "shan't",
  "she",
  "she'd",
  "she'll",
  "she's",
  "should",
  "shouldn't",
  "so",
  "some",
  "such",
  "than",
  "that",
  "that's",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "there's",
  "these",
  "they",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "wasn't",
  "we",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "were",
  "weren't",
  "what",
  "what's",
  "when",
  "when's",
  "where",
  "where's",
  "which",
  "while",
  "who",
  "who's",
  "whom",
  "why",
  "why's",
  "with",
  "won't",
  "would",
  "wouldn't",
  "you",
  "you'd",
  "you'll",
  "you're",
  "you've",
  "your",
  "yours",
  "yourself",
  "yourselves",
  "pixie",
  "please",
  "pls",
  "thx",
  "thanks",
  "thank",
  "bro",
  "gng",
  "yo",
  "hey",
  "hi",
]);

const SIMPLE_LOOKUP_PATTERNS = [
  /\b(?:where\s+(?:is|can\s+i\s+find|do\s+i\s+go\s+for|to\s+go\s+for|do\s+i\s+go))\b/i,
  /\b(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:link|url|website|site|repo|channel))\b/i,
  /\b(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:deadline|due\s+date))\b/i,
];

const MIN_SHARED_TOKENS = 2;
const DEFAULT_THRESHOLD = 0.35;
const CANDIDATE_LIMIT = 200;
// Resolve links from trusted operator configuration. Never assume a workspace domain.
function archiveHost(): string | null {
  const configured = (process.env.PIXIE_SLACK_WORKSPACE_URL || "").trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.port || parsed.search || parsed.hash || !/^[a-z0-9-]+\.slack\.com$/.test(parsed.hostname)) return null;
    return `${parsed.origin}/archives`;
  } catch { return null; }
}

function isSimpleLookupQuestion(question: string, answerResult: { direct?: boolean } | null = null) {
  const q = (question || "").trim().toLowerCase();
  if (!q) return true;

  if (answerResult?.direct === true) return true;

  if (q.split(/\s+/).length <= 2) return true;

  for (const pattern of SIMPLE_LOOKUP_PATTERNS) {
    if (pattern.test(q)) return true;
  }

  return false;
}

function tokenize(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w: string) => w.length > 2 && !STOP_WORDS.has(w));
}

function calculateTokenSimilarity(queryTokens: string[], targetTokens: string[]) {
  if (!queryTokens.length || !targetTokens.length) return 0;

  const querySet = new Set(queryTokens);
  const targetSet = new Set(targetTokens);

  let matchCount = 0;
  for (const token of querySet) {
    if (targetSet.has(token)) {
      matchCount++;
    }
  }

  if (matchCount < MIN_SHARED_TOKENS) return 0;

  const overlapRatio = (2 * matchCount) / (querySet.size + targetSet.size);
  const queryCoverage = matchCount / querySet.size;
  return Math.max(overlapRatio, queryCoverage * 0.85);
}

function buildSlackPermalink(channel: string, threadTs: string) {
  const host = archiveHost();
  if (!host || !/^[A-Z0-9]{8,}$/.test(String(channel || ""))) return null;
  if (!/^\d{10,}\.\d{6}$/.test(String(threadTs || ""))) return null;
  const cleanTs = String(threadTs).replace(".", "");
  return `${host}/${channel}/p${cleanTs}`;
}

async function findRelatedThread(
  question: string,
  { currentThreadTs = null, channel = null, result = null, threshold = 0.35 }: RelatedOptions = {},
): Promise<RelatedThread | null> {
  if (isSimpleLookupQuestion(question, result)) {
    return null;
  }

  const queryTokens = tokenize(question);
  if (queryTokens.length < 2) {
    return null;
  }

  const candidates: ThreadCandidate[] = [];

  try {
    const recent = db.getRecentAnsweredThreads(200);
    for (const r of recent) {
      if (r.thread_ts && r.channel && r.thread_ts !== currentThreadTs) {
        candidates.push({
          question: r.question,
          channel: r.channel,
          threadTs: r.thread_ts,
        });
      }
    }
  } catch (error: unknown) {
    log.debug(
      "relatedThreads",
      `query answered_threads failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const learned = db.getLearnedFactsWithThreads(200);
    for (const f of learned) {
      if (f.source_ts && f.channel && f.source_ts !== currentThreadTs) {
        candidates.push({
          question: f.question,
          channel: f.channel,
          threadTs: f.source_ts,
        });
      }
    }
  } catch (error: unknown) {
    log.debug(
      "relatedThreads",
      `query learned facts failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!candidates.length) return null;

  let bestMatch: RelatedThread | null = null;
  let highestScore = 0;

  const seenThreads = new Set<string>();
  for (const cand of candidates) {
    const key = `${cand.channel}:${cand.threadTs}`;
    if (seenThreads.has(key)) continue;
    seenThreads.add(key);

    const candTokens = tokenize(cand.question);
    const score = calculateTokenSimilarity(queryTokens, candTokens);

    if (score >= threshold && score > highestScore) {
      highestScore = score;
      bestMatch = {
        threadTs: cand.threadTs,
        channel: cand.channel,
        matchedQuestion: cand.question,
        score,
        permalink: buildSlackPermalink(cand.channel, cand.threadTs),
      };
    }
  }

  if (bestMatch && bestMatch.permalink) {
    log.debug(
      "relatedThreads",
      `found related thread: score=${bestMatch.score.toFixed(2)} matched="${bestMatch.matchedQuestion}" url=${bestMatch.permalink}`,
    );
    return bestMatch;
  }

  return null;
}

function formatRelatedThreadLine(related: RelatedThread | null) {
  if (!related?.permalink) return "";
  return `\n\n_🧵 Related discussion: <${related.permalink}|view previous thread>_`;
}

export = {
  findRelatedThread,
  formatRelatedThreadLine,
  isSimpleLookupQuestion,
  calculateTokenSimilarity,
  tokenize,
  buildSlackPermalink,
};
