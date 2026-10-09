process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const reply = require("./reply");

type MessagePayload = {
  channel?: string;
  ts?: string;
  text?: string;
  blocks?: Array<{ type?: string; text?: { text?: string }; elements?: Array<{ action_id?: string }> }>;
  [key: string]: unknown;
};
type TestClient = {
  calls: { posts: MessagePayload[]; updates: MessagePayload[] };
  chat: {
    postMessage: (payload: MessagePayload) => Promise<{ ts: string }>;
    update: (payload: MessagePayload) => Promise<Record<string, unknown>>;
    delete?: (payload: MessagePayload) => Promise<Record<string, unknown>>;
  };
};

test("an em dash becomes a comma", () => {
  assert.equal(
    reply.plainDashes("PS5 is 11,400 px — that's about 202h at T4"),
    "PS5 is 11,400 px, that's about 202h at T4",
  );
});

test("en dashes and spaced double hyphens go the same way", () => {
  assert.equal(reply.plainDashes("i'm pixie – a helper bot"), "i'm pixie, a helper bot");
  assert.equal(reply.plainDashes("i'm pixie -- a helper bot"), "i'm pixie, a helper bot");
});

test("a dash with no spaces around it is still a dash", () => {
  assert.equal(reply.plainDashes("11,400 px—202h at T4"), "11,400 px, 202h at T4");
});

test("a dash at the edge of a line is dropped, not turned into a comma", () => {
  assert.equal(reply.plainDashes("hang on —"), "hang on");
  assert.equal(reply.plainDashes("— hang on"), "hang on");
  assert.equal(reply.plainDashes("first line —\nsecond line"), "first line\nsecond line");
});

test("no doubled or stranded punctuation is left behind", () => {
  assert.equal(reply.plainDashes("yeah, — that one"), "yeah, that one");
  assert.equal(reply.plainDashes("the price — 11,400 px — is fixed."), "the price, 11,400 px, is fixed.");
  assert.equal(reply.plainDashes("wait — ."), "wait.");
});

test("hyphens inside words and flags are left completely alone", () => {
  const cmd = "run `git commit --amend` then `npm run build -- --watch`";
  assert.equal(reply.plainDashes(cmd), cmd);
  assert.equal(reply.plainDashes("a well-known set-up"), "a well-known set-up");
  assert.equal(reply.plainDashes("- first\n- second"), "- first\n- second");
});

test("code blocks are never rewritten", () => {
  const text = "try this:\n```\nfoo --bar — baz\n```\nand then — you're done";
  assert.equal(reply.plainDashes(text), "try this:\n```\nfoo --bar — baz\n```\nand then, you're done");
});

test("empty and missing text survive", () => {
  assert.equal(reply.plainDashes(""), "");
  assert.equal(reply.plainDashes(null), "");
  assert.equal(reply.plainDashes(undefined), "");
});

function fakeClient(): TestClient {
  const calls: { posts: MessagePayload[]; updates: MessagePayload[] } = { posts: [], updates: [] };
  return {
    calls,
    chat: {
      postMessage: async (payload: MessagePayload) => {
        calls.posts.push(payload);
        return { ts: "posted-1" };
      },
      update: async (payload: MessagePayload) => {
        calls.updates.push(payload);
        return {};
      },
    },
  };
}

test("streaming placeholder uses the full word spinner and stops cleanly", async () => {
  const client = fakeClient();
  assert.equal(reply.STREAMING_WORDS.length, 187);
  assert.equal(reply.STREAMING_WORDS[0], "Accomplishing");
  assert.equal(reply.STREAMING_WORDS.at(-1), "Zigzagging");

  const ts = await reply.postThinking(client, "C1", "spinner-thread");
  assert.equal(ts, "posted-1");
  assert.equal(client.calls.posts[0]?.text, "_Accomplishing..._");

  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAMING_WORD_INTERVAL_MS + 40));
  assert.equal(client.calls.updates[0]?.text, "_Actioning..._");

  await reply.discardPlaceholder(client, "C1", ts);
  const updatesAfterStop = client.calls.updates.length;
  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAMING_WORD_INTERVAL_MS + 40));
  assert.equal(client.calls.updates.length, updatesAfterStop, "discarding the placeholder stops the spinner");
});

test("withReplySignature appends a program's catchphrase to an answer", () => {
  const prog = { id: "demo", replySignature: "stay helpful :demo:" };
  assert.equal(
    reply.withReplySignature("Yes, tier 2 needs a testbench.", prog),
    "Yes, tier 2 needs a testbench.\n\nstay helpful :demo:",
  );
});

test("withReplySignature is idempotent and trims trailing whitespace before appending", () => {
  const prog = { id: "demo", replySignature: "stay helpful :demo:" };
  const once = reply.withReplySignature("answer body", prog);
  assert.equal(reply.withReplySignature(once, prog), once);
  assert.equal(reply.withReplySignature("answer body\n\n", prog), "answer body\n\nstay helpful :demo:");
});

test("withReplySignature is a no-op for a program with no signature, and for empty text", () => {
  assert.equal(reply.withReplySignature("hello", { id: "acme" }), "hello");
  assert.equal(reply.withReplySignature("hello", { id: "acme", replySignature: "   " }), "hello");
  assert.equal(reply.withReplySignature("hello", null), "hello");
  assert.equal(reply.withReplySignature("", { id: "demo", replySignature: "stay helpful :demo:" }), "");
});

test("finalize strips dashes from the text and from the blocks", async () => {
  const client = fakeClient();
  const text = "the price — 11,400 px";
  await reply.finalize(client, "C1", "t1", Promise.resolve(null), text, {
    blocks: reply.blocksFor(text),
  });

  const posted = client.calls.posts[0];
  assert.equal(posted.text, "the price, 11,400 px");
  assert.equal(posted.blocks?.[0]?.text?.text, "the price, 11,400 px");
});

test("streamed fragments are stripped as they go out", async () => {
  const client = fakeClient();
  const writer = reply.makeStreamWriter({
    client,
    channel: "C1",
    ensurePlaceholder: async () => "ts-1",
  });
  writer.write("the price — 11,400");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await writer.settle();

  assert.equal(client.calls.updates.at(-1)?.text, "the price, 11,400");
});

test("the source line pixie appends carries no dash either", () => {
  const line = reply.sourceLineFor("Some Source");
  assert.doesNotMatch(line, /[—–]/);
});

test("muting mid-stream suppresses further edits and the final post", async () => {
  const reply = require("./reply");
  const db = require("./db");
  const updates: MessagePayload[] = [];
  const deletes: MessagePayload[] = [];
  const client = {
    chat: {
      postMessage: async () => ({ ts: "ph-1" }),
      update: async (args: MessagePayload) => {
        updates.push(args);
        return {};
      },
      delete: async (args: MessagePayload) => {
        deletes.push(args);
        return {};
      },
    },
  };
  const writer = reply.makeStreamWriter({
    client,
    channel: "C1",
    ensurePlaceholder: async () => "ph-1",
    threadTs: "mute-stream-1",
  });
  writer.write("partial answer");
  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAM_UPDATE_MS + 50));
  assert.equal(updates.length, 1);

  db.muteThread("mute-stream-1", "C1");
  try {
    writer.write("more answer arriving late");
    await writer.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAM_UPDATE_MS + 50));
    assert.equal(updates.length, 1, "no edit lands after mute");

    const ts = await reply.finalize(client, "C1", "mute-stream-1", Promise.resolve("ph-1"), "finished answer");
    assert.equal(ts, null);
    assert.equal(deletes.length, 1, "hanging placeholder is removed");
  } finally {
    db.unmuteThread("mute-stream-1");
  }
});

test("finalize deletes placeholderTs before posting fresh when chat.update fails", async () => {
  const deletes: MessagePayload[] = [];
  const posts: MessagePayload[] = [];
  const client = {
    chat: {
      update: async () => {
        throw new Error("cant_update_message");
      },
      delete: async (args: MessagePayload) => {
        deletes.push(args);
        return { ok: true };
      },
      postMessage: async (payload: MessagePayload) => {
        posts.push(payload);
        return { ts: "fresh-post-1" };
      },
    },
  };

  const ts = await reply.finalize(client, "C1", "t1", Promise.resolve("ph-old"), "hello world");
  assert.equal(ts, "fresh-post-1");
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0], { channel: "C1", ts: "ph-old" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "hello world");
});

test("discardPlaceholder retries on transient errors with backoff", async () => {
  let attempts = 0;
  const client = {
    chat: {
      delete: async () => {
        attempts++;
        if (attempts < 2) {
          const err = Object.assign(new Error("rate_limited"), { code: "rate_limited" });
          err.code = "rate_limited";
          throw err;
        }
        return { ok: true };
      },
    },
  };

  await reply.discardPlaceholder(client, "C1", "ph-transient");
  assert.equal(attempts, 2);
});

test("discardPlaceholder safely ignores permanent errors without retrying", async () => {
  let attempts = 0;
  const client = {
    chat: {
      delete: async () => {
        attempts++;
        const err = Object.assign(new Error("message_not_found"), { data: { error: "message_not_found" } });
        err.data = { error: "message_not_found" };
        throw err;
      },
    },
  };

  await reply.discardPlaceholder(client, "C1", "ph-missing");
  assert.equal(attempts, 1);
});

test("stripReasoning removes leading safety headers, thinking tags, and scratchpad", () => {
  assert.equal(reply.stripReasoning("<think>internal deliberation</think>Hello world"), "Hello world");
  assert.equal(reply.stripReasoning("<scratchpad>drafting</scratchpad>The answer is 42"), "The answer is 42");
  assert.equal(reply.stripReasoning("Safety Assessment: Safe to answer\nHere is your answer"), "Here is your answer");
  assert.equal(reply.stripReasoning("**Thinking Process:**\nFinal answer here"), "Final answer here");
  assert.equal(reply.stripReasoning("<think>unclosed thought tag"), "");
});

test("finalize strips reasoning and instruction leak from text and blocks", async () => {
  const client = fakeClient();
  const text = "<think>hide this</think>Safety Assessment: Safe\nreal answer";
  await reply.finalize(client, "C1", "t1", Promise.resolve(null), text, {
    blocks: reply.blocksFor(text),
  });

  const posted = client.calls.posts[0];
  assert.equal(posted.text, "real answer");
  assert.equal(posted.blocks?.[0]?.text?.text, "real answer");
});

test("stream re-checks takeover per edit, not just mute", async () => {
  const db = require("./db");
  const updates: MessagePayload[] = [];
  const client = {
    chat: {
      postMessage: async () => ({ ts: "ph-take" }),
      update: async (args: MessagePayload) => {
        updates.push(args);
        return {};
      },
      delete: async () => ({}),
    },
  };
  const writer = reply.makeStreamWriter({
    client,
    channel: "C1",
    ensurePlaceholder: async () => "ph-take",
    threadTs: "take-stream-1",
  });
  writer.write("first fragment");
  await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAM_UPDATE_MS + 50));
  assert.equal(updates.length, 1);
  db.markTakeover("take-stream-1", "C1", "U-helper");
  try {
    writer.write("second fragment after takeover");
    await writer.settle();
    await new Promise<void>((resolve) => setTimeout(resolve, reply.STREAM_UPDATE_MS + 50));
    assert.equal(updates.length, 1, "takeover parks the stream like mute does");
  } finally {
    db.clearTakeover("take-stream-1");
  }
});

test("finalize with no placeholder posts fresh instead of dropping", async () => {
  const client = fakeClient();
  const ts = await reply.finalize(client, "C1", "t-fresh", Promise.resolve(null), "fresh answer here");
  assert.ok(ts, "null placeholder falls back to a fresh post");
  assert.match(client.calls.posts[0].text, /fresh answer here/);
});

test("finalize in shadow mode sends nothing and discards the placeholder", async () => {
  const deletes: number[] = [];
  const posts: MessagePayload[] = [];
  const client = {
    chat: {
      update: async (args: MessagePayload) => {
        posts.push(args);
        return {};
      },
      delete: async () => {
        deletes.push(1);
        return {};
      },
      postMessage: async (args: MessagePayload) => {
        posts.push(args);
        return { ts: "x" };
      },
    },
  };
  const ts = await reply.finalize(client, "C1", "t-shadow", Promise.resolve("ph-s"), "should not send", {
    program: { shadowMode: true },
  });
  assert.equal(ts, null);
  assert.equal(posts.length, 0, "shadow suppresses all sends and updates");
});

test("finalize keeps an answer to a ping in a thread that was already taken over", async () => {
  const db = require("./db");
  const deletes: number[] = [];
  const updates: MessagePayload[] = [];
  const client = {
    chat: {
      update: async (args: MessagePayload) => {
        updates.push(args);
        return {};
      },
      delete: async () => {
        deletes.push(1);
        return {};
      },
      postMessage: async () => ({ ts: "x" }),
    },
  };
  db.markTakeover("take-before-1", "C1", "U-helper");
  try {
    const before = reply.silenceState("take-before-1");
    const ts = await reply.finalize(client, "C1", "take-before-1", Promise.resolve("ph-1"), "the answer", {
      silencedBefore: before,
    });
    assert.equal(ts, "ph-1");
    assert.equal(deletes.length, 0, "the thinking message is overwritten, not deleted");
    assert.match(updates[0].text, /the answer/);
  } finally {
    db.clearTakeover("take-before-1");
  }
});

test("finalize still drops the answer when the thread goes quiet mid-answer", async () => {
  const db = require("./db");
  const deletes: number[] = [];
  const client = {
    chat: {
      update: async () => ({}),
      delete: async () => {
        deletes.push(1);
        return {};
      },
      postMessage: async () => ({ ts: "x" }),
    },
  };
  const before = reply.silenceState("take-during-1");
  db.markTakeover("take-during-1", "C1", "U-helper");
  try {
    const ts = await reply.finalize(client, "C1", "take-during-1", Promise.resolve("ph-2"), "late answer", {
      silencedBefore: before,
    });
    assert.equal(ts, null);
    assert.equal(deletes.length, 1);
  } finally {
    db.clearTakeover("take-during-1");
  }
});
export {};
