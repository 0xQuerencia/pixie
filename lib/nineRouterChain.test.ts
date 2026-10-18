const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function chain(env: Record<string, string>, key = "helpAnswer") {
  const script = `const {config}=require(${JSON.stringify(path.join(__dirname, "config"))});
    const out=[];let t=config.${key};while(t){out.push(t.baseUrl+"|"+t.model);t=t.fallback;}
    console.log(JSON.stringify(out));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    env: {
      PATH: process.env.PATH || "",
      OPENCODE_API_KEY: "zen-test",
      HCAI_API_KEY: "hcai-test",
      OPENROUTER_API_KEY: "or-test",
      PIXIE_ANSWER_BASE_URL: "http://router.test/v1",
      ...env,
    },
  });
  return JSON.parse(run.stdout.toString().trim().split("\n").pop() || "[]") as string[];
}

test("help answers stay on Nine Router by default, even with other provider keys set", () => {
  const hops = chain({});
  assert.ok(hops.length >= 1);
  for (const hop of hops) assert.match(hop, /^http:\/\/router\.test\/v1\|/);
});

test("ping answers also stay on Nine Router", () => {
  for (const hop of chain({}, "pingAnswer")) assert.match(hop, /^http:\/\/router\.test\/v1\|/);
});

test("PIXIE_ANSWER_PROVIDER=hcai never reroutes program answers off Nine Router", () => {
  for (const key of ["helpAnswer", "pingAnswer"]) {
    for (const hop of chain({ PIXIE_ANSWER_PROVIDER: "hcai" }, key)) assert.match(hop, /^http:\/\/router\.test\/v1\|/);
  }
});

test("PIXIE_ANSWER_ALLOW_FALLBACK=1 reopens the off-router fallbacks", () => {
  const hops = chain({ PIXIE_ANSWER_ALLOW_FALLBACK: "1" });
  assert.ok(hops.some((hop) => !hop.startsWith("http://router.test/v1|")));
});

test("chat uses Nine Router unless PIXIE_ANSWER_PROVIDER=hcai", () => {
  assert.match(chain({}, "answer")[0], /^http:\/\/router\.test\/v1\|/);
  assert.match(chain({ PIXIE_ANSWER_PROVIDER: "hcai" }, "answer")[0], /hack|hcai|ai\.hackclub/i);
});

export {};
