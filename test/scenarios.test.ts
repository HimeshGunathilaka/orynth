/**
 * Scenarios from the Orynth product description: the identity rules,
 * the payment-recovery flow, the engineering challenges it lists, and its
 * suggested API. Every test talks to a real HTTP server over a real socket.
 */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrynth,
  IdempotencyKeyExpiredError,
  OperationConflictError,
  OperationUncertainError,
  type ExecuteContext,
  type OrynthOptions,
  type ReconcileResult,
} from "../src/index.js";
import { indexedDBStorage } from "../src/storage/index.js";
import { HttpError } from "./helpers.js";
import { startServer, type Order, type OrderInput, type TestServer } from "./server.js";

let server: TestServer;

afterEach(async () => {
  vi.useRealTimers();
  await server.close();
});

/** The app's order code, as it would run in one browser tab. */
function tab(options: OrynthOptions & { timeout?: number; token?: () => string } = {}) {
  const { timeout = 5000, token, ...guardOptions } = options;
  const guard = createOrynth(guardOptions);
  const createOrder = guard.define({
    name: "create-order",
    persistInput: true,
    execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
      const response = await fetch(`${server.baseUrl}/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(token && { Authorization: `Bearer ${token()}` }),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new HttpError(response.status);
      return (await response.json()) as Order;
    },
    reconcile: async ({ idempotencyKey }) => {
      const response = await fetch(`${server.baseUrl}/orders/by-key/${encodeURIComponent(idempotencyKey)}`);
      if (!response.ok) return { status: "unknown" };
      return (await response.json()) as ReconcileResult<Order>;
    },
  });
  return { guard, createOrder };
}

const order = (): OrderInput => ({ productId: "123", quantity: 2 });

describe("Module 1: operation identity", () => {
  it("new action = new ID; retry of an unresolved operation = same ID", async () => {
    server = await startServer();
    const { createOrder } = tab();
    server.plan.push("drop-after-commit");

    const first = createOrder.create(order());
    await expect(first.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(first.retry()).resolves.toMatchObject({ id: "order-1" }); // replayed by the server

    // The user intentionally orders the same thing again.
    const second = createOrder.create(order());
    await expect(second.run()).resolves.toMatchObject({ id: "order-2" });

    expect(server.posts.map((post) => post.key)).toEqual([
      first.idempotencyKey,
      first.idempotencyKey,
      second.idempotencyKey,
    ]);
    expect(second.id).not.toBe(first.id);
  });

  it("submits once when the same intent is triggered twice (the double-click case)", async () => {
    server = await startServer({ idempotent: false }); // client-side protection only
    const { createOrder } = tab();
    const submit = (input: OrderInput) =>
      (createOrder.get("checkout-1") ?? createOrder.create(input, { id: "checkout-1" })).run();

    const [a, b] = await Promise.all([submit(order()), submit(order())]);
    expect(b).toEqual(a);
    expect(server.posts).toHaveLength(1);
  });

  it("does not order again when the intent's key is reused after success", async () => {
    server = await startServer();
    const { createOrder } = tab();
    const submit = () => createOrder.create(order(), { idempotencyKey: "checkout-1" }).run();

    await submit();
    await submit();
    expect(server.orders).toHaveLength(1);
  });
});

describe("Module 3: persistent operation tracking", () => {
  it("recovers a payment the server completed after the connection dropped and the page was refreshed", async () => {
    server = await startServer({ idempotent: false }); // any resubmission would duplicate it
    const indexedDB = new IDBFactory();
    server.plan.push("drop-after-commit");

    // 1–3. The user submits, the server processes it, the connection drops.
    const before = tab({ storage: indexedDBStorage({ indexedDB }) });
    const payment = before.createOrder.create(order());
    await expect(payment.run()).rejects.toBeInstanceOf(OperationUncertainError);

    // 4–5. The user refreshes; the app restores the unresolved operation.
    const after = tab({ storage: indexedDBStorage({ indexedDB }) });
    const [restored] = await after.createOrder.restore();
    expect(restored).toMatchObject({ id: payment.id, idempotencyKey: payment.idempotencyKey, status: "uncertain" });
    await expect(restored!.run()).rejects.toBeInstanceOf(OperationUncertainError); // never resubmitted

    // 6–7. It asks the backend, learns the payment succeeded, and submits nothing new.
    await expect(restored!.reconcile()).resolves.toEqual({ status: "succeeded", result: server.orders[0] });
    expect(server.posts).toHaveLength(1);
    expect(server.orders).toHaveLength(1);
  });
});

describe("Engineering challenges", () => {
  it("concurrent tabs: a tab does not resubmit an operation another tab is still sending", async () => {
    server = await startServer({ idempotent: false });
    const indexedDB = new IDBFactory();
    server.plan.push("slow");

    const tabA = tab({ storage: indexedDBStorage({ indexedDB }) });
    const sending = tabA.createOrder.create(order());
    const run = sending.run();
    await vi.waitFor(() => expect(server.posts).toHaveLength(1));

    // Tab B starts while tab A's request is in flight and finds the stored record.
    const tabB = tab({ storage: indexedDBStorage({ indexedDB }) });
    const [restored] = await tabB.createOrder.restore();
    // With Web Locks it waits for tab A, then sees the operation resolved; without, tab A's lease refuses it.
    const retry = restored!.retry().catch((error: unknown) => error);

    await expect(run).resolves.toMatchObject({ id: "order-1" });
    expect(await retry).toBeInstanceOf(OperationConflictError);
    await expect(restored!.reconcile()).resolves.toMatchObject({ status: "succeeded" });
    expect(server.posts).toHaveLength(1);
  });

  it("concurrent tabs: a stale tab cannot resubmit an operation another tab already resolved", async () => {
    server = await startServer({ idempotent: false });
    const indexedDB = new IDBFactory();
    server.plan.push("drop-after-commit");

    const tabA = tab({ storage: indexedDBStorage({ indexedDB }) });
    const stale = tabA.createOrder.create(order());
    await expect(stale.run()).rejects.toBeInstanceOf(OperationUncertainError);

    const tabB = tab({ storage: indexedDBStorage({ indexedDB }) });
    const [restored] = await tabB.createOrder.restore();
    await expect(restored!.reconcile()).resolves.toMatchObject({ status: "succeeded" });

    await expect(stale.retry()).rejects.toBeInstanceOf(OperationConflictError);
    expect(server.posts).toHaveLength(1);
    await expect(stale.reconcile()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("custom IDs: a new session does not reuse the ID of a stored operation it has not restored", async () => {
    server = await startServer({ idempotent: false });
    const indexedDB = new IDBFactory();
    server.plan.push("drop-after-commit");
    const before = tab({ storage: indexedDBStorage({ indexedDB }) });
    await expect(before.createOrder.create(order(), { id: "checkout-1" }).run()).rejects.toThrow();

    const after = tab({ storage: indexedDBStorage({ indexedDB }) });
    await expect(after.createOrder.create(order(), { id: "checkout-1" }).run()).rejects.toBeInstanceOf(
      OperationConflictError,
    );
    expect(server.posts).toHaveLength(1);
  });

  it("expired server keys: refuses to resubmit once the backend has forgotten the key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    server = await startServer({ keyTtl: 60_000 });
    const { createOrder } = tab({ ttl: 60_000 }); // the backend's documented key retention
    server.plan.push("drop-after-commit");

    const op = createOrder.create(order());
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(op.state.expiresAt).toBe(Date.now() + 60_000);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await expect(op.retry()).rejects.toBeInstanceOf(IdempotencyKeyExpiredError);
    expect(server.posts).toHaveLength(1);
    expect(op.status).toBe("uncertain");
  });

  it("long-running operations: a 409 while the first request is still processing is not a failure", async () => {
    server = await startServer();
    const { createOrder } = tab({ timeout: 50 });
    server.plan.push("slow");

    const op = createOrder.create(order());
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError); // client timed out
    await expect(op.retry()).rejects.toBeInstanceOf(OperationUncertainError); // 409: still processing
    expect(op.status).toBe("uncertain");

    await expect(op.reconcile({ attempts: 20, delay: 50, jitter: false })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(server.orders).toHaveLength(1);
  });

  it("authentication changes: a retry after re-authenticating reuses the key", async () => {
    server = await startServer({ token: "fresh-session" });
    let session = "expired-session";
    const { createOrder } = tab({ token: () => session });

    const op = createOrder.create(order());
    await expect(op.run()).rejects.toMatchObject({ status: 401 });
    expect(op.status).toBe("failed");

    session = "fresh-session"; // the app refreshes the session
    await expect(op.retry()).resolves.toMatchObject({ id: "order-1" });
    expect(server.posts.map((post) => post.key)).toEqual([op.idempotencyKey, op.idempotencyKey]);
  });

  it("different request payloads: a changed input is never sent under the original key", async () => {
    server = await startServer();
    const { createOrder } = tab();
    server.plan.push("drop-after-commit");

    const form = order();
    const op = createOrder.create(form);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);

    form.quantity = 5; // the app keeps editing the object it passed in
    await expect(op.retry()).rejects.toThrow(/input .*changed/);
    expect(server.posts).toHaveLength(1);
  });
});

describe("Suggested API", () => {
  it("accepts guard-wide retry defaults", async () => {
    server = await startServer();
    const { createOrder } = tab({ retry: { attempts: 3, delay: 10 } });
    server.plan.push("drop-after-commit");

    await expect(createOrder.create(order()).run()).resolves.toMatchObject({ id: "order-1" });
    expect(server.posts).toHaveLength(2);
    expect(server.orders).toHaveLength(1);
  });
});
