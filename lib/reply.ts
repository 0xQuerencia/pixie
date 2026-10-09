const knowledge = require("./knowledge");
const log = require("./log");
const { config } = require("./config");

const STREAMING_WORDS = [
  "Accomplishing",
  "Actioning",
  "Actualizing",
  "Architecting",
  "Baking",
  "Beaming",
  "Beboppin'",
  "Befuddling",
  "Billowing",
  "Blanching",
  "Bloviating",
  "Boogieing",
  "Boondoggling",
  "Booping",
  "Bootstrapping",
  "Brewing",
  "Bunning",
  "Burrowing",
  "Calculating",
  "Canoodling",
  "Caramelizing",
  "Cascading",
  "Catapulting",
  "Cerebrating",
  "Channeling",
  "Channelling",
  "Choreographing",
  "Churning",
  "Clauding",
  "Coalescing",
  "Cogitating",
  "Combobulating",
  "Composing",
  "Computing",
  "Concocting",
  "Considering",
  "Contemplating",
  "Cooking",
  "Crafting",
  "Creating",
  "Crunching",
  "Crystallizing",
  "Cultivating",
  "Deciphering",
  "Deliberating",
  "Determining",
  "Dilly-dallying",
  "Discombobulating",
  "Doing",
  "Doodling",
  "Drizzling",
  "Ebbing",
  "Effecting",
  "Elucidating",
  "Embellishing",
  "Enchanting",
  "Envisioning",
  "Evaporating",
  "Fermenting",
  "Fiddle-faddling",
  "Finagling",
  "Flambéing",
  "Flibbertigibbeting",
  "Flowing",
  "Flummoxing",
  "Fluttering",
  "Forging",
  "Forming",
  "Frolicking",
  "Frosting",
  "Gallivanting",
  "Galloping",
  "Garnishing",
  "Generating",
  "Gesticulating",
  "Germinating",
  "Gitifying",
  "Grooving",
  "Gusting",
  "Harmonizing",
  "Hashing",
  "Hatching",
  "Herding",
  "Honking",
  "Hullaballooing",
  "Hyperspacing",
  "Ideating",
  "Imagining",
  "Improvising",
  "Incubating",
  "Inferring",
  "Infusing",
  "Ionizing",
  "Jitterbugging",
  "Julienning",
  "Kneading",
  "Leavening",
  "Levitating",
  "Lollygagging",
  "Manifesting",
  "Marinating",
  "Meandering",
  "Metamorphosing",
  "Misting",
  "Moonwalking",
  "Moseying",
  "Mulling",
  "Mustering",
  "Musing",
  "Nebulizing",
  "Nesting",
  "Newspapering",
  "Noodling",
  "Nucleating",
  "Orbiting",
  "Orchestrating",
  "Osmosing",
  "Perambulating",
  "Percolating",
  "Perusing",
  "Philosophising",
  "Photosynthesizing",
  "Pollinating",
  "Pondering",
  "Pontificating",
  "Pouncing",
  "Precipitating",
  "Prestidigitating",
  "Processing",
  "Proofing",
  "Propagating",
  "Puttering",
  "Puzzling",
  "Quantumizing",
  "Razzle-dazzling",
  "Razzmatazzing",
  "Recombobulating",
  "Reticulating",
  "Roosting",
  "Ruminating",
  "Sautéing",
  "Scampering",
  "Schlepping",
  "Scurrying",
  "Seasoning",
  "Shenaniganing",
  "Shimmying",
  "Simmering",
  "Skedaddling",
  "Sketching",
  "Slithering",
  "Smooshing",
  "Sock-hopping",
  "Spelunking",
  "Spinning",
  "Sprouting",
  "Stewing",
  "Sublimating",
  "Swirling",
  "Swooping",
  "Symbioting",
  "Synthesizing",
  "Tempering",
  "Thinking",
  "Thundering",
  "Tinkering",
  "Tomfoolering",
  "Topsy-turvying",
  "Transfiguring",
  "Transmuting",
  "Twisting",
  "Undulating",
  "Unfurling",
  "Unravelling",
  "Vibing",
  "Waddling",
  "Wandering",
  "Warping",
  "Whatchamacalliting",
  "Whirlpooling",
  "Whirring",
  "Whisking",
  "Wibbling",
  "Working",
  "Wrangling",
  "Zesting",
  "Zigzagging",
] as const;

const STREAMING_WORD_INTERVAL_MS = 900;
const THINKING = `_${STREAMING_WORDS[0]}..._`;

const STREAM_UPDATE_MS = 350;

type ThinkingSpinner = { stop: () => Promise<void> };
const thinkingSpinners = new Map<string, ThinkingSpinner>();

function spinnerKey(channel: string, ts: string) {
  return `${channel}\u0000${ts}`;
}

async function stopThinkingSpinner(channel: string, ts: string | null | undefined) {
  if (!ts) return;
  const key = spinnerKey(channel, ts);
  const spinner = thinkingSpinners.get(key);
  if (!spinner) return;
  thinkingSpinners.delete(key);
  await spinner.stop();
}

function startThinkingSpinner(client: SlackClient, channel: string, ts: string) {
  if (!client?.chat || typeof client.chat.update !== "function") return;

  let wordIndex = 0;
  let inFlight: Promise<void> | null = null;
  const key = spinnerKey(channel, ts);
  const timer = setInterval(() => {
    if (inFlight) return;
    wordIndex = (wordIndex + 1) % STREAMING_WORDS.length;
    inFlight = Promise.resolve()
      .then(() => client.chat.update({ channel, ts, text: `_${STREAMING_WORDS[wordIndex]}..._` }))
      .catch((error: unknown) => log.debug("respond", `thinking spinner update failed: ${errorMessage(error)}`))
      .finally(() => {
        inFlight = null;
      });
  }, STREAMING_WORD_INTERVAL_MS);

  thinkingSpinners.set(key, {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  });
}

const programs = require("./programs");
import type { Program, ProgramSource, SlackClient } from "./types";

type ProgramLike = Partial<Program> & { id?: string };
interface ReplyBlock {
  type?: string;
  text?: { type?: string; text?: string; [key: string]: unknown };
  elements?: ReplyBlock[];
  [key: string]: unknown;
}
interface SourceLike extends Partial<ProgramSource> {
  hidden?: boolean;
  siteUrl?: string;
}
interface StreamWriterOptions {
  client: SlackClient;
  channel: string;
  ensurePlaceholder: () => Promise<string | null>;
  threadTs?: string | null;
  silencedBefore?: { muted: boolean; takeover: boolean } | null;
}
interface SilenceState {
  muted: boolean;
  takeover: boolean;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sendProgramMessage(args: Record<string, unknown>) {
  return require("./slackMessages").sendProgramMessage(args);
}

const DASH_ANYWHERE = /\s*[\u2014\u2013]\s*|\s+--(?=\s)\s*/g;
const DASH_LINE_END = /\s*(?:[\u2014\u2013]|--)\s*$/gm;
const DASH_LINE_START = /^\s*(?:[\u2014\u2013]|--)\s*/gm;
const CODE_SPANS = /(```[\s\S]*?```|`[^`\n]*`)/g;

function dedash(part: string) {
  return part
    .replace(DASH_LINE_END, "")
    .replace(DASH_LINE_START, "")
    .replace(DASH_ANYWHERE, ", ")
    .replace(/,[\s,]*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?;:)\]])/g, "$1")
    .replace(/([(\[])\s*,\s*/g, "$1");
}

function plainDashes(text: string) {
  if (!text) return "";
  return String(text)
    .split(CODE_SPANS)
    .map((part, i) => (i % 2 === 1 ? part : dedash(part)))
    .join("");
}

function withReplySignature(text: string, program: ProgramLike | null) {
  const sig = program && typeof program.replySignature === "string" ? program.replySignature.trim() : "";
  if (!sig || !text || !String(text).trim()) return text;
  const body = String(text).replace(/\s+$/, "");
  if (body === sig || body.endsWith(`\n${sig}`)) return body;
  return `${body}\n\n${sig}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plainDashesInBlocks<T extends object>(blocks: T[]): T[];
function plainDashesInBlocks(blocks: unknown[]): unknown[];
function plainDashesInBlocks(blocks: unknown[]): unknown[] {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (!isRecord(block)) return block;
    const textObject = isRecord(block.text) ? block.text : null;
    const text = textObject && typeof textObject.text === "string" ? textObject.text : null;
    if (text) return { ...block, text: { ...textObject, text: plainDashes(text) } };
    if (Array.isArray(block.elements)) {
      return { ...block, elements: plainDashesInBlocks(block.elements) };
    }
    return block;
  });
}

function sourceLineFor(source: SourceLike | string, program: ProgramLike | string | null = null) {
  if (!source) return "";
  const sourceName = typeof source === "object" ? source.name : source;
  let isHidden = typeof source === "object" ? !!source.hidden : false;

  if (typeof sourceName !== "string") return "";

  if (
    sourceName.length > 40 ||
    sourceName.includes("?") ||
    sourceName.toLowerCase().startsWith("how to") ||
    sourceName.toLowerCase().startsWith("how do")
  ) {
    return "";
  }

  if (!isHidden) {
    try {
      const allSources = knowledge.loadSources();
      const matched = allSources.find(
        (s: SourceLike) => s && s.name && s.name.toLowerCase() === sourceName.toLowerCase(),
      );
      if (matched && matched.hidden) {
        isHidden = true;
      }
    } catch (error: unknown) {
      log.debug("reply", `source hidden check: ${errorMessage(error)}`);
    }
  }
  if (isHidden) return "";

  let url = knowledge.getSourceUrl(sourceName);
  if (program) {
    const record = typeof program === "string" ? require("./programs").get(program) : program;
    const owned = (record?.sources || []).find(
      (candidate: SourceLike) =>
        candidate?.name &&
        (candidate.name.toLowerCase() === sourceName.toLowerCase() ||
          knowledge.sourceContainsCitation(candidate, sourceName)),
    );
    if (!owned) return "";
    url = owned.siteUrl || knowledge.getSourceUrl(owned.name) || null;
  }
  if (url) {
    return `\n\n_source: <${url}|${sourceName}>_`;
  }
  return "";
}

function escapeSlack(text: string) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function blocksFor(text: string): ReplyBlock[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

function postThinking(client: SlackClient, channel: string, threadTs: string, program: ProgramLike | null = null) {
  return sendProgramMessage({ client, program, channel, threadTs, text: THINKING })
    .then((res: { ts?: string }) => {
      const ts = res.ts || null;
      if (ts) startThinkingSpinner(client, channel, ts);
      return ts;
    })
    .catch((error: unknown) => {
      log.debug("respond", `could not post placeholder: ${errorMessage(error)}`);
      return null;
    });
}

function stripReasoning(text: string) {
  if (!text) return "";
  let clean = String(text);

  clean = clean
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/^[\s\S]*?<\/(?:think|thinking|thought|scratchpad)>/gi, "")
    .replace(/<(?:think|thinking|thought|scratchpad)>[\s\S]*$/gi, "")
    .trim();

  while (true) {
    const next = clean
      .replace(
        /^(?:User\s+Safety|Safety\s+Assessment|Safety|Content\s+Filter|Safety\s+Category|Safety\s+Verdict):\s*[^\n]+\s*\n*/i,
        "",
      )
      .trim();
    if (next === clean) break;
    clean = next;
  }

  if (
    /^(?:Here(?:\x27s|\x20is) (?:a |the )?thinking process:?|\*\*Thinking Process:?\*\*|Thinking Process:?)/i.test(
      clean,
    )
  ) {
    const markers = [
      /\n(?:SOURCE|ANSWER|OUTPUT|FINAL ANSWER):\s*/i,
      /\n[•\*]\s*\*Asker:\*/i,
      /\n(?:[^\n:]+)\s*::\s*(?:[^\n]+)$/m,
    ];
    for (const marker of markers) {
      const match = clean.match(marker);
      if (match && match.index !== undefined) {
        clean = clean.slice(match.index + match[0].length).trim();
        break;
      }
    }
  }

  while (true) {
    const next = clean
      .replace(
        /^(?:(?:\*{1,2})?(?:Here(?:\x27s|\x20is) (?:a |the )?)?(?:thinking\s+process|scratchpad|reasoning|internal\s+notes)(?:\*{1,2})?:?\s*[^\n]*\n*)/i,
        "",
      )
      .trim();
    if (next === clean) break;
    clean = next;
  }

  return clean;
}

function stripReasoningInBlocks(blocks: ReplyBlock[]): ReplyBlock[] {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block?.text?.text) return { ...block, text: { ...block.text, text: stripReasoning(block.text.text) } };
    if (Array.isArray(block?.elements)) {
      return { ...block, elements: stripReasoningInBlocks(block.elements) };
    }
    return block;
  });
}

function makeStreamWriter({
  client,
  channel,
  ensurePlaceholder,
  threadTs = null,
  silencedBefore = null,
}: StreamWriterOptions) {
  let latest = "";
  let sent = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = 0;
  let inFlight = Promise.resolve();

  const flush = () => {
    timer = null;
    lastAt = Date.now();
    const cleanLatest = stripReasoning(latest);
    if (!cleanLatest || cleanLatest === sent) return;
    sent = cleanLatest;
    const text = sent;
    inFlight = inFlight
      .then(() => ensurePlaceholder())
      .then(async (ts) => {
        if (!ts) return null;
        await stopThinkingSpinner(channel, ts);
        if (threadTs && newlySilenced(threadTs, silencedBefore)) return null;
        return client.chat.update({ channel, ts, text: plainDashes(text) });
      })
      .catch((error: unknown) => log.debug("respond", `stream update failed: ${errorMessage(error)}`));
  };

  return {
    write(text: string) {
      latest = text;
      if (timer) return;
      timer = setTimeout(flush, Math.max(0, STREAM_UPDATE_MS - (Date.now() - lastAt)));
    },
    async settle() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
    },
  };
}

function silencedThread(threadTs: string | null) {
  if (!threadTs) return false;
  try {
    const db = require("./db");
    return db.isThreadMuted(threadTs) || db.isTakeover(threadTs);
  } catch (_error: unknown) {
    return false;
  }
}

function silenceState(threadTs: string | null): SilenceState {
  if (!threadTs) return { muted: false, takeover: false };
  try {
    const db = require("./db");
    return { muted: db.isThreadMuted(threadTs), takeover: db.isTakeover(threadTs) };
  } catch (_error: unknown) {
    return { muted: false, takeover: false };
  }
}

function newlySilenced(threadTs: string, before: SilenceState | null = null) {
  if (!before) return silencedThread(threadTs);
  const now = silenceState(threadTs);
  return (now.muted && !before.muted) || (now.takeover && !before.takeover);
}

function decidePostSuppression({
  program,
  threadTs,
  placeholderTs,
  silencedBefore = null,
}: {
  program?: ProgramLike | null;
  threadTs: string;
  placeholderTs: string | null;
  silencedBefore?: SilenceState | null;
}) {
  if (program && program.shadowMode === true) return "shadow";
  if (placeholderTs && newlySilenced(threadTs, silencedBefore)) return "silenced";
  return null;
}

async function finalize(
  client: SlackClient,
  channel: string,
  threadTs: string,
  placeholder: Promise<string | null>,
  text: string,
  {
    blocks = null,
    program = null,
    silencedBefore = null,
  }: { blocks?: ReplyBlock[] | null; program?: ProgramLike | null; silencedBefore?: SilenceState | null } = {},
) {
  const cleanText = stripReasoning(text);
  const cleanBlocks = blocks ? stripReasoningInBlocks(blocks) : null;
  const payload = {
    channel,
    text: plainDashes(cleanText),
    ...(cleanBlocks ? { blocks: plainDashesInBlocks(cleanBlocks) } : {}),
  };
  const placeholderTs = await placeholder;
  await stopThinkingSpinner(channel, placeholderTs);

  const suppressed = decidePostSuppression({ program, threadTs, placeholderTs, silencedBefore });
  if (suppressed) {
    await discardPlaceholder(client, channel, placeholderTs);
    return null;
  }

  if (placeholderTs) {
    try {
      await client.chat.update({ ...payload, ts: placeholderTs });
      return placeholderTs;
    } catch (error: unknown) {
      log.debug("respond", `update failed, posting fresh: ${errorMessage(error)}`);
      await discardPlaceholder(client, channel, placeholderTs);
    }
  }

  const res = await sendProgramMessage({
    client,
    program,
    channel,
    threadTs,
    text: payload.text,
    blocks: payload.blocks || null,
  });
  return res ? res.ts : null;
}

async function discardPlaceholder(
  client: SlackClient,
  channel: string,
  placeholder: string | Promise<string | null> | null,
) {
  try {
    const ts = await Promise.resolve(placeholder).catch(() => null);
    if (!ts) return;
    await stopThinkingSpinner(channel, ts);
    if (!client?.chat?.delete) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await client.chat.delete({ channel, ts });
        if (res && res.ok === false) {
          const errCode = res.error || "";
          if (
            errCode === "message_not_found" ||
            errCode === "channel_not_found" ||
            errCode === "cant_delete_message" ||
            errCode === "compliance_exports_prevent_deletion"
          ) {
            return;
          }
          throw new Error(errCode || "delete failed");
        }
        return;
      } catch (error: unknown) {
        const code = error instanceof Error ? error.message : String(error);
        if (
          code === "message_not_found" ||
          code === "channel_not_found" ||
          code === "cant_delete_message" ||
          code === "compliance_exports_prevent_deletion"
        ) {
          return;
        }
        if (attempt < 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    }
  } catch (_error: unknown) {}
}

async function flagForHumans(
  client: SlackClient,
  channel: string,
  messageTs: string,
  question = "",
  requesterId: string | null = null,
  workspaceId: string | null = null,
  placeholder: string | Promise<string | null> | null = null,
) {
  if (!programs.isHelpChannel(channel) || !messageTs) {
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
    return;
  }

  const prog = programs.forChannel(channel, workspaceId);
  if (prog && (prog.posture === "passive" || prog.shadowMode === true)) {
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
    if (prog.posture === "passive") return;
  }

  const reaction = config.escalateReaction;
  if (reaction && !(prog && prog.shadowMode === true)) {
    try {
      await client.reactions?.add?.({ channel, timestamp: messageTs, name: reaction });
    } catch (error: unknown) {
      log.debug("respond", `could not flag for humans: ${errorMessage(error)}`);
    }
  }

  try {
    const tickets = require("./tickets");
    await tickets.escalateTicket({
      program: prog,
      channel,
      threadTs: messageTs,
      requesterId: requesterId || "unknown",
      question: question || "Unanswered question in help channel",
      client,
      workspaceId,
      placeholder,
    });
  } catch (error: unknown) {
    log.debug("respond", `could not escalate ticket: ${errorMessage(error)}`);
    if (placeholder) await discardPlaceholder(client, channel, placeholder);
  }
}

async function seedFeedbackReactions(client: SlackClient, channel: string, messageTs: string) {
  if (!messageTs) return;
  const reactions = config.feedbackReactions || [];
  if (!client || !channel || !messageTs || reactions.length === 0) return;
  for (const name of reactions) {
    client.reactions.add({ channel, timestamp: messageTs, name }).catch((error: unknown) => {
      log.debug("respond", `could not seed reaction ${name}: ${errorMessage(error)}`);
    });
  }
}

export = {
  escapeSlack,
  plainDashes,
  plainDashesInBlocks,
  withReplySignature,
  sourceLineFor,
  blocksFor,
  postThinking,
  makeStreamWriter,
  finalize,
  discardPlaceholder,
  flagForHumans,
  seedFeedbackReactions,
  stripReasoning,
  stripReasoningInBlocks,
  decidePostSuppression,
  silenceState,
  THINKING,
  STREAMING_WORDS,
  STREAMING_WORD_INTERVAL_MS,
  STREAM_UPDATE_MS,
};
