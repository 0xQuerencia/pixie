const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planEngagement, finalAction } = require("./messagePolicy");

const settings = { enabled: true, mentionReplies: true, generalMentionChat: true };

function plan(role: string, intent: string, options: Record<string, unknown> = {}) {
  const extraSettings = options.settings;
  return planEngagement({
    role,
    settings: { ...settings, ...(extraSettings && typeof extraSettings === "object" ? extraSettings : {}) },
    addressed: options.addressed ?? true,
    addressedHow: options.addressedHow,
    engagement: { intent, engage: intent !== "unrelated_chatter" && intent !== "human_conversation" },
  });
}

test("implicit 1:1 thread chatter is silent in main and help roles", () => {
  for (const role of ["main", "organizer", "help"]) {
    assert.deepEqual(plan(role, "unrelated_chatter", { addressedHow: "thread" }), {
      proceed: false,
      reason: "thread_chatter",
    });
    assert.deepEqual(plan(role, "human_conversation", { addressedHow: "thread" }), {
      proceed: false,
      reason: "thread_chatter",
    });
  }
});

test("thread program questions still proceed and addressed smalltalk still gets a general reply", () => {
  assert.deepEqual(plan("main", "direct_program_question", { addressedHow: "thread" }), {
    proceed: true,
    kind: "program",
    reason: "addressed_program",
  });
  assert.deepEqual(plan("help", "addressed_smalltalk", { addressedHow: "thread" }), {
    proceed: true,
    kind: "general",
    support: false,
    reason: "addressed_general",
  });
});

test("explicit mentions keep chat behavior on, but general chat off is silent", () => {
  assert.deepEqual(plan("main", "unrelated_chatter", { addressedHow: "mention" }), {
    proceed: true,
    kind: "general",
    reason: "addressed_general",
  });
  assert.deepEqual(
    plan("main", "unrelated_chatter", {
      addressedHow: "mention",
      settings: { generalMentionChat: false },
    }),
    {
      proceed: false,
      reason: "general_chat_off",
    },
  );
});

test("missing provenance keeps legacy mention behavior and DMs are unchanged", () => {
  assert.deepEqual(plan("main", "human_conversation"), {
    proceed: true,
    kind: "general",
    reason: "addressed_general",
  });
  assert.deepEqual(plan("dm", "unrelated_chatter", { addressedHow: "thread" }), {
    proceed: true,
    kind: "general",
    reason: "dm",
  });
});

test("a program question is never answered from ungrounded model text, even on a ping", () => {
  const base = { settings, addressed: true, kind: "program", grounded: false, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "uncertain");
  assert.equal(finalAction({ ...base, role: "dm" }), "uncertain");
  assert.equal(finalAction({ ...base, role: "help" }), "escalate_and_uncertain");
  assert.equal(finalAction({ ...base, role: "help", settings: { ...settings, escalateUnknown: false } }), "uncertain");
});

test("an addressed general chat message still gets a chat reply", () => {
  const base = { settings, addressed: true, kind: "general", grounded: false, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "reply_chat");
});

test("a ping still admits uncertainty when there is nothing to say, or strict grounding is on", () => {
  const base = { settings, role: "main", addressed: true, kind: "program", grounded: false };
  assert.equal(finalAction({ ...base, hasAnswer: false }), "uncertain");
  assert.equal(finalAction({ ...base, hasAnswer: true, unclear: true }), "uncertain");
  assert.equal(finalAction({ ...base, hasAnswer: true, requireGrounded: true }), "uncertain");
  assert.equal(
    finalAction({ ...base, hasAnswer: true, settings: { ...settings, generalMentionChat: false } }),
    "uncertain",
  );
});

test("an unaddressed message never posts an ungrounded answer", () => {
  const base = { settings, addressed: false, kind: "program", grounded: false, hasAnswer: true };
  assert.equal(finalAction({ ...base, role: "main" }), "silence");
  assert.equal(finalAction({ ...base, role: "help" }), "escalate");
});
export {};
