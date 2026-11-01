import type { BackoffOptions, ConcurrencyStrategy, ReconcileResult } from "./types.js";

const STRATEGIES: readonly ConcurrencyStrategy[] = ["join", "reject", "ignore", "queue"];
const RECONCILE_STATUSES = new Set(["succeeded", "failed", "pending", "not-found", "unknown"]);
// RFC 9110 token characters.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function assertString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

export function assertFunction(name: string, value: unknown, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

export function assertHeaderName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HEADER_NAME.test(value)) {
    throw new TypeError(`idempotencyHeader must be a valid HTTP header name, got ${String(value)}`);
  }
}

export function assertStrategy(value: unknown): asserts value is ConcurrencyStrategy {
  if (!STRATEGIES.includes(value as ConcurrencyStrategy)) {
    throw new TypeError(`concurrency must be one of ${STRATEGIES.join(", ")}, got ${String(value)}`);
  }
}

/** A duration: a positive number of milliseconds or `Infinity`. */
export function assertTtl(value: unknown, name = "ttl"): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds, got ${String(value)}`);
  }
}

/** A point in time in epoch milliseconds; `Infinity` for never. */
export function assertTimestamp(name: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${name} must be a number of epoch milliseconds, got ${String(value)}`);
  }
}

export function assertAttempts(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new RangeError(`attempts must be an integer of at least 1, got ${String(value)}`);
  }
}

export function assertBackoff({ delay, maxDelay, factor }: BackoffOptions): void {
  for (const [name, value, min] of [["delay", delay, 0], ["maxDelay", maxDelay, 0], ["factor", factor, 1]] as const) {
    if (value !== undefined && !(typeof value === "number" && value >= min && Number.isFinite(value))) {
      throw new RangeError(`${name} must be a finite number of at least ${min}, got ${String(value)}`);
    }
  }
}

/**
 * Checks the shape of a value returned by a developer's `reconcile` function.
 * A success must include `result` (even `null`), so a misnamed field is not
 * mistaken for a success without a result.
 */
export function isReconcileResult(value: unknown): value is ReconcileResult<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const { status } = value as { status?: unknown };
  return RECONCILE_STATUSES.has(status as string) && (status !== "succeeded" || "result" in value);
}
