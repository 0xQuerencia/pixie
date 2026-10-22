process.env.PIXIE_DB_PATH = ":memory:";

process.env.JEV_ENABLED = "false";

process.env.PIXIE_RESOLUTION_PIPELINE = "false";

try {
  require("bun:test").beforeEach(() => require("./providerHealth").reset());
} catch (_error: unknown) {}

export = {};
