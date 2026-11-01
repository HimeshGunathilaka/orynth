import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMutationGuard,
  OperationInProgressError,
  OperationUncertainError,
  type ConcurrencyStrategy,
  type OperationStatus,
} from "../src/index.js";
import { connectionReset, deferred, HttpError } from "./helpers.js";

/** A definition whose executions only finish when the test says so. */
function controlled(concurrency?: ConcurrencyStrategy) {
  const gates: ReturnType<typeof deferred<string>>[] = [];
  let running = 0;
  let maxRunning = 0;
  const execute = vi.fn(async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    const gate = deferred<string>();
    gates.push(gate);
    try {
      return await gate.promise;
    } finally {
      running--;
    }
  });
  const def = createMutationGuard().define({ name: "op", execute, ...(concurrency && { concurrency }) });
  return { def, execute, gates, maxRunning: () => maxRunning };
}

describe("execution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes, stores the result and walks created → pending → succeeded", async () => {
    const def = createMutationGuard().define({
      name: "create-order",
      execute: async ({ input }: { input: { quantity: number } }) => ({ orderId: "o1", ...input }),
    });
    const op = def.create({ quantity: 2 });
    const statuses: OperationStatus[] = [];
    op.subscribe((state) => statuses.push(state.status));

    expect(op.status).toBe("created");
    const result = await op.run();

    expect(result).toEqual({ orderId: "o1", quantity: 2 });
    expect(statuses).toEqual(["pending", "succeeded"]);
    expect(op.state).toMatchObject({ status: "succeeded", result, attempts: 1, error: undefined });
    expect(op.state.updatedAt).toBeGreaterThanOrEqual(op.state.createdAt);
  });

  it("does not execute a succeeded operation again", async () => {
    const execute = vi.fn(async () => "ok");
    const op = createMutationGuard().define({ name: "op", execute }).create();
    await op.run();
    await expect(op.run()).resolves.toBe("ok");
    await expect(op.retry()).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("join (default): concurrent calls share one execution", async () => {
    const { def, execute, gates } = controlled();
    const op = def.create();

    const calls = [op.run(), op.run(), op.retry()];
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve("ok");

    await expect(Promise.all(calls)).resolves.toEqual(["ok", "ok", "ok"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reject: duplicate calls fail fast while the first proceeds", async () => {
    const { def, execute, gates } = controlled("reject");
    const op = def.create();

    const first = op.run();
    const duplicate = op.run();
    await expect(duplicate).rejects.toBeInstanceOf(OperationInProgressError);
    await expect(duplicate).rejects.toMatchObject({ operationId: op.id });

    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve("ok");
    await expect(first).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("ignore: duplicate calls resolve with undefined and do nothing", async () => {
    const { def, execute, gates } = controlled("ignore");
    const op = def.create();

    const first = op.run();
    await expect(op.run()).resolves.toBeUndefined();

    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve("ok");
    await expect(first).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("queue: waits for the current execution and never overlaps", async () => {
    const { def, execute, gates, maxRunning } = controlled("queue");
    const op = def.create();

    const first = op.run();
    const queuedRetry = op.retry();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.reject(connectionReset());
    await expect(first).rejects.toBeInstanceOf(OperationUncertainError);

    // The queued retry starts only after the first execution settled.
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve("ok");
    await expect(queuedRetry).resolves.toBe("ok");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(maxRunning()).toBe(1);
  });

  it("queue: a queued run after success returns the result without executing", async () => {
    const { def, execute, gates } = controlled("queue");
    const op = def.create();

    const runs = [op.run(), op.run()];
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve("ok");

    await expect(Promise.all(runs)).resolves.toEqual(["ok", "ok"]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("scopes protection to the operation, not the payload", async () => {
    const { def, execute, gates } = controlled();
    const a = def.create({ same: "payload" });
    const b = def.create({ same: "payload" });

    const runs = [a.run(), b.run()];
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[0]!.resolve("a");
    gates[1]!.resolve("b");

    await expect(Promise.all(runs)).resolves.toEqual(["a", "b"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("marks definitive errors as failed and rethrows the original error", async () => {
    const error = new HttpError(422);
    const execute = vi.fn(async () => {
      throw error;
    });
    const op = createMutationGuard().define({ name: "op", execute }).create();

    await expect(op.run()).rejects.toBe(error);
    expect(op.state).toMatchObject({ status: "failed", error });
    // Running again reports the stored failure instead of resubmitting.
    await expect(op.run()).rejects.toBe(error);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("marks network failures as uncertain, not failed", async () => {
    const cause = connectionReset();
    const execute = vi.fn(async () => {
      throw cause;
    });
    const op = createMutationGuard().define({ name: "op", execute }).create();

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toBe(cause);
    expect(op.state).toMatchObject({ status: "uncertain", error: cause });

    // An uncertain operation is never resubmitted by run().
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("lets the developer decide which errors are uncertain", async () => {
    class GatewayTimeout extends Error {}
    const def = createMutationGuard().define({
      name: "op",
      isUncertain: (error) => error instanceof GatewayTimeout,
      execute: async ({ input }: { input: "timeout" | "network" }) => {
        throw input === "timeout" ? new GatewayTimeout() : connectionReset();
      },
    });

    const timedOut = def.create("timeout");
    const network = def.create("network");
    await Promise.allSettled([timedOut.run(), network.run()]);
    expect(timedOut.status).toBe("uncertain");
    expect(network.status).toBe("failed");
  });

  it("treats a throwing classifier as an uncertain outcome", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const bug = new Error("classifier bug");
    const op = createMutationGuard()
      .define({
        name: "op",
        isUncertain: () => {
          throw bug;
        },
        execute: async () => {
          throw new HttpError(400);
        },
      })
      .create();

    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(op.status).toBe("uncertain");
    expect(reported).toEqual([bug]);
  });

  it("handles execute functions that throw synchronously", async () => {
    const op = createMutationGuard()
      .define({
        name: "op",
        execute: (() => {
          throw new HttpError(400);
        }) as () => Promise<never>,
      })
      .create();
    await expect(op.run()).rejects.toBeInstanceOf(HttpError);
    expect(op.status).toBe("failed");
  });

  it("isolates listener errors from the operation", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const op = createMutationGuard().define({ name: "op", execute: async () => "ok" }).create();
    const seen: OperationStatus[] = [];
    op.subscribe(() => {
      throw new Error("listener bug");
    });
    op.subscribe((state) => seen.push(state.status));

    await expect(op.run()).resolves.toBe("ok");
    expect(seen).toEqual(["pending", "succeeded"]);
    expect(reported).toHaveLength(2);
  });

  it("falls back to console.error where reportError does not exist, as in Node", async () => {
    expect(globalThis).not.toHaveProperty("reportError");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const op = createMutationGuard().define({ name: "op", execute: async () => "ok" }).create();
    op.subscribe(() => {
      throw new Error("listener bug");
    });
    await expect(op.run()).resolves.toBe("ok");
    expect(consoleError).toHaveBeenCalledWith(new Error("listener bug"));
  });

  it("stops notifying after unsubscribe", async () => {
    const op = createMutationGuard().define({ name: "op", execute: async () => "ok" }).create();
    const listener = vi.fn();
    const unsubscribe = op.subscribe(listener);
    unsubscribe();
    await op.run();
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes immutable state snapshots", async () => {
    const op = createMutationGuard().define({ name: "op", execute: async () => "ok" }).create();
    const before = op.state;
    await op.run();
    expect(Object.isFrozen(op.state)).toBe(true);
    expect(before.status).toBe("created");
    expect(op.state).not.toBe(before);
  });

  it("validates definitions", () => {
    const guard = createMutationGuard();
    guard.define({ name: "taken", execute: async () => 1 });
    expect(() => guard.define({ name: "taken", execute: async () => 1 })).toThrow(/already defined/);
    expect(() => guard.define({ name: "", execute: async () => 1 })).toThrow(TypeError);
    expect(() => guard.define({ name: "x", execute: "nope" as never })).toThrow(TypeError);
    expect(() => guard.define({ name: "y", execute: async () => 1, concurrency: "drop" as never })).toThrow(TypeError);
    expect(() => guard.define({ name: "z", execute: async () => 1, ttl: -1 })).toThrow(RangeError);
  });
});
