process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const macros = require("./macros");
const programs = require("./programs");
const { config } = require("./config");
const handlers = require("./handlers");
const reply = require("./reply");
const context = require("./context");
const respond = require("./respond");
const learn = require("./learn");
const vision = require("./vision");
const rateLimit = require("./rateLimit");
const teachThread = require("./teachThread");
const sumThread = require("./sumThread");
const intent = require("./intent");

db.open(":memory:");
config.slack.botUserId = "U0PIXIE";

test("mentionsPixieByName matches the name and its suffixes", () => {
  assert.equal(handlers.mentionsPixieByName("pixie help"), true);
  assert.equal(handlers.mentionsPixieByName("hey Pixie!"), true);
  assert.equal(handlers.mentionsPixieByName("pixies are cool"), true);
});

test("mentionsPixieByName ignores unrelated text", () => {
  assert.equal(handlers.mentionsPixieByName("acme is great"), false);
  assert.equal(handlers.mentionsPixieByName(""), false);
  assert.equal(handlers.mentionsPixieByName(undefined), false);
});

test("mentionsPixieByName follows the configured bot identity", () => {
  const savedName = process.env.PIXIE_BOT_NAME;
  const savedSlug = process.env.PIXIE_BOT_SLUG;
  process.env.PIXIE_BOT_NAME = "Live Helper";
  process.env.PIXIE_BOT_SLUG = "live-helper";
  try {
    assert.equal(handlers.mentionsPixieByName("live helper can you help?"), true);
    assert.equal(handlers.mentionsPixieByName("pixie can you help?"), false);
  } finally {
    if (savedName === undefined) delete process.env.PIXIE_BOT_NAME;
    else process.env.PIXIE_BOT_NAME = savedName;
    if (savedSlug === undefined) delete process.env.PIXIE_BOT_SLUG;
    else process.env.PIXIE_BOT_SLUG = savedSlug;
  }
});

test("mentionsPixieDirectly matches the resolved bot user id", () => {
  assert.equal(handlers.mentionsPixieDirectly("<@U0PIXIE> whats up"), true);
  assert.equal(handlers.mentionsPixieDirectly("<@U0SOMEONE> whats up"), false);
});

test("mentionsPixieDirectly is false when the bot id is unresolved", () => {
  const saved = config.slack.botUserId;
  config.slack.botUserId = null;
  try {
    assert.equal(handlers.mentionsPixieDirectly("<@undefined> hi"), false);
  } finally {
    config.slack.botUserId = saved;
  }
});

test("stripBotMention removes every ping and trims", () => {
  assert.equal(handlers.stripBotMention("<@U0PIXIE> how do i join <@U0PIXIE>"), "how do i join");
});

test("stripBotMention leaves other people's mentions intact", () => {
  assert.equal(handlers.stripBotMention("<@U0PIXIE> ask <@U0ALEX> about it"), "ask <@U0ALEX> about it");
});

test("shouldConsiderThreadReply allows all top-level messages", () => {
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "1.1", text: "hi" }), true);
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "1.1", thread_ts: "1.1", text: "hi" }), true);
});

test("shouldConsiderThreadReply skips threads pixie has not spoken in", () => {
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "lol same" }), false);
});

test("shouldConsiderThreadReply allows a thread reply that names or pings pixie", () => {
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "pixie help" }), true);
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "2.2", thread_ts: "1.1", text: "<@U0PIXIE> help" }), true);
});

test("shouldConsiderThreadReply allows a thread pixie already replied in", () => {
  context.addToThread("thread-spoken", "assistant", "here you go", null, "C1");
  assert.equal(handlers.shouldConsiderThreadReply({ ts: "3.3", thread_ts: "thread-spoken", text: "thanks" }), true);
});

test("shouldConsiderThreadReply skips unaddressed thread when PIXIE_THREAD_REQUIRE_MENTION is set", () => {
  const origEnv = process.env.PIXIE_THREAD_REQUIRE_MENTION;
  try {
    process.env.PIXIE_THREAD_REQUIRE_MENTION = "1";
    context.addToThread("thread-spoken-req", "assistant", "here you go", null, "C1");
    assert.equal(
      handlers.shouldConsiderThreadReply({ ts: "4.4", thread_ts: "thread-spoken-req", text: "asking another human" }),
      false,
    );
    assert.equal(
      handlers.shouldConsiderThreadReply({ ts: "4.4", thread_ts: "thread-spoken-req", text: "pixie help" }),
      true,
    );
  } finally {
    process.env.PIXIE_THREAD_REQUIRE_MENTION = origEnv;
  }
});

test("mentionsPixieByName supports PIXIE_BOT_ALIASES", () => {
  const origAliases = process.env.PIXIE_BOT_ALIASES;
  try {
    process.env.PIXIE_BOT_ALIASES = "seb,seba,sebastian";
    assert.equal(handlers.mentionsPixieByName("hey seb check this"), true);
    assert.equal(handlers.mentionsPixieByName("sebastian what is live"), true);
    assert.equal(handlers.mentionsPixieByName("hey bob check this"), false);
  } finally {
    process.env.PIXIE_BOT_ALIASES = origAliases;
  }
});

test("findImage picks the first image with a private URL", () => {
  assert.equal(handlers.findImage({}), null);
  assert.equal(handlers.findImage({ files: [] }), null);
  assert.equal(handlers.findImage({ files: [{ mimetype: "application/pdf", url_private: "u" }] }), null);

  const image = { mimetype: "image/png", url_private: "https://files.slack.com/x.png" };
  assert.equal(handlers.findImage({ files: [{ mimetype: "text/plain" }, image] }), image);
});

test("onAppMention analyses an attached image instead of replying blind", async () => {
  const savedRespond = respond.respond;
  const savedVision = vision.analyzeImage;
  const savedHelp = config.slack.helpChannel;
  const posted: any[] = [];
  let visionSawQuestion = null;

  respond.respond = async () => {
    throw new Error("an image mention must not fall through to the text path");
  };
  vision.analyzeImage = async (_url: any, question: any) => {
    visionSawQuestion = question;
    return "that's a photo of a breadboard";
  };
  config.slack.helpChannel = "C0MENTION";

  try {
    await handlers.onAppMention({
      event: {
        ts: "500.1",
        channel: "C0MENTION",
        user: "U0ASKER",
        text: "<@U0PIXIE> bruda cant u see the IMAGE",
        files: [{ mimetype: "image/png", url_private: "https://files.slack.com/x.png" }],
      },
      client: { chat: { postMessage: async (args: any) => void posted.push(args) } },
    });
  } finally {
    respond.respond = savedRespond;
    vision.analyzeImage = savedVision;
    config.slack.helpChannel = savedHelp;
  }

  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /breadboard/);
  assert.equal(visionSawQuestion, "bruda cant u see the IMAGE");
});

test("onAppMention still uses the text path when there is no image", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";

  try {
    await handlers.onAppMention({
      event: { ts: "501.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> how do i ship" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].question, "how do i ship");
  assert.equal(calls[0].addressedHow, "mention");
});

const HELP_CHANNEL = "C0HELP";

async function routeHelpMessage(event: any) {
  const savedHelp = config.slack.helpChannel;
  const savedAuto = config.slack.autoReplyChannel;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  const calls: any[] = [];
  config.slack.helpChannel = HELP_CHANNEL;
  config.slack.autoReplyChannel = "C0FAQ";
  respond.respond = async (args: any) => void calls.push(args);
  learn.captureFromReply = async () => null;

  try {
    await handlers.onMessage({
      event: { channel: HELP_CHANNEL, user: "U0ASKER", ...event },
      client: {},
    });
    return calls;
  } finally {
    config.slack.helpChannel = savedHelp;
    config.slack.autoReplyChannel = savedAuto;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }
}

test("help channel still answers a top-level post", async () => {
  const calls = await routeHelpMessage({ ts: "100.1", text: "how do i submit my project" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.ok(calls[0].seedClient);
});

test("explicit human review requests escalate once without calling the provider", async () => {
  const programs = require("./programs");
  const savedForChannel = programs.forChannel;
  const savedIsHelp = programs.isHelpChannel;
  const savedRespond = respond.respond;
  const posted: any[] = [];
  const program = {
    id: "sandbox-escalation",
    name: "Pixie Sandbox",
    supportName: "Sandbox Help",
    posture: "active",
    ticketsEnabled: true,
    autoEscalate: true,
    helpChannel: HELP_CHANNEL,
    organizerChannel: "C0ORGANIZER",
  };
  programs.forChannel = () => program;
  programs.isHelpChannel = (channel: any) => channel === HELP_CHANNEL;
  respond.respond = async () => {
    throw new Error("terminal human review must not call provider");
  };
  const client = {
    chat: {
      postMessage: async (args: any) => {
        posted.push(args);
        return { ts: `posted-${posted.length}` };
      },
    },
  };
  const event = {
    ts: "human-escalation-1",
    channel: HELP_CHANNEL,
    user: "U0ASKER",
    team: "T-ESCALATION",
    text: "human please — i can't access my acme account and need an organizer to look at it",
  };
  try {
    await handlers.onMessage({ event, client });
    await handlers.onMessage({ event, client });
  } finally {
    programs.forChannel = savedForChannel;
    programs.isHelpChannel = savedIsHelp;
    respond.respond = savedRespond;
  }
  const ticket = db.getTicketByThreadTs(event.ts, event.team);
  assert.ok(ticket);
  assert.equal(posted.length, 2, "one public acknowledgement and one organizer card");
  assert.equal(posted.filter((p: any) => p.channel === HELP_CHANNEL).length, 1);
  assert.equal(posted.filter((p: any) => p.channel === "C0ORGANIZER").length, 1);
  assert.match(posted.find((p: any) => p.channel === HELP_CHANNEL).text, /Someone will be here to help you soon/);
  assert.match(posted.find((p: any) => p.channel === "C0ORGANIZER").text, new RegExp(`Ticket #${ticket.id}`));
});

test("a casual help-channel root stays silent and does not open a ticket", async () => {
  const programs = require("./programs");
  const savedForChannel = programs.forChannel;
  const savedIsHelp = programs.isHelpChannel;
  const savedRespond = respond.respond;
  const program = {
    id: "queue-greeting",
    name: "Queue",
    posture: "active",
    ticketsEnabled: true,
    helpChannel: HELP_CHANNEL,
    organizerChannel: "C0ORG-QG",
  };
  programs.forChannel = () => program;
  programs.isHelpChannel = (channel: any) => channel === HELP_CHANNEL;
  let responded = false;
  respond.respond = async () => {
    responded = true;
  };
  const posts: any[] = [];
  const client = {
    chat: {
      postMessage: async (a: any) => {
        posts.push(a);
        return { ts: `qg-${posts.length}` };
      },
    },
    reactions: { add: async () => ({}) },
  };
  const event = { ts: "qg-1", channel: HELP_CHANNEL, user: "U0ASKER", team: "T-QG", text: "hi" };
  try {
    await handlers.onMessage({ event, client });
    await handlers.onMessage({ event, client });
  } finally {
    programs.forChannel = savedForChannel;
    programs.isHelpChannel = savedIsHelp;
    respond.respond = savedRespond;
  }
  const ticket = db.getTicketByThreadTs("qg-1", "T-QG");
  assert.equal(ticket, null, "casual chatter must not create a support ticket");
  assert.equal(responded, false, "the eligibility gate keeps Pixie from answering a greeting");
  assert.equal(posts.length, 0, "casual chatter must not post ticket UI");
});

test("a substantive help-channel root routes through respond and owns ticket creation", async () => {
  const calls: any[] = [];
  const savedHelp = config.slack.helpChannel;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;
  config.slack.helpChannel = HELP_CHANNEL;
  respond.respond = async (args: any) => void calls.push(args);
  learn.captureFromReply = async () => null;
  const event = {
    ts: "support-root-1",
    channel: HELP_CHANNEL,
    user: "U-SUPPORT",
    team: "T-SUPPORT",
    text: "how do I submit my project?",
  };
  try {
    await handlers.onMessage({ event, client: {} });
  } finally {
    config.slack.helpChannel = savedHelp;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(db.getTicketByThreadTs(event.ts, event.team), null, "stubbed respond owns the ticket in production");
});

test("isolated app_mention ignores bot and self events", async () => {
  const savedRespond = respond.respond;
  const calls: any[] = [];
  const savedHelp = config.slack.helpChannel;
  config.slack.helpChannel = HELP_CHANNEL;
  respond.respond = async (args: any) => void calls.push(args);
  try {
    for (const event of [
      { ts: "mention-bot", channel: HELP_CHANNEL, user: "U-other", bot_id: "B-other", text: "<@U0PIXIE> help" },
      {
        ts: "mention-subtype",
        channel: HELP_CHANNEL,
        user: "U-other",
        subtype: "bot_message",
        text: "<@U0PIXIE> help",
      },
      { ts: "mention-self", channel: HELP_CHANNEL, user: "U0PIXIE", text: "<@U0PIXIE> help" },
    ])
      await handlers.onAppMention({ event, client: {} });
  } finally {
    config.slack.helpChannel = savedHelp;
    respond.respond = savedRespond;
  }
  assert.equal(calls.length, 0);
});

test("help channel routes unaddressed thread follow-up to HELP_ONLY gate", async () => {
  context.addToThread("200.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "200.2",
    thread_ts: "200.1",
    text: "i tried running that but got permission denied, what should i do?",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(calls[0].addressed, false);
  assert.ok(calls[0].seedClient);
});

test("help channel skips a thread reply that has no content signal", async () => {
  context.addToThread("300.1", "assistant", "try reinstalling the extension", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "300.2",
    thread_ts: "300.1",
    text: "👍",
  });
  assert.equal(calls.length, 0);
  assert.match(context.getThreadContext("300.1"), /👍/);
});

test("help channel answers a thread reply that names pixie", async () => {
  const calls = await routeHelpMessage({
    ts: "400.2",
    thread_ts: "400.1",
    text: "pixie, i still can't connect my keyboard",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].threadTs, "400.1");
  assert.ok(calls[0].seedClient);
});

test("help channel hands an unnamed thread reply to the gate once pixie has spoken there", async () => {
  context.addToThread("700.1", "assistant", "try reinstalling the extension", null, HELP_CHANNEL);

  const calls = await routeHelpMessage({
    ts: "700.2",
    thread_ts: "700.1",
    text: "still not working, tried that already",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
  assert.equal(calls[0].addressed, false);
});

test("help channel: an untagged question in a thread pixie never spoke in is left to the humans", async () => {
  const calls = await routeHelpMessage({
    ts: "799.2",
    thread_ts: "799.1",
    text: "did you try reseating the cable?",
  });
  assert.equal(calls.length, 0);
});

test("help channel ignores non-question chatter in a thread pixie never spoke in", async () => {
  const calls = await routeHelpMessage({ ts: "798.2", thread_ts: "798.1", text: "ok cool" });
  assert.equal(calls.length, 0);
  assert.equal(context.getThreadContext("798.1"), null);
});

test("faqChannels hands a low-signal reply to the gate instead of dropping it", async () => {
  const FAQ_CHANNEL = "C0FAQTX";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  let mode = null;
  respond.respond = async (args: any) => {
    mode = args.mode;
    return true;
  };
  learn.captureFromReply = async () => null;

  context.addToThread("faq-thread-1", "assistant", "here's how you do it", null, FAQ_CHANNEL);

  try {
    await handlers.onMessage({
      event: {
        ts: "600.2",
        thread_ts: "faq-thread-1",
        channel: FAQ_CHANNEL,
        user: "U0ASKER",
        text: "lol thanks so much for that",
      },
      client: {},
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  assert.equal(mode, respond.HELP_ONLY, "the gate decides, not a pattern over the message");
});

test("faqChannels still drops a bare reaction without calling the model", async () => {
  const FAQ_CHANNEL = "C0FAQTY";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  respond.respond = async () => {
    throw new Error("should not respond — the message is a bare reaction");
  };
  learn.captureFromReply = async () => null;

  context.addToThread("faq-thread-2", "assistant", "here's how you do it", null, FAQ_CHANNEL);

  try {
    await handlers.onMessage({
      event: {
        ts: "601.2",
        thread_ts: "faq-thread-2",
        channel: FAQ_CHANNEL,
        user: "U0ASKER2",
        text: "lmaooo :yay:",
      },
      client: {},
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  assert.match(context.getThreadContext("faq-thread-2"), /lmaooo/);
});

test("onMessage records what people say even when it stays quiet", async () => {
  const FAQ_CHANNEL = "C0FAQTZ";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedCapture = learn.captureFromReply;

  config.slack.faqChannels = [FAQ_CHANNEL];
  respond.respond = async () => true;
  learn.captureFromReply = async () => null;

  try {
    for (const [i, text] of ["my build broke", "tried reinstalling", "still nothing"].entries()) {
      await handlers.onMessage({
        event: { ts: `70${i}.1`, channel: FAQ_CHANNEL, user: "U0DEBUG", text },
        client: {},
      });
    }
  } finally {
    config.slack.faqChannels = savedFaq;
    respond.respond = savedRespond;
    learn.captureFromReply = savedCapture;
  }

  const recent = db.recentUserMessages("U0DEBUG", { channel: FAQ_CHANNEL, limit: 3 });
  assert.deepEqual(
    recent.map((r: any) => r.text),
    ["my build broke", "tried reinstalling", "still nothing"],
    "oldest first, ready to paste into the gate prompt",
  );
});

test("onReactionAdded still records ordinary feedback on a normal message", async () => {
  const savedRecordFeedback = db.recordFeedback;
  const calls: any[] = [];
  db.recordFeedback = (...args: any[]) => calls.push(args);

  try {
    await handlers.onReactionAdded({
      event: {
        reaction: "upvote",
        user: "U-fan",
        item: { type: "message", channel: "C0DOCS", ts: "702.1" },
        item_user: "U0PIXIE",
      },
      client: {},
    });
  } finally {
    db.recordFeedback = savedRecordFeedback;
  }

  assert.deepEqual(calls, [["702.1", "U-fan", 1]]);
});

test("onReactionAdded deletes pixie's own message on :x:", async () => {
  const deleted: any[] = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "x",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "800.2" },
    },
    client: {
      conversations: {
        history: async (args: any) => {
          assert.equal(args.channel, "C0DEL");
          return { messages: [{ user: "U0PIXIE", ts: "800.2" }] };
        },
      },
      chat: {
        delete: async (args: any) => {
          deleted.push(args);
          return { ok: true };
        },
      },
    },
  });

  assert.equal(deleted.length, 1, "message should have been deleted on :x:");
  assert.equal(deleted[0].channel, "C0DEL");
  assert.equal(deleted[0].ts, "800.2");
});

test("onReactionAdded deletes a threaded reply using item_user, with no history call", async () => {
  const deleted: any[] = [];
  await handlers.onReactionAdded({
    event: {
      reaction: "x",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "900.1" },
      item_user: "U0PIXIE",
    },
    client: {
      conversations: {
        history: async () => {
          throw new Error("history must not be called");
        },
      },
      chat: {
        delete: async (args: any) => {
          deleted.push(args);
          return { ok: true };
        },
      },
    },
  });

  assert.equal(deleted.length, 1, "a threaded reply by pixie should still be deletable");
  assert.equal(deleted[0].channel, "C0DEL");
  assert.equal(deleted[0].ts, "900.1");
});

test("onReactionAdded stops the spinner before deleting a placeholder", async () => {
  let updates = 0;
  const deleted: any[] = [];
  const client = {
    chat: {
      postMessage: async () => ({ ts: "reaction-spinner" }),
      update: async () => {
        updates++;
        return {};
      },
      delete: async (args: any) => {
        deleted.push(args);
        return { ok: true };
      },
    },
  };

  await reply.postThinking(client, "C0DEL", "reaction-spinner-thread");
  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAMING_WORD_INTERVAL_MS + 40));
  assert.equal(updates, 1);

  await handlers.onReactionAdded({
    event: {
      reaction: "x",
      user: "U-someone",
      item: { type: "message", channel: "C0DEL", ts: "reaction-spinner" },
      item_user: "U0PIXIE",
    },
    client,
  });
  const updatesAfterDelete = updates;
  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAMING_WORD_INTERVAL_MS + 40));

  assert.equal(deleted.length, 1);
  assert.equal(updates, updatesAfterDelete);
});

test("a broadcast thread reply routes once like a normal thread reply", async () => {
  context.addToThread("900.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const calls = await routeHelpMessage({
    ts: "900.2",
    thread_ts: "900.1",
    subtype: "thread_broadcast",
    text: "tried that, still getting the same error, what next?",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.HELP_ONLY);
});

test("a broadcast can never file a second ticket for its thread", async () => {
  const tickets = require("./tickets");
  const nope = { chat: { postMessage: async () => ({ ts: "card-1" }) } };
  const prog = { id: "bc", name: "Bc", posture: "active", helpChannel: "C-BC" };
  const first = await tickets.escalateTicket({
    program: prog,
    channel: "C-BC",
    threadTs: "bc-1",
    requesterId: "U1",
    question: "help",
    client: nope,
    workspaceId: "TBC",
  });
  const second = await tickets.escalateTicket({
    program: prog,
    channel: "C-BC",
    threadTs: "bc-1",
    requesterId: "U1",
    question: "help",
    client: nope,
    workspaceId: "TBC",
  });
  assert.equal(first.id, second.id);
});

test("message edits and deletes stay silent and file nothing", async () => {
  const changed = await routeHelpMessage({ ts: "910.1", subtype: "message_changed", text: "how do i submit" });
  assert.equal(changed.length, 0);
  const deleted = await routeHelpMessage({ ts: "910.2", subtype: "message_deleted", text: "" });
  assert.equal(deleted.length, 0);
});

test("takeover cue parks the thread until Pixie is invited back", async () => {
  context.addToThread("800.1", "assistant", "here's the answer", null, HELP_CHANNEL);
  const cue = await routeHelpMessage({ ts: "800.2", thread_ts: "800.1", text: "I'll handle this" });
  assert.equal(cue.length, 0);
  assert.equal(db.isTakeover("800.1"), true);

  const chatter = await routeHelpMessage({ ts: "800.3", thread_ts: "800.1", text: "any update?" });
  assert.equal(chatter.length, 0, "takeover stays silent");

  const back = await routeHelpMessage({ ts: "800.4", thread_ts: "800.1", text: "pixie come back, need you" });
  assert.equal(back.length, 1);
  assert.equal(db.isTakeover("800.1"), false);
});

test("muted thread reactivates only on explicit invitation", async () => {
  db.muteThread("801.1", HELP_CHANNEL);
  try {
    const quiet = await routeHelpMessage({ ts: "801.2", thread_ts: "801.1", text: "what about the pcb" });
    assert.equal(quiet.length, 0);
    const invited = await routeHelpMessage({ ts: "801.3", thread_ts: "801.1", text: "pixie help" });
    assert.equal(invited.length, 1);
    assert.equal(db.isThreadMuted("801.1"), false);
  } finally {
    db.unmuteThread("801.1");
  }
});

test("redelivered events never double-answer", async () => {
  const first = await routeHelpMessage({ ts: "802.1", text: "how do i submit my project" });
  assert.equal(first.length, 1);
  const second = await routeHelpMessage({ ts: "802.1", text: "how do i submit my project" });
  assert.equal(second.length, 0);
});

test("onAppMention answers once in a muted thread without clearing the mute", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";
  db.muteThread("810.1", "C0MENTION");
  try {
    await handlers.onAppMention({
      event: {
        ts: "810.2",
        thread_ts: "810.1",
        channel: "C0MENTION",
        user: "U0ASKER",
        text: "<@U0PIXIE> is pcbway allowed?",
      },
      client: {},
    });
    assert.equal(calls.length, 1);
    assert.equal(db.isThreadMuted("810.1"), true);
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
    db.unmuteThread("810.1");
  }
});

test("onAppMention reactivates a muted thread only on explicit invitation", async () => {
  const savedRespond = respond.respond;
  const savedHelp = config.slack.helpChannel;
  const calls: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  config.slack.helpChannel = "C0MENTION";
  db.muteThread("811.1", "C0MENTION");
  try {
    await handlers.onAppMention({
      event: { ts: "811.2", thread_ts: "811.1", channel: "C0MENTION", user: "U0ASKER", text: "<@U0PIXIE> come back" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    config.slack.helpChannel = savedHelp;
  }
  assert.equal(calls.length, 1);
  assert.equal(db.isThreadMuted("811.1"), false);
});

test("staging allowlist drops non-sandbox channels before any handling", async () => {
  const saved = config.slack.stagingOnlyChannels;
  const savedFaq = config.slack.faqChannels;
  config.slack.stagingOnlyChannels = ["C0HELP00001"];
  config.slack.faqChannels = ["C0HELP00001"];
  try {
    const prod = await routeHelpMessage({ ts: "950.1", channel: "C0PIXEL", text: "pixie how do i submit my project" });
    assert.equal(prod.length, 0, "production channel event must not be handled in staging");
    const sandbox = await routeHelpMessage({
      ts: "950.2",
      channel: "C0HELP00001",
      text: "pixie how do i submit my project",
    });
    assert.equal(sandbox.length, 1, "sandbox channel event is handled");
  } finally {
    config.slack.stagingOnlyChannels = saved;
    config.slack.faqChannels = savedFaq;
  }
});

test("a plain message naming Pixie in an unclaimed channel gets total silence", async () => {
  const savedRespond = respond.respond;
  const posted: any[] = [];
  respond.respond = async (args: any) => void posted.push(args);
  try {
    await handlers.onMessage({
      event: {
        ts: "990.1",
        channel: "C0RANDOM-UNCLAIMED",
        user: "U0ASKER",
        text: "pixie, what do you think about this pcb layout?",
      },
      client: {
        chat: {
          postMessage: async (args: any) => void posted.push(args),
          postEphemeral: async (args: any) => void posted.push(args),
        },
      },
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posted.length, 0, "no reply, no escalation, nothing — the channel was never claimed");
});

test("an @-mention in an unclaimed channel gets total silence, even a sensitive one", async () => {
  const savedRespond = respond.respond;
  const posted: any[] = [];
  respond.respond = async (args: any) => void posted.push(args);
  try {
    await handlers.onAppMention({
      event: {
        ts: "991.1",
        channel: "C0RANDOM-UNCLAIMED-2",
        user: "U0ASKER",
        text: "<@U0PIXIE> is anyone else having thoughts of self harm",
      },
      client: {
        chat: {
          postMessage: async (args: any) => void posted.push(args),
          postEphemeral: async (args: any) => void posted.push(args),
        },
      },
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posted.length, 0, "no answer, no escalation ticket — an unclaimed channel gets nothing");
  assert.equal(db.getTicketByThreadTs("991.1", undefined), null, "no ticket was filed for the unclaimed channel");
});

test("a DM still works — the scope gate is channel-only, not global", async () => {
  const savedRespond = respond.respond;
  const calls: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  try {
    await handlers.onMessage({
      event: {
        ts: "992.1",
        channel: "D0DM-CHANNEL",
        channel_type: "im",
        user: "U0ASKER",
        text: "how do i submit my project",
      },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(calls.length, 1, "DMs are exempt from channel-claim scoping");
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].dm, true);
  assert.equal(calls[0].scope, "D0DM-CHANNEL");
});

test("normal DM passes explicit identity and is reserved by the DM limiter", async () => {
  const savedRespond = respond.respond;
  const savedCheck = rateLimit.check;
  const calls: any[] = [];
  const checks: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  rateLimit.check = (...args: any[]) => {
    checks.push(args);
    return { allowed: true, reason: "reserved" };
  };
  try {
    await handlers.onMessage({
      event: { ts: "dm-limit-1", channel: "D0LIMIT", channel_type: "im", user: "U-LIMIT", text: "expensive ask" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    rateLimit.check = savedCheck;
  }
  assert.equal(calls.length, 1);
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0], [{ userId: "U-LIMIT", scope: "D0LIMIT", dm: true }, { dm: true }]);
  assert.deepEqual(calls[0].userId, "U-LIMIT");
  assert.equal(calls[0].dm, true);
  assert.equal(calls[0].scope, "D0LIMIT");
});

test("DM image is rate limited before vision and emits a metric", async () => {
  const savedCheck = rateLimit.check;
  const savedVision = vision.analyzeImage;
  const savedMetric = db.recordMetric;
  const posted: any[] = [];
  let visionCalled = false;
  const metrics: any[] = [];
  rateLimit.check = (identity: any, options: any) => {
    assert.deepEqual(identity, { userId: "U-IMAGE", scope: "D0IMAGE", dm: true });
    assert.equal(options.dm, true);
    return { allowed: false, reason: "limit" };
  };
  vision.analyzeImage = async () => {
    visionCalled = true;
  };
  db.recordMetric = (...args: any[]) => metrics.push(args);
  try {
    await handlers.handleImage({
      event: { ts: "image-limit-1", channel: "D0IMAGE", channel_type: "im", user: "U-IMAGE", text: "look", files: [] },
      client: { chat: { postMessage: async (args: any) => posted.push(args) } },
      imageFile: { mimetype: "image/png", url_private: "https://files/image.png" },
    });
  } finally {
    rateLimit.check = savedCheck;
    vision.analyzeImage = savedVision;
    db.recordMetric = savedMetric;
  }
  assert.equal(visionCalled, false);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /slow down/);
  assert.deepEqual(metrics[0], ["rate_limited", null, "limit", null]);
});

test("duplicate rate-limited DM delivery posts one notice and records one metric", async () => {
  const savedCheck = rateLimit.check;
  const savedMetric = db.recordMetric;
  const posts: any[] = [];
  const metrics: any[] = [];
  rateLimit.check = () => ({ allowed: false, reason: "limit" });
  db.recordMetric = (...args: any[]) => metrics.push(args);
  const event = {
    ts: "dm-rate-duplicate",
    channel: "D0RATE-DUP",
    channel_type: "im",
    user: "U-RATE-DUP",
    text: "how do I submit this",
  };
  const client = { chat: { postMessage: async (args: any) => posts.push(args) } };

  try {
    await handlers.onMessage({ event, client });
    await handlers.onMessage({ event, client });
  } finally {
    rateLimit.check = savedCheck;
    db.recordMetric = savedMetric;
  }

  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "woah slow down a sec — gimme a minute to catch up :pls:");
  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0], ["rate_limited", null, "limit", "shared"]);
});

test("rate-limit notice failure does not reject the DM handler", async () => {
  const savedCheck = rateLimit.check;
  const savedMetric = db.recordMetric;
  const metrics: any[] = [];
  rateLimit.check = () => ({ allowed: false, reason: "limit" });
  db.recordMetric = (...args: any[]) => metrics.push(args);
  const client = {
    chat: {
      postMessage: async () => {
        throw Object.assign(new Error("not_in_channel"), { code: "not_in_channel" });
      },
    },
  };

  try {
    await assert.doesNotReject(() =>
      handlers.onMessage({
        event: {
          ts: "dm-rate-failure",
          channel: "D0RATE-FAIL",
          channel_type: "im",
          user: "U-RATE-FAIL",
          text: "how do I submit this",
        },
        client,
      }),
    );
  } finally {
    rateLimit.check = savedCheck;
    db.recordMetric = savedMetric;
  }

  assert.ok(metrics.length >= 1);
  assert.deepEqual(metrics[0], ["rate_limited", null, "limit", "shared"]);
});

test("DM teach and sum are rate limited before their model paths", async () => {
  const savedCheck = rateLimit.check;
  const savedTeach = teachThread.summarizeThread;
  const savedSum = sumThread.summarizeThreadForHelper;
  const savedIsHelper = db.isHelper;
  const posted: any[] = [];
  let teachCalled = false;
  let sumCalled = false;
  rateLimit.check = () => ({ allowed: false, reason: "limit" });
  db.isHelper = () => true;
  teachThread.summarizeThread = async () => {
    teachCalled = true;
  };
  sumThread.summarizeThreadForHelper = async () => {
    sumCalled = true;
  };
  const client = {
    chat: {
      postEphemeral: async (args: any) => posted.push(args),
      postMessage: async (args: any) => posted.push(args),
    },
  };
  try {
    await handlers.handleTeachRequest({
      event: {
        ts: "teach-limit",
        channel: "D0COMMAND",
        channel_type: "im",
        user: "U-COMMAND",
        thread_ts: "teach-thread",
      },
      client,
      question: "!teach thread",
      prog: { id: "p" },
      mentionOnly: false,
      claimFirst: false,
    });
    await handlers.handleSumRequest({
      event: { ts: "sum-limit", channel: "D0COMMAND", channel_type: "im", user: "U-COMMAND", thread_ts: "sum-thread" },
      client,
      question: "!sum thread",
      prog: { id: "p" },
      mentionOnly: false,
      claimFirst: false,
    });
  } finally {
    rateLimit.check = savedCheck;
    teachThread.summarizeThread = savedTeach;
    sumThread.summarizeThreadForHelper = savedSum;
    db.isHelper = savedIsHelper;
  }
  assert.equal(teachCalled, false);
  assert.equal(sumCalled, false);
  assert.equal(posted.length, 2);
  assert.ok(posted.every((post: any) => /slow down/.test(post.text)));
});

test("DMs without a user identity fail closed without calling respond", async () => {
  const savedRespond = respond.respond;
  const calls: any[] = [];
  const posted: any[] = [];
  respond.respond = async () => calls.push(true);
  try {
    await handlers.onMessage({
      event: { ts: "dm-missing-user", channel: "D0MISSING", channel_type: "im", text: "expensive ask" },
      client: { chat: { postMessage: async (args: any) => posted.push(args) } },
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(calls.length, 0);
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /slow down/);
});

test("handleTeachRequest lets a program roster helper teach", async () => {
  const prog = { id: "teachgate", name: "TeachGate" };
  db.syncHelper({ programId: "teachgate", userId: "U0ROSTER", source: "manual" });
  const savedTeach = learn.teach;
  const posted: any[] = [];
  learn.teach = () => 4242;
  const client = { chat: { postEphemeral: async (a: any) => void posted.push(a) } };
  try {
    const consumed = await handlers.handleTeachRequest({
      event: { ts: "aa.1", channel: "C-TG", thread_ts: "aa.0", user: "U0ROSTER" },
      client,
      question: "!teach when is launch :: august 18",
      prog,
      mentionOnly: false,
      claimFirst: false,
    });
    assert.equal(consumed, true);
    assert.match(posted[0].text, /Memorized/);
  } finally {
    learn.teach = savedTeach;
  }
});

test("handleTeachRequest bounces a non-helper who is not a global admin", async () => {
  const posted: any[] = [];
  const client = { chat: { postEphemeral: async (a: any) => void posted.push(a) } };
  const consumed = await handlers.handleTeachRequest({
    event: { ts: "bb.1", channel: "C-TG", thread_ts: "bb.0", user: "U0STRANGER" },
    client,
    question: "!teach x :: y",
    prog: { id: "teachgate", name: "TeachGate" },
    mentionOnly: false,
    claimFirst: false,
  });
  assert.equal(consumed, true);
  assert.match(posted[0].text, /helpers-only/);
});

test("onAppMention routes to respond ALWAYS addressed (mention path parity)", async () => {
  const savedRespond = respond.respond;
  const calls: any[] = [];
  respond.respond = async (args: any) => void calls.push(args);
  const programs = require("./programs");
  const saved = process.env.PIXIE_PROGRAMS_JSON;
  process.env.PIXIE_PROGRAMS_JSON = JSON.stringify([
    { id: "charmen", name: "CharMen", helpChannel: "C-CHARMEN", channels: ["C-CHARMEN"] },
  ]);
  programs.invalidate();
  try {
    await handlers.onAppMention({
      event: { ts: "993.1", channel: "C-CHARMEN", user: "U0ASKER", text: "<@U0PIXIE> how do i submit" },
      client: {},
    });
  } finally {
    respond.respond = savedRespond;
    if (saved === undefined) delete process.env.PIXIE_PROGRAMS_JSON;
    else process.env.PIXIE_PROGRAMS_JSON = saved;
    programs.invalidate();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.equal(calls[0].addressed, true);
});

test("!sum and !teach from a helper still run in a taken-over help thread", async () => {
  const savedTeach = learn.teach;
  const savedSum = sumThread.summarizeThreadForHelper;
  const savedIsHelper = db.isHelper;
  const savedHelp = config.slack.helpChannel;
  let sumCalled = false;
  let taught: any = null;
  db.isHelper = () => true;
  learn.teach = (fact: any) => {
    taught = fact;
    return 77;
  };
  sumThread.summarizeThreadForHelper = async () => {
    sumCalled = true;
    return "summary";
  };
  config.slack.helpChannel = HELP_CHANNEL;
  const posted: any[] = [];
  const client = {
    chat: { postEphemeral: async (a: any) => void posted.push(a), postMessage: async (a: any) => void posted.push(a) },
  };
  db.markTakeover("830.1", HELP_CHANNEL, "U0HELPER");
  try {
    await handlers.onMessage({
      event: { channel: HELP_CHANNEL, user: "U0HELPER", ts: "830.2", thread_ts: "830.1", text: "!sum" },
      client,
    });
    await handlers.onMessage({
      event: {
        channel: HELP_CHANNEL,
        user: "U0HELPER",
        ts: "830.3",
        thread_ts: "830.1",
        text: "!teach when is launch :: august 18",
      },
      client,
    });
  } finally {
    learn.teach = savedTeach;
    sumThread.summarizeThreadForHelper = savedSum;
    db.isHelper = savedIsHelper;
    config.slack.helpChannel = savedHelp;
    db.clearTakeover("830.1");
  }
  assert.equal(sumCalled, true);
  assert.equal(taught?.answer, "august 18");
});

test("untagged thread message: addressed while it is just Pixie and the asker; silent once another human joins", async () => {
  const FAQ_CHANNEL = "C0FAQTZ";
  const savedFaq = config.slack.faqChannels;
  const savedRespond = respond.respond;
  const savedBot = config.slack.botUserId;
  const calls: any[] = [];
  config.slack.faqChannels = [FAQ_CHANNEL];
  config.slack.botUserId = "UPIXIE";
  respond.respond = async (args: any) => void calls.push(args);
  context.addToThread("crowd-thread", "assistant", "restoration energy comes from restoring pixels", null, FAQ_CHANNEL);
  let thread: Array<{ user: string; ts: string; text?: string }> = [
    { user: "U0CROWDASK", ts: "7200.0", text: "what is restoration energy" },
    { user: "UPIXIE", ts: "7200.1", text: "restoration energy comes from restoring pixels" },
  ];
  const client = { conversations: { replies: async () => ({ messages: thread }) } };
  const send = (ts: any, user: any, text: any) =>
    handlers.onMessage({
      event: { ts, thread_ts: "crowd-thread", channel: FAQ_CHANNEL, user, text, parent_user_id: "U0CROWDASK" },
      client,
    });
  try {
    await send("7200.2", "U0CROWDASK", "whats your favourite colour");
    thread = [...thread, { user: "U0CROWDASK", ts: "7200.2" }];
    await send("7200.3", "U0CROWDHELPER", "did you check the docs page for this?");
    thread = [...thread, { user: "U0CROWDHELPER", ts: "7200.3" }];
    await send("7200.4", "U0CROWDASK", "yeah i did, what else can i try");
  } finally {
    config.slack.faqChannels = savedFaq;
    config.slack.botUserId = savedBot;
    respond.respond = savedRespond;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].addressed, true);
  assert.equal(calls[0].addressedHow, "thread");
  assert.equal(calls[0].mode, respond.ALWAYS);
  assert.match(
    context.getThreadContext("crowd-thread") || "",
    /what else can i try/,
    "silent turns still join the transcript",
  );
});

test("untagged chatter in a two-person Pixie thread produces no Slack post", async () => {
  const FAQ_CHANNEL = "C0FAQOFFTOPIC";
  const savedFaq = config.slack.faqChannels;
  const savedIntent = intent.classifyIntentContext;
  const posted: any[] = [];
  config.slack.faqChannels = [FAQ_CHANNEL];
  context.addToThread("offtopic-thread", "assistant", "what is restoration energy?", null, FAQ_CHANNEL);
  intent.classifyIntentContext = async () => ({ directedAtHuman: true, verdict: intent.CASUAL_CHAT });
  const client = {
    chat: {
      postMessage: async (message: any) => {
        posted.push(message);
        return { ts: "offtopic-post" };
      },
      update: async (message: any) => {
        posted.push(message);
        return {};
      },
    },
    conversations: {
      replies: async () => ({
        messages: [
          { user: "U0ASKER", ts: "7400.0", text: "what is restoration energy?" },
          { user: "U0PIXIE", ts: "7400.1", text: "restoration energy comes from restoring pixels" },
        ],
      }),
    },
  };

  try {
    await handlers.onMessage({
      event: {
        ts: "7400.2",
        thread_ts: "offtopic-thread",
        channel: FAQ_CHANNEL,
        user: "U0ASKER",
        parent_user_id: "U0ASKER",
        text: "which has realtime data",
      },
      client,
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    intent.classifyIntentContext = savedIntent;
  }

  assert.deepEqual(posted, []);
});

test("a pinged sensitive message with no ticket possible still gets a reply", async () => {
  const FAQ_CHANNEL = "C0FAQSENS";
  const tickets = require("./tickets");
  const savedFaq = config.slack.faqChannels;
  const savedBot = config.slack.botUserId;
  const savedEscalate = tickets.escalateTicket;
  const savedHandOff = tickets.handOffToHelper;
  config.slack.faqChannels = [FAQ_CHANNEL];
  config.slack.botUserId = "UPIXIE";
  tickets.escalateTicket = async () => null;
  tickets.handOffToHelper = async () => null;
  const posted: any[] = [];
  const client = {
    chat: {
      postMessage: async (m: any) => {
        posted.push(m);
        return { ok: true, ts: "sens" };
      },
    },
  };
  try {
    await handlers.onMessage({
      event: { ts: "7300.1", channel: FAQ_CHANNEL, user: "U0SENS", text: "<@UPIXIE> can a human look at my account?" },
      client,
    });
  } finally {
    config.slack.faqChannels = savedFaq;
    config.slack.botUserId = savedBot;
    tickets.escalateTicket = savedEscalate;
    tickets.handOffToHelper = savedHandOff;
  }
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /needs a person/);
  assert.equal(posted[0].thread_ts, "7300.1");
});

test("a helper trigger sends one interpolated macro and dedupes Slack redelivery", async () => {
  const programId = "handler-macro-send";
  const helperId = "U-HANDLER-MACRO";
  const requesterId = "U-HANDLER-REQUESTER";
  const channel = "C-HANDLER-MACRO";
  const threadTs = "handler-macro-thread";
  db.saveProgram({ id: programId, name: "Macro Acme", helpChannel: channel, channels: [channel] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual", role: "helper" });
  const macro = macros.create({
    programId,
    trigger: "?need-info",
    name: "Need info",
    content: "Hi {requester}, ticket {ticket_id} has {queue_depth} waiting ({typical_wait}); you are #{position}.",
  }).macro;
  const ticketId = db.createTicket({
    programId,
    workspaceId: "T-HANDLER",
    channel,
    threadTs,
    requesterId,
    question: "help",
  });
  const posts: any[] = [];
  const ephemerals: any[] = [];
  const reactions: any[] = [];
  const client = {
    chat: {
      postMessage: async (payload: any) => {
        posts.push(payload);
        return { ts: "macro-reply-1" };
      },
      postEphemeral: async (payload: any) => {
        ephemerals.push(payload);
      },
    },
    reactions: {
      add: async (payload: any) => {
        reactions.push(payload);
      },
    },
  };
  const savedRespond = respond.respond;
  const responded: any[] = [];
  respond.respond = async (args: any) => {
    responded.push(args);
  };
  const event = {
    ts: "handler-macro-message",
    team: "T-HANDLER",
    channel,
    thread_ts: threadTs,
    user: helperId,
    text: "?NEED-INFO please check",
  };
  try {
    await handlers.onMessage({ event, client });
    await handlers.onMessage({ event, client });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, new RegExp(`<@${requesterId}>`));
  assert.match(posts[0].text, new RegExp(`ticket ${ticketId}`));
  assert.deepEqual(reactions, [{ channel, timestamp: event.ts, name: "white_check_mark" }]);
  assert.deepEqual(ephemerals, []);
  assert.deepEqual(responded, []);
  assert.equal(db.listTicketEvents(ticketId).filter((row: any) => row.event_type === "macro_sent").length, 1);
  assert.equal(db.listAuditEvents({ programId }).filter((row: any) => row.action === "macro.sent").length, 1);
  assert.equal(macro.trigger, "?need-info");
});

test("typing !need-info sends a macro that was saved as ?need-info", async () => {
  const programId = "handler-macro-sigil";
  const helperId = "U-HANDLER-SIGIL";
  const channel = "C-HANDLER-SIGIL";
  const threadTs = "handler-sigil-thread";
  db.saveProgram({ id: programId, name: "Sigil Acme", helpChannel: channel, channels: [channel] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual", role: "helper" });
  macros.create({ programId, trigger: "?need-info", name: "Need info", content: "please share more" });
  const ticketId = db.createTicket({
    programId,
    workspaceId: "T-HANDLER",
    channel,
    threadTs,
    requesterId: "U-REQ-SIGIL",
    question: "help",
  });
  const posts: any[] = [];
  const reactions: any[] = [];
  const client = {
    chat: {
      postMessage: async (payload: any) => {
        posts.push(payload);
        return { ts: "sigil-reply" };
      },
      postEphemeral: async () => {
        throw new Error("unexpected ephemeral");
      },
    },
    reactions: {
      add: async (payload: any) => {
        reactions.push(payload);
      },
    },
  };
  await handlers.onMessage({
    event: {
      ts: "handler-sigil-message",
      team: "T-HANDLER",
      channel,
      thread_ts: threadTs,
      user: helperId,
      text: "!need-info",
    },
    client,
  });
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /please share more/);
  assert.deepEqual(
    reactions.map((r: any) => r.name),
    ["white_check_mark"],
  );
  assert.equal(db.listTicketEvents(ticketId).filter((row: any) => row.event_type === "macro_sent").length, 1);
});

test("unknown macro triggers stay private and list only enabled macros", async () => {
  const programId = "handler-macro-unknown";
  const helperId = "U-HANDLER-UNKNOWN";
  const channel = "C-HANDLER-UNKNOWN";
  const threadTs = "handler-unknown-thread";
  db.saveProgram({ id: programId, name: "Unknown Acme", helpChannel: channel, channels: [channel] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  macros.create({ programId, trigger: "?need-info", name: "Need info", content: "info" });
  macros.create({ programId, trigger: "?disabled", name: "Disabled", content: "no", enabled: false });
  const ticketId = db.createTicket({
    programId,
    workspaceId: "T-HANDLER-UNKNOWN",
    channel,
    threadTs,
    requesterId: "U-REQUESTER",
    question: "help",
  });
  const posts: any[] = [];
  const ephemerals: any[] = [];
  const reactions: any[] = [];
  const client = {
    chat: {
      postMessage: async (payload: any) => {
        posts.push(payload);
        return { ts: "unexpected" };
      },
      postEphemeral: async (payload: any) => {
        ephemerals.push(payload);
      },
    },
    reactions: {
      add: async (payload: any) => {
        reactions.push(payload);
      },
    },
  };
  await handlers.onMessage({
    event: {
      ts: "handler-unknown-message",
      team: "T-HANDLER-UNKNOWN",
      channel,
      thread_ts: threadTs,
      user: helperId,
      text: "?need-inf",
    },
    client,
  });
  assert.equal(ticketId > 0, true);
  assert.deepEqual(posts, []);
  assert.equal(ephemerals.length, 1);
  assert.equal(ephemerals[0].user, helperId);
  assert.match(ephemerals[0].text, /No macro `\?need-inf` for Unknown Acme/);
  assert.match(ephemerals[0].text, /\?need-info/);
  assert.doesNotMatch(ephemerals[0].text, /\?disabled/);
  assert.deepEqual(reactions, [{ channel, timestamp: "handler-unknown-message", name: "question" }]);
});

test("macros work in any program thread for helpers, like !sum", async () => {
  const programId = "handler-macro-gates";
  const channel = "C-HANDLER-GATES";
  db.saveProgram({ id: programId, name: "Gate Acme", helpChannel: channel, channels: [channel] });
  programs.invalidate();
  const helperId = "U-HANDLER-GATE-HELPER";
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  macros.create({ programId, trigger: "!gate", name: "Gate", content: "hi {requester}, gate" });
  db.createTicket({
    programId,
    workspaceId: "T-HANDLER-GATES",
    channel,
    threadTs: "handler-gate-ticket",
    requesterId: "U-REQUESTER",
    question: "help",
  });
  const posts: any[] = [];
  const reactions: any[] = [];
  const ephemerals: any[] = [];
  const client = {
    chat: {
      postMessage: async (payload: any) => {
        posts.push(payload);
        return { ts: `p${posts.length}` };
      },
      postEphemeral: async (payload: any) => {
        ephemerals.push(payload);
      },
    },
    reactions: {
      add: async (payload: any) => {
        reactions.push(payload);
      },
    },
    conversations: {
      replies: async () => ({ messages: [{ ts: "handler-no-ticket", user: "U-THREAD-STARTER", text: "q" }] }),
    },
  };
  const savedRespond = respond.respond;
  respond.respond = async () => {};
  try {
    await handlers.onMessage({
      event: {
        ts: "handler-gate-nonhelper",
        team: "T-HANDLER-GATES",
        channel,
        thread_ts: "handler-gate-ticket",
        user: "U-STRANGER",
        text: "!gate",
      },
      client,
    });
    assert.equal(posts.length, 0);
    assert.equal(ephemerals.length, 1);
    assert.match(ephemerals[0].text, /helpers-only/);

    await handlers.onMessage({
      event: {
        ts: "handler-gate-chatter",
        team: "T-HANDLER-GATES",
        channel,
        thread_ts: "handler-gate-ticket",
        user: "U-STRANGER",
        text: "!important the site is down",
      },
      client,
    });
    assert.equal(ephemerals.length, 1);
    assert.equal(
      db.claimMessage("handler-gate-chatter", channel),
      true,
      "the chatter message was left for normal handling",
    );

    await handlers.onMessage({
      event: {
        ts: "handler-gate-nonticket",
        team: "T-HANDLER-GATES",
        channel,
        thread_ts: "handler-no-ticket",
        user: helperId,
        text: "!gate",
      },
      client,
    });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].thread_ts, "handler-no-ticket");
    assert.equal(posts[0].text, "hi <@U-THREAD-STARTER>, gate");
    assert.deepEqual(
      reactions.map((r: any) => r.name),
      ["white_check_mark"],
    );
    assert.equal(db.listAuditEvents({ programId }).filter((row: any) => row.action === "macro.sent").length, 1);
  } finally {
    respond.respond = savedRespond;
  }
});

test("macro triggers in channels no program claims fall through", async () => {
  const posts: any[] = [];
  const client = {
    chat: {
      postMessage: async (p: any) => {
        posts.push(p);
        return { ts: "x" };
      },
      postEphemeral: async (p: any) => {
        posts.push(p);
      },
    },
    reactions: { add: async () => {} },
  };
  const savedRespond = respond.respond;
  respond.respond = async () => {};
  try {
    await handlers.onMessage({
      event: {
        ts: "handler-unclaimed-msg",
        team: "T-NONE",
        channel: "C-UNCLAIMED-MACRO",
        thread_ts: "handler-unclaimed-thread",
        user: "U-ANYONE",
        text: "!need-info",
      },
      client,
    });
  } finally {
    respond.respond = savedRespond;
  }
  assert.equal(posts.filter((p: any) => /macro|helpers-only/i.test(p.text || "")).length, 0);
});

test("a resolved macro trigger uses the canonical resolve transition", async () => {
  const programId = "handler-macro-resolve";
  const helperId = "U-HANDLER-RESOLVE";
  const channel = "C-HANDLER-RESOLVE";
  const threadTs = "handler-resolve-thread";
  db.saveProgram({ id: programId, name: "Resolve Acme", helpChannel: channel, channels: [channel] });
  programs.invalidate();
  db.syncHelper({ programId, userId: helperId, source: "manual" });
  macros.create({
    programId,
    trigger: "!done",
    name: "Done",
    content: "done {ticket_id}",
    onSendTransition: "resolved",
  });
  const ticketId = db.createTicket({
    programId,
    workspaceId: "T-HANDLER-RESOLVE",
    channel,
    threadTs,
    requesterId: "U-REQUESTER",
    question: "help",
  });
  const client = {
    chat: {
      postMessage: async () => ({ ts: "resolve-reply" }),
      update: async () => ({}),
      postEphemeral: async () => ({}),
    },
    reactions: { add: async () => ({}), remove: async () => ({}) },
  };
  await handlers.onMessage({
    event: {
      ts: "handler-resolve-message",
      team: "T-HANDLER-RESOLVE",
      channel,
      thread_ts: threadTs,
      user: helperId,
      text: "!DONE",
    },
    client,
  });
  assert.equal(db.getTicket(ticketId).status, "resolved");
  assert.ok(db.listTicketEvents(ticketId).some((row: any) => row.event_type === "resolved"));
  assert.ok(db.listTicketEvents(ticketId).some((row: any) => row.event_type === "macro_sent"));
});
export {};
