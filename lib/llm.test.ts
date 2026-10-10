const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const llm = require("./llm");
const { isRetryableStatus, isRetryableError } = llm;

async function withAxiosPost(impl: typeof axios.post, fn: () => Promise<unknown>) {
  const original = axios.post;
  axios.post = impl;
  try {
    return await fn();
  } finally {
    axios.post = original;
  }
}

test("isRetryableStatus covers throttling and server errors", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, String(status));
  }
});

test("isRetryableStatus rejects client errors we cannot recover from", () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableStatus(status), false, String(status));
  }
});

test("isRetryableError treats a missing response as retryable", () => {
  assert.equal(isRetryableError(new Error("socket hang up")), true);
  assert.equal(isRetryableError({ code: "ECONNABORTED" }), true);
});

test("isRetryableError defers to the status when there is a response", () => {
  assert.equal(isRetryableError({ response: { status: 429 } }), true);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
});

const sse = (c: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`;

test("parseSseChunk pulls the content deltas out of complete lines", () => {
  const { deltas, rest } = llm.parseSseChunk(`${sse("he")}${sse("llo")}`);
  assert.deepEqual(deltas, ["he", "llo"]);
  assert.equal(rest, "");
});

test("parseSseChunk holds back a partial line", () => {
  const whole = sse("hi");
  const cut = whole.length - 4;

  const first = llm.parseSseChunk(whole.slice(0, cut));
  assert.deepEqual(first.deltas, []);

  const second = llm.parseSseChunk(first.rest + whole.slice(cut));
  assert.deepEqual(second.deltas, ["hi"]);
});

test("parseSseChunk ignores [DONE], keepalives and unparseable frames", () => {
  const { deltas } = llm.parseSseChunk('data: [DONE]\n\ndata: {not json}\n: keepalive\ndata: {"choices":[{}]}\n');
  assert.deepEqual(deltas, []);
});

type MockFetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } };
};

type FetchImpl = (...args: Parameters<typeof fetch>) => Promise<MockFetchResponse>;
type StreamResult = { text: string; stopped?: boolean };

function fakeFetch(
  chunks: string[],
  { status = 200, finishReason = "stop" }: { status?: number; finishReason?: string | null } = {},
): FetchImpl {
  const frames = finishReason
    ? [...chunks, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n`]
    : chunks;
  return async (..._args: Parameters<typeof fetch>): Promise<MockFetchResponse> => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => "boom",
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () =>
            i < frames.length ? { done: false, value: new TextEncoder().encode(frames[i++]) } : { done: true },
        };
      },
    },
  });
}

async function withFetch<T>(impl: FetchImpl, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const REQUEST = { baseUrl: "http://x", apiKey: "k", model: "m", messages: [] };

test("completeStream assembles the deltas and reports each one as it lands", async () => {
  const seen: string[][] = [];
  const result = await withFetch<StreamResult>(fakeFetch([sse("one "), sse("two"), "data: [DONE]\n"]), () =>
    llm.completeStream(REQUEST, (delta: string, text: string) => seen.push([delta, text])),
  );

  assert.equal(result.text, "one two");
  assert.deepEqual(seen, [
    ["one ", "one "],
    ["two", "one two"],
  ]);
});

test("completeStream retains a terminal SSE frame without its trailing newline", async () => {
  const terminal = 'data: {"choices":[{"delta":{"content":" complete."},"finish_reason":"stop"}]}';
  const result = await withFetch<StreamResult>(
    fakeFetch([sse("A grounded answer"), terminal], { finishReason: null }),
    () => llm.completeStream(REQUEST, () => {}),
  );

  assert.equal(result.text, "A grounded answer complete.");
});

test("completeStream rejects a length-limited terminal stream", async () => {
  await withFetch(fakeFetch([sse("A visibly incomplete answer")], { finishReason: "length" }), async () => {
    await assert.rejects(
      () => llm.completeStream(REQUEST, () => {}),
      /stream ended without a complete answer \(finish_reason=length\)/,
    );
  });
});

test("completeStream stops when the callback returns false", async () => {
  const seen: string[] = [];
  const result = await withFetch<StreamResult>(fakeFetch([sse("SILENT"), sse(" and more")]), () =>
    llm.completeStream(REQUEST, (delta: string) => {
      seen.push(delta);
      return false;
    }),
  );

  assert.deepEqual(seen, ["SILENT"]);
  assert.equal(result.stopped, true);
  assert.equal(result.text, "SILENT");
});

test("completeStream retries an attempt that streamed nothing", async () => {
  let attempts = 0;
  const flaky = async (...args: Parameters<typeof fetch>) => {
    attempts += 1;
    if (attempts === 1) {
      const err = Object.assign(new Error("503"), { response: { status: 503 } });
      err.response = { status: 503 };
      throw err;
    }
    return fakeFetch([sse("recovered")])(...args);
  };

  const result = await withFetch<StreamResult>(flaky, () => llm.completeStream(REQUEST, () => {}));

  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered");
});

test("completeStream does not retry once text has been streamed", async () => {
  let attempts = 0;
  const breaksMidStream: FetchImpl = async (_input, _init) => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      text: async () => "",
      body: {
        getReader() {
          let first = true;
          return {
            read: async () => {
              if (!first) throw new Error("socket hang up");
              first = false;
              return { done: false, value: new TextEncoder().encode(sse("half an ans")) };
            },
          };
        },
      },
    };
  };

  await withFetch(breaksMidStream, async () => {
    await assert.rejects(() => llm.completeStream(REQUEST, () => {}), /socket hang up/);
  });
  assert.equal(attempts, 1);
});

test("completeStream throws a non-retryable status straight away", async () => {
  let attempts = 0;
  const unauthorized = async (...args: Parameters<typeof fetch>) => {
    attempts += 1;
    return fakeFetch([], { status: 401 })(...args);
  };

  await withFetch(unauthorized, async () => {
    await assert.rejects(() => llm.completeStream(REQUEST, () => {}), /HTTP 401/);
  });
  assert.equal(attempts, 1);
});

const STANDBY = { baseUrl: "http://standby", apiKey: "k2", model: "m2" };

function byBaseUrl(routes: Record<string, FetchImpl>): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    const key = Object.keys(routes).find((k: string) => url.startsWith(k));
    if (!key) throw Object.assign(new Error("ECONNREFUSED"), { cause: { code: "ECONNREFUSED" } });
    return routes[key](url, init);
  };
}

test("completeStream falls back to the standby when the primary is unreachable", async () => {
  const seenUrls: string[] = [];
  const fetchImpl = byBaseUrl({
    "http://standby": (...args: Parameters<typeof fetch>) => {
      seenUrls.push("standby");
      return fakeFetch([sse("from the standby"), "data: [DONE]\n"])(...args);
    },
  });

  const result = await withFetch<StreamResult>(fetchImpl, () =>
    llm.completeStream({ ...REQUEST, baseUrl: "http://dead", fallback: STANDBY }, () => {}),
  );

  assert.equal(result.text, "from the standby");
  assert.deepEqual(seenUrls, ["standby"]);
});

test("completeStream does not fall back once text has reached the reader", async () => {
  let standbyCalls = 0;
  const fetchImpl = byBaseUrl({
    "http://flaky": async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      body: {
        getReader() {
          let sent = false;
          return {
            read: async () => {
              if (sent) throw new Error("socket hang up");
              sent = true;
              return { done: false, value: new TextEncoder().encode(sse("half an ")) };
            },
          };
        },
      },
    }),
    "http://standby": (...args: Parameters<typeof fetch>) => {
      standbyCalls += 1;
      return fakeFetch([sse("whole other answer")])(...args);
    },
  });

  await withFetch(fetchImpl, async () => {
    await assert.rejects(
      () => llm.completeStream({ ...REQUEST, baseUrl: "http://flaky", fallback: STANDBY }, () => {}),
      /socket hang up/,
    );
  });
  assert.equal(standbyCalls, 0, "a visible reply must never be rewritten by the standby");
});

test("thinkingFor only returns thinking object for deepseek models", () => {
  const thinkingObj = { type: "disabled" };
  assert.deepEqual(llm.thinkingFor("deepseek-v4-flash-free", thinkingObj), thinkingObj);
  assert.deepEqual(llm.thinkingFor("deepseek-chat", thinkingObj), thinkingObj);
  assert.equal(llm.thinkingFor("gc/gemini-3.1-flash-lite-preview", thinkingObj), undefined);
  assert.equal(llm.thinkingFor("kr/claude-sonnet-4.5", thinkingObj), undefined);
});

test("thinkingFor does not match a deepseek model behind someone else's gateway", () => {
  assert.equal(llm.thinkingFor("deepseek/deepseek-v4-flash-latest", { type: "disabled" }), undefined);
});

test("completeStream calls apiKey function per attempt and passes key to onRateLimited on 429", async () => {
  let keysCalled: string[] = [];
  const apiKeyFn = () => {
    const k = `key-${keysCalled.length + 1}`;
    keysCalled.push(k);
    return k;
  };

  let rateLimitedKey: string | null = null;
  const onRateLimited = (key: string) => {
    rateLimitedKey = key;
  };

  let attempts = 0;
  const rateLimitFetch: FetchImpl = async (_url, _options) => {
    attempts++;
    if (attempts === 1) {
      return fakeFetch([], { status: 429 })("", {});
    }
    return fakeFetch([sse("success")])("", {});
  };

  const result = await withFetch<StreamResult>(rateLimitFetch, () =>
    llm.completeStream({ ...REQUEST, apiKey: apiKeyFn, onRateLimited }, () => {}),
  );

  assert.equal(result.text, "success");
  assert.equal(attempts, 2);
  assert.equal(rateLimitedKey, "key-1");
  assert.deepEqual(keysCalled, ["key-1", "key-2"]);
});

test("requestCompletion attaches the key it used to a thrown error", async () => {
  const apiKeyFn = () => "key-1";
  const err429 = Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });

  await withAxiosPost(
    async () => {
      throw err429;
    },
    async () => {
      await assert.rejects(
        () => llm.requestCompletion({ ...REQUEST, apiKey: apiKeyFn }),
        (thrown: { usedKey?: string }) => {
          assert.equal(thrown, err429);
          assert.equal(thrown.usedKey, "key-1");
          return true;
        },
      );
    },
  );
});

test("complete falls through a two-hop fallback chain to reach a working tier", async () => {
  const seenUrls: string[] = [];
  await withAxiosPost(
    async (url: string) => {
      seenUrls.push(url);
      if (url.startsWith("http://hop2")) {
        return { data: { choices: [{ message: { content: "from hop2" }, finish_reason: "stop" }] } };
      }
      const err = Object.assign(new Error("bad request"), { response: { status: 400 } });
      err.response = { status: 400 };
      throw err;
    },
    async () => {
      const result = await llm.complete({
        ...REQUEST,
        baseUrl: "http://primary",
        fallback: {
          baseUrl: "http://hop1",
          apiKey: "k1",
          model: "m1",
          fallback: { baseUrl: "http://hop2", apiKey: "k2", model: "m2" },
        },
      });
      assert.equal(result.text, "from hop2");
    },
  );

  assert.ok(seenUrls.some((u: string) => u.startsWith("http://primary")));
  assert.ok(seenUrls.some((u: string) => u.startsWith("http://hop1")));
  assert.ok(seenUrls.some((u: string) => u.startsWith("http://hop2")));
});

test("completeStream falls through a two-hop fallback chain to reach a working tier", async () => {
  const fetchImpl = byBaseUrl({
    "http://primary": (...args: Parameters<typeof fetch>) => fakeFetch([], { status: 400 })(...args),
    "http://hop1": (...args: Parameters<typeof fetch>) => fakeFetch([], { status: 400 })(...args),
    "http://standby": (...args: Parameters<typeof fetch>) => fakeFetch([sse("from hop2"), "data: [DONE]\n"])(...args),
  });

  const result = await withFetch<StreamResult>(fetchImpl, () =>
    llm.completeStream(
      {
        ...REQUEST,
        baseUrl: "http://primary",
        fallback: { baseUrl: "http://hop1", apiKey: "k1", model: "m1", fallback: STANDBY },
      },
      () => {},
    ),
  );

  assert.equal(result.text, "from hop2");
});

test("completeStream rethrows when no standby is configured", async () => {
  await withFetch(byBaseUrl({}), async () => {
    await assert.rejects(() => llm.completeStream({ ...REQUEST, baseUrl: "http://dead" }, () => {}), /ECONNREFUSED/);
  });
});

test("stripThinking removes think, thinking, thought, and scratchpad tags", () => {
  assert.equal(llm.stripThinking("<think>thinking hard</think>The answer"), "The answer");
  assert.equal(llm.stripThinking("<thinking>deep thought</thinking>The answer"), "The answer");
  assert.equal(llm.stripThinking("<thought>some thought</thought>The answer"), "The answer");
  assert.equal(llm.stripThinking("<scratchpad>internal notes</scratchpad>The answer"), "The answer");
  assert.equal(llm.stripThinking("<think>broken opening tag"), "");
  assert.equal(llm.stripThinking("leading text</think>The answer"), "The answer");
});

test("stripThinking removes unbracketed thinking process blocks", () => {
  const thoughtOnly = `Here's a thinking process:\n\n1. **Analyze User Input:**\n- some notes\nFormat: "question :: answer"`;
  assert.equal(llm.stripThinking(thoughtOnly), "");

  const thoughtWithAnswer = `${thoughtOnly}\n\nWhat is show and tell? :: Participants showcase their projects in a huddle.`;
  assert.equal(
    llm.stripThinking(thoughtWithAnswer),
    "What is show and tell? :: Participants showcase their projects in a huddle.",
  );
});

test("retryable 429 is retried up to 3 attempts with backoff, then succeeds", async () => {
  let calls = 0;
  await withAxiosPost(
    async () => {
      calls += 1;
      if (calls < 3) {
        const err = Object.assign(new Error("rate limited"), { response: { status: 429 } });
        err.response = { status: 429 };
        throw err;
      }
      return { data: { choices: [{ message: { content: "recovered" }, finish_reason: "stop" }] } };
    },
    async () => {
      const result = await llm.complete({ baseUrl: "http://x", apiKey: "k", model: "m", messages: [] });
      assert.equal(result.text, "recovered");
    },
  );
  assert.equal(calls, 3, "3 attempts: 400/800/1600 backoff chain");
});

test("non-retryable 401 throws immediately with no retry", async () => {
  let calls = 0;
  await withAxiosPost(
    async () => {
      calls += 1;
      const err = Object.assign(new Error("bad key"), { response: { status: 401 } });
      err.response = { status: 401 };
      throw err;
    },
    async () => {
      await assert.rejects(
        () => llm.complete({ baseUrl: "http://x", apiKey: "k", model: "m", messages: [] }),
        /bad key/,
      );
    },
  );
  assert.equal(calls, 1);
});

test("thinking param only goes to bare deepseek models, never gateway names", () => {
  assert.deepEqual(llm.thinkingFor("deepseek-chat", { type: "enabled" }), { type: "enabled" });
  assert.equal(llm.thinkingFor("deepseek/deepseek-v4-flash-latest", { type: "enabled" }), undefined);
  assert.equal(llm.thinkingFor("kr/claude-sonnet-4.5", { type: "enabled" }), undefined);
  assert.equal(llm.thinkingFor("gpt-4o", { type: "enabled" }), undefined);
});

test("provider exhaustion with no fallback left rejects (defined degradation)", async () => {
  await withAxiosPost(
    async () => {
      const err = Object.assign(new Error("down"), { response: { status: 500 } });
      err.response = { status: 500 };
      throw err;
    },
    async () => {
      await assert.rejects(
        () => llm.complete({ baseUrl: "http://dead", apiKey: "k", model: "m", messages: [] }),
        /down/,
      );
    },
  );
});

test("withNoTelemetry keeps a probe completion out of llm_usage", async () => {
  const db = require("./db");
  const originalRecord = db.recordLlmUsage;
  let recorded = 0;
  db.recordLlmUsage = () => {
    recorded += 1;
  };
  try {
    await withAxiosPost(
      async () => ({ data: { choices: [{ message: { content: "probe answer" }, finish_reason: "stop" }] } }),
      async () => {
        const result = await llm.withNoTelemetry(() => llm.complete({ ...REQUEST, telemetry: { operation: "probe" } }));
        assert.equal(result.text, "probe answer");
      },
    );
  } finally {
    db.recordLlmUsage = originalRecord;
  }
  assert.equal(recorded, 0);
});

export {};
