process.env.PIXIE_DB_PATH = ":memory:";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const intent = require("./intent");
const llm = require("./llm");
const db = require("./db");
const { worthClassifying, looksLikeHelpRequest, buildUserPrompt, HISTORY_LIMIT } = intent;

try {
  db.open(":memory:");
} catch (_) {}

test("worthClassifying sends anything with words in it to the model", () => {
  assert.equal(worthClassifying("how do i submit my project?"), true);
  assert.equal(worthClassifying("my build broke"), true);
  assert.equal(worthClassifying("```TypeError: undefined is not a function```"), true);
  assert.equal(worthClassifying("imagine if the whole thing was written in rust"), true);
  assert.equal(worthClassifying("lol thanks so much for that"), true);
  assert.equal(worthClassifying("wait WHAT IF I JS GET 60 DIFFERENT API KEYS"), true);
  assert.equal(worthClassifying("still nothing"), true);
});

test("worthClassifying drops messages that say nothing at all", () => {
  assert.equal(worthClassifying(""), false);
  assert.equal(worthClassifying(undefined), false);
  assert.equal(worthClassifying("   "), false);
  assert.equal(worthClassifying("ok"), false);
  assert.equal(worthClassifying("lmaooo"), false);
  assert.equal(worthClassifying("gg"), false);
  assert.equal(worthClassifying("yeah true"), false);
  assert.equal(worthClassifying("lol same"), false);
});

test("worthClassifying looks past emoji, pings and links", () => {
  assert.equal(worthClassifying(":yay: :sho: :pf:"), false);
  assert.equal(worthClassifying("<@U123>"), false);
  assert.equal(worthClassifying(":upvote: thanks"), false);
  assert.equal(worthClassifying("<@U123> my tileset wont render"), true);
});

test("worthClassifying keeps a real message that opens with a reaction word", () => {
  assert.equal(worthClassifying("ok so where do i put the token"), true);
  assert.equal(worthClassifying("nah the build still fails after that"), true);
  assert.equal(worthClassifying("w or l on using godot for this"), true);
});

test("a scoped program gets the OFF_TOPIC verdict offered", () => {
  const prompt = intent.intentSystemPrompt({ name: "Acme" }, { scoped: true });
  assert.match(prompt, /OFF_TOPIC/);
  assert.match(prompt, /HELP_NEEDED\|CASUAL_CHAT\|OFF_TOPIC/);
  assert.match(prompt, /only wants Acme answers/);
  assert.match(prompt, /asking about the shop, catalogue, items/);
  assert.match(prompt, /asking about hardware, firmware, testing/);
  assert.match(prompt, /cannot tell whether a question is about Acme.*OFF_TOPIC/s);
});

test("an unscoped program is never offered OFF_TOPIC", () => {
  const prompt = intent.intentSystemPrompt({ name: "Acme" });
  assert.doesNotMatch(prompt, /OFF_TOPIC/);
  assert.match(prompt, /exactly one JSON object/);
});

test("addressing pixie lifts the scope restriction", () => {
  const scoped = { id: "acme", name: "Acme", scope: "program" };
  const open = { id: "sprig", name: "Sprig", scope: "any" };

  assert.equal(intent.scopedFor(scoped, false), true, "unaddressed in a scoped program");
  assert.equal(intent.scopedFor(scoped, true), false, "they asked her directly");
  assert.equal(intent.scopedFor(open, false), false, "an open program never scopes");
  assert.equal(intent.scopedFor(null, false), false);
});

test("buildUserPrompt puts the history first and the message under judgement last", () => {
  const prompt = buildUserPrompt("still nothing", ["my build broke", "tried reinstalling"]);
  assert.match(prompt, /oldest first/);
  assert.match(prompt, /1\. \[human\] my build broke/);
  assert.match(prompt, /2\. \[human\] tried reinstalling/);
  assert.match(prompt, /The message to judge \(human, not context\):\n\[human\] still nothing$/);
});

test("buildUserPrompt says so plainly when there is no history", () => {
  const prompt = buildUserPrompt("how do i connect hackatime", []);
  assert.match(prompt, /no context available/);
  assert.match(prompt, /\[human\] how do i connect hackatime$/);
});

test("HISTORY_LIMIT is three — enough to see what someone is in the middle of", () => {
  assert.equal(HISTORY_LIMIT, 3);
});

test("looksLikeHelpRequest accepts someone asking the room for something", () => {
  assert.equal(looksLikeHelpRequest("how do i connect hackatime"), true);
  assert.equal(looksLikeHelpRequest("how do i go to the shop"), true);
  assert.equal(looksLikeHelpRequest("how do i test my firmware if i don't have hardware yet"), true);
  assert.equal(looksLikeHelpRequest("anyone know why this wont build"), true);
  assert.equal(looksLikeHelpRequest("should i use godot or unity for this"), true);
  assert.equal(looksLikeHelpRequest("where do i submit"), true);
  assert.equal(looksLikeHelpRequest("my sprite sheet is broken"), true);
  assert.equal(looksLikeHelpRequest("```ReferenceError: x is not defined```"), true);
});

test("looksLikeHelpRequest rejects small talk and riffing", () => {
  assert.equal(looksLikeHelpRequest("hi guys"), false);
  assert.equal(looksLikeHelpRequest("whats up everyone"), false);
  assert.equal(looksLikeHelpRequest("imagine if the whole thing was written in rust"), false);
  assert.equal(looksLikeHelpRequest("gonna rewrite this tonight"), false);
  assert.equal(looksLikeHelpRequest("this shop pricing is so unbalanced ngl"), false);
  assert.equal(looksLikeHelpRequest(""), false);
  assert.equal(looksLikeHelpRequest(undefined), false);
});

test("looksLikeHelpRequest rejects a fragment ending in a bare contraction", () => {
  assert.equal(looksLikeHelpRequest("ridit isn't"), false);
  assert.equal(looksLikeHelpRequest("nah it wont"), false);
  assert.equal(looksLikeHelpRequest("i cant"), false);
});

test("looksLikeHelpRequest accepts a contraction that names what is failing", () => {
  assert.equal(looksLikeHelpRequest("my sprite wont load"), true);
  assert.equal(looksLikeHelpRequest("the editor isnt showing my tiles"), true);
  assert.equal(looksLikeHelpRequest("hackatime doesnt connect for me"), true);
});

test("looksLikeHelpRequest rejects fragments but not short code", () => {
  assert.equal(looksLikeHelpRequest("stuck lol"), false);
  assert.equal(looksLikeHelpRequest("build broke"), false);
  assert.equal(looksLikeHelpRequest("```segfault```"), true);
});

test("short HELP_ONLY inputs pin current verdict", async () => {
  assert.equal(worthClassifying("how"), false);
  assert.equal(worthClassifying("what"), false);
  assert.equal(worthClassifying("ok"), false);
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("what"), false);
  assert.equal(looksLikeHelpRequest("ok"), false);
  assert.equal(await intent.classifyIntent("how", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("what", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("ok", null, { history: [] }), null);
});

test("duplicate-text history pins current context", async () => {
  process.env.PIXIE_DB_PATH = ":memory:";
  const db = require("./db");
  try {
    db.open(":memory:");
  } catch (_) {}
  const user = `char-dup-${Date.now()}`;
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "my build broke" });
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "still nothing" });
  db.recordUserMessage({ userId: user, channel: "C1", threadTs: "1.1", text: "still nothing" });
  const recent = db.recentUserMessages(user, { channel: "C1", limit: 3 });
  assert.deepEqual(
    recent.map((r: any) => r.text),
    ["my build broke", "still nothing", "still nothing"],
  );
  const rows = recent.map((r: any) => (r.text || "").trim()).filter(Boolean);
  const current = "still nothing";
  if (rows.length > 0 && rows[rows.length - 1] === current.trim()) rows.pop();
  assert.deepEqual(rows.slice(-intent.HISTORY_LIMIT), ["my build broke", "still nothing"]);
  assert.equal(worthClassifying("still nothing"), true);
  const prompt = intent.buildUserPrompt("still nothing", ["my build broke", "still nothing"]);
  assert.match(prompt, /1\. \[human\] my build broke/);
  assert.match(prompt, /2\. \[human\] still nothing/);
});

test("buildUserPrompt preserves bounded thread and recent speaker boundaries", () => {
  const prompt = intent.buildUserPrompt("please help Pixie", [], {
    threadMessages: [
      { speaker: "human", text: "my build fails" },
      { speaker: "pixie", text: "What error do you see?" },
    ],
    recentMessages: [{ userId: "U1", text: "talking to another human" }],
  });
  assert.match(prompt, /Thread context/);
  assert.match(prompt, /\[pixie\] What error do you see\?/);
  assert.match(prompt, /Recent channel context/);
  assert.match(prompt, /\[human\] talking to another human/);
  assert.match(prompt, /\[human\] please help Pixie$/);
});

test("parseContextResult is strict and fails closed", () => {
  const valid =
    '{"verdict":"HELP_NEEDED","addressedToPixie":true,"directedAtHuman":false,"recentPixieParticipation":true,"programRelevance":"relevant"}';
  assert.deepEqual(intent.parseContextResult(valid), {
    verdict: "HELP_NEEDED",
    addressedToPixie: true,
    directedAtHuman: false,
    recentPixieParticipation: true,
    programRelevance: "relevant",
  });
  assert.equal(intent.parseContextResult("HELP_NEEDED"), null);
  assert.equal(intent.parseContextResult(`${valid.slice(0, -1)},"extra":true}`), null);
  assert.equal(intent.parseContextResult(valid.replace("true", '"true"')), null);
});

test("parseContextResult tolerates a markdown code fence and surrounding prose", () => {
  const obj = {
    verdict: "HELP_NEEDED",
    addressedToPixie: false,
    directedAtHuman: false,
    recentPixieParticipation: false,
    programRelevance: "relevant",
  };
  const body = JSON.stringify(obj, null, 2);
  assert.deepEqual(intent.parseContextResult("```json\n" + body + "\n```"), obj);
  assert.deepEqual(intent.parseContextResult("```\n" + body + "\n```"), obj);
  assert.deepEqual(intent.parseContextResult("Here is the JSON:\n" + body), obj);
  assert.equal(intent.parseContextResult('```json\n{"verdict":"MAYBE"}\n```'), null);
});

test("a fenced HELP_NEEDED verdict still reaches shouldAttemptAnswer", () => {
  const fenced =
    "```json\n" +
    JSON.stringify({
      verdict: "HELP_NEEDED",
      addressedToPixie: false,
      directedAtHuman: false,
      recentPixieParticipation: false,
      programRelevance: "relevant",
    }) +
    "\n```";
  const norm = intent.normalizeIntentResult(intent.parseContextResult(fenced));
  assert.equal(norm.shouldAttemptAnswer, true);
});

test("structured intent is enriched into the canonical engagement decision", () => {
  const support = intent.normalizeIntentResult({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    recentPixieParticipation: true,
    programRelevance: "relevant",
  });
  assert.equal(support.needsHelp, true);
  assert.equal(support.shouldAttemptAnswer, true);
  assert.equal(support.recentPixieParticipation, true);

  const human = intent.normalizeIntentResult({
    verdict: intent.HELP_NEEDED,
    addressedToPixie: false,
    directedAtHuman: true,
    recentPixieParticipation: false,
    programRelevance: "relevant",
  });
  assert.equal(human.shouldAttemptAnswer, false);

  assert.equal(intent.normalizeIntentResult(intent.HELP_NEEDED).shouldAttemptAnswer, true);
  assert.equal(intent.normalizeIntentResult(intent.CASUAL_CHAT).shouldAttemptAnswer, false);
  assert.equal(intent.normalizeIntentResult(null), null);
});

test("short-input ticket gate pins current", () => {
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("ok"), false);
  assert.equal(null !== intent.HELP_NEEDED, true);
});

test("short-input: length<5 fail-softs to null", async () => {
  assert.equal(await intent.classifyIntent("how", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("ab", null, { history: [] }), null);
  assert.equal(await intent.classifyIntent("abcd", null, { history: [] }), null);
  assert.notEqual(null, intent.HELP_NEEDED);
  assert.equal(looksLikeHelpRequest("how"), false);
  assert.equal(looksLikeHelpRequest("abcd"), false);
});

{
  let realComplete: any;
  before(() => {
    realComplete = llm.complete;
  });
  after(() => {
    llm.complete = realComplete;
  });

  test("unparseable classifier output records intent_parse_failure and fails soft to null", async () => {
    const baseline = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    llm.complete = async () => ({ text: "I think this is HELP_NEEDED, definitely." });
    const verdict = await intent.classifyIntent("how do i submit my project to acme", null, { history: [] });
    assert.equal(verdict, null, "a bad parse fails soft, never a guessed verdict");
    const after = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    assert.equal(after, baseline + 1);
  });

  test("a fenced-but-valid verdict parses and records no parse failure", async () => {
    const baseline = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    llm.complete = async () => ({
      text:
        "```json\n" +
        JSON.stringify({
          verdict: "HELP_NEEDED",
          addressedToPixie: false,
          directedAtHuman: false,
          recentPixieParticipation: false,
          programRelevance: "relevant",
        }) +
        "\n```",
    });
    const verdict = await intent.classifyIntent("how do i submit my project to acme", null, { history: [] });
    assert.equal(verdict, "HELP_NEEDED");
    const after = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    assert.equal(after, baseline);
  });

  test("noTelemetry suppresses classifier failure metrics", async () => {
    const baseline = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    llm.complete = async () => ({ text: "not structured" });
    const verdict = await intent.classifyIntent("how do i submit my project to acme", null, {
      history: [],
      noTelemetry: true,
    });
    assert.equal(verdict, null);
    const after = db.handle().query("SELECT COUNT(*) c FROM metrics WHERE kind = 'intent_parse_failure'").get().c;
    assert.equal(after, baseline);
  });
}
export {};
