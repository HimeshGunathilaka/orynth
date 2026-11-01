import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrynth,
  InvalidTransitionError,
  OrynthError,
  OperationInProgressError,
  OperationUncertainError,
  type OperationStatus,
  type ReconcileResult,
} from "../src/index.js";
import { assertTransition } from "../src/lifecycle.js";
import { connectionReset, deferred, HttpError } from "./helpers.js";

const STATUSES: OperationStatus[] = ["created", "pending", "uncertain", "recovering", "succeeded", "failed"];
const VALID = new Set([
  "created→pending",
  "pending→succeeded",
  "pending→failed",
  "pending→uncertain",
  "uncertain→recovering",
  "uncertain→pending",
  "recovering→succeeded",
  "recovering→failed",
  "recovering→uncertain",
  "failed→pending",
]);

/** An operation that ends up `uncertain`, with a scripted reconcile function. */
async function uncertainOperation(...outcomes: (ReconcileResult<string> | Error)[]) {
  const execute = vi.fn(async (): Promise<string> => {
    throw connectionReset();
  });
  const reconcile = vi.fn(async (): Promise<ReconcileResult<string>> => {
    const outcome = outcomes.shift() ?? { status: "unknown" };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const op = createOrynth().define({ name: "op", execute, reconcile }).create();
  await op.run().catch(() => {});
  expect(op.status).toBe("uncertain");
  const statuses: OperationStatus[] = [];
  op.subscribe((state) => statuses.push(state.status));
  return { op, execute, reconcile, statuses };
}

describe("state machine", () => {
  it.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)))("%s → %s", (from, to) => {
    if (VALID.has(`${from}→${to}`)) expect(() => assertTransition(from, to)).not.toThrow();
    else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
  });

  it("refuses to reconcile an operation that never ran", async () => {
    const op = createOrynth()
      .define({ name: "op", execute: async () => 1, reconcile: async () => ({ status: "not-found" }) })
      .create();
    await expect(op.reconcile()).rejects.toMatchObject({ from: "created", to: "recovering" });
    expect(op.status).toBe("created");
  });
});

describe("reconciliation", () => {
  afterEach(() => vi.useRealTimers());

  it("succeeded: stores the backend's result", async () => {
    const { op, execute, statuses } = await uncertainOperation({ status: "succeeded", result: "order-1" });

    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: "order-1" });
    expect(statuses).toEqual(["recovering", "succeeded"]);
    expect(op.state).toMatchObject({ status: "succeeded", result: "order-1", error: undefined });
    await expect(op.run()).resolves.toBe("order-1");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("failed: records the backend's error", async () => {
    const error = new HttpError(402);
    const { op, statuses } = await uncertainOperation({ status: "failed", error });

    await expect(op.reconcile()).resolves.toEqual({ status: "failed", error });
    expect(statuses).toEqual(["recovering", "failed"]);
    await expect(op.run()).rejects.toBe(error);
  });

  it("failed without an error: substitutes a descriptive one", async () => {
    const { op } = await uncertainOperation({ status: "failed" });
    const outcome = await op.reconcile();
    expect(outcome.status).toBe("failed");
    expect(op.state.error).toBeInstanceOf(OrynthError);
  });

  it.each([{ status: "pending" }, { status: "not-found" }, { status: "unknown" }] as const)(
    "$status: leaves the operation uncertain and does not resubmit",
    async (outcome) => {
      const { op, execute, statuses } = await uncertainOperation(outcome);

      await expect(op.reconcile()).resolves.toEqual(outcome);
      expect(statuses).toEqual(["recovering", "uncertain"]);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    },
  );

  it("keeps the original error when the outcome stays unknown", async () => {
    const { op } = await uncertainOperation({ status: "not-found" });
    const original = op.state.error;
    await op.reconcile();
    expect(op.state.error).toBe(original);
  });

  it("treats an unreachable status endpoint as unknown", async () => {
    const unreachable = connectionReset();
    const { op } = await uncertainOperation(unreachable, { status: "succeeded", result: "order-1" });

    await expect(op.reconcile()).resolves.toEqual({ status: "unknown", error: unreachable });
    expect(op.status).toBe("uncertain");
    // It can be tried again later.
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: "order-1" });
  });

  it("treats a malformed reconcile result as unknown", async () => {
    const { op } = await uncertainOperation({ status: "done" } as never);
    const outcome = await op.reconcile();
    expect(outcome).toMatchObject({ status: "unknown", error: expect.any(OrynthError) });
    expect(op.status).toBe("uncertain");
  });

  it("rejects a success without a result, so a misnamed field cannot resolve the operation", async () => {
    const { op } = await uncertainOperation({ status: "succeeded", order: "order-1" } as never);
    await expect(op.reconcile()).resolves.toMatchObject({ status: "unknown" });
    expect(op.status).toBe("uncertain");
  });

  it("requires a reconcile function", async () => {
    const op = createOrynth()
      .define({
        name: "op",
        execute: async () => {
          throw connectionReset();
        },
      })
      .create();
    await op.run().catch(() => {});
    await expect(op.reconcile()).rejects.toThrow(/no reconcile function/);
    expect(op.status).toBe("uncertain");
  });

  it("returns the known outcome of a resolved operation without asking the backend", async () => {
    const reconcile = vi.fn();
    const op = createOrynth().define({ name: "op", execute: async () => "ok", reconcile }).create();
    await op.run();
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: "ok" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("shares one lookup between concurrent reconcile calls", async () => {
    const gate = deferred<ReconcileResult<string>>();
    const { op, reconcile } = await uncertainOperation();
    reconcile.mockImplementationOnce(() => gate.promise);

    const calls = [op.reconcile(), op.reconcile()];
    gate.resolve({ status: "succeeded", result: "x" });
    await expect(Promise.all(calls)).resolves.toEqual([
      { status: "succeeded", result: "x" },
      { status: "succeeded", result: "x" },
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("cannot reconcile while a request is in flight", async () => {
    const gate = deferred<string>();
    const op = createOrynth()
      .define({ name: "op", execute: () => gate.promise, reconcile: async () => ({ status: "unknown" }) })
      .create();
    const run = op.run();
    await expect(op.reconcile()).rejects.toBeInstanceOf(OperationInProgressError);
    gate.resolve("ok");
    await run;
  });

  it("join: run() during reconciliation waits for it and never resubmits", async () => {
    const gate = deferred<ReconcileResult<string>>();
    const { op, execute, reconcile } = await uncertainOperation();
    reconcile.mockImplementationOnce(() => gate.promise);

    const reconciling = op.reconcile();
    const run = op.run();
    gate.resolve({ status: "succeeded", result: "order-1" });

    await expect(run).resolves.toBe("order-1");
    await reconciling;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("queue: retry() during reconciliation runs only if the backend did not complete it", async () => {
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(connectionReset())
      .mockResolvedValueOnce("resubmitted");
    const gate = deferred<ReconcileResult<string>>();
    const op = createOrynth()
      .define({ name: "op", concurrency: "queue", execute, reconcile: () => gate.promise })
      .create();
    await op.run().catch(() => {});

    const reconciling = op.reconcile();
    const retry = op.retry();
    expect(execute).toHaveBeenCalledTimes(1);
    gate.resolve({ status: "not-found" });

    await expect(reconciling).resolves.toEqual({ status: "not-found" });
    await expect(retry).resolves.toBe("resubmitted");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("lets a listener start reconciliation as soon as the outcome becomes uncertain", async () => {
    const reconciled = deferred<ReconcileResult<string>>();
    const op = createOrynth()
      .define({
        name: "op",
        execute: async (): Promise<string> => {
          throw connectionReset();
        },
        reconcile: async () => ({ status: "succeeded", result: "order-1" }),
      })
      .create();
    op.subscribe((state) => {
      if (state.status === "uncertain") op.reconcile().then(reconciled.resolve, reconciled.reject);
    });

    await op.run().catch(() => {});
    await expect(reconciled.promise).resolves.toEqual({ status: "succeeded", result: "order-1" });
    expect(op.status).toBe("succeeded");
  });

  it("polls until the backend reaches a final answer", async () => {
    vi.useFakeTimers();
    const { op, reconcile, statuses } = await uncertainOperation(
      { status: "pending" },
      { status: "not-found" },
      { status: "succeeded", result: "order-1" },
    );

    const outcome = op.reconcile({ attempts: 5, delay: 1000, jitter: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(op.status).toBe("recovering");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(outcome).resolves.toEqual({ status: "succeeded", result: "order-1" });
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual(["recovering", "succeeded"]);
  });

  it("stops polling after the attempt limit and stays uncertain", async () => {
    vi.useFakeTimers();
    const { op, reconcile } = await uncertainOperation();

    const outcome = op.reconcile({ attempts: 3, delay: 100 });
    await vi.runAllTimersAsync();

    await expect(outcome).resolves.toEqual({ status: "unknown" });
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(op.status).toBe("uncertain");
  });

  it("validates polling options", async () => {
    const { op } = await uncertainOperation();
    await expect(op.reconcile({ attempts: 0 })).rejects.toThrow(RangeError);
    expect(op.status).toBe("uncertain");
  });
});
