// Loads the built package through its `exports` map, as a CommonJS consumer would.
const assert = require("node:assert/strict");
const { createOrynth, OperationUncertainError, StorageError } = require("orynth");
const { indexedDBStorage, memoryStorage } = require("orynth/storage");

(async () => {
  const guard = createOrynth({ storage: memoryStorage() });
  const op = guard
    .define({
      name: "create-order",
      execute: async () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    })
    .getOrCreate("checkout-1");
  assert.equal(op.idempotencyKey, "checkout-1");
  await assert.rejects(op.run(), OperationUncertainError);

  // Errors from the storage entry are wrapped by the core entry, so instanceof works.
  const idb = createOrynth({ storage: indexedDBStorage() });
  await assert.rejects(idb.define({ name: "x", execute: async () => 1 }).create().run(), StorageError);
  console.log("CJS smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
