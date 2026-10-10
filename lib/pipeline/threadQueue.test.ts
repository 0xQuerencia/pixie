const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ThreadQueue, threadKey } = require("./threadQueue");

test("threadKey isolates workspace, channel, thread, and program", () => {
  assert.notEqual(
    threadKey({ workspaceId: "W1", channel: "C1", threadTs: "T1", programId: "P1" }),
    threadKey({ workspaceId: "W2", channel: "C1", threadTs: "T1", programId: "P1" }),
  );
  assert.notEqual(
    threadKey({ workspaceId: "W1", channel: "C1", threadTs: "T1", programId: "P1" }),
    threadKey({ workspaceId: "W1", channel: "C1", threadTs: "T1", programId: "P2" }),
  );
});

test("ThreadQueue serializes one thread but runs different threads concurrently", async () => {
  const queue = new ThreadQueue({ maxPending: 4 });
  const firstRelease = deferred();
  const started: string[] = [];

  const first = queue.enqueue(
    "same",
    async () => {
      started.push("first");
      await firstRelease.promise;
      return "one";
    },
    "dropped",
  );
  const second = queue.enqueue(
    "same",
    async () => {
      started.push("second");
      return "two";
    },
    "dropped",
  );
  const other = queue.enqueue(
    "other",
    async () => {
      started.push("other");
      return "other";
    },
    "dropped",
  );

  await other;
  assert.deepEqual(started, ["first", "other"]);
  firstRelease.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["one", "two"]);
  assert.deepEqual(started, ["first", "other", "second"]);
});

test("ThreadQueue drops the oldest waiting turn and continues after errors", async () => {
  const queue = new ThreadQueue({ maxPending: 1 });
  const release = deferred();
  const first = queue.enqueue(
    "same",
    async () => {
      await release.promise;
      throw new Error("first failed");
    },
    false,
  );
  const dropped = queue.enqueue("same", async () => "old", false);
  const next = queue.enqueue("same", async () => "new", false);

  assert.equal(await dropped, false);
  release.resolve();
  await assert.rejects(first, /first failed/);
  assert.equal(await next, "new");
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export {};
