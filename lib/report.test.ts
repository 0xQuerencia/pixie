process.env.PIXIE_DB_PATH = ":memory:";

interface LlmMessage {
  content: string;
}
interface LlmOptions {
  model: string;
  messages: LlmMessage[];
}
interface ThreadReply {
  channel: string;
  ts: string;
}
interface PostedMessage {
  channel?: string;
  text?: string;
  username?: string;
}
type JudgeReply = (question: string) => string | Promise<string>;
type JudgeCheck = (asked: string[]) => unknown | Promise<unknown>;

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const llm = require("./llm");
const { config } = require("./config");
const report = require("./report");
const learn = require("./learn");

db.open(":memory:");

async function withJudge(reply: string | JudgeReply, fn: JudgeCheck) {
  const original = llm.complete;
  const asked: string[] = [];
  llm.complete = async (options: LlmOptions) => {
    const question = (options.messages.at(-1) as LlmMessage).content;
    asked.push(question);
    if (typeof reply === "function") return { text: await reply(question) };
    return { text: reply };
  };
  try {
    return await fn(asked);
  } finally {
    llm.complete = original;
  }
}

test("judgeGap maps each verdict, however the model pads it", async () => {
  await withJudge("DOCS", async () => assert.equal(await report.judgeGap("what are the program rules"), report.DOCS));
  await withJudge("transient\n", async () => assert.equal(await report.judgeGap("is the site down"), report.TRANSIENT));
  await withJudge("NOISE.", async () => assert.equal(await report.judgeGap("marketing as in?"), report.NOISE));
});

test("judgeGap returns null when the model says something unusable", async () => {
  await withJudge("i think probably yes?", async () => assert.equal(await report.judgeGap("anything"), null));
  await withJudge("", async () => assert.equal(await report.judgeGap("anything"), null));
});

test("judgeGap returns null when the call throws", async () => {
  const original = llm.complete;
  llm.complete = async () => {
    throw new Error("model on fire");
  };
  try {
    assert.equal(await report.judgeGap("anything"), null);
  } finally {
    llm.complete = original;
  }
});

test("the judge uses the cheap classifier model, not the answer model", async () => {
  const original = llm.complete;
  let used: string | null = null;
  llm.complete = async (options: LlmOptions) => {
    used = options.model;
    return { text: "DOCS" };
  };
  try {
    await report.judgeGap("anything");
    assert.equal(used, config.intent.model);
  } finally {
    llm.complete = original;
  }
});

test("classifyGaps writes a verdict per gap and leaves unreadable ones alone", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.recordGap("what are the program rules", "U1", "C1");
  db.recordGap("and my pc crashed -_-", "U2", "C1");
  db.recordGap("even sp[aces failed me", "U3", "C1");

  const verdicts: Record<string, string> = {
    "what are the program rules": "DOCS",
    "and my pc crashed -_-": "TRANSIENT",
    "even sp[aces failed me": "???",
  };

  await withJudge(
    (q: string) => verdicts[q],
    async () => {
      assert.equal(await report.classifyGaps({ limit: 10, spacingMs: 0 }), 2);
    },
  );

  const counts = db.gapCountsByKind();
  assert.equal(counts[report.DOCS], 1);
  assert.equal(counts[report.TRANSIENT], 1);
  assert.equal(counts.unjudged, 1, "an unreadable verdict stays unjudged, not guessed");
});

test("classifyGaps stops at the per-pass cap and skips already-judged rows", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  for (let i = 0; i < 5; i++) db.recordGap(`question ${i}`, "U1", "C1");

  await withJudge("DOCS", async (asked: string[]) => {
    assert.equal(await report.classifyGaps({ limit: 2, spacingMs: 0 }), 2);
    assert.equal(asked.length, 2, "the cap is a cap");

    await report.classifyGaps({ limit: 10, spacingMs: 0 });
    assert.equal(asked.length, 5, "the three remaining are picked up, the two done are not re-judged");
  });
});

test("classifyGaps is a no-op with nothing pending", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  await withJudge("DOCS", async (asked: string[]) => {
    assert.equal(await report.classifyGaps({ limit: 5, spacingMs: 0 }), 0);
    assert.deepEqual(asked, []);
  });
});

test("draftDoc returns the drafted text, trimmed", async () => {
  await withJudge("  export as PNG at native size, no upscaling  ", async () => {
    assert.equal(await report.draftDoc("how do i export a sprite"), "export as PNG at native size, no upscaling");
  });
});

test("draftDoc returns null when the model doesn't know or says nothing usable", async () => {
  await withJudge("UNKNOWN", async () => assert.equal(await report.draftDoc("anything"), null));
  await withJudge("unknown.", async () => assert.equal(await report.draftDoc("anything"), null));
  await withJudge("", async () => assert.equal(await report.draftDoc("anything"), null));
});

test("draftDoc returns null when the call throws", async () => {
  const original = llm.complete;
  llm.complete = async () => {
    throw new Error("model on fire");
  };
  try {
    assert.equal(await report.draftDoc("anything"), null);
  } finally {
    llm.complete = original;
  }
});

test("draftDoc uses the answer model, not the cheap classifier", async () => {
  const original = llm.complete;
  let used: string | null = null;
  llm.complete = async (options: LlmOptions) => {
    used = options.model;
    return { text: "an answer" };
  };
  try {
    await report.draftDoc("anything");
    assert.equal(used, config.answer.model);
  } finally {
    llm.complete = original;
  }
});

test("draftDoc grounds the prompt in the corpus, the thread transcript, and the anti-invention guardrail", async () => {
  const original = llm.complete;
  let system: string | null = null;
  llm.complete = async (options: LlmOptions) => {
    system = options.messages[0].content;
    return { text: "an answer" };
  };
  try {
    await report.draftDoc(
      "how do i unlock the next region",
      "### Regions\nFinish your region's ship requirement to unlock the next one.",
      "Q: how do i unlock the next region\nREPLY: finish your ship requirement",
    );
    assert.match(system, /Finish your region's ship requirement/, "corpus reaches the prompt");
    assert.match(system, /Never invent .* fact, number, date, or rule/, "the shared guardrail is included");
  } finally {
    llm.complete = original;
  }
});

test("draftDoc passes the thread transcript alongside the question", async () => {
  const original = llm.complete;
  let userContent: string | null = null;
  llm.complete = async (options: LlmOptions) => {
    userContent = options.messages[1].content;
    return { text: "an answer" };
  };
  try {
    await report.draftDoc("how do i export a sprite", "", "Q: how do i export a sprite\nREPLY: export as PNG");
    assert.match(userContent, /export as PNG/);
  } finally {
    llm.complete = original;
  }
});

test("gatherThreadContext returns nothing without a client — not an error", async () => {
  assert.equal(await report.gatherThreadContext(null, "anything"), "");
});

test("gatherThreadContext pulls the real thread(s) behind a question", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.recordGap("how do i unlock the next region", "U1", "C1", "100.1");

  const fetched: ThreadReply[] = [];
  const client = {
    conversations: {
      replies: async ({ channel, ts }: ThreadReply) => {
        fetched.push({ channel, ts });
        return {
          messages: [
            { text: "how do i unlock the next region" },
            { text: "finish your ship requirement and it opens" },
          ],
        };
      },
    },
  };

  const context = await report.gatherThreadContext(client, "how do i unlock the next region");
  assert.deepEqual(fetched, [{ channel: "C1", ts: "100.1" }]);
  assert.match(context, /finish your ship requirement/);
});

test("gatherThreadContext stays within the gap's program when scoped", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.recordGap("same scoped question", "U1", "C-program-a", "300.1", "report-program-a");
  db.recordGap("same scoped question", "U2", "C-program-b", "300.2", "report-program-b");

  const fetched: ThreadReply[] = [];
  const client = {
    conversations: {
      replies: async ({ channel, ts }: ThreadReply) => {
        fetched.push({ channel, ts });
        return { messages: [{ text: "the answer" }] };
      },
    },
  };

  await report.gatherThreadContext(client, "same scoped question", "report-program-a");
  assert.deepEqual(fetched, [{ channel: "C-program-a", ts: "300.1" }]);
});

test("gatherThreadContext skips a thread whose fetch fails rather than throwing", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.recordGap("does this explode", "U1", "C1", "200.1");

  const client = {
    conversations: {
      replies: async () => {
        throw new Error("channel_not_found");
      },
    },
  };

  assert.equal(await report.gatherThreadContext(client, "does this explode"), "");
});

test("draftGaps queues a PENDING learned fact per unclassified DOCS gap", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  seedGap("how do i export a sprite", report.DOCS);
  seedGap("is the program server down", report.TRANSIENT);

  await withJudge("export as PNG, no upscaling", async () => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 1);
  });

  const rows = learn.pending(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].question, "how do i export a sprite");
  assert.equal(rows[0].answer, "export as PNG, no upscaling");
  assert.equal(rows[0].author_id, null, "a draft has no human author");
});

test("draftGaps carries program ownership and refuses approval for an unowned draft", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  db.recordGap("owned report question", "U1", "C-owned", "owned-gap", "report-owned");
  db.handle().query("UPDATE doc_gaps SET kind = ? WHERE message_ts = ?").run(report.DOCS, "owned-gap");

  await withJudge("owned report answer", async () => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0, programId: "report-owned" }), 1);
  });

  const [owned] = learn.pending(10, "report-owned");
  assert.equal(owned.program_id, "report-owned");
  assert.equal(learn.approve(owned.id), true);

  db.recordGap("unowned report question", "U1", "C-unowned", "unowned-gap");
  db.handle().query("UPDATE doc_gaps SET kind = ? WHERE message_ts = ?").run(report.DOCS, "unowned-gap");
  await withJudge("unowned report answer", async () => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 1);
  });
  const unowned = learn
    .pending(10)
    .find((row: { question: string; program_id: string | null }) => row.question === "unowned report question");
  assert.equal(unowned.program_id, null);
  assert.equal(learn.approve(unowned.id), false);
});

test("draftGaps does not re-draft a gap already queued for review", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  seedGap("how do i join a village", report.DOCS);
  seedGap("how do i join a village", report.DOCS);

  await withJudge("ask in the help channel and a maintainer will add you", async (asked: string[]) => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 1);
    assert.equal(asked.length, 1, "one draft call for the grouped question");

    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 0, "already queued — nothing left to draft");
    assert.equal(asked.length, 1, "no second call on the same gap");
  });
});

test("draftGaps leaves a gap undrafted when the model doesn't know", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  seedGap("what colour is the program logo exactly", report.DOCS);

  await withJudge("UNKNOWN", async () => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 0);
  });
  assert.equal(learn.pending(10).length, 0);
});

test("draftGaps stops at the per-pass cap", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  for (let i = 0; i < 5; i++) seedGap(`question ${i}`, report.DOCS);

  await withJudge("an answer", async (asked: string[]) => {
    assert.equal(await report.draftGaps(null, { limit: 2, spacingMs: 0 }), 2);
    assert.equal(asked.length, 2, "the cap is a cap");
  });
});

test("draftGaps is a no-op with no DOCS gaps", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  seedGap("is the program server down", report.TRANSIENT);
  seedGap("even sp[aces failed me", report.NOISE);

  await withJudge("an answer", async (asked: string[]) => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 0);
    assert.deepEqual(asked, []);
  });
});

test("an approved draft lands in the corpus like any other learned fact", async () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM learned_facts").run();
  seedGap("how do i unlock the next region", report.DOCS, 0, "report-approval");

  await withJudge("finish your current region's ship requirement, then it opens automatically", async () => {
    assert.equal(await report.draftGaps(null, { limit: 5, spacingMs: 0 }), 1);
  });

  const [row] = learn.pending(10);
  assert.equal(learn.approve(row.id), true);
  assert.match(learn.corpusSection("report-approval"), /unlock the next region/);
});

function seedGap(question: string, kind: string, agoMs = 0, programId: string | null = null) {
  db.recordGap(question, "U1", "C1", null, programId);
  const id = db.handle().query("SELECT MAX(id) AS id FROM doc_gaps").get().id;
  db.handle()
    .query("UPDATE doc_gaps SET kind = ?, created_at = ? WHERE id = ?")
    .run(kind, Date.now() - agoMs, id);
}

function seedMetric(kind: string, agoMs = 0) {
  db.recordMetric(kind, 1000);
  const id = db.handle().query("SELECT MAX(id) AS id FROM metrics").get().id;
  db.handle()
    .query("UPDATE metrics SET created_at = ? WHERE id = ?")
    .run(Date.now() - agoMs, id);
}

test("the report lists docs gaps and never the ones that aren't docs problems", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();

  seedGap("who are the program organizers", report.DOCS);
  seedGap("who are the program organizers", report.DOCS);
  seedGap("how do i be an org", report.DOCS);
  seedGap("is the program server down", report.TRANSIENT);
  seedGap("my pfp is bugged sometimes", report.TRANSIENT);
  seedGap("even sp[aces failed me", report.NOISE);
  seedMetric("answer_docs");
  seedMetric("answer_chat");

  const text = report.reportText(0);

  assert.match(text, /who are the program organizers/);
  assert.match(text, /how do i be an org/);
  assert.match(text, /2×/, "identical asks are grouped and counted");

  assert.doesNotMatch(text, /server down/, "a transient problem is not a docs gap");
  assert.doesNotMatch(text, /pfp is bugged/);
  assert.doesNotMatch(text, /sp\[aces/);
  assert.match(text, /\*3\* were one-off problems or chatter/);
});

test("the report shows the week-on-week change in coverage", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();

  const lastWeek = 10 * 24 * 60 * 60 * 1000;
  seedMetric("answer_docs", lastWeek);
  for (let i = 0; i < 3; i++) seedMetric("answer_chat", lastWeek);
  for (let i = 0; i < 3; i++) seedMetric("answer_docs");
  seedMetric("answer_chat");

  assert.match(report.reportText(0), /\*75%\* straight from the docs \(\+50 vs the week before\)/);
});

test("the report says so plainly when nothing was asked", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  assert.match(report.reportText(0), /nobody asked pixie anything this week/);
});

test("an unjudged backlog is reported as unsorted rather than silently dropped", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  seedMetric("answer_docs");
  db.recordGap("not judged yet", "U1", "C1");

  assert.match(report.reportText(0), /\*1\* not sorted yet/);
});

test("lastBoundary lands on the most recent Monday 09:00", () => {
  const boundary = new Date(report.lastBoundary(new Date(2026, 6, 29, 14, 30)));
  assert.equal(boundary.getDay(), 1);
  assert.equal(boundary.getHours(), 9);
  assert.equal(boundary.getDate(), 27);
});

test("lastBoundary rolls back a week when the boundary hasn't passed yet", () => {
  const boundary = new Date(report.lastBoundary(new Date(2026, 6, 27, 8, 0)));
  assert.equal(boundary.getDate(), 20);
  assert.equal(boundary.getHours(), 9);
});

test("a report is due once per week and not twice after a restart", async () => {
  db.handle().query("DELETE FROM metrics").run();
  db.handle().query("DELETE FROM doc_gaps").run();
  config.reportChannel = "C_REPORT";
  assert.equal(report.isReportDue(), true, "never sent — due");

  const posts: PostedMessage[] = [];
  const client = {
    chat: {
      postMessage: async (payload: PostedMessage) => {
        posts.push(payload);
        return { ts: "1" };
      },
    },
  };

  await report.postWeekly(client);
  assert.equal(posts.length, 1);
  assert.equal(report.isReportDue(), false, "just sent — not due again");

  await report.tick(client);
  assert.equal(posts.length, 1, "a restart must not repost the same week");

  db.handle()
    .query("UPDATE metrics SET created_at = ? WHERE kind = ?")
    .run(Date.now() - 30 * 24 * 60 * 60 * 1000, report.SENT_METRIC);
  assert.equal(report.isReportDue(), true);
});

test("a post that throws leaves the report due", async () => {
  db.handle().query("DELETE FROM metrics").run();
  config.reportChannel = "C_REPORT";
  const client = {
    chat: {
      postMessage: async () => {
        throw new Error("slack said no");
      },
    },
  };

  await assert.rejects(() => report.postWeekly(client), /slack said no/);
  assert.equal(report.isReportDue(), true);
});

test("with no channel configured the weekly post is skipped, not attempted", async () => {
  const originalReport = config.reportChannel;
  const originalHelp = config.slack.helpChannel;
  config.reportChannel = null;
  config.slack.helpChannel = null;

  try {
    assert.equal(report.reportChannel(), null);
    assert.equal(await report.postWeekly({}), false, "no client call at all");
  } finally {
    config.reportChannel = originalReport;
    config.slack.helpChannel = originalHelp;
  }
});

test("no trend is shown when the previous week has no data", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  seedMetric("answer_docs");
  seedMetric("answer_chat");

  const text = report.reportText(0);
  assert.match(text, /\*50%\* straight from the docs\./);
  assert.doesNotMatch(text, /vs the week before/);
  assert.doesNotMatch(text, /against 0 the week before/);
});

test("reportChannel prefers explicit config over the help channel", () => {
  const savedReport = config.reportChannel;
  const savedHelp = config.slack.helpChannel;
  try {
    config.reportChannel = "C-REPORT";
    config.slack.helpChannel = "C-HELP";
    assert.equal(report.reportChannel(), "C-REPORT");
    config.reportChannel = null;
    assert.equal(report.reportChannel(), "C-HELP");
  } finally {
    config.reportChannel = savedReport;
    config.slack.helpChannel = savedHelp;
  }
});

test("collect windows are exactly one week and coverage is docs/total", () => {
  db.handle().query("DELETE FROM doc_gaps").run();
  db.handle().query("DELETE FROM metrics").run();
  seedMetric("answer_docs");
  seedMetric("answer_docs");
  seedMetric("answer_chat");
  const week = report.collect(0);
  assert.equal(week.answered.docs, 2);
  assert.equal(week.answered.total, 3);
  assert.equal(week.coverage, 67);
  assert.equal(report.WEEK_MS, 7 * 24 * 60 * 60 * 1000);
});

test("judge verdicts are case/padding-insensitive, unknowns stay null", async () => {
  await withJudge("  docs. ", async () => assert.equal(await report.judgeGap("q"), report.DOCS));
  await withJudge("Noise...", async () => assert.equal(await report.judgeGap("q"), report.NOISE));
  await withJudge("maybe transient-ish", async () => assert.equal(await report.judgeGap("q"), null));
});

test("draftSourceTs namespaces synthetic rows off the Slack ts space", () => {
  assert.match(report.draftSourceTs(42), /^gap-draft:42$/);
  assert.doesNotMatch(report.draftSourceTs(42), /^\d+\.\d+$/);
});
export {};
