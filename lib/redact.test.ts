const { test } = require("node:test");
const assert = require("node:assert/strict");
const { redactSecrets } = require("./redact");

test("redacts JSON-shaped credentials", () => {
  const out = redactSecrets('help {"password":"hunter-two", "api_key": \'k-123\', "ok": "fine"}');
  assert.doesNotMatch(out, /hunter-two|k-123/);
  assert.match(out, /"ok": "fine"/);
});

test("redacts header, cookie, bearer and token shapes", () => {
  const out = redactSecrets(
    "Authorization: Bearer abc.def\nCookie: sid=1; x=2\ntoken=zzz xoxb-111-222 ghp_abcdef sk-live-123 eyJhbGciOi.eyJzdWIi.sig",
  );
  assert.doesNotMatch(out, /abc\.def|sid=1|zzz|xoxb|ghp_|sk-live|eyJhbGciOi/);
});

test("redacts url userinfo and query secrets", () => {
  const out = redactSecrets("failed https://user:pass@example.com/x?token=TOP_SECRET&ok=1#access_token=abc");
  assert.doesNotMatch(out, /pass@|TOP_SECRET|abc/);
  assert.match(out, /ok=1/);
});

test("leaves ordinary text alone", () => {
  assert.equal(redactSecrets("My login page redirects after sign in"), "My login page redirects after sign in");
});
export {};
