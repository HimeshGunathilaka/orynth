import { describe, expect, it, vi } from "vitest";
import {
  createOrynth,
  memoryStorage,
  OperationConflictError,
  OperationUncertainError,
  OrynthError,
  type ExecuteContext,
  type OperationStorage,
  type ReconcileContext,
} from "../src/index.js";
import { connectionReset, deferred, flush, orderBackend } from "./helpers.js";

type OrderInput = { productId: string; quantity: number };

/** The same app code, started once per "page load" against shared storage. */
function app(storage: OperationStorage, backend: ReturnType<typeof orderBackend>, persistInput = false) {
  const guard = createOrynth({ storage });
  const execute = vi.fn(({ input, idempotencyKey }: ExecuteContext<OrderInput>) =>
    backend.createOrder(input, idempotencyKey),
  );
  const reconcile = vi.fn(({ idempotencyKey }: ReconcileContext<OrderInput>) => backend.lookup(idempotencyKey));
  const orders = guard.define({ name: "create-order", execute, reconcile, persistInput });
  return { guard, orders, execute, reconcile };
}

describe("getOrCreate", () => {
  it("creates an operation with the ID as its idempotency key", async () => {
    const { orders, execute } = app(memoryStorage(), orderBackend());
    const op = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });

    expect(op).toMatchObject({ id: "checkout-1", idempotencyKey: "checkout-1", status: "created" });
    await expect(op.run()).resolves.toMatchObject({ id: "order-1" });
    expect(execute.mock.calls[0]![0]).toMatchObject({ idempotencyKey: "checkout-1", headers: { "Idempotency-Key": "checkout-1" } });
  });

  it("joins every submission of the same checkout while it is in flight: one request", async () => {
    const backend = orderBackend();
    const { orders, execute } = app(memoryStorage(), backend);
    const response = deferred();
    execute.mockImplementationOnce(async ({ input, idempotencyKey }) => {
      await response.promise;
      return backend.createOrder(input, idempotencyKey);
    });

    // Two clicks, or a button and a keyboard shortcut in another component: separate but equal inputs.
    const submit = () => orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }).run();
    const first = submit();
    const second = submit();
    response.resolve();

    expect(await second).toBe(await first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(backend.orders.size).toBe(1);
  });

  it("refuses different input for an operation in flight, and sends nothing for it", async () => {
    const backend = orderBackend();
    const { orders, execute } = app(memoryStorage(), backend);
    const response = deferred();
    execute.mockImplementationOnce(async ({ input, idempotencyKey }) => {
      await response.promise;
      return backend.createOrder(input, idempotencyKey);
    });

    const first = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }).run();
    try {
      expect(() => orders.getOrCreate("checkout-1", { productId: "123", quantity: 2 })).toThrow(OperationConflictError);
    } finally {
      response.resolve(); // a request left hanging would keep the operation's Web Lock from the other tests
    }

    await expect(first).resolves.toMatchObject({ quantity: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("compares with the input as sent, even if the app edits the same object afterward", async () => {
    const { orders, execute } = app(memoryStorage(), orderBackend());
    execute.mockRejectedValueOnce(connectionReset());
    const form = { productId: "123", quantity: 1 };
    await expect(orders.getOrCreate("checkout-1", form).run()).rejects.toBeInstanceOf(OperationUncertainError);

    form.quantity = 2;
    expect(() => orders.getOrCreate("checkout-1", form)).toThrow(/tracked with different input/);
    form.quantity = 1;
    expect(orders.getOrCreate("checkout-1", form).status).toBe("uncertain");
  });

  it("returns an uncertain operation, which is reconciled rather than sent again", async () => {
    const backend = orderBackend();
    const { orders, execute } = app(memoryStorage(), backend);
    backend.dropNextResponse();
    const first = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    await expect(first.run()).rejects.toBeInstanceOf(OperationUncertainError);

    // The user clicks again after the timeout.
    const again = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    expect(again).toBe(first);
    await expect(again.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(again.reconcile()).resolves.toMatchObject({ status: "succeeded", result: { id: "order-1" } });
    expect(backend.orders.size).toBe(1);
  });

  it("finds the operation restored after a reload, with its original key", async () => {
    const storage = memoryStorage();
    const backend = orderBackend();
    const before = app(storage, backend, true);
    backend.dropNextResponse();
    await expect(before.orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }).run()).rejects.toThrow();

    const after = app(storage, backend, true);
    const [restored] = await after.orders.restore();
    const op = after.orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    expect(op).toBe(restored);
    expect(op).toMatchObject({ idempotencyKey: "checkout-1", status: "uncertain" });
    expect(() => after.orders.getOrCreate("checkout-1", { productId: "123", quantity: 2 })).toThrow(OperationConflictError);

    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.reconcile()).resolves.toMatchObject({ status: "succeeded" });
    expect(after.execute).not.toHaveBeenCalled();
    expect(backend.orders.size).toBe(1);
  });

  it("finds the restored operation when a JSON-backed store turned its Date into a string and dropped undefined fields", async () => {
    // Like the docs' localStorage adapter, or AsyncStorage, MMKV and SQLite rows in React Native.
    const rows = new Map<string, string>();
    const storage: OperationStorage = {
      set: async (record) => void rows.set(record.id, JSON.stringify(record)),
      get: async (id) => (rows.has(id) ? JSON.parse(rows.get(id)!) : undefined),
      delete: async (id) => void rows.delete(id),
      list: async () => [...rows.values()].map((row) => JSON.parse(row)),
    };
    const form = () => ({ productId: "123", quantity: 1, deliverOn: new Date("2026-12-24T00:00:00.000Z"), coupon: undefined });
    const backend = orderBackend();
    backend.dropNextResponse();
    const before = createOrynth({ storage }).define({ name: "create-order", persistInput: true, execute: ({ input, idempotencyKey }: ExecuteContext<ReturnType<typeof form>>) => backend.createOrder(input, idempotencyKey) });
    await expect(before.getOrCreate("checkout-1", form()).run()).rejects.toBeInstanceOf(OperationUncertainError);

    const after = createOrynth({ storage }).define({ name: "create-order", persistInput: true, execute: async () => backend.orders.get("checkout-1")! });
    const [restored] = await after.restore();
    expect(restored!.input).toEqual({ productId: "123", quantity: 1, deliverOn: "2026-12-24T00:00:00.000Z" });
    expect(after.getOrCreate("checkout-1", form())).toBe(restored);
    expect(() => after.getOrCreate("checkout-1", { ...form(), deliverOn: new Date("2026-12-25T00:00:00.000Z") })).toThrow(OperationConflictError);
  });

  it("returns a restored operation whose input was not persisted: there is nothing to compare", async () => {
    const storage = memoryStorage();
    const backend = orderBackend();
    backend.dropNextResponse();
    await app(storage, backend).orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }).run().catch(() => {});

    const after = app(storage, backend);
    const [restored] = await after.orders.restore();
    const op = after.orders.getOrCreate("checkout-1", { productId: "123", quantity: 2 });
    expect(op).toBe(restored);
    expect(op.input).toBeUndefined();
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(after.execute).not.toHaveBeenCalled();
  });

  it("without restore(), a stored operation for the ID is not sent again", async () => {
    const storage = memoryStorage();
    const backend = orderBackend();
    backend.dropNextResponse();
    await app(storage, backend).orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }).run().catch(() => {});

    const after = app(storage, backend);
    const op = after.orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toThrow(/already stored; restore it/);
    expect(after.execute).not.toHaveBeenCalled();
  });

  it("once the operation has resolved, a repeat sends the same key and the backend returns the same order", async () => {
    const backend = orderBackend();
    const { orders, execute } = app(memoryStorage(), backend);
    const first = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    const order = await first.run();
    await flush(); // the record is deleted and the ID released

    const again = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    expect(again).not.toBe(first);
    expect(again.idempotencyKey).toBe("checkout-1");
    await expect(again.run()).resolves.toEqual(order);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(backend.orders.size).toBe(1);
  });

  it("right after it resolves, returns the resolved operation instead of throwing", async () => {
    const { orders, execute } = app(memoryStorage(), orderBackend());
    const first = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    const order = await first.run();

    const again = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 });
    await expect(again.run()).resolves.toEqual(order);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("uses a custom key, and refuses a key that differs from the tracked operation's", async () => {
    const { orders, execute } = app(memoryStorage(), orderBackend());
    execute.mockRejectedValueOnce(connectionReset());
    const op = orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }, { idempotencyKey: "order-checkout-1" });
    expect(op.idempotencyKey).toBe("order-checkout-1");
    await op.run().catch(() => {});

    expect(orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 })).toBe(op);
    expect(orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }, { idempotencyKey: "order-checkout-1" })).toBe(op);
    expect(() =>
      orders.getOrCreate("checkout-1", { productId: "123", quantity: 1 }, { idempotencyKey: "checkout-1" }),
    ).toThrow(/another idempotency key/);
  });

  it("does not return another user's operation", async () => {
    let user = "alice";
    const guard = createOrynth({ scope: () => user });
    const orders = guard.define({
      name: "create-order",
      execute: async () => {
        throw connectionReset();
      },
    });
    const alices = orders.getOrCreate("checkout-1", { quantity: 1 });
    await alices.run().catch(() => {});

    user = "bob";
    expect(orders.get("checkout-1")).toBeUndefined();
    expect(() => orders.getOrCreate("checkout-1", { quantity: 1 })).toThrow(/already active/);
    user = "alice";
    expect(orders.getOrCreate("checkout-1", { quantity: 1 })).toBe(alices);
  });

  it("validates its arguments", () => {
    const { orders } = app(memoryStorage(), orderBackend());
    const input = { productId: "123", quantity: 1 };
    expect(() => orders.getOrCreate("", input)).toThrow(TypeError);
    expect(() => orders.getOrCreate(42 as never, input)).toThrow(TypeError);
    expect(() => orders.getOrCreate("checkout-1", input, { idempotencyKey: "" })).toThrow(TypeError);
    expect(() => orders.getOrCreate("checkout-1", input, { expiresAt: "soon" as never })).toThrow(TypeError);
  });

  it("works for operations without input", async () => {
    const ping = createOrynth().define({ name: "ping", execute: async ({ idempotencyKey }) => idempotencyKey });
    await expect(ping.getOrCreate("ping-1").run()).resolves.toBe("ping-1");
    expect(() => ping.getOrCreate("ping-1")).not.toThrow(OrynthError);
  });
});
