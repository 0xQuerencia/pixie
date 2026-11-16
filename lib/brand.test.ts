process.env.PIXIE_DB_PATH = ":memory:";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const brand = require("./brand");

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("with nothing set, the bot is still pixie", () => {
  withEnv({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(brand.name(), "pixie");
    assert.equal(brand.slug(), "pixie");
    assert.equal(brand.cmd(), "/pixie");
    assert.equal(brand.cmd("teach"), "/pixie-teach");
  });
});

test("a bot's name and slug drive its commands", () => {
  withEnv({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(brand.name(), "Sol");
    assert.equal(brand.cmd(), "/sol");
    assert.equal(brand.cmd("gaps"), "/sol-gaps");
  });
});

test("the slug is derived from the name when only the name is set", () => {
  withEnv({ PIXIE_BOT_NAME: "Athena", PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(brand.slug(), "athena");
    assert.equal(brand.cmd("teach"), "/athena-teach");
  });
});

test("a display name with spaces or caps is slugified before becoming a command", () => {
  withEnv({ PIXIE_BOT_NAME: "Sol Helper Bot", PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(brand.slug(), "sol-helper-bot");
    assert.equal(brand.cmd(), "/sol-helper-bot");
  });
});

test("punctuation is stripped rather than passed into a command name", () => {
  withEnv({ PIXIE_BOT_SLUG: "Solvable! YSWS (2026)" }, () => {
    assert.equal(brand.slug(), "solvable-ysws-2026");
  });
});

test("a slug that slugifies to nothing falls back rather than producing '/'", () => {
  withEnv({ PIXIE_BOT_SLUG: "!!!" }, () => {
    assert.equal(brand.slug(), "pixie");
    assert.equal(brand.cmd(), "/pixie");
  });
});

test("an empty or whitespace value is treated as unset", () => {
  withEnv({ PIXIE_BOT_NAME: "   ", PIXIE_BOT_SLUG: "" }, () => {
    assert.equal(brand.name(), "pixie");
    assert.equal(brand.slug(), "pixie");
  });
});

test("payload ids are underscored", () => {
  withEnv({ PIXIE_BOT_SLUG: "sol-helper" }, () => {
    assert.equal(brand.id("teach_thread"), "sol_helper_teach_thread");
  });
});

test("brand values are read per call, not captured at require time", () => {
  withEnv({ PIXIE_BOT_SLUG: "first" }, () => {
    assert.equal(brand.cmd(), "/first");
  });
  withEnv({ PIXIE_BOT_SLUG: "second" }, () => {
    assert.equal(brand.cmd(), "/second");
  });
});

test("defaults are the pixie identity", () => {
  withEnv({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(brand.name(), brand.DEFAULT_NAME);
    assert.equal(brand.slug(), brand.DEFAULT_SLUG);
  });
});

test("rebranded commands carry no pixie residue", () => {
  withEnv({ PIXIE_BOT_NAME: "Sol", PIXIE_BOT_SLUG: "sol" }, () => {
    assert.doesNotMatch(brand.cmd(), /pixie/);
    assert.doesNotMatch(brand.cmd("teach"), /pixie/);
    assert.doesNotMatch(brand.id("teach_thread"), /pixie/);
  });
});

test("cmd with empty suffix is the bare ask command", () => {
  withEnv({ PIXIE_BOT_SLUG: "sol" }, () => {
    assert.equal(brand.cmd(""), "/sol");
    assert.match(brand.cmd("report"), /^\/sol-report$/);
  });
});
export {};

test("generated Slack manifest respects configured command prefix and shortcut length", () => {
  const manifest = require("../scripts/manifest.cjs").manifest;
  withEnv({ PIXIE_BOT_NAME: "Pixie Reincarnated", PIXIE_BOT_SLUG: "community-helper" }, () => {
    const rendered = manifest();
    assert.equal(rendered.features.slash_commands[0].command, "/community-helper");
    assert.equal(rendered.features.slash_commands[1].command, "/community-helper-check");
    assert.equal(rendered.features.shortcuts[0].callback_id, "community_helper_teach_thread");
    assert.ok(rendered.features.shortcuts[0].name.length <= 24);
  });
  withEnv({ PIXIE_BOT_NAME: undefined, PIXIE_BOT_SLUG: undefined }, () => {
    assert.equal(manifest().features.slash_commands[0].command, "/pixie");
  });
});
