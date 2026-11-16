const test = require("node:test");
const assert = require("node:assert/strict");
const relatedThreads = require("./relatedThreads");
const db = require("./db");

test("isSimpleLookupQuestion identifies simple link and navigation lookups", () => {
  assert.equal(relatedThreads.isSimpleLookupQuestion("where is the dashboard"), true);
  assert.equal(relatedThreads.isSimpleLookupQuestion("where do i go for the docs"), true);
  assert.equal(relatedThreads.isSimpleLookupQuestion("what is the link to the docs"), true);
  assert.equal(relatedThreads.isSimpleLookupQuestion("what's the website url"), true);
  assert.equal(relatedThreads.isSimpleLookupQuestion("what is the deadline"), true);
  assert.equal(relatedThreads.isSimpleLookupQuestion("hi"), true);
});

test("isSimpleLookupQuestion identifies direct calculation results", () => {
  assert.equal(relatedThreads.isSimpleLookupQuestion("how many hours for macbook", { direct: true }), true);
});

test("isSimpleLookupQuestion allows nuanced and troubleshooting questions", () => {
  assert.equal(relatedThreads.isSimpleLookupQuestion("how do i fix sprite rendering artifacts in Godot export"), false);
  assert.equal(relatedThreads.isSimpleLookupQuestion("can i change my project idea midway through the program"), false);
  assert.equal(relatedThreads.isSimpleLookupQuestion("is custom hardware allowed if i built the PCB myself"), false);
});

test("tokenize cleans text and drops stop words", () => {
  const tokens = relatedThreads.tokenize("how do I fix the Godot web export error?");
  assert.ok(tokens.includes("fix"));
  assert.ok(tokens.includes("godot"));
  assert.ok(tokens.includes("web"));
  assert.ok(tokens.includes("export"));
  assert.ok(tokens.includes("error"));
  assert.ok(!tokens.includes("how"));
  assert.ok(!tokens.includes("the"));
});

test("buildSlackPermalink uses only trusted configured workspace domains", () => {
  const old = process.env.PIXIE_SLACK_WORKSPACE_URL;
  try {
    delete process.env.PIXIE_SLACK_WORKSPACE_URL;
    assert.equal(relatedThreads.buildSlackPermalink("C0MAIN00001", "1788107539.615819"), null);
    process.env.PIXIE_SLACK_WORKSPACE_URL = "https://example.slack.com";
    assert.equal(
      relatedThreads.buildSlackPermalink("C0MAIN00001", "1788107539.615819"),
      "https://example.slack.com/archives/C0MAIN00001/p1788107539615819",
    );
    process.env.PIXIE_SLACK_WORKSPACE_URL = "https://hackclub.slack.com";
    assert.match(relatedThreads.buildSlackPermalink("C0MAIN00001", "1788107539.615819"), /hackclub\.slack\.com/);
    for (const unsafe of [
      "http://example.slack.com",
      "https://example.slack.com.evil.test",
      "https://user@example.slack.com",
      "https://example.slack.com:8443",
    ]) {
      process.env.PIXIE_SLACK_WORKSPACE_URL = unsafe;
      assert.equal(relatedThreads.buildSlackPermalink("C0MAIN00001", "1788107539.615819"), null);
    }
  } finally {
    if (old === undefined) delete process.env.PIXIE_SLACK_WORKSPACE_URL;
    else process.env.PIXIE_SLACK_WORKSPACE_URL = old;
  }
});

test("findRelatedThread finds past thread and ignores current active thread", async () => {
  const old = process.env.PIXIE_SLACK_WORKSPACE_URL;
  process.env.PIXIE_SLACK_WORKSPACE_URL = "https://example.slack.com";
  try {
    db.open(":memory:");
    db.recordAnsweredThread({
      question: "how to fix a web export error",
      channel: "C0HELP00001",
      threadTs: "1788100100.111111",
    });
  
    const simple = await relatedThreads.findRelatedThread("where is the dashboard", {
      currentThreadTs: "1788200000.222222",
      channel: "C0HELP00001",
    });
    assert.equal(simple, null);
  
    const selfMatch = await relatedThreads.findRelatedThread("web export error", {
      currentThreadTs: "1788100100.111111",
      channel: "C0MAIN00001",
    });
    assert.equal(selfMatch, null);
  
    const match = await relatedThreads.findRelatedThread("how do i fix the web export error on chrome", {
      currentThreadTs: "1788200000.222222",
      channel: "C0MAIN00001",
    });
    assert.notEqual(match, null);
    assert.equal(match.channel, "C0HELP00001");
    assert.equal(match.threadTs, "1788100100.111111");
    assert.ok(match.permalink.includes("p1788100100111111"));
  
    const line = relatedThreads.formatRelatedThreadLine(match);
    assert.ok(line.includes("Related discussion:"));
    assert.ok(line.includes("view previous thread"));
  } finally {
    if (old === undefined) delete process.env.PIXIE_SLACK_WORKSPACE_URL;
    else process.env.PIXIE_SLACK_WORKSPACE_URL = old;
  }
});

test("thin token queries never match", async () => {
  assert.equal(await relatedThreads.findRelatedThread("", { currentThreadTs: "x" }), null);
  assert.equal(await relatedThreads.findRelatedThread("supercalifragilistic", { currentThreadTs: "x" }), null);
});

test("similarity needs two shared tokens — single-word overlap is zero", () => {
  assert.equal(relatedThreads.calculateTokenSimilarity(["web"], ["web", "export", "error"]), 0);
  assert.ok(relatedThreads.calculateTokenSimilarity(["web", "export"], ["web", "export", "error"]) > 0);
});

test("malformed thread ts yields no permalink and empty line", () => {
  assert.equal(relatedThreads.buildSlackPermalink("C1", "not-a-ts"), null);
  assert.equal(relatedThreads.buildSlackPermalink(null, "1.2"), null);
  assert.equal(relatedThreads.formatRelatedThreadLine(null), "");
  assert.equal(relatedThreads.formatRelatedThreadLine({}), "");
});

test("tokenize drops short tokens and punctuation", () => {
  assert.deepEqual(relatedThreads.tokenize("a be go!"), []);
  assert.ok(
    relatedThreads.tokenize("PCB-order stuck?").includes("pcb-order") ||
      relatedThreads.tokenize("PCB-order stuck?").includes("pcb"),
  );
});
export {};
