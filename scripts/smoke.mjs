// Loads the built package through its `exports` map, as an ESM consumer would.
import assert from "node:assert/strict";
import { createOrynth, OperationUncertainError } from "orynth";
import { indexedDBStorage, memoryStorage } from "orynth/storage";

const storage = memoryStorage();
const definition = {
  name: "create-order",
  execute: async () => {
    throw new TypeError("fetch failed");
  },
  reconcile: async () => ({ status: "succeeded", result: "order-1" }),
};

const op = createOrynth({ storage }).define(definition).create({ productId: "123" });
await assert.rejects(op.run(), OperationUncertainError);

const [restored] = await createOrynth({ storage }).define(definition).restore();
assert.equal(restored.idempotencyKey, op.idempotencyKey);
assert.deepEqual(await restored.reconcile(), { status: "succeeded", result: "order-1" });

assert.equal(typeof indexedDBStorage, "function");
await assert.rejects(indexedDBStorage().list(), /IndexedDB is not available/);
console.log("ESM smoke test passed");

// An app can end up with both builds loaded; error checks must still work across them.
const { createRequire } = await import("node:module");
const cjs = createRequire(import.meta.url)("orynth");
assert.ok(new cjs.OperationUncertainError("op", new Error("lost")) instanceof OperationUncertainError);
console.log("ESM/CJS instanceof check passed");
