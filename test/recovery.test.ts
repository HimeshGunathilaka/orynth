import { describe, expect, it, vi } from "vitest";
import {
  createMutationGuard,
  memoryStorage,
  MutationGuardError,
  OperationUncertainError,
  type ExecuteContext,
  type OperationRecord,
  type OperationStorage,
  type ReconcileContext,
} from "../src/index.js";
import { connectionReset, deferred, flakyStorage, flush, orderBackend } from "./helpers.js";

type OrderInput = { productId: string; quantity: number };

/** The same app code, started once per "page load" against shared storage. */
function app(storage: OperationStorage, backend: ReturnType<typeof orderBackend>, persistInput = false) {
  const guard = createMutationGuard({ storage });
  const execute = vi.fn(({ input, idempotencyKey }: ExecuteContext<OrderInput>) =>
    backend.createOrder(input, idempotencyKey),
  );
  const reconcile = vi.fn(({ idempotencyKey }: ReconcileContext<OrderInput>) => backend.lookup(idempotencyKey));
  const createOrder = guard.define({ name: "create-order", execute, reconcile, persistInput });
  return { guard, createOrder, execute, reconcile };
}

const stored = (status: OperationRecord["status"], overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: `op-${status}`,
  name: "create-order",
  idempotencyKey: `key-${status}`,
  status,
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe("recovery", () => {
  it("recovers an order the server created after the connection dropped, without a duplicate", async () => {
    const storage = memoryStorage();
    const backend = orderBackend();

    // Session 1: the server commits the order, but the response is lost.
    const session1 = app(storage, backend);
    const op = session1.createOrder.create({ productId: "123", quantity: 2 });
    backend.dropNextResponse();
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(op.status).toBe("uncertain");
    expect(backend.orders.size).toBe(1);

    // Session 2: the user reloads the page.
    const session2 = app(storage, backend);
    const [restored] = await session2.guard.restore();
    expect(restored).toMatchObject({ id: op.id, idempotencyKey: op.idempotencyKey, status: "uncertain" });

    // Restoring never executes, and run() refuses to resubmit an uncertain operation.
    await expect(restored!.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(session2.execute).not.toHaveBeenCalled();

    // The backend confirms the order exists.
    await expect(restored!.reconcile()).resolves.toEqual({
      status: "succeeded",
      result: { id: "order-1", productId: "123", quantity: 2 },
    });
    expect(restored!.state.result).toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect(backend.orders.size).toBe(1);
    await flush();
    expect(await storage.list()).toEqual([]);
  });

  it("treats every unresolved stored status as uncertain", async () => {
    const storage = memoryStorage();
    for (const status of ["pending", "uncertain", "recovering"] as const) await storage.set(stored(status));
    const { guard, execute } = app(storage, orderBackend());

    const restored = await guard.restore();
    expect(restored.map((op) => [op.id, op.status])).toEqual([
      ["op-pending", "uncertain"],
      ["op-uncertain", "uncertain"],
      ["op-recovering", "uncertain"],
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("restores the stored error and attempt count", async () => {
    const storage = memoryStorage();
    const error = { name: "TypeError", message: "fetch failed" };
    await storage.set(stored("uncertain", { attempts: 3, error }));
    const [op] = await app(storage, orderBackend()).guard.restore();
    expect(op!.state).toMatchObject({ attempts: 3, error });
  });

  it("returns live operations instead of stale copies", async () => {
    const storage = memoryStorage();
    const gate = deferred<string>();
    const guard = createMutationGuard({ storage });
    const def = guard.define({ name: "op", execute: () => gate.promise });
    const op = def.create();
    const run = op.run();
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(1));

    // A request is still in flight in this session: it must not be marked uncertain.
    const restored = await guard.restore();
    expect(restored).toEqual([op]);
    expect(op.status).toBe("pending");

    gate.resolve("ok");
    await expect(run).resolves.toBe("ok");
  });

  it("returns the same instances when restoring twice", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending"));
    const { guard } = app(storage, orderBackend());
    const [first, second] = await Promise.all([guard.restore(), guard.restore()]);
    expect(first).toHaveLength(1);
    expect(second[0]).toBe(first[0]);
    expect(await guard.restore()).toEqual(first);
  });

  it("restores per definition, and leaves unknown definitions in storage until they are defined", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending"));
    await storage.set(stored("uncertain", { id: "refund-1", name: "refund" }));
    const { guard, createOrder } = app(storage, orderBackend());

    expect((await createOrder.restore()).map((op) => op.id)).toEqual(["op-pending"]);
    expect((await guard.restore()).map((op) => op.id)).toEqual(["op-pending"]);
    expect(await storage.list()).toHaveLength(2);

    guard.define({ name: "refund", execute: async () => "refunded" });
    expect((await guard.restore()).map((op) => op.id)).toEqual(["op-pending", "refund-1"]);
  });

  it("ignores malformed and resolved records", async () => {
    const storage = memoryStorage();
    await storage.set({ id: "broken" } as OperationRecord);
    await storage.set(stored("succeeded"));
    await storage.set(stored("pending"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const restored = await app(storage, orderBackend()).guard.restore();
    expect(restored.map((op) => op.id)).toEqual(["op-pending"]);
  });

  it("does not resubmit when the backend has no record of the operation", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending"));
    const backend = orderBackend();
    const { guard, execute } = app(storage, backend);

    const [op] = await guard.restore();
    await expect(op!.reconcile()).resolves.toEqual({ status: "not-found" });
    expect(op!.status).toBe("uncertain");
    expect(execute).not.toHaveBeenCalled();
    expect(await storage.list()).toEqual([expect.objectContaining({ id: "op-pending" })]);
  });

  it("can resubmit explicitly after not-found when the input was persisted", async () => {
    // The previous session crashed before its request reached the server.
    const storage = memoryStorage();
    await storage.set(stored("pending", { input: { productId: "123", quantity: 1 } }));
    const backend = orderBackend();

    const { guard, execute } = app(storage, backend, true);
    const [restored] = await guard.restore();
    await expect(restored!.reconcile()).resolves.toEqual({ status: "not-found" });

    // The app decides resubmission is safe (the backend honors idempotency keys).
    await expect(restored!.retry()).resolves.toMatchObject({ productId: "123" });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "key-pending", input: { productId: "123", quantity: 1 } }),
    );
    expect(backend.orders.size).toBe(1);
  });

  it("cannot retry a restored operation whose input was not persisted", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending"));
    const { guard, execute } = app(storage, orderBackend());
    const [op] = await guard.restore();

    expect(op!.input).toBeUndefined();
    await expect(op!.retry()).rejects.toThrow(MutationGuardError);
    await expect(op!.retry()).rejects.toThrow(/input was not persisted/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the operation when the status endpoint is unavailable, and recovers later", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending"));
    const backend = orderBackend();
    backend.orders.set("key-pending", { id: "order-9", productId: "1", quantity: 1 });
    const { guard, reconcile } = app(storage, backend);
    const [op] = await guard.restore();

    reconcile.mockRejectedValueOnce(connectionReset());
    await expect(op!.reconcile()).resolves.toMatchObject({ status: "unknown" });
    expect(op!.status).toBe("uncertain");
    await flush();
    expect(await storage.list()).toEqual([expect.objectContaining({ id: "op-pending", status: "uncertain" })]);

    await expect(op!.reconcile()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("passes the stored identity and persisted input to reconcile", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending", { input: { productId: "7", quantity: 1 } }));
    const { guard, reconcile } = app(storage, orderBackend(), true);
    const [op] = await guard.restore();
    await op!.reconcile();
    expect(reconcile).toHaveBeenCalledWith({
      operationId: "op-pending",
      idempotencyKey: "key-pending",
      input: { productId: "7", quantity: 1 },
      headers: { "Idempotency-Key": "key-pending" },
    });
  });
});


describe("ID ownership", () => {
  it("does not resurrect a resolved operation whose record could not be deleted", async () => {
    const { storage, fail } = flakyStorage();
    const execute = vi.fn(async () => {
      fail("delete");
      return "ok";
    });
    const guard = createMutationGuard({ storage, onStorageError: () => {} });
    const def = guard.define({ name: "op", execute, persistInput: true });
    const op = def.create("input");
    await op.run();
    await flush();

    // The stale `pending` record is still stored, but this guard knows the operation succeeded.
    expect(await guard.restore()).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("ignores records read before an operation resolved and was deleted", async () => {
    const inner = memoryStorage();
    const gate = deferred();
    let snapshotGate = false;
    // list() takes its snapshot immediately but answers later, as an IndexedDB read can.
    const storage: OperationStorage = {
      ...inner,
      async list() {
        const snapshot = await inner.list();
        if (snapshotGate) await gate.promise;
        return snapshot;
      },
    };
    const run = deferred<string>();
    const guard = createMutationGuard({ storage });
    const op = guard.define({ name: "op", execute: () => run.promise }).create();
    const running = op.run();
    await vi.waitFor(async () => expect(await inner.list()).toHaveLength(1));

    snapshotGate = true;
    const restoring = guard.restore();
    await flush();
    run.resolve("ok");
    await running;
    await vi.waitFor(async () => expect(await inner.list()).toEqual([]));
    gate.resolve();

    expect(await restoring).toEqual([]);
  });

  it("owns the ID before the pending record is written", async () => {
    const inner = memoryStorage();
    const gate = deferred();
    // The record becomes visible before set() resolves, as with some remote stores.
    const storage: OperationStorage = {
      ...inner,
      async set(record) {
        await inner.set(record);
        await gate.promise;
      },
    };
    const guard = createMutationGuard({ storage });
    const execute = vi.fn(async () => "ok");
    const op = guard.define({ name: "op", execute }).create();
    const running = op.run();
    await vi.waitFor(async () => expect(await inner.list()).toHaveLength(1));

    // No second handle is created for the operation that is starting.
    expect(await guard.restore()).toEqual([]);
    gate.resolve();
    await expect(running).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two handles with the same custom ID execute", async () => {
    const gate = deferred<string>();
    const execute = vi.fn(() => gate.promise);
    const def = createMutationGuard().define({ name: "op", execute });
    const a = def.create(undefined, { id: "checkout-42" });
    const b = def.create(undefined, { id: "checkout-42" });

    const runA = a.run();
    await expect(b.run()).rejects.toThrow(/already active/);
    gate.resolve("ok");
    await expect(runA).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("frees the ID once the operation resolved and its record is gone", async () => {
    const def = createMutationGuard().define({ name: "op", execute: async () => "ok" });
    await def.create(undefined, { id: "checkout-42" }).run();
    await flush();
    await expect(def.create(undefined, { id: "checkout-42" }).run()).resolves.toBe("ok");
  });
});

describe("record validation", () => {
  it("treats a null expiresAt as no expiry", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending", { expiresAt: null as never }));
    expect(await app(storage, orderBackend()).guard.restore()).toHaveLength(1);
    expect(await storage.list()).toHaveLength(1);
  });

  it("ignores a stored input unless the definition persists inputs", async () => {
    const storage = memoryStorage();
    await storage.set(stored("pending", { input: null }));
    const { guard, execute } = app(storage, orderBackend());
    const [op] = await guard.restore();
    expect(op!.input).toBeUndefined();
    await expect(op!.retry()).rejects.toThrow(/input was not persisted/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports malformed records", async () => {
    const storage = memoryStorage();
    await storage.set({ ...stored("pending"), createdAt: "yesterday" } as never);
    const onStorageError = vi.fn();
    const guard = createMutationGuard({ storage, onStorageError });
    guard.define({ name: "create-order", execute: async () => "ok" });
    expect(await guard.restore()).toEqual([]);
    expect(onStorageError).toHaveBeenCalledWith(expect.objectContaining({ message: "Ignored a malformed operation record" }));
  });
});
