import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMutationGuard, OperationUncertainError, type ExecuteContext } from "../src/index.js";
import { backoffDelay } from "../src/retry.js";
import { connectionReset, HttpError } from "./helpers.js";

type Input = { productId: string };

/** Fails with the given errors in order, then succeeds. */
function scripted(...errors: unknown[]) {
  return vi.fn(async ({ attempt }: ExecuteContext<Input>) => {
    const error = errors[attempt - 1];
    if (error) throw error;
    return `ok on attempt ${attempt}`;
  });
}

describe("retry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is disabled by default, because resending is only safe with backend idempotency", async () => {
    const execute = scripted(connectionReset());
    const op = createMutationGuard().define({ name: "op", execute }).create({ productId: "1" });

    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries uncertain outcomes with exponential backoff, reusing key and input", async () => {
    const execute = scripted(connectionReset(), connectionReset());
    const op = createMutationGuard()
      .define({ name: "op", execute, retry: { attempts: 3, delay: 1000, jitter: false } })
      .create({ productId: "1" });

    const result = op.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toBe("ok on attempt 3");
    const contexts = execute.mock.calls.map(([ctx]) => ctx);
    expect(new Set(contexts.map((ctx) => ctx.idempotencyKey))).toEqual(new Set([op.idempotencyKey]));
    expect(new Set(contexts.map((ctx) => ctx.input))).toEqual(new Set([op.input]));
  });

  it("stays pending with the last error while waiting to retry", async () => {
    const error = connectionReset();
    const execute = scripted(error);
    const op = createMutationGuard()
      .define({ name: "op", execute, retry: { delay: 500, jitter: false } })
      .create({ productId: "1" });

    const result = op.run();
    await vi.advanceTimersByTimeAsync(100);
    expect(op.state).toMatchObject({ status: "pending", error, attempts: 1 });

    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe("ok on attempt 2");
    expect(op.state).toMatchObject({ status: "succeeded", error: undefined, attempts: 2 });
  });

  it("stops at the attempt limit and reports the outcome as uncertain", async () => {
    const execute = scripted(connectionReset(), connectionReset(), connectionReset(), connectionReset());
    const op = createMutationGuard()
      .define({ name: "op", execute, retry: { attempts: 3, delay: 10, jitter: false } })
      .create({ productId: "1" });

    const result = op.run().catch((e: unknown) => e);
    await vi.runAllTimersAsync();

    expect(await result).toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(op.state).toMatchObject({ status: "uncertain", attempts: 3 });
  });

  it("does not retry permanent failures by default", async () => {
    const execute = scripted(new HttpError(422));
    const op = createMutationGuard().define({ name: "op", execute, retry: true }).create({ productId: "1" });

    await expect(op.run()).rejects.toBeInstanceOf(HttpError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(op.status).toBe("failed");
  });

  it("supports custom retry conditions", async () => {
    const shouldRetry = vi.fn((error: unknown) => error instanceof HttpError && error.status === 429);
    const execute = scripted(new HttpError(429), new HttpError(429));
    const op = createMutationGuard()
      .define({ name: "op", execute, retry: { attempts: 5, delay: 10, shouldRetry } })
      .create({ productId: "1" });

    const result = op.run();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ok on attempt 3");
    expect(shouldRetry).toHaveBeenNthCalledWith(1, expect.any(HttpError), { attempt: 1, uncertain: false });
    expect(shouldRetry).toHaveBeenNthCalledWith(2, expect.any(HttpError), { attempt: 2, uncertain: false });
  });

  it("can be disabled explicitly", async () => {
    const execute = scripted(connectionReset());
    const op = createMutationGuard().define({ name: "op", execute, retry: false }).create({ productId: "1" });
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("retries manually after a failure with the same identity", async () => {
    const execute = scripted(new HttpError(503), undefined);
    const op = createMutationGuard()
      .define({ name: "op", execute, isUncertain: () => false })
      .create({ productId: "1" });

    await expect(op.run()).rejects.toBeInstanceOf(HttpError);
    expect(op.status).toBe("failed");

    await expect(op.retry()).resolves.toBe("ok on attempt 2");
    const [first, second] = execute.mock.calls.map(([ctx]) => ctx);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(second!.input).toBe(first!.input);
  });

  it("gives each manual retry the full automatic retry budget", async () => {
    const execute = scripted(connectionReset(), connectionReset(), connectionReset());
    const op = createMutationGuard()
      .define({ name: "op", execute, retry: { attempts: 2, delay: 10 } })
      .create({ productId: "1" });

    const first = op.run().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await first).toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(2);

    const second = op.retry();
    await vi.runAllTimersAsync();
    await expect(second).resolves.toBe("ok on attempt 4");
  });

  it("validates retry options", () => {
    const guard = createMutationGuard();
    const execute = async () => 1;
    expect(() => guard.define({ name: "a", execute, retry: { attempts: 0 } })).toThrow(RangeError);
    expect(() => guard.define({ name: "b", execute, retry: { attempts: 1.5 } })).toThrow(RangeError);
    expect(() => guard.define({ name: "c", execute, retry: { delay: -1 } })).toThrow(RangeError);
    expect(() => guard.define({ name: "d", execute, retry: { factor: 0.5 } })).toThrow(RangeError);
    expect(() => guard.define({ name: "e", execute, retry: { shouldRetry: 1 as never } })).toThrow(TypeError);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially up to maxDelay", () => {
    const options = { delay: 100, factor: 3, maxDelay: 2000, jitter: false };
    expect([1, 2, 3, 4, 5].map((attempt) => backoffDelay(options, attempt))).toEqual([100, 300, 900, 2000, 2000]);
  });

  it("uses 1s doubling up to 30s by default", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect([1, 2, 3, 6].map((attempt) => backoffDelay({}, attempt))).toEqual([1000, 2000, 4000, 30_000]);
  });

  it("applies jitter between 50% and 100% of the delay", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    expect(backoffDelay({ delay: 1000 }, 1)).toBe(500);
    expect(backoffDelay({ delay: 1000 }, 1)).toBe(750);
  });
});
