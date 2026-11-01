/**
 * Regression tests for the production-readiness report: shared devices, IDs
 * stuck after failures, Web Locks failures and waits, coordination without
 * Web Locks, storage failure policy, and the smaller findings.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrynth,
  memoryStorage,
  OrynthError,
  OperationConflictError,
  OperationInProgressError,
  OperationUncertainError,
  StorageError,
  type ExecuteContext,
  type LockManagerLike,
  type OperationStorage,
  type ReconcileResult,
} from "../src/index.js";
import { connectionReset, deferred, flakyStorage, flush } from "./helpers.js";

const lost = async (): Promise<string> => {
  throw connectionReset();
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared devices", () => {
  it("only restores, finds and runs operations of the current scope", async () => {
    let user: string | undefined = "alice";
    const storage = memoryStorage();
    const open = () => {
      const guard = createOrynth({ storage, scope: () => user });
      return { guard, orders: guard.define({ name: "order", execute: lost, persistInput: true }) };
    };

    const alice = open();
    const op = alice.orders.create({ productId: "1" }, { id: "checkout-1" });
    await op.run().catch(() => {});
    expect(op.state.scope).toBe("alice");

    // Alice signs out and Bob signs in, without a reload.
    user = "bob";
    expect(alice.orders.get("checkout-1")).toBeUndefined();
    expect(await alice.guard.restore()).toEqual([]);
    await expect(op.retry()).rejects.toThrow(/another scope/);
    await expect(op.reconcile()).rejects.toThrow(/another scope/);

    // Or after a reload.
    expect(await open().guard.restore()).toEqual([]);

    user = "alice";
    expect((await open().guard.restore()).map((restored) => restored.id)).toEqual(["checkout-1"]);
  });

  it("clear() deletes every stored operation and discards the tracked ones, leaving running ones alone", async () => {
    let user = "alice";
    const storage = memoryStorage();
    const guard = createOrynth({ storage, scope: () => user });
    const orders = guard.define({ name: "order", execute: lost });
    const alices = orders.create();
    await alices.run().catch(() => {});
    user = "bob";
    await orders.create().run().catch(() => {});
    const gate = deferred<string>();
    const running = guard.define({ name: "slow", execute: () => gate.promise }).create();
    const run = running.run();
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(3));

    await guard.clear();
    expect((await storage.list()).map((record) => record.id)).toEqual([running.id]);
    await expect(alices.reconcile()).rejects.toThrow(/discarded/);

    gate.resolve("ok");
    await run;
    await vi.waitFor(async () => expect(await storage.list()).toEqual([]));
  });

  it("discard() deletes the record, frees the ID and refuses further work", async () => {
    const storage = memoryStorage();
    const orders = createOrynth({ storage }).define({
      name: "order",
      execute: lost,
      reconcile: async () => ({ status: "not-found" }),
    });
    const op = orders.create(undefined, { id: "checkout-1" });
    await op.run().catch(() => {});

    await op.discard();
    expect(await storage.list()).toEqual([]);
    expect(orders.get("checkout-1")).toBeUndefined();
    await expect(op.retry()).rejects.toThrow(/discarded/);
    await expect(op.reconcile()).rejects.toThrow(/discarded/);
    expect(() => orders.create(undefined, { id: "checkout-1" })).not.toThrow();
  });

  it("discard() is refused while the operation is running", async () => {
    const gate = deferred<string>();
    const op = createOrynth().define({ name: "op", execute: () => gate.promise }).create();
    const run = op.run();
    await expect(op.discard()).rejects.toBeInstanceOf(OperationInProgressError);
    gate.resolve("ok");
    await run;
  });
});

describe("IDs after failures before sending", () => {
  it("a conflict with an unrestored stored operation frees the ID, so restore() can recover it", async () => {
    const storage = memoryStorage();
    // A previous session left checkout-1 unresolved.
    const earlier = createOrynth({ storage }).define({ name: "order", execute: lost, persistInput: true });
    await earlier.create({ n: 1 }, { id: "checkout-1" }).run().catch(() => {});

    const orders = createOrynth({ storage }).define({ name: "order", execute: lost, persistInput: true });
    // The user clicks before restore() has run.
    await expect(orders.create({ n: 1 }, { id: "checkout-1" }).run()).rejects.toBeInstanceOf(
      OperationConflictError,
    );
    expect(orders.get("checkout-1")).toBeUndefined();

    const [restored] = await orders.restore();
    expect(restored).toMatchObject({ id: "checkout-1", status: "uncertain" });
    expect(orders.get("checkout-1")).toBe(restored);
  });

  it("a storage failure before sending frees the ID", async () => {
    const { storage, fail } = flakyStorage();
    const orders = createOrynth({ storage }).define({ name: "order", execute: async () => "ok" });
    fail("set");
    await expect(orders.create(undefined, { id: "checkout-1" }).run()).rejects.toBeInstanceOf(StorageError);
    expect(orders.get("checkout-1")).toBeUndefined();
    expect(() => orders.create(undefined, { id: "checkout-1" })).not.toThrow();
  });
});

describe("Web Locks", () => {
  it("runs without them when a lock request fails, and reports that once", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const locks: LockManagerLike = {
      request: () => Promise.reject(new DOMException("The origin is opaque", "SecurityError")),
    };
    const execute = vi.fn(async () => "ok");
    const def = createOrynth({ locks }).define({ name: "op", execute });

    await expect(def.create().run()).resolves.toBe("ok");
    await expect(def.create().run()).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([expect.objectContaining({ cause: expect.objectContaining({ name: "SecurityError" }) })]);
  });

  it("also when request() throws synchronously", async () => {
    vi.stubGlobal("reportError", () => {});
    const locks: LockManagerLike = {
      request: () => {
        throw new TypeError("navigator.locks is broken");
      },
    };
    const def = createOrynth({ locks }).define({ name: "op", execute: async () => "ok" });
    await expect(def.create().run()).resolves.toBe("ok");
  });

  it.skipIf(!globalThis.navigator?.locks)("gives up waiting for another tab after lockTimeout, sending nothing", async () => {
    const storage = memoryStorage();
    const gate = deferred<string>();
    const tabA = createOrynth({ storage }).define({ name: "op", execute: () => gate.promise });
    const run = tabA.create().run();
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(1));

    const reconcile = vi.fn(async (): Promise<ReconcileResult<string>> => ({ status: "not-found" }));
    const tabB = createOrynth({ storage, lockTimeout: 100 });
    tabB.define({ name: "op", execute: lost, reconcile });
    const [restored] = await tabB.restore();
    await expect(restored!.reconcile()).rejects.toBeInstanceOf(OperationInProgressError);
    expect(reconcile).not.toHaveBeenCalled();

    gate.resolve("ok");
    await run;
  });
});

describe("without Web Locks", () => {
  it("a tab does not resend an operation another tab is still sending, even after reconciling it", async () => {
    const storage = memoryStorage();
    const gate = deferred<string>();
    const sent: string[] = [];
    const definition = (tab: string) => ({
      name: "op",
      persistInput: true,
      execute: async ({ input }: ExecuteContext<{ n: number }>) => {
        sent.push(`${tab}:${input.n}`);
        return tab === "A" ? gate.promise : "B";
      },
      reconcile: async (): Promise<ReconcileResult<string>> => ({ status: "pending" }),
    });
    const tabA = createOrynth({ storage, locks: false }).define(definition("A"));
    const run = tabA.create({ n: 1 }).run();
    await vi.waitFor(async () => expect((await storage.list())[0]?.lease).toBeDefined());

    const tabB = createOrynth({ storage, locks: false });
    tabB.define(definition("B"));
    const [restored] = await tabB.restore();
    await expect(restored!.retry()).rejects.toThrow(/being sent by another tab/);

    // Reconciling rewrites the record but keeps tab A's lease.
    await restored!.reconcile();
    await flush();
    expect((await storage.list())[0]?.lease).toBeDefined();
    await expect(restored!.retry()).rejects.toBeInstanceOf(OperationConflictError);

    gate.resolve("A");
    await run;
    await expect(restored!.retry()).rejects.toBeInstanceOf(OperationConflictError);
    expect(sent).toEqual(["A:1"]);
  });

  it("renews the lease while a long request is in flight", async () => {
    vi.useFakeTimers({ now: 0 });
    const storage = memoryStorage();
    const gate = deferred<string>();
    const run = createOrynth({ storage, locks: false })
      .define({ name: "op", execute: () => gate.promise })
      .create()
      .run();

    await vi.advanceTimersByTimeAsync(0);
    expect((await storage.list())[0]!.lease!.until).toBe(30_000);
    await vi.advanceTimersByTimeAsync(25_000); // renewed at 10 s and 20 s
    expect((await storage.list())[0]!.lease!.until).toBe(50_000);

    gate.resolve("ok");
    await run;
    await vi.advanceTimersByTimeAsync(0);
    expect(await storage.list()).toEqual([]);
  });

  it("an operation's own write that is still settling is not mistaken for another tab's", async () => {
    const inner = memoryStorage();
    // A write-behind adapter: get() sees the record before set() resolves.
    const storage: OperationStorage = {
      ...inner,
      async set(record) {
        await inner.set(record);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    const execute = vi.fn<() => Promise<string>>().mockRejectedValueOnce(connectionReset()).mockResolvedValueOnce("ok");
    const op = createOrynth({ storage, locks: false }).define({ name: "op", execute }).create();
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.retry()).resolves.toBe("ok");
  });
});

describe("storage failures", () => {
  it("requireStorage: false sends the request even if its record can't be saved, and reports it", async () => {
    const { storage, fail } = flakyStorage();
    fail("set");
    const onStorageError = vi.fn();
    const execute = vi.fn(async () => "ok");
    const guard = createOrynth({ storage, onStorageError });
    const def = guard.define({ name: "op", execute, requireStorage: false });

    await expect(def.create().run()).resolves.toBe("ok");
    expect(onStorageError).toHaveBeenCalledWith(expect.any(StorageError));
    // The guard default (true) still applies to other definitions.
    await expect(guard.define({ name: "strict", execute }).create().run()).rejects.toBeInstanceOf(StorageError);
  });

  it("stores proxied inputs (Vue reactive, MobX) as plain data", async () => {
    const storage = memoryStorage();
    const reactive = new Proxy({ productId: "1", quantity: 2 }, {});
    expect(() => structuredClone(reactive)).toThrow();

    const op = createOrynth({ storage })
      .define({ name: "op", persistInput: true, execute: lost })
      .create(reactive);
    await op.run().catch(() => {});
    await flush();
    expect((await storage.list())[0]!.input).toEqual({ productId: "1", quantity: 2 });
  });
});

describe("smaller findings", () => {
  it("a stale tab's reconcile does not bring back an operation another tab resolved", async () => {
    const storage = memoryStorage();
    const backend = { answer: "unknown" as "unknown" | "succeeded" };
    const define = (guard: ReturnType<typeof createOrynth>) =>
      guard.define({
        name: "op",
        persistInput: true,
        execute: lost,
        reconcile: async (): Promise<ReconcileResult<string>> =>
          backend.answer === "succeeded" ? { status: "succeeded", result: "ok" } : { status: "unknown" },
      });
    const tabA = createOrynth({ storage });
    const a = define(tabA).create({ n: 1 });
    await a.run().catch(() => {});
    const tabB = createOrynth({ storage });
    define(tabB);
    const [b] = await tabB.restore();

    backend.answer = "succeeded";
    await a.reconcile();
    await vi.waitFor(async () => expect(await storage.list()).toEqual([]));

    backend.answer = "unknown"; // tab B's lookup can't tell
    await expect(b!.reconcile()).resolves.toEqual({ status: "unknown" });
    await flush();
    expect(await storage.list()).toEqual([]);
    await expect(b!.retry()).rejects.toBeInstanceOf(OperationConflictError);
  });

  it("reports malformed records without their contents", async () => {
    const storage = memoryStorage();
    await storage.set({ id: "x", input: { card: "4242 4242 4242 4242" } } as never);
    const onStorageError = vi.fn();
    await createOrynth({ storage, onStorageError }).restore();

    const [error] = onStorageError.mock.calls[0]! as [StorageError];
    expect(error).toMatchObject({ message: "Ignored a malformed operation record", operationId: "x" });
    expect(error.cause).toBeUndefined();
  });

  it("restore() during a running operation returns only the ones that need recovery", async () => {
    const storage = memoryStorage();
    const guard = createOrynth({ storage });
    const gate = deferred<string>();
    const running = guard.define({ name: "slow", execute: () => gate.promise }).create();
    const uncertain = guard.define({ name: "lost", execute: lost, reconcile: async () => ({ status: "not-found" }) });
    const op = uncertain.create();
    await op.run().catch(() => {});
    const run = running.run();

    // The README's startup loop: every returned operation can be reconciled.
    const restored = await guard.restore();
    expect(restored).toEqual([op]);
    for (const each of restored) await each.reconcile();

    gate.resolve("ok");
    await run;
  });

  it("detects changes inside Map and Set inputs", async () => {
    const input = { items: new Map([["sku-1", 1]]), tags: new Set(["gift"]) };
    const op = createOrynth().define({ name: "op", execute: lost }).create(input);
    await op.run().catch(() => {});
    input.items.set("sku-1", 2);
    await expect(op.retry()).rejects.toThrow(/changed after it was sent/);
  });

  it("error classes work with instanceof across copies of the package", async () => {
    vi.resetModules();
    const copy = await import("../src/errors.js");
    expect(copy.OperationUncertainError).not.toBe(OperationUncertainError);

    const fromCopy = new copy.OperationUncertainError("op", new Error("lost"));
    expect(fromCopy).toBeInstanceOf(OperationUncertainError);
    expect(fromCopy).toBeInstanceOf(OrynthError);
    expect(fromCopy).not.toBeInstanceOf(StorageError);
    expect(new StorageError("x", undefined)).toBeInstanceOf(copy.OrynthError);

    class AppError extends OrynthError {}
    expect(new AppError("x")).toBeInstanceOf(OrynthError);
    expect(new OrynthError("x")).not.toBeInstanceOf(AppError);
  });
});
