import type { OperationStatus } from "./types.js";

// Shared through the global symbol registry, so every copy of the package agrees on it.
const KINDS = Symbol.for("orynth.error-kinds");

/**
 * Base class for errors raised by Orynth itself. `instanceof` works
 * across duplicate copies of the package, such as its ESM and CommonJS builds
 * loaded side by side.
 */
export class OrynthError extends Error {
  static readonly kind: string = "OrynthError";
  override name = "OrynthError";

  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    const kinds: string[] = [];
    for (let type: unknown = new.target; typeof type === "function" && type !== Error; type = Object.getPrototypeOf(type)) {
      if (Object.hasOwn(type, "kind")) kinds.push((type as typeof OrynthError).kind);
    }
    Object.defineProperty(this, KINDS, { value: kinds });
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    const kinds = (value as Record<symbol, unknown> | null | undefined)?.[KINDS];
    // Classes outside this package (subclasses without their own `kind`) use the normal check.
    if (!Object.hasOwn(this, "kind") || !Array.isArray(kinds)) {
      return Function.prototype[Symbol.hasInstance].call(this, value);
    }
    return kinds.includes(this.kind);
  }
}

/**
 * The operation is busy: `run()` or `retry()` was called while it was running
 * with the `reject` strategy, `reconcile()` was called during a request, or
 * another tab held the operation for longer than `lockTimeout`.
 */
export class OperationInProgressError extends OrynthError {
  static override readonly kind: string = "OperationInProgressError";
  override name = "OperationInProgressError";
  readonly operationId: string;

  constructor(operationId: string, message = `Operation ${operationId} is already in progress`) {
    super(message);
    this.operationId = operationId;
  }
}

/**
 * The backend may or may not have completed the operation. The original error
 * is available as `cause`. Reconcile the operation before submitting it again.
 */
export class OperationUncertainError extends OrynthError {
  static override readonly kind: string = "OperationUncertainError";
  override name = "OperationUncertainError";
  readonly operationId: string;

  constructor(operationId: string, cause: unknown) {
    super(
      `The outcome of operation ${operationId} is uncertain: the backend may have completed it`,
      { cause },
    );
    this.operationId = operationId;
  }
}

/** An operation was asked to move between two states the lifecycle does not connect. */
export class InvalidTransitionError extends OrynthError {
  static override readonly kind: string = "InvalidTransitionError";
  override name = "InvalidTransitionError";
  readonly from: OperationStatus;
  readonly to: OperationStatus;

  constructor(from: OperationStatus, to: OperationStatus) {
    super(`Invalid operation state transition: ${from} → ${to}`);
    this.from = from;
    this.to = to;
  }
}

/** A storage adapter failed. The adapter's error is available as `cause`. */
export class StorageError extends OrynthError {
  static override readonly kind: string = "StorageError";
  override name = "StorageError";
  readonly operationId: string | undefined;

  constructor(message: string, operationId: string | undefined, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.operationId = operationId;
  }
}

/**
 * The stored operation is not what this handle expects: another tab or instance
 * resolved, resubmitted, is sending or already created it. Nothing was sent.
 * Reconcile the operation (or restore it) instead of resubmitting.
 */
export class OperationConflictError extends OrynthError {
  static override readonly kind: string = "OperationConflictError";
  override name = "OperationConflictError";
  readonly operationId: string;

  constructor(operationId: string, message: string) {
    super(message);
    this.operationId = operationId;
  }
}

/**
 * The backend no longer remembers the operation's idempotency key, so it would
 * treat a resubmission as a new operation. Nothing was sent.
 */
export class IdempotencyKeyExpiredError extends OrynthError {
  static override readonly kind: string = "IdempotencyKeyExpiredError";
  override name = "IdempotencyKeyExpiredError";
  readonly operationId: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;

  constructor(operationId: string, expiresAt: number) {
    // A stored record may hold a time outside the Date range.
    const date = new Date(expiresAt);
    super(
      `The idempotency key of operation ${operationId} expired at ` +
        `${Number.isNaN(date.getTime()) ? expiresAt : date.toISOString()}; resubmitting it could create a duplicate`,
    );
    this.operationId = operationId;
    this.expiresAt = expiresAt;
  }
}
