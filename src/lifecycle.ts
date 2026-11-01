import { InvalidTransitionError } from "./errors.js";
import type { OperationStatus } from "./types.js";

const TRANSITIONS: Record<OperationStatus, readonly OperationStatus[]> = {
  created: ["pending"],
  pending: ["succeeded", "failed", "uncertain"],
  // `pending` only through an explicit `retry()`.
  uncertain: ["recovering", "pending"],
  recovering: ["succeeded", "failed", "uncertain"],
  // `pending` only through an explicit `retry()`.
  failed: ["pending"],
  succeeded: [],
};

export function assertTransition(from: OperationStatus, to: OperationStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new InvalidTransitionError(from, to);
}

/** The backend's answer is known; there is nothing left to recover. */
export function isResolved(status: OperationStatus): boolean {
  return status === "succeeded" || status === "failed";
}

/** A request or reconciliation is in flight. */
export function isBusy(status: OperationStatus): boolean {
  return status === "pending" || status === "recovering";
}
