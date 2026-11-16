process.env.PIXIE_DB_PATH = ":memory:";

process.env.JEV_ENABLED = "false";

process.env.PIXIE_RESOLUTION_PIPELINE = "false";

// Unit tests must never silently call a real remote AI provider. Tests that
// intentionally exercise integrations run separately with an explicit opt-in.
if (process.env.PIXIE_TEST_ALLOW_NETWORK !== "1") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
      return Promise.reject(new Error(`Unit test attempted external fetch: ${url.origin}. Mock the provider instead.`));
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

try {
  require("bun:test").beforeEach(() => require("./providerHealth").reset());
} catch (_error: unknown) {}

export = {};
