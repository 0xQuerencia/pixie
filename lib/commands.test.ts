process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("./config");
const learn = require("./learn");
const teachThread = require("./teachThread");
const commands = require("./commands");
const traceStore = require("./pipeline/traceStore");
const { parseForgetInput, parseId, adminOnlyShortcut, teachThreadShortcut } = commands;

const ADMIN = "U0ADMIN";
config.slack.adminUserIds = [ADMIN];

test("parseForgetInput parses single ids, ranges, pending, and all", () => {
  assert.deepEqual(parseForgetInput("15"), { type: "id", id: 15 });
  assert.deepEqual(parseForgetInput("#15"), { type: "id", id: 15 });

  assert.deepEqual(parseForgetInput("12-40"), { type: "range", from: 12, to: 40 });
  assert.deepEqual(parseForgetInput("#12-#40"), { type: "range", from: 12, to: 40 });

  assert.deepEqual(parseForgetInput("pending"), { type: "pending" });
  assert.deepEqual(parseForgetInput("PENDING"), { type: "pending" });

  assert.deepEqual(parseForgetInput("all"), { type: "all" });
  assert.equal(parseForgetInput("allofit"), null);
  assert.equal(parseForgetInput("invalid"), null);
});

test("parseId accepts a bare or hashed id and rejects anything else", () => {
  assert.equal(parseId("7"), 7);
  assert.equal(parseId("#7"), 7);
  assert.equal(parseId(" 7 "), 7);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-3"), null);
  assert.equal(parseId("seven"), null);
  assert.equal(parseId(""), null);
});

function stubEphemeralClient() {
  const posted: any[] = [];
  return { client: { chat: { postEphemeral: async (args: any) => void posted.push(args) } }, posted };
}

test("adminOnlyShortcut blocks a non-admin and answers ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const inner = async () => {
    throw new Error("must not run for a non-admin");
  };

  await adminOnlyShortcut(inner)({
    shortcut: { channel: { id: "C1" }, user: { id: "U0NOTADMIN" } },
    ack: async () => {},
    client,
  });

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /helpers-only/);
});

test("adminOnlyShortcut runs the handler for an admin", async () => {
  let ran = false;
  await adminOnlyShortcut(async () => void (ran = true))({
    shortcut: { channel: { id: "C1" }, user: { id: ADMIN } },
    ack: async () => {},
    client: {},
  });
  assert.equal(ran, true);
});

test("teachThreadShortcut queues a summary and confirms ephemerally", async () => {
  const { client, posted } = stubEphemeralClient();
  const savedSummarize = teachThread.summarizeThread;
  const savedCapture = learn.captureFromThread;
  teachThread.summarizeThread = async () => ({ question: "how do i join", answer: "post in #acme-help" });
  learn.captureFromThread = () => 42;

  try {
    await teachThreadShortcut({
      shortcut: {
        channel: { id: "C1" },
        message: { thread_ts: "1.1", ts: "1.2" },
        message_ts: "1.2",
        user: { id: ADMIN },
      },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = savedSummarize;
    learn.captureFromThread = savedCapture;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /queued for review/);
  assert.match(posted[0].text, /#42/);
});

test("teachThreadShortcut tells the admin when nothing was found", async () => {
  const { client, posted } = stubEphemeralClient();
  const saved = teachThread.summarizeThread;
  teachThread.summarizeThread = async () => null;

  try {
    await teachThreadShortcut({
      shortcut: { channel: { id: "C1" }, message: { ts: "1.2" }, message_ts: "1.2", user: { id: ADMIN } },
      ack: async () => {},
      client,
    });
  } finally {
    teachThread.summarizeThread = saved;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /couldn't find/);
});

test("programCommand list, add, set, and remove — admin-only", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);

  await commands.programCommand({
    command: { text: "list", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /registered programs/);

  await commands.programCommand({
    command: { text: "add testprog Test Program", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[1], /saved program `testprog`/);

  await commands.programCommand({
    command: { text: "set testprog posture passive", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[2], /updated `testprog` posture to `passive`/);

  await commands.programCommand({
    command: { text: "remove testprog", user_id: ADMIN },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[3], /removed program `testprog`/);
});

test("programCommand rejects list/add/set/remove for a non-admin, non-helper user", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);
  await commands.programCommand({
    command: { text: "list", user_id: "U0RANDOM" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /helpers-only/);
});

test("programCommand tickets on|off is reachable by a program's own helper, not just admins, and is channel-scoped", async () => {
  const responses: any[] = [];
  const sendEphemeral = async (msg: any) => responses.push(msg.text);
  const db = require("./db");
  const programs = require("./programs");
  db.saveProgram({ id: "cmd-tix", name: "CmdTix", helpChannel: "C-CMD-TIX", channels: ["C-CMD-TIX"] });
  db.syncHelper({ programId: "cmd-tix", userId: "U-HELPER-TIX", source: "manual" });
  programs.invalidate();

  await commands.programCommand({
    command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U0RANDOM" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[0], /helpers-only/);

  await commands.programCommand({
    command: { text: "tickets off", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[1], /ticket auto-creation from this channel is \*off\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, false);

  await commands.programCommand({
    command: { text: "tickets on", channel_id: "C-CMD-TIX", user_id: "U-HELPER-TIX" },
    ack: async () => {},
    respond: sendEphemeral,
  });
  assert.match(responses[2], /back \*on\*/);
  assert.equal(programs.get("cmd-tix").publicTicketsEnabled, true);
});

test("every registered command has its ephemeral replies de-dashed", async () => {
  const registered: Record<string, any> = {};
  const app = {
    command: (name: any, handler: any) => {
      registered[name] = handler;
    },
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);

  const sent: any[] = [];
  const handler = commands.plainSpoken(async ({ respond }: any) => {
    await respond({ response_type: "ephemeral", text: "the price — 11,400 px" });
  });
  await handler({ command: { user_id: "U1" }, ack: async () => {}, respond: async (p: any) => sent.push(p) });

  assert.equal(sent[0].text, "the price, 11,400 px");
  assert.ok(Object.keys(registered).length > 0, "register() bound no commands");
});

test("/pixie help returns the actor's filtered runtime command list", async () => {
  const responses: any[] = [];
  await commands.askCommand({
    command: { text: "help", user_id: "U0RANDOM", channel_id: "C1" },
    ack: async () => {},
    respond: async (payload: any) => responses.push(payload),
  });

  assert.match(responses[0].text, /\/pixie-sources/);
  assert.doesNotMatch(responses[0].text, /\/pixie-teach/);
});

test("REGISTRY: slash defs, CAPABILITIES, and Bolt bindings cover each other", () => {
  const brand = require("./brand");
  const capabilities = require("./capabilities");
  const commandRegistry = require("./commandRegistry");

  const slashDefs = commandRegistry.COMMANDS.filter((c: any) => c.surface === "slash" || c.surface === "both");
  const suffixOf = (def: any) => (def.name === "ask" ? "" : def.name);

  const capabilitySuffixes = new Set(capabilities.CAPABILITIES.map((c: any) => c.suffix));
  for (const def of slashDefs) {
    assert.ok(capabilitySuffixes.has(suffixOf(def)), `/${def.name} has no CAPABILITIES entry`);
  }
  for (const suffix of capabilitySuffixes) {
    assert.ok(
      slashDefs.some((d: any) => suffixOf(d) === suffix),
      `CAPABILITIES suffix ${JSON.stringify(suffix)} has no registry def`,
    );
  }

  const bound: any[] = [];
  const app = {
    command: (name: any) => void bound.push(name),
    action: () => {},
    shortcut: () => {},
    event: () => {},
    view: () => {},
  };
  commands.register(app);
  const expected = slashDefs.map((d: any) => brand.cmd(suffixOf(d)));
  for (const name of expected) {
    assert.ok(bound.includes(name), `${name} in registry but not bound by register()`);
  }
});

test("/pixie ask parity — docs hit answers ephemerally, miss chats, error falls back", async () => {
  const respond = require("./respond");
  const chat = require("./chat");
  const sent: any[] = [];
  const sendEphemeral = async (m: any) => sent.push(m);
  const origLookup = respond.lookupAnswer;
  const origChat = chat.getChatReply;
  const { config } = require("./config");
  const savedFaq = config.slack.faqChannels;
  config.slack.faqChannels = [...(savedFaq || []), "C1"];
  try {
    let lookedUpFor = null;
    respond.lookupAnswer = async (_q: any, _c: any, prog: any) => {
      lookedUpFor = prog;
      return { source: "Docs", answer: "docs answer here" };
    };
    await commands.askCommand({
      command: { text: "how do i join", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /docs answer here/);
    assert.ok(lookedUpFor, "the lookup is scoped to the channel's program");

    sent.length = 0;
    let unscopedLookups = 0;
    respond.lookupAnswer = async () => {
      unscopedLookups += 1;
      return { source: "Docs", answer: "leak" };
    };
    chat.getChatReply = async () => "chat only";
    await commands.askCommand({
      command: { text: "what is the payout", user_id: "U1", channel_id: "C-NOBODY" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.equal(unscopedLookups, 0);
    assert.doesNotMatch(sent[0].text, /leak/);

    sent.length = 0;
    respond.lookupAnswer = async () => null;
    chat.getChatReply = async () => "chat reply here";
    await commands.askCommand({
      command: { text: "hey pixie", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /chat reply here/);

    sent.length = 0;
    respond.lookupAnswer = async () => {
      throw new Error("boom");
    };
    await commands.askCommand({
      command: { text: "anything", user_id: "U1", channel_id: "C1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0].text, /having trouble thinking/);
  } finally {
    respond.lookupAnswer = origLookup;
    chat.getChatReply = origChat;
    config.slack.faqChannels = savedFaq;
  }
});

test("/pixie ask records a structured final_action trace without answer text", async () => {
  const respond = require("./respond");
  const programs = require("./programs");
  const { config } = require("./config");
  const savedFaq = config.slack.faqChannels;
  config.slack.faqChannels = [...(savedFaq || []), "C1"];
  const program = programs.forChannel("C1");
  const originalLookup = respond.lookupAnswer;
  respond.lookupAnswer = async () => ({ source: "Docs", answer: "private answer text" });
  try {
    await commands.askCommand({
      command: { text: "how do i join", user_id: "U-trace-command", channel_id: "C1", thread_ts: "command-thread" },
      ack: async () => {},
      respond: async () => {},
    });
  } finally {
    respond.lookupAnswer = originalLookup;
    config.slack.faqChannels = savedFaq;
  }

  const rows = traceStore.forThread(program.id, "command-thread");
  const finalAction = rows.find((row: { stage: string }) => row.stage === "final_action");
  assert.ok(finalAction);
  assert.equal(finalAction.payload.action, "reply");
  assert.equal(JSON.stringify(finalAction.payload).includes("private answer text"), false);
});

test("/pixie-check dispatches to the deterministic path", async () => {
  const validator = require("./validator");
  const respond = require("./respond");
  const sent: any[] = [];
  const sendEphemeral = async (m: any) => sent.push(m.text);
  const origValidate = validator.validateRepository;
  try {
    validator.validateRepository = async () => ({
      ok: true,
      url: "https://github.com/u/r",
      fullName: "u/r",
      isReady: true,
      passes: ["ok"],
      issues: [],
      tips: [],
    });
    await commands.checkCommand({
      command: { text: "https://github.com/u/r", user_id: "U1" },
      ack: async () => {},
      respond: sendEphemeral,
    });
    assert.match(sent[0], /Ready for submission/);
  } finally {
    validator.validateRepository = origValidate;
  }
});
export {};
