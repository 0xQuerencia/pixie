process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./db");
const cache = require("./cache");

db.open(":memory:");

test("normalize collapses punctuation, case, spacing and filler", () => {
  assert.equal(cache.normalize("Whats  the DEADLINE??"), "deadline");
});

test("normalize drops user mentions so a ping does not split the key", () => {
  assert.equal(cache.normalize("<@U0PIXIE> whats the deadline"), "deadline");
});

test("keyFor treats a contraction and its apostrophe form as one question", () => {
  assert.equal(cache.keyFor("What's Restoration Energy?"), cache.keyFor("whats restoration energy"));
  assert.equal(cache.keyFor("wheres the game"), cache.keyFor("where is the game"));
});

test("keyFor is stable across wording noise", () => {
  const a = cache.keyFor("whats the deadline?");
  const b = cache.keyFor("Whats the deadline");
  const c = cache.keyFor("  whats   the  deadline!!  ");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("keyFor preserves the legacy question-only hash when program ID is omitted", () => {
  assert.equal(cache.keyFor("whats the deadline?"), "e23839cd729a3f6017fc6cbf5ef21eeb64d77cdf");
});

test("keyFor survives a reworded question", () => {
  const asked = cache.keyFor("when is the deadline");
  assert.equal(cache.keyFor("the deadline is when?"), asked);
  assert.equal(cache.keyFor("deadline?"), cache.keyFor("deadline"));
});

test("keyFor differs for genuinely different questions", () => {
  assert.notEqual(cache.keyFor("whats the deadline"), cache.keyFor("where do i play"));

  assert.notEqual(cache.keyFor("how do i submit my project"), cache.keyFor("can i submit late"));
});

test("cache keys preserve polarity and cannot reuse an affirmative answer for a negation", () => {
  assert.match(cache.normalize("AI not allowed"), /(^| )not( |$)/);
  assert.match(cache.normalize("AI no longer allowed"), /(^| )no( |$)/);
  assert.match(cache.normalize("AI never allowed"), /(^| )never( |$)/);
  assert.match(cache.normalize("AI cannot be used"), /(^| )cannot( |$)/);
  assert.notEqual(cache.keyFor("AI allowed"), cache.keyFor("AI not allowed"));

  cache.put("AI allowed", { source: "Policy", answer: "yes" }, undefined, "acme");
  assert.equal(cache.get("AI not allowed", "acme"), null);
  assert.deepEqual(cache.get("AI allowed", "acme"), { source: "Policy", answer: "yes" });
});

test("keyFor refuses a question with no meaningful words", () => {
  assert.equal(cache.normalize("what is it"), "");
  assert.equal(cache.keyFor("what is it"), null);

  cache.put("what is it", { source: "Acme FAQ", answer: "nope" });
  assert.equal(cache.get("what is it"), null);
  assert.equal(cache.get("how do you do that"), null);
});

test("get returns null on a miss and the stored result on a hit", () => {
  assert.equal(cache.get("never asked before"), null);

  cache.put("how do i join", { source: "Acme FAQ", answer: "just sign up at play.acme.rsvp" });
  assert.deepEqual(cache.get("How do I join?"), {
    source: "Acme FAQ",
    answer: "just sign up at play.acme.rsvp",
  });
});

test("cache keeps the same normalized question isolated by program ID", () => {
  const question = "when is the deadline?";

  cache.put(question, { source: "Acme FAQ", answer: "august 18" }, undefined, "acme");
  cache.put(question, { source: "Sprig FAQ", answer: "september 30" }, undefined, "sprig");

  assert.notEqual(cache.keyFor(question, "acme"), cache.keyFor(question, "sprig"));
  assert.deepEqual(cache.get(question, "acme"), { source: "Acme FAQ", answer: "august 18" });
  assert.deepEqual(cache.get(question, "sprig"), { source: "Sprig FAQ", answer: "september 30" });
});

test("an aged answer is still served, so a popular question stays instant", () => {
  cache.put("how do i unlock a region", { source: "Acme Docs", answer: "finish the sidequests" });
  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("how do i unlock a region"));

  assert.equal(cache.get("how do i unlock a region").answer, "finish the sidequests");
});

test("an aged timeline answer is refused rather than served", () => {
  cache.put("when does acme launch", { source: "Program timeline", answer: "august 18 — in 21 days" });
  assert.equal(cache.get("when does acme launch").answer, "august 18 — in 21 days");

  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("when does acme launch"));

  assert.equal(cache.get("when does acme launch"), null, "a countdown must never be served from yesterday");
});

test("isVolatile matches the timeline section however it is cased", () => {
  assert.equal(cache.isVolatile("Program timeline"), true);
  assert.equal(cache.isVolatile("  program TIMELINE "), true);
  assert.equal(cache.isVolatile("Acme FAQ"), false);
  assert.equal(cache.isVolatile(null), false);
});

test("keyFor is sha1(programId:sorted tokens) and strictly tenant-isolated", () => {
  const crypto = require("crypto");
  const q = "when is the char deadline?";
  const normalized = cache.normalize(q);
  const expectPlain = crypto.createHash("sha1").update(normalized).digest("hex");
  const expectScoped = crypto.createHash("sha1").update(`char-prog:${normalized}`).digest("hex");
  assert.equal(cache.keyFor(q), expectPlain);
  assert.equal(cache.keyFor(q, "char-prog"), expectScoped);
  assert.notEqual(cache.keyFor(q, "char-prog"), cache.keyFor(q, "other-prog"));

  cache.put(q, { source: "Docs", answer: "august 18" }, undefined, "char-prog-a");
  assert.equal(cache.get(q, "char-prog-b"), null);
  assert.equal(cache.get(q), null);
  assert.deepEqual(cache.get(q, "char-prog-a"), { source: "Docs", answer: "august 18" });
});

test("fresh volatile answers serve but stale volatile answers bypass", () => {
  cache.put("char volatile q", { source: "Program timeline", answer: "launch soon" });
  assert.equal(cache.get("char volatile q").answer, "launch soon");
  db.handle()
    .query("UPDATE answer_cache SET created_at = ?, refreshed_at = ? WHERE question_hash = ?")
    .run(1, 1, cache.keyFor("char volatile q"));
  assert.equal(cache.get("char volatile q"), null);
});

test("cache layer itself is unconditional — !contextPrompt guard lives in the caller", () => {
  cache.put("char unconditional q", { source: "Docs", answer: "stored" });
  assert.ok(cache.get("char unconditional q"));
  assert.equal(cache.put.length >= 2, true);
});
export {};
