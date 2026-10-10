process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const auth = require("./auth");
const serve = require("./serve");

function asCookie(role: string, userId: string) {
  return { Cookie: `${auth.COOKIE_NAME}=${auth.signSession(userId, "Test", role)}` };
}

test("global log stream rejects a non-admin session", async () => {
  for (const path of ["/api/stream"]) {
    const res = await serve.handleRequest(
      new Request(`http://localhost${path}`, { headers: asCookie("user", "U-plain") }),
    );
    assert.equal(res.status, 403, path);
  }
});

test("global log stream rejects anonymous callers and serves admins", async () => {
  const anon = await serve.handleRequest(new Request("http://localhost/api/stream"));
  assert.equal(anon.status, 401);
  const admin = await serve.handleRequest(
    new Request("http://localhost/api/stream", { headers: asCookie("admin", "admin") }),
  );
  assert.equal(admin.status, 200);
  await admin.body?.cancel();
});
export {};
