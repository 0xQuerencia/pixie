const log = require("./log");
const semanticSimilarity = require("./semanticSimilarity");

type Domain = "hardware" | "software" | "general";
type Section = [string, string];
interface Chunk {
  source: string;
  heading: string | null;
  domain: Domain;
  text: string;
}
interface IndexedDoc {
  chunk: Chunk;
  freq: Map<string, number>;
  length: number;
}
interface SearchIndex {
  docs: IndexedDoc[];
  docFreq: Map<string, number>;
  avgLength: number;
}
interface ScoreFlags {
  isAiQuery: boolean;
  isFirmwareQuery: boolean;
  isSoftwareQuery: boolean;
  isHardwareQuery: boolean;
  isCadOrPcbQuery: boolean;
  isReadmeQuery: boolean;
  isReturnedQuery: boolean;
  isReferralQuery: boolean;
  isDisclosureQuery: boolean;
  isConsequenceQuery: boolean;
  queryMentionsHours: boolean;
}
interface AiSignals {
  has30Percent: boolean;
  isHardwareAiProhibition: boolean;
  isFirmwareAiRule: boolean;
  isReadmeAiRule: boolean;
  isDisclosureChunk: boolean;
  isConsequenceChunk: boolean;
  isGenericAiAllowance: boolean;
  isVagueHonestyHeading: boolean;
  isVagueAllowance: boolean;
}
interface DomainSignals {
  isHardwareChunk: boolean;
  isSoftwareChunk: boolean;
}
interface ScoredChunk {
  chunk: Chunk;
  value: number;
}
interface DetailedScore {
  chunk: Chunk;
  lexical: number;
  semantic: number;
  total: number;
}
interface SelectContextOptions {
  generated: Section[];
  learned?: Section[];
  index: SearchIndex;
  sources: Section[];
  question: string;
  budget?: number;
  exclude?: Set<string> | string[] | null;
  generatedLast?: boolean;
}

const MIN_CHUNK = 100;
const MAX_CHUNK = 900;

const DEFAULT_BUDGET = 2500;

const IDENTITY_BUDGET = 2500;
const TIMELINE_BUDGET = 1200;
const LEARNED_BUDGET = 1500;
const LEARNED_MAX_FACTS = 5;
const TOTAL_CONTEXT_BUDGET = 8000;

const K1 = 1.2;
const B = 0.75;

const BOOST_DECIDING_RULE = 6.0;
const BOOST_SPECIFIC_CAP = 5.0;
const BOOST_RETURNED_RULE = 5.0;
const BOOST_DOMAIN_MATCH = 3.0;
const DEMOTE_CONTRADICTION = 0.1;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "im",
  "my",
  "me",
  "you",
  "your",
  "we",
  "our",
  "they",
  "them",
  "do",
  "does",
  "did",
  "how",
  "what",
  "when",
  "where",
  "why",
  "who",
  "can",
  "could",
  "should",
  "would",
  "will",
  "get",
  "got",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "so",
  "just",
  "pixie",
  "whats",
  "hows",
  "wheres",
  "whens",
  "whos",
  "whys",
  "thats",
  "theres",
  "heres",
  "ive",
  "ill",
  "youre",
  "u",
  "ur",
  "pls",
  "plz",
]);

const SOFTWARE_TERMS = new Set([
  "software",
  "code",
  "coding",
  "repo",
  "github",
  "app",
  "website",
  "web",
  "frontend",
  "backend",
  "script",
  "npm",
  "deploy",
  "hosting",
  "git",
  "python",
  "javascript",
  "typescript",
  "html",
  "css",
  "api",
  "cli",
  "library",
  "bot",
  "pr",
  "commit",
  "developer",
  "browser",
  "extension",
]);

const HARDWARE_TERMS = new Set([
  "hardware",
  "pcb",
  "circuit",
  "wiring",
  "wire",
  "cad",
  "schematic",
  "breadboard",
  "soldering",
  "gerber",
  "component",
  "3d",
  "kicad",
  "step",
  "stl",
  "electronics",
  "enclosure",
  "bom",
  "resistor",
  "microcontroller",
  "devboard",
  "macropad",
  "fusion360",
  "easyeda",
]);

const AI_TERMS = ["ai", "chatgpt", "copilot", "claude", "gpt", "llm"];
const FIRMWARE_TERMS = ["firmware", "embedded"];
const CAD_TERMS = ["cad", "pcb", "schematic", "circuit", "3d", "gerber", "step", "stl", "breadboard", "soldering"];
const RETURNED_TERMS = ["returned", "return", "resubmit", "resubmission"];
const REFERRAL_TERMS = ["referral", "referrals"];
const DISCLOSURE_TERMS = ["disclose", "disclosure"];
const CONSEQUENCE_TERMS = ["exceed", "hide", "hiding", "consequence", "fraud", "ban", "penalty"];
const HOURS_TERMS = ["hour", "hours", "deflate", "deflation", "reduce", "payout"];

function detectDomain(text: string): Domain {
  const lowered = String(text || "").toLowerCase();
  const hasHardware =
    /\b(?:hardware|pcb|wiring\s+diagram|gerber|breadboard|soldering|schematic|cad\b|3d\s+model|\.step\b|\.stl\b|kicad|easyeda|devboard|macropad|circuit|resistor)\b/i.test(
      lowered,
    );
  const hasSoftware =
    /\b(?:software|web\s+app|website|mobile\s+app|playable\s+url|browser\s+extension|frontend|backend|npm|pypi|github\s+repo)\b/i.test(
      lowered,
    );

  if (hasHardware && !hasSoftware) return "hardware";
  if (hasSoftware && !hasHardware) return "software";
  return "general";
}

function foldPlural(token: string) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && /(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): string[] {
  const rawWords = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokens: string[] = [];
  for (const word of rawWords) {
    if (word.includes("-")) {
      for (const part of word.split("-")) {
        if (part.length > 1 && !STOPWORDS.has(part)) {
          tokens.push(foldPlural(part));
        }
      }
      const combined = word.replace(/-/g, "");
      if (combined.length > 1 && !STOPWORDS.has(combined)) {
        tokens.push(foldPlural(combined));
      }
    } else if (word.length > 1 && !STOPWORDS.has(word)) {
      tokens.push(foldPlural(word));
    }
  }

  if (tokens.includes("old") && !tokens.includes("age")) {
    tokens.push("age");
  }
  if (tokens.includes("expiration") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("expires") && !tokens.includes("expire")) {
    tokens.push("expire");
  }
  if (tokens.includes("resubmission") && !tokens.includes("resubmit")) {
    tokens.push("resubmit");
  }
  if (tokens.includes("returned") && !tokens.includes("return")) {
    tokens.push("return");
  }
  if (tokens.includes("return") && !tokens.includes("returned")) {
    tokens.push("returned");
  }
  if ((tokens.includes("disclosure") || tokens.includes("disclosing")) && !tokens.includes("disclose")) {
    tokens.push("disclose");
  }
  if (tokens.includes("disclose") && !tokens.includes("disclosure")) {
    tokens.push("disclosure");
  }

  return tokens;
}

function chunkSection(name: string, rawText: string): Chunk[] {
  const normalized = String(rawText || "")
    .replace(/([^\n])\n(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([.?!])\n([A-Z0-9*-])/g, "$1\n\n$2")
    .trim();
  if (!normalized) return [];
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let buffer = "";

  const flush = () => {
    const body = buffer.trim();
    buffer = "";
    if (!body) return;
    const alreadyHasHeading = heading && (body.startsWith(heading) || body.startsWith("#") || body.includes(heading));
    const fullText = heading && !alreadyHasHeading ? `${heading}\n${body}` : body;
    chunks.push({
      source: name,
      heading,
      domain: detectDomain(fullText),
      text: fullText,
    });
  };

  for (const paragraph of paragraphs) {
    const headingMatch = paragraph.match(/^#{1,6}\s+(.+)$/m);
    if (headingMatch && paragraph.startsWith("#")) {
      flush();
      heading = headingMatch[1].trim();
    }

    if (paragraph.length > MAX_CHUNK) {
      flush();
      let piece = "";
      for (const sentence of paragraph.split(/(?<=[.!?])\s+|\n+/)) {
        if (piece && piece.length + sentence.length > MAX_CHUNK) {
          buffer = piece;
          flush();
          piece = "";
        }
        piece = piece ? `${piece}\n${sentence}` : sentence;
      }
      buffer = piece;
      flush();
      continue;
    }

    if (buffer && shouldFlushBeforeMerge(buffer, paragraph)) {
      flush();
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > MAX_CHUNK) {
      flush();
      buffer = paragraph;
    } else {
      buffer = candidate;
      const isLeadIn = /:\s*$/.test(buffer);
      if (!isLeadIn && buffer.length >= MIN_CHUNK) {
        flush();
      }
    }
  }

  flush();
  return chunks;
}

function shouldFlushBeforeMerge(buffer: string, paragraph: string) {
  const bufDomain = detectDomain(buffer);
  const paraDomain = detectDomain(paragraph);
  const domainConflict =
    (bufDomain === "software" && paraDomain === "hardware") || (bufDomain === "hardware" && paraDomain === "software");
  if (domainConflict) return true;
  if (/:\s*$/.test(buffer)) return false;
  if (/[.?!]\s*$/.test(buffer) && buffer.length >= 60) return true;
  return buffer.length + paragraph.length > MAX_CHUNK;
}

function chunkSections(sections: Section[]) {
  return sections.flatMap(([name, text]) => chunkSection(name, text));
}

function buildIndex(chunks: Chunk[]): SearchIndex {
  const docs: IndexedDoc[] = chunks.map((chunk) => {
    const terms = tokenize(`${chunk.heading || ""} ${chunk.text}`);
    const freq = new Map<string, number>();
    for (const term of terms) freq.set(term, (freq.get(term) || 0) + 1);
    return { chunk, freq, length: terms.length };
  });

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.freq.keys()) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }

  const totalLength = docs.reduce((sum, d) => sum + d.length, 0);
  return { docs, docFreq, avgLength: docs.length > 0 ? totalLength / docs.length : 0 };
}

function classifyQuery(queryTerms: string[]): ScoreFlags {
  const has = (list: string[]) => queryTerms.some((term) => list.includes(term));
  const hasSet = (set: Set<string>) => queryTerms.some((term) => set.has(term));
  const isFirmwareQuery = has(FIRMWARE_TERMS);
  return {
    isAiQuery: has(AI_TERMS),
    isFirmwareQuery,
    isSoftwareQuery: hasSet(SOFTWARE_TERMS),
    isHardwareQuery: !isFirmwareQuery && hasSet(HARDWARE_TERMS),
    isCadOrPcbQuery: has(CAD_TERMS),
    isReadmeQuery: queryTerms.some((term) => term === "readme"),
    isReturnedQuery: has(RETURNED_TERMS),
    isReferralQuery: has(REFERRAL_TERMS),
    isDisclosureQuery: has(DISCLOSURE_TERMS),
    isConsequenceQuery: has(CONSEQUENCE_TERMS),
    queryMentionsHours: has(HOURS_TERMS),
  };
}

function bm25TermScore(tf: number, docLength: number, avgLength: number, idf: number) {
  const norm = tf * (K1 + 1);
  const denom = tf + K1 * (1 - B + (B * docLength) / (avgLength || 1));
  return idf * (norm / denom);
}

function baseScore(
  doc: IndexedDoc,
  queryTerms: string[],
  total: number,
  docFreq: Map<string, number>,
  avgLength: number,
) {
  let value = 0;
  for (const term of queryTerms) {
    const tf = doc.freq.get(term);
    if (!tf) continue;
    const frequency = docFreq.get(term) ?? 0;
    const idf = Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5));
    value += bm25TermScore(tf, doc.length, avgLength, idf);
  }
  return value;
}

function aiChunkSignals(text: string, heading: string, combined: string): AiSignals {
  return {
    has30Percent: /30\s*%|30\s*percent|hard ceiling/i.test(combined),
    isHardwareAiProhibition:
      /(?:hardware|cad|pcb|3d|step)/i.test(text) &&
      /(?:not allowed|100%\s*original|0%\s*ai|not\s+(?:be\s+)?generated by ai|ai cannot generate|custom designs by you)/i.test(
        text,
      ),
    isFirmwareAiRule: /firmware/i.test(text) && /(?:30%|standard software code limit|microcontroller)/i.test(text),
    isReadmeAiRule: /readme/i.test(text) && /(?:cannot be built by ai|write your own readme)/i.test(text),
    isDisclosureChunk: /disclose|disclosure/i.test(text),
    isConsequenceChunk: /(?:exceed|hide|hiding|consequence|fraud|permanent ban|reject your project|penaliz)/i.test(
      text,
    ),
    isGenericAiAllowance: /using ai tools|permitted|30% of (?:the total|your project's) code/i.test(combined),
    isVagueHonestyHeading: /be honest about ai/i.test(heading),
    isVagueAllowance: /using ai tools/i.test(text),
  };
}

function applyAiBoost(value: number, flags: ScoreFlags, signals: AiSignals) {
  if (!flags.isAiQuery) return value;
  if (flags.isFirmwareQuery) {
    if (signals.isFirmwareAiRule) return value + BOOST_DECIDING_RULE;
    if (signals.isHardwareAiProhibition) return value * DEMOTE_CONTRADICTION;
    return value;
  }
  if (flags.isHardwareQuery || flags.isCadOrPcbQuery) {
    if (signals.isHardwareAiProhibition) return value + BOOST_DECIDING_RULE;
    const generic = signals.isGenericAiAllowance && !signals.isHardwareAiProhibition && !signals.isReadmeAiRule;
    if (generic) return 0;
    return value;
  }
  if (flags.isReadmeQuery) {
    if (signals.isReadmeAiRule) return value + BOOST_DECIDING_RULE;
    const generic = signals.isGenericAiAllowance && !signals.isHardwareAiProhibition && !signals.isReadmeAiRule;
    if (generic) return 0;
    return value;
  }
  if (flags.isDisclosureQuery) {
    if (signals.isDisclosureChunk) return value + BOOST_DECIDING_RULE;
    return value;
  }
  if (flags.isConsequenceQuery) {
    if (signals.isConsequenceChunk) return value + BOOST_DECIDING_RULE;
    return value;
  }
  if (signals.has30Percent || signals.isHardwareAiProhibition) return value + BOOST_SPECIFIC_CAP;
  if (signals.isVagueHonestyHeading || (signals.isVagueAllowance && !signals.has30Percent)) {
    return value * DEMOTE_CONTRADICTION;
  }
  return value;
}

function chunkDomainSignals(domain: Domain, combined: string): DomainSignals {
  return {
    isHardwareChunk:
      domain === "hardware" ||
      /hardware-requirements|hardware\s+requirements|\bpcb\b|wiring\s+diagram|gerber|breadboard|soldering|\bcad\b|3d\s+model|\.step\b|\.stl\b/i.test(
        combined,
      ),
    isSoftwareChunk:
      domain === "software" ||
      /software-requirements|software\s+requirements|\bsoftware\b|web\s+app|website|mobile\s+app|browser\s+extension|\bcli\b/i.test(
        combined,
      ),
  };
}

function applyDomainBoost(value: number, flags: ScoreFlags, domainSignals: DomainSignals) {
  if (flags.isSoftwareQuery && !flags.isHardwareQuery) {
    if (domainSignals.isHardwareChunk && !domainSignals.isSoftwareChunk) return 0;
    if (domainSignals.isSoftwareChunk) return value + BOOST_DOMAIN_MATCH;
    return value;
  }
  if (flags.isHardwareQuery && !flags.isSoftwareQuery) {
    if (domainSignals.isSoftwareChunk && !domainSignals.isHardwareChunk) return 0;
    if (domainSignals.isHardwareChunk) return value + BOOST_DOMAIN_MATCH;
  }
  return value;
}

function applyReturnedBoost(value: number, flags: ScoreFlags, combined: string) {
  if (!flags.isReturnedQuery) return value;
  const isReturnedChunk =
    /(?:returned|needs changes|resubmitted|resubmit)/i.test(combined) &&
    /(?:feedback|adjustments|changes|not a (?:penalty|punishment)|eligible)/i.test(combined);
  const isDeflationChunk =
    /(?:deflate|deflation|override hours|reduce|deduct|cut|hours spent)/i.test(combined) &&
    /(?:doubt|claimed hours|genuine effort|audit|indicators converge)/i.test(combined);
  if (isReturnedChunk) value += BOOST_RETURNED_RULE;
  if (isDeflationChunk && !flags.queryMentionsHours) return 0;
  return value;
}

function applyReferralBoost(value: number, flags: ScoreFlags, combined: string) {
  if (!flags.isReferralQuery) return value;
  const isReferralChunk = /referral/i.test(combined);
  const hasExpiration = /(?:48\s*hours?|2\s*days?|expire|expiration)/i.test(combined);
  if (isReferralChunk && hasExpiration) return value + BOOST_DECIDING_RULE;
  return value;
}

function boostedValue(base: number, doc: IndexedDoc, flags: ScoreFlags) {
  const text = doc.chunk.text || "";
  const heading = doc.chunk.heading || "";
  const source = doc.chunk.source || "";
  const domain = doc.chunk.domain || detectDomain(text);
  const combined = `${heading} ${text} ${source}`;
  const rawSignals = aiChunkSignals(text, heading, combined);
  const signals = {
    ...rawSignals,
    isGenericAiAllowance:
      rawSignals.isGenericAiAllowance && !rawSignals.isHardwareAiProhibition && !rawSignals.isReadmeAiRule,
  };
  let value = applyAiBoost(base, flags, signals);
  if (value === 0) return 0;
  value = applyDomainBoost(value, flags, chunkDomainSignals(domain, combined));
  if (value === 0) return 0;
  value = applyReturnedBoost(value, flags, combined);
  if (value === 0) return 0;
  value = applyReferralBoost(value, flags, combined);
  return value;
}

function score(index: SearchIndex, queryTerms: string[]): ScoredChunk[] {
  const { docs, docFreq, avgLength } = index;
  const total = docs.length;
  const flags = classifyQuery(queryTerms);
  return docs
    .map((doc) => {
      const base = baseScore(doc, queryTerms, total, docFreq, avgLength);
      if (base <= 0) return { chunk: doc.chunk, value: 0 };
      return { chunk: doc.chunk, value: boostedValue(base, doc, flags) };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
}

/**
 * Return the lexical score and a bounded paraphrase signal separately. The
 * semantic signal is reranking-only: policy/domain contradiction filters are
 * applied before it can contribute, and it can never create source content.
 */
function scoreDetailed(index: SearchIndex, question: string): DetailedScore[] {
  const queryTerms = tokenize(question);
  if (queryTerms.length === 0) return [];
  const { docs, docFreq, avgLength } = index;
  const totalDocs = docs.length;
  const flags = classifyQuery(queryTerms);
  return docs
    .map((doc) => {
      const base = baseScore(doc, queryTerms, totalDocs, docFreq, avgLength);
      const lexical = base > 0 ? boostedValue(base, doc, flags) : 0;
      // Run the existing hard filters with a neutral lexical score so a fuzzy
      // match cannot bypass exact software/hardware or policy exclusions.
      const eligible = boostedValue(1, doc, flags) > 0;
      const semantic = eligible
        ? semanticSimilarity.score(question, `${doc.chunk.heading || ""}\n${doc.chunk.text}`.slice(0, 2400))
        : 0;
      const semanticBonus = semantic >= 0.18 ? Math.min(semantic * 1.25, 1.25) : 0;
      return {
        chunk: doc.chunk,
        lexical,
        semantic,
        total: lexical + semanticBonus,
      };
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total || b.lexical - a.lexical);
}

function selectChunks(index: SearchIndex, question: string, budget = DEFAULT_BUDGET): Chunk[] {
  const selected: Chunk[] = [];
  let used = 0;
  for (const { chunk } of scoreDetailed(index, question)) {
    if (used + chunk.text.length > budget) break;
    selected.push(chunk);
    used += chunk.text.length;
  }
  return selected;
}

function selectContext({
  generated,
  learned = [],
  index,
  sources,
  question,
  budget = DEFAULT_BUDGET,
  exclude = null,
  generatedLast = false,
}: SelectContextOptions) {
  const dropped = exclude instanceof Set ? exclude : new Set(exclude || []);
  const kept = ([name]: Section) => !dropped.has(name);

  const budgetFor = (name: string) => {
    if (name === "About pixie") return IDENTITY_BUDGET;
    if (name === "Program timeline") return TIMELINE_BUDGET;
    if (name === "Learned answers") return LEARNED_BUDGET;
    return TIMELINE_BUDGET;
  };
  const render = ([name, text]: Section) => `### ${name}\n${String(text || "").slice(0, budgetFor(name))}`;
  const renderLearned = ([name, text]: Section) => `### ${name}\n${String(text || "").slice(0, LEARNED_BUDGET)}`;

  const head = generated
    .filter(kept)
    .filter(([, text]) => text)
    .map(render);
  const learnedSections = learned
    .filter(kept)
    .filter(([, text]) => text)
    .map(renderLearned);
  const first = [...head, ...learnedSections];
  const order = (retrieved: string[]) =>
    (generatedLast ? [...retrieved, ...first] : [...first, ...retrieved]).join("\n\n");
  const enforceTotal = (text: string) =>
    text.length > TOTAL_CONTEXT_BUDGET ? text.slice(0, TOTAL_CONTEXT_BUDGET) : text;

  const chunks = selectChunks(index, question, budget).filter((c) => !dropped.has(c.source));
  if (chunks.length === 0) {
    log.debug("retrieve", `no chunk matched "${(question || "").slice(0, 60)}" — sending capped corpus`);
    let used = 0;
    const capped: string[] = [];
    for (const [name, text] of sources.filter(kept)) {
      if (used >= budget) break;
      const slice = text.slice(0, Math.max(200, budget - used));
      capped.push(`### ${name}\n${slice}`);
      used += slice.length;
    }
    return enforceTotal(order(capped));
  }

  const bySource = new Map<string, string[]>();
  for (const chunk of chunks) {
    const texts = bySource.get(chunk.source) || [];
    texts.push(chunk.text);
    bySource.set(chunk.source, texts);
  }

  const body = [...bySource].map(([name, texts]) => `### ${name}\n${texts.join("\n\n")}`);
  return enforceTotal(order(body));
}

export = {
  tokenize,
  foldPlural,
  detectDomain,
  chunkSection,
  chunkSections,
  buildIndex,
  score,
  scoreDetailed,
  selectChunks,
  selectContext,
  MIN_CHUNK,
  MAX_CHUNK,
  DEFAULT_BUDGET,
  IDENTITY_BUDGET,
  TIMELINE_BUDGET,
  LEARNED_BUDGET,
  LEARNED_MAX_FACTS,
  TOTAL_CONTEXT_BUDGET,
  K1,
  B,
  BOOST_DECIDING_RULE,
  BOOST_SPECIFIC_CAP,
  BOOST_RETURNED_RULE,
  BOOST_DOMAIN_MATCH,
  DEMOTE_CONTRADICTION,
};
