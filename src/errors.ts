import type { OperationStatus } from "./types.js";

/** Base class for errors raised by MutationGuard itself. */
export class MutationGuardError extends Error {
  override name = "MutationGuardError";
}

/** `run()` or `retry()` was called while the operation was busy, with the `reject` strategy. */
export class OperationInProgressError extends MutationGuardError {
  override name = "OperationInProgressError";
  readonly operationId: string;

  constructor(operationId: string) {
    super(`Operation ${operationId} is already in progress`);
    this.operationId = operationId;
  }
}

/**
 * The backend may or may not have completed the operation. The original error
 * is available as `cause`. Reconcile the operation before submitting it again.
 */
export class OperationUncertainError extends MutationGuardError {
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
export class InvalidTransitionError extends MutationGuardError {
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
export class StorageError extends MutationGuardError {
  override name = "StorageError";
  readonly operationId: string | undefined;

  constructor(message: string, operationId: string | undefined, cause: unknown) {
    super(message, { cause });
    this.operationId = operationId;
  }
}
