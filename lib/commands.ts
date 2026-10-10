import knowledge = require("./knowledge");
import answer = require("./answer");
import respond = require("./respond");
import reply = require("./reply");
import context = require("./context");
import learn = require("./learn");
import teachThread = require("./teachThread");
import home = require("./home");
import report = require("./report");
import db = require("./db");
import log = require("./log");
import brand = require("./brand");
import capabilities = require("./capabilities");
import configModule = require("./config");
import stats = require("./stats");
import traceStore = require("./pipeline/traceStore");
import type { Program, SlackClient } from "./types";
import type { LearnedRow } from "./db.types";

const { config, isAdmin } = configModule;
const { relativeTime, statsText } = stats;
interface SlashCommand {
  text?: string;
  user_id?: string;
  channel_id?: string;
  team_id?: string;
  thread_ts?: string;
  trigger_id?: string;
}
interface ResponsePayload {
  response_type?: string;
  text?: string;
  blocks?: unknown[];
  [key: string]: unknown;
}
type Ack = () => Promise<unknown>;
type Respond = (payload: ResponsePayload | string) => Promise<unknown>;
interface CommandArgs {
  command: SlashCommand;
  ack: Ack;
  respond: Respond;
  client?: SlackClient;
}
interface ShortcutArgs {
  shortcut: {
    channel: { id: string };
    user: { id: string };
    message: { thread_ts?: string };
    message_ts: string;
  };
  ack: Ack;
  client: SlackClient;
}
interface ActionArgs {
  action: { value?: string };
  body: { channel?: { id?: string }; message?: { ts?: string; thread_ts?: string }; user?: { id?: string } };
  ack: Ack;
  client: SlackClient;
}
interface AppLike {
  command(name: string, handler: unknown): void;
  action(name: string | RegExp, handler: unknown): void;
  shortcut(name: string, handler: unknown): void;
  event(name: string, handler: unknown): void;
}
interface ForgetAll {
  type: "all";
}
interface ForgetPending {
  type: "pending";
}
interface ForgetRange {
  type: "range";
  from: number;
  to: number;
}
interface ForgetId {
  type: "id";
  id: number;
}
type ForgetInput = ForgetAll | ForgetPending | ForgetRange | ForgetId;
const formatHelp = (args: { actorId?: string | null; program?: Program | null }): string =>
  (capabilities.formatHelp as (input: { actorId?: string | null; program?: Program | null }) => string)(args);
const lookupAnswer = (
  question: string,
  context: string,
  program: Program | null,
  channel?: string | null,
): Promise<{ answer: string; source?: string } | null> =>
  (
    respond.lookupAnswer as (
      q: string,
      c: string,
      p: Program | null,
      ch?: string | null,
    ) => Promise<{ answer: string; source?: string } | null>
  )(question, context, program, channel);
const recordGap = (
  question: string,
  userId?: string | null,
  channel?: string | null,
  messageTs?: string | null,
  programId?: string | null,
): unknown =>
  (db.recordGap as (q: string, u?: string | null, c?: string | null, ts?: string | null, p?: string | null) => unknown)(
    question,
    userId,
    channel,
    messageTs,
    programId,
  );
const topGaps = (
  limit?: number,
  sinceMs?: number,
  options?: { kind?: string },
): Array<{ ask_count: number; question: string }> =>
  (
    db.topGaps as (
      n?: number,
      since?: number,
      opts?: { kind?: string },
    ) => Array<{ ask_count: number; question: string }>
  )(limit, sinceMs, options);
const teach = (input: {
  question: string;
  answer: string;
  authorId: string;
  threadTs?: string | null;
  channel?: string | null;
  programId?: string | null;
}): number | null =>
  (
    learn.teach as (value: {
      question: string;
      answer: string;
      authorId: string;
      threadTs?: string | null;
      channel?: string | null;
      programId?: string | null;
    }) => number | null
  )(input);
const addToThread = (
  threadTs: string,
  role: string,
  content: string,
  userId?: string | null,
  channel?: string | null,
): unknown =>
  (context.addToThread as (ts: string, r: string, text: string, u?: string | null, c?: string | null) => unknown)(
    threadTs,
    role,
    content,
    userId,
    channel,
  );

function errorMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

const GAP_LIMIT = 15;
const PENDING_LIMIT = 15;
const NOT_ALLOWED = "that one's helpers-only :ban:";

function adminOnly(handler: (args: CommandArgs) => Promise<unknown>) {
  return async (args: CommandArgs): Promise<void> => {
    if (!isAdmin(args.command?.user_id)) {
      await args.ack();
      await args.respond({ response_type: "ephemeral", text: NOT_ALLOWED });
      return;
    }
    await handler(args);
  };
}

function plainSpoken(handler: (args: CommandArgs) => Promise<unknown>) {
  // Bolt respond
  return async (args: CommandArgs): Promise<unknown> => {
    const original = args.respond;
    const respond =
      typeof original === "function"
        ? async (payload: ResponsePayload | string) => {
            if (payload && typeof payload === "object") {
              return original({
                ...payload,
                ...(payload.text ? { text: reply.plainDashes(payload.text) } : {}),
                ...(payload.blocks ? { blocks: reply.plainDashesInBlocks(payload.blocks) } : {}),
              });
            }
            return original(typeof payload === "string" ? reply.plainDashes(payload) : payload);
          }
        : original;
    return handler({ ...args, respond });
  };
}

function adminOnlyShortcut(handler: (args: ShortcutArgs) => Promise<unknown>) {
  return async (args: ShortcutArgs): Promise<unknown> => {
    if (!isAdmin(args.shortcut?.user?.id)) {
      await args.ack();
      await args.client.chat.postEphemeral({
        channel: args.shortcut.channel.id,
        user: args.shortcut.user.id,
        text: NOT_ALLOWED,
      });
      return;
    }
    await handler(args);
  };
}

async function reportCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const weeksAgo = (command.text || "").trim().toLowerCase() === "last" ? 1 : 0;
  await sendEphemeral({ response_type: "ephemeral", text: report.reportText(weeksAgo) });
}

async function askCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const question = (command.text || "").trim();
  if (/^help(?:\s|$)/i.test(question)) {
    const program = programs.forChannel(command.channel_id as string);
    await sendEphemeral({
      response_type: "ephemeral",
      text: formatHelp({ actorId: command.user_id as string, program }),
    });
    return;
  }
  if (!question) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: `ask me something! e.g. \`${brand.cmd()} how do i unlock the next region\``,
    });
    return;
  }

  const askPolicy = require("./channelPolicy").resolve(command.channel_id, command.team_id || null);
  const askProgram = askPolicy.role === "none" ? null : askPolicy.program;
  const traceRequestId = `command:${command.user_id || "unknown"}:${Date.now()}`;
  const appendCommandFinalAction = (action: string, reason: string) => {
    if (!askProgram?.id) return;
    try {
      traceStore.append({
        programId: askProgram.id,
        threadTs: command.thread_ts || null,
        requestId: traceRequestId,
        stage: "final_action",
        payload: { action, reason },
      });
    } catch (error: unknown) {
      log.debug("commands", `answer trace write failed: ${errorMessage(error)}`);
    }
  };
  try {
    const result = askProgram ? await lookupAnswer(question, "", askProgram, command.channel_id as string) : null;
    if (result) {
      appendCommandFinalAction("reply", "command_answer");
      await sendEphemeral({
        response_type: "ephemeral",
        text: `${result.answer}${respond.sourceLineFor(result.source, askProgram)}`,
      });
      db.recordMetric("answer_docs");
      return;
    }

    if (askProgram) recordGap(question, command.user_id as string, command.channel_id as string, null, askProgram.id);
    const { getChatReply } = require("./chat");
    const chatReply = await getChatReply(question, "", command.channel_id === config.slack.helpChannel);
    appendCommandFinalAction(chatReply ? "reply_chat" : "fallback", "command_answer");
    await sendEphemeral({ response_type: "ephemeral", text: chatReply || respond.MENTION_FALLBACK });
    db.recordMetric(chatReply ? "answer_chat" : "fallback");
  } catch (e: unknown) {
    log.error("commands", `${brand.cmd()} failed:`, errorMessage(e));
    appendCommandFinalAction("error_reply", "command_error");
    await sendEphemeral({ response_type: "ephemeral", text: respond.ERROR_FALLBACK });
  }
}

const validator = require("./validator");

async function checkCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();
  const input = (command.text || "").trim();
  if (!input) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: `Provide a public GitHub repo URL to check, e.g. \`${brand.cmd("check")} https://github.com/user/cool-game\``,
    });
    return;
  }

  try {
    const report = await validator.validateRepository(input);
    const replyText = validator.formatValidationReport(report);
    await sendEphemeral({ response_type: "ephemeral", text: replyText });
    db.recordMetric("command_check");
  } catch (e: unknown) {
    log.error("commands", `${brand.cmd("check")} failed:`, errorMessage(e));
    await sendEphemeral({ response_type: "ephemeral", text: `Could not inspect repository: ${errorMessage(e)}` });
  }
}

async function sourcesCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  let sources = [];
  try {
    const srcPolicy = require("./channelPolicy").resolve(command?.channel_id, command?.team_id || null);
    const prog = srcPolicy.role === "none" ? null : srcPolicy.program;
    sources = prog
      ? [...(prog.sources || []), ...(prog.sharedSources ? require("./programs").shared().sources || [] : [])]
      : [];
  } catch (e: unknown) {
    await sendEphemeral({ response_type: "ephemeral", text: `couldn't read sources.json: ${errorMessage(e)}` });
    return;
  }

  const lines = sources.map((s) => `• *${s.name}* — \`${s.type}\``);
  const built = knowledge.lastBuiltAt;
  await sendEphemeral({
    response_type: "ephemeral",
    text: [
      `*what i know* (${sources.length} source${sources.length === 1 ? "" : "s"})`,
      ...lines,
      "",
      `_last refreshed ${relativeTime(built?.getTime())}, auto-refresh every ${config.refreshIntervalMin}m_`,
    ].join("\n"),
  });
}

async function reloadCommand({ ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();
  try {
    await knowledge.refreshCorpus(true);
    (db as typeof db & { clearCache: () => void }).clearCache();
    await sendEphemeral({
      response_type: "ephemeral",
      text: "refreshed the docs and cleared the answer cache :yesyes:",
    });
  } catch (e: unknown) {
    await sendEphemeral({ response_type: "ephemeral", text: `refresh failed: ${errorMessage(e)}` });
  }
}

async function gapsCommand({ ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const gaps = topGaps(GAP_LIMIT, undefined, { kind: report.DOCS });
  if (gaps.length === 0) {
    await sendEphemeral({ response_type: "ephemeral", text: "no unanswered questions logged yet :yay:" });
    return;
  }

  const lines = gaps.map(
    (g: { ask_count: number; question: string }, i: number) =>
      `${i + 1}. *${g.ask_count}×* — ${g.question.slice(0, 160)}`,
  );
  await sendEphemeral({
    response_type: "ephemeral",
    text: ["*questions the docs didn't cover* (last 30d)", ...lines, "", "_worth adding these to the docs_"].join("\n"),
  });
}

async function statsCommand({ ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();
  await sendEphemeral({ response_type: "ephemeral", text: statsText() });
}

async function teachCommand({ command, ack, respond: sendEphemeral, client }: CommandArgs): Promise<void> {
  await ack();

  const text = (command.text || "").trim();
  const teachPolicy = require("./channelPolicy").resolve(command.channel_id as string, command.team_id || null);
  if (teachPolicy.role !== "main" && teachPolicy.role !== "help") {
    await sendEphemeral({
      response_type: "ephemeral",
      text: "run this in one of the program's channels so i know which program it's for :ban:",
    });
    return;
  }
  const teachProgramId = teachPolicy.program.id;
  const parsed = learn.parseTeach(text);
  if (parsed) {
    const id = teach({
      ...parsed,
      authorId: command.user_id as string,
      channel: command.channel_id as string,
      programId: teachProgramId,
    });
    await sendEphemeral({
      response_type: "ephemeral",
      text: id
        ? `got it, i'll use that from now on :yesyes:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — remove it with \`/pixie-forget ${id}\`_`
        : "couldn't save that one, try again",
    });
    return;
  }

  let threadTs = command.thread_ts;
  const channel = command.channel_id as string;
  const user = command.user_id as string;

  if (!threadTs && client && client.conversations && client.conversations.history) {
    try {
      const history = await client.conversations.history({ channel, limit: 10 });
      const recentWithThread = (history.messages || []).find(
        (m: { thread_ts?: string; reply_count?: number; ts?: string }) =>
          m.thread_ts || (m.reply_count && m.reply_count > 0),
      );
      if (recentWithThread) {
        threadTs = recentWithThread.thread_ts || recentWithThread.ts;
      }
    } catch (e: unknown) {
      log.debug("commands", `could not inspect channel history for thread: ${errorMessage(e)}`);
    }
  }

  if (threadTs && client) {
    try {
      const threadResult = await teachThread.summarizeThread({ client, channel, threadTs });
      if (threadResult) {
        const id = teach({ ...threadResult, authorId: user, threadTs, channel, programId: teachProgramId });
        await sendEphemeral({
          response_type: "ephemeral",
          text: id
            ? `🧚 Summarized and added this thread to active memory! :yesyes:\n>*Q:* ${threadResult.question}\n>*A:* ${threadResult.answer}\n\n_#${id} — remove with \`/pixie-forget ${id}\`_`
            : "already memorized this thread or couldn't save it",
        });
        return;
      }
    } catch (e: unknown) {
      log.error("commands", "teach thread failed:", errorMessage(e));
    }
  }

  await sendEphemeral({
    response_type: "ephemeral",
    text: `use \`${brand.cmd("teach")} <question> ${learn.TEACH_SEPARATOR} <answer>\` or run \`${brand.cmd("teach")}\` inside a thread to memorize the thread!`,
  });
}

async function teachThreadShortcut({ shortcut, ack, client }: ShortcutArgs): Promise<void> {
  await ack();

  const channel = shortcut.channel.id;
  const threadTs = shortcut.message.thread_ts || shortcut.message_ts;
  const user = shortcut.user.id;
  const workspaceId = require("./workspace").workspaceOf({}, shortcut);
  const prog = require("./programs").forChannel(channel, workspaceId);

  try {
    const parsed = await teachThread.summarizeThread({ client, channel, threadTs });
    if (!parsed) {
      await client.chat.postEphemeral({
        channel,
        user,
        text: "couldn't find a clear question and answer in that thread",
      });
      return;
    }

    const id = learn.captureFromThread({ ...parsed, authorId: user, threadTs, channel, programId: prog.id });
    await client.chat.postEphemeral({
      channel,
      user,
      text: id
        ? `queued for review :thonk:\n>*Q:* ${parsed.question}\n>*A:* ${parsed.answer}\n\n_#${id} — approve with \`/pixie-approve ${id}\`, or \`/pixie-forget ${id}\` to drop it_`
        : `already queued this thread, or couldn't save it — check \`${brand.cmd("pending")}\``,
    });
  } catch (e: unknown) {
    log.error("commands", "teach-thread shortcut failed:", errorMessage(e));
    await client.chat.postEphemeral({ channel, user, text: respond.ERROR_FALLBACK });
  }
}

async function pendingCommand({ ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const rows = learn.pending(PENDING_LIMIT);
  if (rows.length === 0) {
    await sendEphemeral({ response_type: "ephemeral", text: "nothing waiting for review :yay:" });
    return;
  }

  const lines = rows.map(
    (r: LearnedRow) =>
      `*#${r.id}* — asked: _${r.question.slice(0, 100)}_\n` +
      `> ${r.answer.slice(0, 240)}\n` +
      `> _from <@${r.author_id}>, ${relativeTime(Number(r.created_at))}_`,
  );

  await sendEphemeral({
    response_type: "ephemeral",
    text: [
      "*answers waiting for review*",
      ...lines,
      "",
      `_\`${brand.cmd("approve")} <n>\` to start using one, \`${brand.cmd("forget")} <n>\` to drop it_`,
    ].join("\n"),
  });
}

function parseId(text: string): number | null {
  const id = Number((text || "").trim().replace(/^#/, ""));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseForgetInput(text: string): ForgetInput | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  if (raw === "all") return { type: "all" };
  if (raw.toLowerCase() === "pending") return { type: "pending" };

  const rangeMatch = raw.match(/^#?(\d+)\s*-\s*#?(\d+)$/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10);
    const to = parseInt(rangeMatch[2], 10);
    if (from > 0 && to >= from) {
      return { type: "range", from, to };
    }
  }

  const id = parseId(raw);
  if (id) return { type: "id", id };

  return null;
}

async function approveCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const id = parseId(command.text || "");
  if (!id) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: `use \`${brand.cmd("approve")} <n>\` — get the number from \`${brand.cmd("pending")}\``,
    });
    return;
  }

  await sendEphemeral({
    response_type: "ephemeral",
    text: learn.approve(id) ? `approved #${id} — i'll use it from now on :yesyes:` : `couldn't find #${id}`,
  });
}

async function forgetCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();

  const parsed = parseForgetInput(command.text || "");
  if (!parsed) {
    await sendEphemeral({
      response_type: "ephemeral",
      text: `use \`${brand.cmd("forget")} <n>\`, \`${brand.cmd("forget")} <from>-<to>\`, \`${brand.cmd("forget")} pending\`, or \`${brand.cmd("forget")} all\``,
    });
    return;
  }

  if (parsed.type === "all") {
    const count = learn.forgetByStatus("all");
    await sendEphemeral({
      response_type: "ephemeral",
      text: count > 0 ? `forgot all ${count} learned fact${count === 1 ? "" : "s"}` : "no learned facts to forget",
    });
    return;
  }

  if (parsed.type === "pending") {
    const count = learn.forgetByStatus("pending");
    await sendEphemeral({
      response_type: "ephemeral",
      text: count > 0 ? `forgot ${count} pending fact${count === 1 ? "" : "s"}` : "no pending facts to forget",
    });
    return;
  }

  if (parsed.type === "range") {
    const count = learn.forgetRange(parsed.from, parsed.to);
    await sendEphemeral({
      response_type: "ephemeral",
      text:
        count > 0
          ? `forgot ${count} fact${count === 1 ? "" : "s"} (#${parsed.from}-#${parsed.to})`
          : `no facts found in range #${parsed.from}-#${parsed.to}`,
    });
    return;
  }

  if (parsed.type === "id") {
    await sendEphemeral({
      response_type: "ephemeral",
      text: learn.forget(parsed.id) ? `forgot #${parsed.id}` : `couldn't find #${parsed.id}`,
    });
  }
}

function welcomeText() {
  const prog = programs.all()[0] || null;
  const links = prog?.links || {};
  const help = prog?.helpChannel ? `<#${prog.helpChannel}>` : "the help channel";
  return [
    `hey! welcome to ${prog?.name || "this program"} :yay:`,
    "",
    `i'm ${brand.name()} — a helper bot for configured programs. you can:`,
    "• ping me in any channel",
    "• DM me right here",
    `• use \`${brand.cmd()} <question>\` for a private answer`,
    "",
    "quick links:",
    ...(links.site ? [`• site: ${links.site}`] : []),
    ...(links.docs ? [`• docs: ${links.docs}`] : []),
    "",
    `stuck on something a helper should see? post in ${help} :oke:`,
  ].join("\n");
}

async function onMemberJoined(): Promise<void> {}

const programs = require("./programs") as {
  forChannel: (channelId: string | null | undefined, workspaceId?: string | null) => Program;
  all: () => Program[];
  get: (id: string) => Program | null;
  shared: () => Program;
  saveProgram: (program: Partial<Program> & { id: string; name: string }) => unknown;
  removeProgram: (id: string) => unknown;
};

async function programCommand({ command, ack, respond: sendEphemeral }: CommandArgs): Promise<void> {
  await ack();
  const raw = (command.text || "").trim();
  const parts = raw.split(/\s+/);
  const sub = (parts[0] || "").toLowerCase();

  if (sub === "tickets") {
    const prog = programs.forChannel(command.channel_id, command.team_id);
    if (!prog || prog.id === programs.shared().id) {
      await sendEphemeral({
        response_type: "ephemeral",
        text: "run this in a program's help channel — no program is claimed here.",
      });
      return;
    }
    const actorId = command.user_id;
    if (!(isAdmin(actorId) || db.isHelper(prog.id, actorId))) {
      await sendEphemeral({ response_type: "ephemeral", text: NOT_ALLOWED });
      return;
    }
    const val = (parts[1] || "").toLowerCase();
    if (val !== "on" && val !== "off") {
      await sendEphemeral({
        response_type: "ephemeral",
        text: `usage: \`${brand.cmd("program")} tickets on|off\` — toggles auto-opened tickets from this help channel specifically.`,
      });
      return;
    }
    programs.saveProgram({ ...prog, publicTicketsEnabled: val === "on" });
    try {
      require("./audit").record({
        programId: prog.id,
        actorId,
        action: "program.public_tickets_toggled",
        metadata: { value: val },
      });
    } catch (_) {}
    await sendEphemeral({
      response_type: "ephemeral",
      text:
        val === "on"
          ? `ticket auto-creation from this channel is back *on* :yesyes:`
          : `ticket auto-creation from this channel is *off* — Pixie will still answer, just won't open tickets here until this is turned back on.`,
    });
    return;
  }

  if (!isAdmin(command.user_id)) {
    await sendEphemeral({ response_type: "ephemeral", text: NOT_ALLOWED });
    return;
  }

  if (!raw || sub === "list") {
    const allProgs = programs.all();
    const lines = allProgs.map(
      (p: Program) =>
        `• *${p.id}* (${p.name}): posture=\`${p.posture || "active"}\`, scope=\`${p.scope || "any"}\`, help_channel=\`${p.helpChannel || "none"}\`, channels=[\`${(p.channels || []).join("`, `")}\`]`,
    );
    await sendEphemeral({
      response_type: "ephemeral",
      text: [`*registered programs* (${allProgs.length})`, ...lines].join("\n"),
    });
    return;
  }

  if (sub === "add") {
    const jsonText = raw.slice(parts[0].length).trim();
    try {
      let progObj = null;
      if (jsonText.startsWith("{")) {
        progObj = JSON.parse(jsonText);
      } else {
        const id = parts[1];
        const name = parts.slice(2).join(" ");
        if (!id || !name) {
          await sendEphemeral({
            response_type: "ephemeral",
            text: `usage: \`${brand.cmd("program")} add <id> <name>\` or \`${brand.cmd("program")} add <json>\``,
          });
          return;
        }
        progObj = { id, name, posture: "active" };
      }
      programs.saveProgram(progObj);
      await sendEphemeral({ response_type: "ephemeral", text: `saved program \`${progObj.id}\` :yesyes:` });
    } catch (e: unknown) {
      await sendEphemeral({ response_type: "ephemeral", text: `could not add program: ${errorMessage(e)}` });
    }
    return;
  }

  if (sub === "set") {
    const id = parts[1];
    const field = parts[2]?.toLowerCase();
    const val = parts[3]?.toLowerCase();
    const allowed: Record<string, string[]> = { posture: ["active", "passive"], scope: ["any", "program"] };
    const choices = Object.prototype.hasOwnProperty.call(allowed, field) ? allowed[field] : null;
    if (!id || !choices || !choices.includes(val)) {
      await sendEphemeral({
        response_type: "ephemeral",
        text: [
          `usage: \`${brand.cmd("program")} set <id> posture active|passive\``,
          `       \`${brand.cmd("program")} set <id> scope any|program\``,
          "",
          "• `scope any` — answers anything someone's stuck on (default)",
          `• \`scope program\` — only answers questions about that program. anything else asked in the channel is left to the humans, unless someone pings ${brand.name()} directly.`,
        ].join("\n"),
      });
      return;
    }
    const existing = programs.get(id);
    if (!existing) {
      await sendEphemeral({ response_type: "ephemeral", text: `program \`${id}\` not found` });
      return;
    }
    const updated = { ...existing, [field]: val };
    programs.saveProgram(updated);
    await sendEphemeral({
      response_type: "ephemeral",
      text: `updated \`${id}\` ${field} to \`${val}\` :yesyes:`,
    });
    return;
  }

  if (sub === "remove" || sub === "delete") {
    const id = parts[1];
    if (!id) {
      await sendEphemeral({ response_type: "ephemeral", text: `usage: \`${brand.cmd("program")} remove <id>\`` });
      return;
    }
    programs.removeProgram(id);
    await sendEphemeral({ response_type: "ephemeral", text: `removed program \`${id}\` :yesyes:` });
    return;
  }

  await sendEphemeral({
    response_type: "ephemeral",
    text: "unknown subcommand. use `list`, `add`, `set`, or `remove`",
  });
}

const tickets = require("./tickets");

function register(app: AppLike): void {
  const cmd = brand.cmd;

  app.command(cmd(), plainSpoken(askCommand));
  app.command(cmd("sources"), plainSpoken(sourcesCommand));
  app.command(cmd("stats"), plainSpoken(statsCommand));
  app.command(cmd("check"), plainSpoken(checkCommand));

  app.command(cmd("report"), plainSpoken(adminOnly(reportCommand)));
  app.command(cmd("reload"), plainSpoken(adminOnly(reloadCommand)));
  app.command(cmd("gaps"), plainSpoken(adminOnly(gapsCommand)));
  app.command(cmd("teach"), plainSpoken(adminOnly(teachCommand)));
  app.command(cmd("pending"), plainSpoken(adminOnly(pendingCommand)));
  app.command(cmd("approve"), plainSpoken(adminOnly(approveCommand)));
  app.command(cmd("forget"), plainSpoken(adminOnly(forgetCommand)));
  app.command(cmd("program"), plainSpoken(programCommand));

  tickets.registerActions(app);

  app.action("sum_post_to_thread", async ({ action, body, ack, client }: ActionArgs) => {
    await ack();
    try {
      const data = JSON.parse(action.value || "{}");
      if (!data.threadTs || !data.channel || !data.summary) return;
      await client.chat.postMessage({
        channel: data.channel,
        thread_ts: data.threadTs,
        text: reply.plainDashes(`🧵 *Thread Summary* (shared by <@${body.user!.id}>):\n\n${data.summary}`),
      });
    } catch (e: unknown) {
      log.debug("commands", `sum_post_to_thread error: ${errorMessage(e)}`);
    }
  });

  app.shortcut(brand.id("teach_thread"), adminOnlyShortcut(teachThreadShortcut));

  app.event("member_joined_channel", onMemberJoined);

  home.register(app);
}

export = {
  register,
  adminOnly,
  adminOnlyShortcut,
  plainSpoken,
  askCommand,
  sourcesCommand,
  reloadCommand,
  gapsCommand,
  statsCommand,
  teachCommand,
  teachThreadShortcut,
  pendingCommand,
  approveCommand,
  forgetCommand,
  programCommand,
  checkCommand,
  helpCommand: askCommand,
  parseId,
  parseForgetInput,
  onMemberJoined,
  welcomeText,
  get WELCOME() {
    return welcomeText();
  },
};
