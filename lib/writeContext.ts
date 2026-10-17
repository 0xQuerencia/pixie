const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

function suppressed() {
  return storage.getStore() === true;
}

function run<T>(withoutWrites: boolean, action: () => T): T {
  return storage.run(withoutWrites, action);
}

export = { suppressed, run };
