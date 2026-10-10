process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const context = require("./context");
const supportMemory = require("./supportMemory");

db.open(":memory:");

test("deriveTopic reduces a question to keywords", () => {
  assert.equal(context.deriveTopic("how do i unlock the next region?"), "unlock next region");
  assert.equal(context.deriveTopic("Where can I find the docs"), "find docs");
});

test("deriveTopic drops code blocks and mentions", () => {
  assert.equal(context.deriveTopic("<@U1> why does ```const x = 1``` break hackatime"), "break hackatime");
});

test("deriveTopic falls back to a truncated question when everything is a stopword", () => {
  assert.equal(context.deriveTopic("how do i do it"), "how do i do it");
});

test("deriveTopic handles empty input", () => {
  assert.equal(context.deriveTopic(""), "");
  assert.equal(context.deriveTopic(undefined), "");
});

test("thread context renders as a role-prefixed transcript", () => {
  context.addToThread("ctx-1", "user", "how do i join", "U1", "C1");
  context.addToThread("ctx-1", "assistant", "just sign up", null, "C1");

  assert.equal(context.getThreadContext("ctx-1"), "user: how do i join\nassistant: just sign up");
});

test("getThreadContext returns null for an unknown thread", () => {
  assert.equal(context.getThreadContext("ctx-unknown"), null);
});

test("thread context stays bounded after a 100-message thread", () => {
  for (let index = 0; index < 100; index += 1) {
    context.addToThread("ctx-100", index % 2 ? "assistant" : "user", `message ${index}`);
  }

  const rendered = context.getThreadContext("ctx-100");
  assert.ok(rendered.length <= 4000);
  assert.ok(rendered.split("\n").length <= 8);
  assert.match(rendered, /message 99/);
  assert.doesNotMatch(rendered, /message 0/);
});

test("latest question is always retained during compaction", () => {
  for (let index = 0; index < 20; index += 1) {
    context.addToThread("ctx-latest", "user", `unrelated archive ${index}`);
  }
  context.addToThread("ctx-latest", "user", "how do I configure the webhook timeout?");

  const rendered = context.getThreadContext("ctx-latest");
  assert.match(rendered, /configure the webhook timeout/);
});

test("follow-up context preserves the entity from the preceding exchange", () => {
  context.addToThread("ctx-follow-up", "user", "How do I configure the webhook timeout?");
  context.addToThread("ctx-follow-up", "assistant", "Set the webhook timeout in the delivery settings.");
  context.addToThread("ctx-follow-up", "user", "What about retries?");

  const rendered = context.getThreadContext("ctx-follow-up");
  assert.match(rendered, /webhook timeout/);
  assert.match(rendered, /What about retries/);
});

test("relevant older turns outrank unrelated recent chatter", () => {
  context.addToThread("ctx-relevance", "user", "How do I rotate the API key for production?");
  context.addToThread("ctx-relevance", "assistant", "Rotate it from the production credentials page.");
  for (let index = 0; index < 10; index += 1) {
    context.addToThread("ctx-relevance", "user", `unrelated chatter about lunch ${index}`);
  }
  context.addToThread("ctx-relevance", "user", "Where is the API key setting?");

  const rendered = context.getThreadContext("ctx-relevance");
  assert.match(rendered, /production credentials/);
  assert.doesNotMatch(rendered, /unrelated chatter about lunch 0/);
});

test("hasSpokenInThread flips only once pixie replies", () => {
  context.addToThread("ctx-2", "user", "anyone here", "U1", "C1");
  assert.equal(context.hasSpokenInThread("ctx-2"), false);

  context.addToThread("ctx-2", "assistant", "yep", null, "C1");
  assert.equal(context.hasSpokenInThread("ctx-2"), true);
});

test("user context exposes derived topics, not raw questions", () => {
  context.updateUserHistory("U7", "how do i unlock the next region?", true, "prog-a");
  const userContext = context.getUserContext("U7", "prog-a");

  assert.deepEqual(userContext.recentTopics, ["unlock next region"]);
  assert.deepEqual(userContext.helpfulAnswers, ["unlock next region"]);
});

test("unhelpful answers are tracked as topics but not as helpful ones", () => {
  context.updateUserHistory("U8", "what is the airspeed of a swallow", false, "prog-a");
  const userContext = context.getUserContext("U8", "prog-a");

  assert.equal(userContext.recentTopics.length, 1);
  assert.deepEqual(userContext.helpfulAnswers, []);
});

test("getUserContext returns null for an unseen user", () => {
  assert.equal(context.getUserContext("U-nobody", "prog-a"), null);
});

test("threads are isolated by ts", () => {
  context.addToThread("char-t-a", "user", "alpha question", "U1", "C1");
  context.addToThread("char-t-b", "user", "beta question", "U1", "C1");
  assert.match(context.getThreadContext("char-t-a"), /alpha question/);
  assert.doesNotMatch(context.getThreadContext("char-t-a"), /beta question/);
});

test("thread context is isolated by channel when a shared thread timestamp is reused", () => {
  context.addToThread("shared-channel-thread", "user", "alpha channel question", "U1", "C-alpha");
  context.addToThread("shared-channel-thread", "user", "beta channel question", "U1", "C-beta");

  assert.match(context.getThreadContext("shared-channel-thread", null, "C-alpha"), /alpha channel question/);
  assert.doesNotMatch(context.getThreadContext("shared-channel-thread", null, "C-alpha"), /beta channel question/);
  assert.match(context.getThreadContext("shared-channel-thread", null, "C-beta"), /beta channel question/);
  assert.doesNotMatch(context.getThreadContext("shared-channel-thread", null, "C-beta"), /alpha channel question/);
  assert.equal(context.getThreadContext("shared-channel-thread"), null);
});

test("thread messages are isolated by channel when a shared thread timestamp is reused", () => {
  context.addToThread("shared-channel-messages", "user", "alpha message", "U1", "C-alpha");
  context.addToThread("shared-channel-messages", "user", "beta message", "U1", "C-beta");

  assert.deepEqual(
    context.getThreadMessages("shared-channel-messages", "C-alpha").map((message) => message.text),
    ["alpha message"],
  );
  assert.deepEqual(
    context.getThreadMessages("shared-channel-messages", "C-beta").map((message) => message.text),
    ["beta message"],
  );
  assert.deepEqual(context.getThreadMessages("shared-channel-messages"), []);
});

test("thread context accepts workspace and channel scopes together", () => {
  context.addToThread("shared-workspace-thread", "user", "workspace one", "U1", {
    workspace: "W1",
    channel: "C1",
  });
  context.addToThread("shared-workspace-thread", "user", "workspace two", "U1", {
    workspace: "W2",
    channel: "C1",
  });

  assert.match(
    context.getThreadContext("shared-workspace-thread", { workspace: "W1", channel: "C1" }),
    /workspace one/,
  );
  assert.doesNotMatch(
    context.getThreadContext("shared-workspace-thread", { workspace: "W1", channel: "C1" }),
    /workspace two/,
  );
});

test("addToThread with no ts is a no-op, never throws", () => {
  assert.doesNotThrow(() => context.addToThread(null, "user", "lost message", "U1", "C1"));
  assert.doesNotThrow(() => context.addToThread(undefined, "user", "lost message", "U1", "C1"));
});

test("support capture recognizes failed attempts and environments", () => {
  assert.equal(context.isAttemptReport("clear-cookies didn't work"), true);
  assert.equal(context.isAttemptReport("I already cleared cookies"), true);
  assert.equal(context.isAttemptReport("I already cleared the cache"), true);
  assert.equal(context.isAttemptReport("I restarted and reinstalled the app"), true);
  assert.equal(context.isAttemptReport("I tried changing the setting"), true);
  assert.equal(context.isAttemptReport("That didn't help"), true);
  assert.deepEqual(context.detectEnvironment("I'm using Chrome on Windows from an iPhone"), [
    "Chrome",
    "Windows",
    "iPhone",
  ]);
  assert.deepEqual(context.extractAttemptedSteps("I already cleared cookies"), ["cleared cookies"]);
  assert.equal(context.isSupportQuestionOrAttempt("what a lovely day"), false);
  assert.equal(context.isSupportQuestionOrAttempt("I love this app"), false);
});

test("support capture ignores chatter and deduplicates repeated reports", () => {
  supportMemory.forgetProgramUser("capture-program", "U-capture");
  context.rememberSupportContext({
    programId: "capture-program",
    userId: "U-capture",
    question: "what a lovely day",
  });
  assert.deepEqual(supportMemory.recall("capture-program", "U-capture"), []);

  const question = "clear-cookies didn't work on Chrome for me";
  context.rememberSupportContext({
    programId: "capture-program",
    userId: "U-capture",
    question,
  });
  context.rememberSupportContext({
    programId: "capture-program",
    userId: "U-capture",
    question,
  });
  const rows = supportMemory.recall("capture-program", "U-capture", 20);
  assert.equal(rows.filter((row) => row.kind === "problem").length, 1);
  assert.equal(rows.filter((row) => row.kind === "attempt").length, 1);
  assert.equal(rows.filter((row) => row.kind === "environment").length, 1);
  assert.equal(new Set(rows.map((row) => row.value)).size, rows.length);
  assert.match(rows.find((row) => row.kind === "environment").value, /Chrome/);
});

test("support capture does not duplicate an utterance as the problem and attempt", () => {
  supportMemory.forgetProgramUser("capture-single-step", "U-capture");
  context.rememberSupportContext({
    programId: "capture-single-step",
    userId: "U-capture",
    question: "restarted",
  });

  const rows = supportMemory.recall("capture-single-step", "U-capture");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "problem");
});

test("seedFromSlack skips the live message and empty texts", async () => {
  const client = {
    conversations: {
      replies: async () => ({
        messages: [
          { ts: "10.1", text: "first question", user: "U1" },
          { ts: "10.2", text: "   ", user: "U2" },
          { ts: "10.3", text: "live question", user: "U1" },
        ],
      }),
    },
  };
  await context.seedFromSlack(client, "C1", "char-seed-1", "UBOT", "10.3");
  const ctx = context.getThreadContext("char-seed-1");
  assert.match(ctx, /first question/);
  assert.doesNotMatch(ctx, /live question/);
  await context.seedFromSlack(client, "C1", "char-seed-1", "UBOT", "10.3");
  assert.equal(context.getThreadContext("char-seed-1"), ctx);
});

test("seedFromSlack failure is non-fatal and still marks seeded", async () => {
  const failing = {
    conversations: {
      replies: async () => {
        throw new Error("channel_not_found");
      },
    },
  };
  await assert.doesNotReject(() => context.seedFromSlack(failing, "C1", "char-seed-fail", "UBOT"));
  assert.equal(context.getThreadContext("char-seed-fail"), null);
});

test("bot messages seed as assistant role", async () => {
  const client = {
    conversations: {
      replies: async () => ({ messages: [{ ts: "20.1", text: "bot reply", user: "UBOT" }] }),
    },
  };
  await context.seedFromSlack(client, "C1", "char-seed-bot", "UBOT");
  assert.match(context.getThreadContext("char-seed-bot"), /assistant: bot reply/);
});

test("threadCrowd: Pixie follows a thread alone only while it is her and one person", () => {
  const BOT = "UBOT";
  const pixie = { user: BOT, ts: "1" };
  const me = (ts: string) => ({ user: "UME", ts });
  const other = (ts: string) => ({ user: "UOTHER", ts });
  assert.deepEqual(context.threadCrowd([me("0"), pixie], "UME", BOT), { pixieIn: true, othersPresent: false });
  assert.deepEqual(context.threadCrowd([me("0"), pixie, other("2")], "UME", BOT), {
    pixieIn: true,
    othersPresent: true,
  });
  assert.deepEqual(
    context.threadCrowd([other("0"), pixie], "UME", BOT),
    { pixieIn: true, othersPresent: true },
    "someone else started it",
  );
  assert.deepEqual(context.threadCrowd([me("0")], "UME", BOT), { pixieIn: false, othersPresent: false });
  assert.equal(context.threadCrowd([{ bot_id: "B1", ts: "1" }], "UME", BOT).pixieIn, true, "bot_id counts as Pixie");
});

test("fetchThreadCrowd falls back to the thread starter when Slack fails", async () => {
  const client = {
    conversations: {
      replies: async () => {
        throw new Error("ratelimited");
      },
    },
  };
  const crowd = await context.fetchThreadCrowd(client, {
    channel: "C1",
    threadTs: "fc.1",
    messageTs: "fc.2",
    userId: "UME",
    botUserId: "UBOT",
    parentUserId: "UOTHER",
  });
  assert.equal(crowd.othersPresent, true);
});

test("seedFromSlack re-seeds a thread whose in-memory transcript was lost", async () => {
  db.touchThread("seed-restart", "C1", { seeded: true });
  let calls = 0;
  const client = {
    conversations: {
      replies: async () => {
        calls += 1;
        return { messages: [{ user: "U1", text: "what is acme", ts: "1" }] };
      },
    },
  };
  await context.seedFromSlack(client, "C1", "seed-restart", "UBOT");
  assert.equal(calls, 1);
  assert.match(context.getThreadContext("seed-restart") || "", /what is acme/);
  await context.seedFromSlack(client, "C1", "seed-restart", "UBOT");
  assert.equal(calls, 1, "a thread with a live transcript is not fetched twice");
});
export {};

test("user topics never cross programs", () => {
  context.updateUserHistory("U-cross", "alpha confidential deadline", true, "prog-a");
  assert.equal(context.getUserContext("U-cross", "prog-b"), null);
  assert.equal(context.getUserContext("U-cross"), null);
  assert.deepEqual(context.getUserContext("U-cross", "prog-a")?.recentTopics.length, 1);
});
