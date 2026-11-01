import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMutationGuard,
  memoryStorage,
  StorageError,
  type OperationRecord,
  type OperationStorage,
} from "../src/index.js";
import { connectionReset, deferred, flakyStorage, flush, HttpError } from "./helpers.js";

const record = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "op-1",
  name: "create-order",
  idempotencyKey: "key-1",
  status: "pending",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("memoryStorage", () => {
  it("stores, replaces, lists and deletes records", async () => {
    const storage = memoryStorage();
    await storage.set(record());
    await storage.set(record({ id: "op-2" }));
    await storage.set(record({ status: "uncertain" }));

    expect(await storage.list()).toEqual([record({ status: "uncertain" }), record({ id: "op-2" })]);
    await storage.delete("op-1");
    await storage.delete("missing");
    expect(await storage.list()).toEqual([record({ id: "op-2" })]);
  });

  it("copies records in and out", async () => {
    const storage = memoryStorage();
    const original = record();
    await storage.set(original);
    original.status = "failed";
    const [listed] = await storage.list();
    listed!.status = "succeeded";
    expect((await storage.list())[0]!.status).toBe("pending");
  });
});

describe("persistence", () => {
  afterEach(() => vi.useRealTimers());

  it("saves the pending record before the request is sent", async () => {
    const storage = memoryStorage();
    let storedDuringExecute: OperationRecord[] = [];
    const op = createMutationGuard({ storage })
      .define({
        name: "op",
        execute: async () => {
          storedDuringExecute = await storage.list();
          return "ok";
        },
      })
      .create({ secret: "card-number" });

    await op.run();
    expect(storedDuringExecute).toEqual([
      expect.objectContaining({ id: op.id, idempotencyKey: op.idempotencyKey, status: "pending", attempts: 1 }),
    ]);
    // Inputs are not persisted unless the definition opts in.
    expect(storedDuringExecute[0]).not.toHaveProperty("input");
  });

  it("persists the input only with persistInput", async () => {
    const storage = memoryStorage();
    const def = createMutationGuard({ storage }).define({
      name: "op",
      persistInput: true,
      execute: async (): Promise<string> => {
        throw connectionReset();
      },
    });
    const op = def.create({ productId: "123" });
    await op.run().catch(() => {});
    await flush();
    expect(await storage.list()).toEqual([expect.objectContaining({ input: { productId: "123" } })]);
  });

  it("keeps uncertain records with a serialized error and removes resolved ones", async () => {
    const storage = memoryStorage();
    const def = createMutationGuard({ storage }).define({
      name: "op",
      execute: async ({ input }: { input: "ok" | "lost" | "rejected" }) => {
        if (input === "lost") throw connectionReset();
        if (input === "rejected") throw new HttpError(422);
        return input;
      },
    });
    const ops = [def.create("ok"), def.create("lost"), def.create("rejected")];
    await Promise.allSettled(ops.map((op) => op.run()));
    await flush();

    expect(await storage.list()).toEqual([
      expect.objectContaining({
        id: ops[1]!.id,
        status: "uncertain",
        error: { name: "TypeError", message: "fetch failed" },
      }),
    ]);
  });

  it("sets expiresAt from ttl, or omits it for Infinity", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const storage = memoryStorage();
    const guard = createMutationGuard({ storage, ttl: 5_000 });
    const lost = async (): Promise<string> => {
      throw connectionReset();
    };
    await guard.define({ name: "a", execute: lost }).create().run().catch(() => {});
    await guard.define({ name: "b", execute: lost, ttl: Infinity }).create().run().catch(() => {});
    await vi.runAllTimersAsync();

    const [a, b] = await storage.list();
    expect(a!.expiresAt).toBe(6_000);
    expect(b).not.toHaveProperty("expiresAt");
  });

  it("measures ttl from when each execution starts, not from create()", async () => {
    vi.useFakeTimers({ now: 0 });
    const storage = memoryStorage();
    const execute = vi.fn(async (): Promise<string> => {
      throw connectionReset();
    });
    const op = createMutationGuard({ storage, ttl: 1_000 }).define({ name: "op", execute }).create();

    vi.setSystemTime(5_000);
    await op.run().catch(() => {});
    await vi.runAllTimersAsync();
    expect((await storage.list())[0]!.expiresAt).toBe(6_000);

    vi.setSystemTime(9_000);
    await op.retry().catch(() => {});
    await vi.runAllTimersAsync();
    expect((await storage.list())[0]!.expiresAt).toBe(10_000);
  });

  it("writes records in the order the states were produced, even with a slow storage", async () => {
    const inner = memoryStorage();
    const writes: string[] = [];
    // The first write is slow; a naive implementation would let later writes overtake it.
    let first = true;
    const storage: OperationStorage = {
      ...inner,
      async set(r) {
        const slow = first;
        first = false;
        if (slow) await new Promise((resolve) => setTimeout(resolve, 20));
        writes.push(r.status);
        await inner.set(r);
      },
      async delete(id) {
        writes.push("deleted");
        await inner.delete(id);
      },
    };
    const def = createMutationGuard({ storage }).define({
      name: "op",
      execute: async (): Promise<string> => {
        throw connectionReset();
      },
      reconcile: async () => ({ status: "not-found" }),
    });
    const op = def.create();
    await op.run().catch(() => {});
    await op.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(writes).toEqual(["pending", "uncertain", "recovering", "uncertain"]);
    expect(await inner.list()).toEqual([expect.objectContaining({ status: "uncertain" })]);
  });
});

describe("storage failures", () => {
  it("does not send the request if the pending record cannot be saved", async () => {
    const { storage, fail, heal } = flakyStorage();
    const execute = vi.fn(async () => "ok");
    const op = createMutationGuard({ storage }).define({ name: "op", execute }).create();

    fail("set");
    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).cause).toEqual(new Error("set failed: quota exceeded"));
    expect(execute).not.toHaveBeenCalled();
    expect(op.status).toBe("created");

    heal();
    await expect(op.run()).resolves.toBe("ok");
  });

  it("reports later write failures without losing the in-memory state", async () => {
    const { storage, fail } = flakyStorage();
    const onStorageError = vi.fn();
    const op = createMutationGuard({ storage, onStorageError })
      .define({
        name: "op",
        execute: async () => {
          fail("delete");
          return "ok";
        },
      })
      .create();

    await expect(op.run()).resolves.toBe("ok");
    await flush();
    expect(op.status).toBe("succeeded");
    expect(onStorageError).toHaveBeenCalledWith(expect.any(StorageError));
    expect(onStorageError.mock.calls[0]![0]).toMatchObject({ operationId: op.id });
  });

  it("logs storage errors by default", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage, fail } = flakyStorage();
    const op = createMutationGuard({ storage })
      .define({
        name: "op",
        execute: async () => {
          fail("delete");
          return "ok";
        },
      })
      .create();
    await op.run();
    await flush();
    expect(consoleError).toHaveBeenCalledWith(expect.any(StorageError));
  });

  it("fails restore loudly when records cannot be loaded", async () => {
    const { storage, fail } = flakyStorage();
    fail("list");
    await expect(createMutationGuard({ storage }).restore()).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects invalid storage adapters", () => {
    expect(() => createMutationGuard({ storage: {} as never })).toThrow(TypeError);
    expect(() => createMutationGuard({ storage: "indexeddb" as never })).toThrow(TypeError);
  });

  it("serializes the pending write behind a slow earlier write", async () => {
    // A slow delete of the previous failure must not land after the retry's pending write.
    const inner = memoryStorage();
    const gate = deferred();
    let gateDelete = false;
    const storage: OperationStorage = {
      ...inner,
      async delete(id) {
        if (gateDelete) await gate.promise;
        await inner.delete(id);
      },
    };
    const execute = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new HttpError(422));
    const op = createMutationGuard({ storage }).define({ name: "op", execute }).create();

    gateDelete = true;
    await op.run().catch(() => {}); // failed → delete is now stuck
    execute.mockImplementationOnce(async () => {
      throw connectionReset();
    });
    const retry = op.retry().catch(() => {});
    await flush();
    expect(execute).toHaveBeenCalledTimes(1); // still waiting for its pending write
    gate.resolve();
    await retry;
    await flush();
    expect(await inner.list()).toEqual([expect.objectContaining({ status: "uncertain" })]);
  });
});
