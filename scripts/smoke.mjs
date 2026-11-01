// Loads the built package through its `exports` map, as an ESM consumer would.
import assert from "node:assert/strict";
import { createMutationGuard, OperationUncertainError } from "mutation-guard";
import { indexedDBStorage, memoryStorage } from "mutation-guard/storage";

const storage = memoryStorage();
const definition = {
  name: "create-order",
  execute: async () => {
    throw new TypeError("fetch failed");
  },
  reconcile: async () => ({ status: "succeeded", result: "order-1" }),
};

const op = createMutationGuard({ storage }).define(definition).create({ productId: "123" });
await assert.rejects(op.run(), OperationUncertainError);

const [restored] = await createMutationGuard({ storage }).define(definition).restore();
assert.equal(restored.idempotencyKey, op.idempotencyKey);
assert.deepEqual(await restored.reconcile(), { status: "succeeded", result: "order-1" });

assert.equal(typeof indexedDBStorage, "function");
await assert.rejects(indexedDBStorage().list(), /IndexedDB is not available/);
console.log("ESM smoke test passed");
