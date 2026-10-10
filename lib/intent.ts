import configModule = require("./config");
import llm = require("./llm");
import answer = require("./answer");
import db = require("./db");
import programs = require("./programs");
import log = require("./log");
import type { Program } from "./types";

const { config } = configModule;
const { looksLikeCode } = answer;
const recordMetric = db.recordMetric as (...args: unknown[]) => unknown;
const recentUserMessages = db.recentUserMessages as (
  userId: string,
  options: { channel?: string; limit: number },
) => Array<{ text?: string }>;

interface ContextMessageInput {
  text: string;
  isPixie?: boolean;
  userId?: string;
  speaker?: string;
}
interface ContextItem {
  text: string;
  speaker: "human" | "pixie";
}
interface ContextResult {
  verdict: string;
  addressedToPixie: boolean;
  directedAtHuman: boolean;
  recentPixieParticipation: boolean;
  programRelevance: string;
  [key: string]: unknown;
}
interface IntentOptions {
  userId?: string | null;
  channel?: string | null;
  history?: string[] | null;
  addressed?: boolean;
  threadMessages?: unknown[];
  recentMessages?: unknown[] | null;
  returnContext?: boolean;
  noTelemetry?: boolean;
}

const MAX_TOKENS = 20;
const MIN_LENGTH = 5;
const TIMEOUT_MS = 10000;
const HELP_NEEDED = "HELP_NEEDED";
const CASUAL_CHAT = "CASUAL_CHAT";
const OFF_TOPIC = "OFF_TOPIC";
const CONTEXT_LIMIT = 8;
const CONTEXT_TEXT_LIMIT = 600;
const PROGRAM_RELEVANCE = new Set(["relevant", "unrelated", "unclear"]);

const HISTORY_LIMIT = 3;

function intentSystemPrompt(
  program: Program | string | null = null,
  { scoped = false }: { scoped?: boolean } = {},
): string {
  const name = typeof program === "string" ? program : program?.name || "Hack Club YSWS";

  const scopeRule = scoped
    ? `

There is a third verdict here, because this channel only wants ${name} answers from pixie.

Answer OFF_TOPIC when someone genuinely needs help, but with something completely unrelated to ${name} or building projects for it — school homework, unrelated maths, relationship or life advice, an unrelated company, or another Hack Club program. Real question, wrong bot. A human in the channel will take it.

Use HELP_NEEDED when the question is about ${name} itself, hardware/firmware development, testing, simulation, PCB design, code, tooling, or when general program or shop questions are asked inside the ${name} channel (e.g. "where are the docs?", "how do i test my firmware if i don't have hardware yet?", "how do i go to the shop?", "how do i submit?", "when is the deadline?", "where is the site?", "what are the rules?").

If you cannot tell whether a question is about ${name} or not, answer OFF_TOPIC. Staying out of it is free.`
    : "";

  return `You are the gate for pixie, a Slack bot in the ${name} channels at Hack Club. Pixie replies only when someone is actually asking a question or genuinely waiting for help with their project/code/setup, and stays completely silent otherwise.

You are shown the last few messages from one person, then the ONE message you have to judge. The earlier messages are context only — never judge them. Judge the final message.

The single question you are answering is: **is this person genuinely asking a question or asking the room for help/guidance right now?**

Answer HELP_NEEDED when:
- they are asking an actionable question about ${name}, project rules, guidelines, eligibility, submissions, code debugging, tooling (git, github, hackatime), build setup, or how something works (e.g. "can ii make any kind of project?", "how do i connect hackatime", "why is my build failing with TypeError")
- they are asking about hardware, firmware, testing, simulators/emulators (e.g. Wokwi, QEMU), microcontrollers, PCB design, pinouts, flashing, components, or building their project (e.g. "how do i test my firmware if i don't have hardware yet", "can i simulate this in wokwi", "how do i flash rp2040", "which microcontroller should i use")
- they are asking about the shop, catalogue, items, costs, hours, orders, shipping, or rewards (e.g. "how do i go to the shop", "where is the shop", "can i buy a raspberry pi", "when is the shop open")
- they are reporting their own project/code broken or stuck and asking for troubleshooting
- they are asking for input choosing between project technologies or options ("should i use godot or kaboom for this", "should i use rp2040 or esp32")
- their earlier messages show them actively debugging their project and this continues it ("still getting error 403", "ok that fixed the first bug but now it crashes")
- they were just given help and are asking a follow-up ("where do i put that API key")

Answer CASUAL_CHAT when:
- speaking to or addressing someone else by name or mention (e.g. "ricky i see another bug", "orpheus check this out", "hey @bob")
- venting, complaining, expressing frustration, or cursing about external apps, third-party download timeouts, OS quirks, or internet speed without asking for help with their project (e.g. "went to download taut but the linux download is timing out", "slack is lagging so bad", "my wifi is dead", "arch is driving me crazy")
- thinking out loud, riffing, banter, jokes, hypotheticals ("what if i just used 60 api keys", "imagine if...")
- narrating daily life or what they're doing without asking for help ("gonna go eat dinner", "finally finished my homework")
- opinions, rants, memes, reactions, greetings, thanks, "gg", "lets go", "fr", "w"
- rhetorical complaints with no question or request in them
- side conversations aimed at other specific people in the room
- they already got their answer and are just acknowledging ("ohhh got it thanks")

When someone is merely venting or complaining about something failing (like a random download or third-party tool) without asking how to fix it or asking for help, classify as CASUAL_CHAT.${scopeRule}

Return exactly one JSON object with exactly these keys and no markdown:
{"verdict":"${scoped ? "HELP_NEEDED|CASUAL_CHAT|OFF_TOPIC" : "HELP_NEEDED|CASUAL_CHAT"}","addressedToPixie":true,"directedAtHuman":false,"recentPixieParticipation":false,"programRelevance":"relevant|unrelated|unclear"}

Context may contain several speakers. Never attribute a human's words to Pixie, and never use a human-to-human request as evidence that Pixie was asked. Set directedAtHuman true only when the current message is semantically asking another person for their personal experience or response. A factual program question that mentions a person as evidence is not directedAtHuman. Direct Pixie targeting is strong evidence for HELP_NEEDED; recent Pixie participation is context, not a request by itself. If context is ambiguous or malformed, choose CASUAL_CHAT and programRelevance "unclear".

When you genuinely cannot tell, choose CASUAL_CHAT. A missed question costs nothing — a human answers it. A reply nobody asked for is noise in the channel.`;
}

function contextMessage(message: unknown): ContextItem | null {
  if (typeof message === "string") return { text: message, speaker: "human" };
  if (!message || typeof message !== "object") return null;
  const value = message as ContextMessageInput;
  if (typeof value.text !== "string" || !value.text.trim()) return null;
  const speaker = value.isPixie || value.userId === "pixie" || value.speaker === "pixie" ? "pixie" : "human";
  return { text: value.text.trim().slice(0, CONTEXT_TEXT_LIMIT), speaker };
}

function boundedContext(messages: unknown[]): ContextItem[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-CONTEXT_LIMIT)
    .map(contextMessage)
    .filter((item): item is ContextItem => item !== null);
}

function buildUserPrompt(
  message: string,
  history: unknown[] = [],
  {
    threadMessages = [],
    recentMessages = null,
  }: { threadMessages?: unknown[]; recentMessages?: unknown[] | null } = {},
): string {
  const lines = [];

  const recent = boundedContext(recentMessages || history);
  const thread = boundedContext(threadMessages);
  if (recent.length > 0 || thread.length > 0) {
    if (thread.length > 0) {
      lines.push("Thread context, oldest first (context only):");
      thread.forEach((item, i) => lines.push(`${i + 1}. [${item.speaker}] ${item.text}`));
    }
    if (recent.length > 0) {
      lines.push("Recent channel context, oldest first (context only):");
      recent.forEach((item, i) => lines.push(`${i + 1}. [${item.speaker}] ${item.text}`));
    }
  } else {
    lines.push("They have not said anything recently — no context available.");
  }

  lines.push(
    "",
    "The message to judge (human, not context):",
    `[human] ${String(message).slice(0, CONTEXT_TEXT_LIMIT)}`,
  );
  return lines.join("\n");
}

function extractJsonObject(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) t = fenced[1].trim();
  if (t[0] !== "{" || t[t.length - 1] !== "}") {
    const first = t.indexOf("{");
    const last = t.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    t = t.slice(first, last + 1);
  }
  return t;
}

function parseContextResult(text: unknown, { scoped = false }: { scoped?: boolean } = {}): ContextResult | null {
  const json = extractJsonObject(text);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (_) {
    return null;
  }
  const expected = [
    "addressedToPixie",
    "directedAtHuman",
    "programRelevance",
    "recentPixieParticipation",
    "verdict",
  ].sort();
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null;
  const verdicts = scoped ? [HELP_NEEDED, CASUAL_CHAT, OFF_TOPIC] : [HELP_NEEDED, CASUAL_CHAT];
  if (
    typeof record.verdict !== "string" ||
    !verdicts.includes(record.verdict) ||
    typeof record.addressedToPixie !== "boolean" ||
    typeof record.directedAtHuman !== "boolean" ||
    typeof record.recentPixieParticipation !== "boolean" ||
    typeof record.programRelevance !== "string" ||
    !PROGRAM_RELEVANCE.has(record.programRelevance)
  )
    return null;
  return record as ContextResult;
}

function enrichContextResult(
  result: ContextResult | null,
  { addressed = false }: { addressed?: boolean } = {},
): (ContextResult & { directedAtPixie: boolean; needsHelp: boolean; shouldAttemptAnswer: boolean }) | null {
  if (!result) return null;
  const directedAtPixie = addressed || result.addressedToPixie === true;
  const directedAtHuman = result.directedAtHuman === true;
  return {
    ...result,
    directedAtPixie,
    directedAtHuman,
    needsHelp: result.verdict === HELP_NEEDED,
    shouldAttemptAnswer: !directedAtHuman && (result.verdict === HELP_NEEDED || directedAtPixie),
  };
}

function normalizeIntentResult(
  result: ContextResult | string | null,
  { addressed = false }: { addressed?: boolean } = {},
) {
  if (!result) return null;
  if (typeof result === "string") {
    return enrichContextResult(
      {
        verdict: result,
        addressedToPixie: addressed,
        directedAtHuman: false,
        recentPixieParticipation: false,
        programRelevance: "unclear",
      },
      { addressed },
    );
  }
  return enrichContextResult(result, { addressed });
}

function historyFor(userId: string | null, channel: string | null, current: string): string[] {
  if (!userId) return [];
  try {
    const rows = recentUserMessages(userId, { channel: channel || undefined, limit: HISTORY_LIMIT + 1 })
      .map((r: { text?: string }) => (r.text || "").trim())
      .filter(Boolean);

    if (rows.length > 0 && current && rows[rows.length - 1] === current.trim()) rows.pop();

    return rows.slice(-HISTORY_LIMIT);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log.debug("intent", `history lookup failed: ${error.message}`);
    return [];
  }
}

function telemetryEnabled(noTelemetry = false) {
  return !noTelemetry && !(typeof llm.telemetrySuppressed === "function" && llm.telemetrySuppressed());
}

function scopedFor(program: Program | null, addressed = false): boolean {
  if (addressed) return false;
  if (!program) return false;
  return programs.isProgramScoped(program);
}

async function classifyIntent(
  message: string,
  program: Program | null = null,
  {
    userId = null,
    channel = null,
    history = null,
    addressed = false,
    threadMessages = [],
    recentMessages = null,
    returnContext = false,
    noTelemetry = false,
  }: IntentOptions = {},
): Promise<string | ContextResult | null> {
  if (!message || message.length < MIN_LENGTH) return null;

  const scoped = scopedFor(program, addressed);
  const recent = history || historyFor(userId, channel, message);

  try {
    const { text } = await llm.complete(
      {
        baseUrl: config.intent.baseUrl,
        apiKey: config.intent.apiKey,
        model: config.intent.model,
        fallback: config.intent.fallback,
        onRateLimited: (config.intent as typeof config.intent & { onRateLimited?: unknown }).onRateLimited,
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
        thinking: { type: "disabled" },
        timeout: TIMEOUT_MS,
        messages: [
          { role: "system", content: intentSystemPrompt(program, { scoped }) },
          { role: "user", content: buildUserPrompt(message, recent, { threadMessages, recentMessages }) },
        ],
        telemetry: { operation: "intent", programId: program?.id || null, channel, noTelemetry },
      },
      "intent",
    );

    const parsed = parseContextResult(text, { scoped });
    if (!parsed && typeof text === "string" && text.trim()) {
      log.warn("intent", `unparseable classifier output: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      if (telemetryEnabled(noTelemetry))
        try {
          recordMetric(
            "intent_parse_failure",
            null,
            scoped ? "scoped" : "open",
            program && program.id ? program.id : null,
          );
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          log.debug("intent", `could not record classifier parse failure: ${failure.message}`);
        }
    }
    const result = normalizeIntentResult(parsed, { addressed });
    return returnContext ? result : result?.verdict || null;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    log.error("intent", "classification failed:", error.message);
    if (telemetryEnabled(noTelemetry))
      try {
        recordMetric("intent_parse_failure", null, "call_failed", program && program.id ? program.id : null);
      } catch (failure) {
        const detail = failure instanceof Error ? failure : new Error(String(failure));
        log.debug("intent", `could not record classifier failure: ${detail.message}`);
      }
    return null;
  }
}

const REACTION_ONLY = new Set(
  (
    "lol lmao lmfao lmaoo lmaooo rofl haha hahaha hehe ok okay okey k kk yeah yea ye yep yup nah nope no yes" +
    " same fr frfr ngl bruh bro yo hi hey hello sup wsg gm gn ty thx thanks tysm np gg ggs w l true real" +
    " nice cool sick based goated damn oof rip wow yay lets go letsgo bet sheesh finally done exactly this"
  ).split(" "),
);

function stripDecoration(text: string): string {
  return (text || "")
    .replace(/:[a-z0-9_+-]+:/gi, " ")
    .replace(/<[@#!][^>]+>/g, " ")
    .replace(/<https?:\/\/[^>]+>/gi, " ")
    .trim();
}

function normalizeReaction(text: string): string {
  return stripDecoration(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function worthClassifying(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (looksLikeCode(raw)) return true;

  const stripped = stripDecoration(raw);
  if (stripped.length < MIN_LENGTH) return false;

  const normalized = normalizeReaction(raw);
  if (!normalized) return false;
  if (REACTION_ONLY.has(normalized)) return false;
  const words = normalized.split(" ");
  if (words.length <= 3 && words.every((w) => REACTION_ONLY.has(w))) return false;

  return true;
}

const PROBLEM_WORD =
  /\b(?:broke|broken|breaks|breaking|error|errors|fail(?:s|ed|ing)?|stuck|bug|bugged|issue|crash(?:ed|ing|es)?|glitch\w*|not working|no idea|confused)\b/i;

const BROKEN_VERB =
  /\b(?:wont|won't|cant|can't|doesnt|doesn't|isnt|isn't|didnt|didn't|not)\s+(?:\w+\s+){0,2}(?:work|works|working|load|loads|loading|run|runs|running|build|building|open|opening|start|starting|render|rendering|show|showing|display|appear|appearing|find|connect|connecting|compile|compiling|save|saving|export|launch|install|update|sync|respond|responding|recognize|detect)\b/i;

const ASK_SHAPE =
  /\?|\b(?:how|what|where|why|which|when|who)\b[^.!?]{0,30}\b(?:do|does|did|can|should|would|is|are|to)\b|\b(?:should|can|could|do) i\b|\banyone know\b|\bdoes anyone\b|\bis there a way\b|\bhow to\b|\bhelp\b/i;

const MIN_REQUEST_WORDS = 3;

function wordCount(text: string): number {
  return text.split(/\s+/).length;
}

function looksLikeHelpRequest(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  if (looksLikeCode(t)) return true;
  if (wordCount(t) < MIN_REQUEST_WORDS) return false;
  return PROBLEM_WORD.test(t) || BROKEN_VERB.test(t) || ASK_SHAPE.test(t);
}

const api = {
  classifyIntent,
  classifyIntentContext: async (message: string, program: Program | null = null, options: IntentOptions = {}) => {
    const result =
      api.classifyIntent !== classifyIntent
        ? await api.classifyIntent(message, program, options)
        : await classifyIntent(message, program, { ...options, returnContext: true });
    return normalizeIntentResult(result, options);
  },
  parseContextResult,
  enrichContextResult,
  normalizeIntentResult,
  intentSystemPrompt,
  buildUserPrompt,
  scopedFor,
  worthClassifying,
  looksLikeHelpRequest,
  HISTORY_LIMIT,
  CONTEXT_LIMIT,
  HELP_NEEDED,
  CASUAL_CHAT,
  OFF_TOPIC,
};

export = api;
