import type { StorageError } from "./errors.js";

/**
 * Lifecycle of an operation:
 *
 * - `created`: not executed yet.
 * - `pending`: a request is in flight (or waiting to be retried).
 * - `uncertain`: the client cannot tell whether the backend completed it.
 * - `recovering`: asking the backend what happened (reconciliation).
 * - `succeeded`: completed; `result` holds the response.
 * - `failed`: definitively failed; `error` holds the reason.
 */
export type OperationStatus =
  | "created"
  | "pending"
  | "uncertain"
  | "recovering"
  | "succeeded"
  | "failed";

/**
 * What happens when `run()` or `retry()` is called while the same operation
 * is already executing.
 *
 * - `join` (default): return the in-flight execution's promise.
 * - `reject`: reject with `OperationInProgressError`.
 * - `ignore`: resolve immediately with `undefined` and do nothing.
 * - `queue`: wait for the in-flight execution to settle, then proceed.
 */
export type ConcurrencyStrategy = "join" | "reject" | "ignore" | "queue";

/** Immutable snapshot of an operation. A new object is created on every change. */
export interface OperationState<TResult = unknown> {
  readonly id: string;
  readonly name: string;
  readonly idempotencyKey: string;
  readonly status: OperationStatus;
  /** Number of times `execute` has been called for this operation. */
  readonly attempts: number;
  /** The result once `status` is `succeeded`. */
  readonly result?: TResult;
  /** The most recent error. Restored operations carry a `SerializedError`. */
  readonly error?: unknown;
  /**
   * Epoch milliseconds when the backend forgets the idempotency key: the
   * first request plus `ttl`. After it the operation is never resubmitted.
   */
  readonly expiresAt?: number;
  /** The instance's `scope` when the operation was created, e.g. the signed-in user. */
  readonly scope?: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds. */
  readonly updatedAt: number;
}

export interface ExecuteContext<TInput> {
  readonly input: TInput;
  readonly operationId: string;
  /** Stable for the lifetime of the operation, including every retry. */
  readonly idempotencyKey: string;
  /** `{ [idempotencyHeader]: idempotencyKey }`, ready to spread into request headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** 1-based count of executions of this operation, including this one. */
  readonly attempt: number;
}

export interface ReconcileContext<TInput> {
  /** `undefined` for restored operations whose input was not persisted. */
  readonly input: TInput | undefined;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** What the backend says happened to an operation. */
export type ReconcileResult<TResult> =
  /** The backend completed the operation. `result` is required; use `null` if there is none. */
  | { status: "succeeded"; result: TResult }
  /** The backend definitively did not complete the operation. */
  | { status: "failed"; error?: unknown }
  /** The backend is still processing the operation. */
  | { status: "pending" }
  /** The backend has no record of the operation. This does not make resubmission safe. */
  | { status: "not-found" }
  /** The outcome cannot be determined right now. */
  | { status: "unknown"; error?: unknown };

export interface BackoffOptions {
  /** Delay before the second attempt, in milliseconds. Default `1000`. */
  delay?: number;
  /** Upper bound for any single delay, in milliseconds. Default `30000`. */
  maxDelay?: number;
  /** Multiplier applied to the delay after each attempt. Default `2`. */
  factor?: number;
  /** Randomize each delay between 50% and 100% of its value. Default `true`. */
  jitter?: boolean;
}

export interface RetryContext {
  /** 1-based number of the attempt that just failed, within the current `run()` or `retry()`. */
  attempt: number;
  /** Whether the error was classified as an uncertain outcome. */
  uncertain: boolean;
}

export interface RetryOptions extends BackoffOptions {
  /** Maximum attempts per `run()` or `retry()` call, including the first. Default `3`. */
  attempts?: number;
  /** Decide whether an error is retried. Default: retry uncertain outcomes only. */
  shouldRetry?: (error: unknown, context: RetryContext) => boolean;
}

export interface ReconcileOptions extends BackoffOptions {
  /**
   * Maximum number of backend lookups. Values above `1` poll while the backend
   * answers `pending`, `not-found` or `unknown`. Default `1`.
   */
  attempts?: number;
}

export interface DefineOptions<TInput, TResult> {
  /** Unique name. Used to reconnect restored operations to this definition. */
  name: string;
  /** Performs the mutation. Throw to signal failure. */
  execute: (context: ExecuteContext<TInput>) => Promise<TResult>;
  /**
   * Asks the backend what happened to an operation. Required for `reconcile()`.
   * Don't call `run()`, `retry()` or `reconcile()` of the same operation from
   * inside it: they would wait for this reconciliation to finish.
   */
  reconcile?: (context: ReconcileContext<TInput>) => Promise<ReconcileResult<TResult>>;
  /** Default `"join"`. */
  concurrency?: ConcurrencyStrategy;
  /**
   * Automatic retries. Disabled by default because resending a mutation is
   * only safe when the backend honors the idempotency key.
   * `true` enables the default policy.
   */
  retry?: boolean | RetryOptions;
  /** Decide whether an error means the outcome is unknown. Default `isUncertainError`. */
  isUncertain?: (error: unknown) => boolean;
  /**
   * Store the input with the operation record so it can be retried after a
   * restore. The input must be serializable by the storage. Default `false`.
   */
  persistInput?: boolean;
  /** Overrides the instance's `idempotencyHeader`. */
  idempotencyHeader?: string;
  /** Overrides the instance's `ttl`. */
  ttl?: number;
  /** Overrides the instance's `requireStorage`. */
  requireStorage?: boolean;
}

/** The part of the Web Locks API (`navigator.locks`) that Orynth uses. */
export interface LockManagerLike {
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

export interface CreateOptions {
  /** Custom operation ID. Default: a random UUID. */
  id?: string;
  /** Custom idempotency key. Default: a random UUID, independent of the input. */
  idempotencyKey?: string;
  /**
   * For a custom `idempotencyKey` that may already have been sent, by an
   * earlier operation: epoch milliseconds when the backend forgets it. The
   * operation is not resent after that. Keys this instance sent itself are
   * remembered without it. Default: `ttl` after this operation's first request.
   */
  expiresAt?: number;
}

/** A handle to one logical operation. */
export interface Operation<TInput = unknown, TResult = unknown> {
  readonly id: string;
  /** Name of the definition this operation belongs to. */
  readonly name: string;
  readonly idempotencyKey: string;
  /** `undefined` for restored operations whose input was not persisted. */
  readonly input: TInput | undefined;
  readonly status: OperationStatus;
  readonly state: OperationState<TResult>;
  /**
   * Executes the operation and resolves with its result.
   *
   * - `created`: executes.
   * - `succeeded`: resolves with the stored result without executing again.
   * - `failed`: rejects with the stored error.
   * - `uncertain`: rejects with `OperationUncertainError`; reconcile or retry instead.
   * - in progress: applies the definition's concurrency strategy.
   */
  run(): Promise<TResult>;
  /**
   * Executes the operation again with the same ID, idempotency key and input.
   * Allowed from `failed` and `uncertain`. Only safe when the backend honors
   * the idempotency key or the operation is otherwise safe to repeat.
   * An `uncertain` operation stays uncertain unless the retry succeeds: its
   * rejection says nothing about the earlier request.
   */
  retry(): Promise<TResult>;
  /**
   * Asks the backend, through the definition's `reconcile` function, what
   * happened to an `uncertain` operation and updates the status. Never
   * resubmits the operation.
   */
  reconcile(options?: ReconcileOptions): Promise<ReconcileResult<TResult>>;
  /** Called synchronously after every state change. Returns an unsubscribe function. */
  subscribe(listener: (state: OperationState<TResult>) => void): () => void;
  /**
   * Stops tracking the operation: deletes its stored record and frees its ID.
   * Use it when the user gives up on an operation whose outcome stays unknown.
   * Later calls to `run()`, `retry()` and `reconcile()` reject. Rejects with
   * `OperationInProgressError` while the operation is running. If another tab
   * or instance has changed the stored operation since this handle last saw it,
   * or is working on it, its record is left to that tab.
   */
  discard(): Promise<void>;
}

type CreateArgs<TInput> = undefined extends TInput
  ? [input?: TInput, options?: CreateOptions]
  : [input: TInput, options?: CreateOptions];

export interface OperationDefinition<TInput, TResult> {
  readonly name: string;
  /** Starts a new logical operation with a new ID and idempotency key. */
  create(...args: CreateArgs<TInput>): Operation<TInput, TResult>;
  /**
   * The operation of this definition with the given ID that the instance is
   * running or tracking (in flight, unresolved or restored), if any.
   */
  get(id: string): Operation<TInput, TResult> | undefined;
  /** `orynth.restore()`, limited to this definition's operations. */
  restore(): Promise<Operation<TInput, TResult>[]>;
}

export interface OrynthOptions {
  /** `"memory"` (default) or a storage adapter such as `indexedDBStorage()`. */
  storage?: "memory" | OperationStorage;
  /** HTTP header name used for `context.headers`. Default `"Idempotency-Key"`. */
  idempotencyHeader?: string;
  /** Default `retry` option for definitions. Default `false`. */
  retry?: boolean | RetryOptions;
  /**
   * How long the backend remembers an idempotency key, in milliseconds,
   * counted from the operation's first request. After it, the operation is
   * never resubmitted (`IdempotencyKeyExpiredError`). Default 24 hours. Use
   * `Infinity` if keys never expire.
   */
  ttl?: number;
  /**
   * Who new operations belong to, such as the signed-in user's ID. `restore()`
   * and `get()` only return operations of the current scope, and an operation
   * of another scope can't be sent or reconciled: it is checked again right
   * before every request and lookup. A function is called each time the scope
   * is needed, and must return a string or `undefined`. Default: no scope.
   */
  scope?: string | (() => string | undefined);
  /**
   * When `true` (default), an operation is not sent if its record can't be
   * saved first, so every sent operation can be recovered. When `false`, a
   * storage failure is reported to `onStorageError` and the request is sent
   * anyway.
   */
  requireStorage?: boolean;
  /**
   * Coordinates operations across tabs with the Web Locks API. Default
   * `navigator.locks` where available; `false` disables it. Without it, or if
   * a lock request fails, tabs coordinate through leases stored with records.
   */
  locks?: LockManagerLike | false;
  /**
   * How long to wait for another tab to finish with an operation before
   * rejecting with `OperationInProgressError`, in milliseconds. Default `10000`.
   */
  lockTimeout?: number;
  /**
   * Called when a storage write that does not block execution fails.
   * The operation's in-memory state is still updated. Default: `console.error`.
   */
  onStorageError?: (error: StorageError) => void;
}

export interface Orynth {
  define<TInput = unknown, TResult = unknown>(
    options: DefineOptions<TInput, TResult> & { concurrency?: "join" | "reject" | "queue" },
  ): OperationDefinition<TInput, TResult>;
  /** With `concurrency: "ignore"`, a duplicate `run()` resolves with `undefined`. */
  define<TInput = unknown, TResult = unknown>(
    options: DefineOptions<TInput, TResult>,
  ): OperationDefinition<TInput, TResult | undefined>;
  /**
   * Returns the current scope's operations that need recovery: unresolved
   * records loaded from storage and reconnected with their definitions, plus
   * `uncertain` operations this instance already tracks. Operations that are
   * running are not returned. Restored operations are `uncertain` and never
   * execute on their own: call `reconcile()`, or `retry()` once resubmission is
   * known to be safe. Expired operations are returned too; they can be
   * reconciled but not resent, so `discard()` them once handled. Records whose
   * definition has not been defined yet are left in storage.
   */
  restore(): Promise<Operation[]>;
  /**
   * Discards every operation and deletes every stored record, in all scopes.
   * Call it on sign-out. Operations that are running, in this tab or another,
   * are left to finish.
   */
  clear(): Promise<void>;
}

/** A failure as stored in an operation record. */
export interface SerializedError {
  name: string;
  message: string;
}

/** What storage adapters persist. Must survive a structured clone. */
export interface OperationRecord {
  id: string;
  name: string;
  idempotencyKey: string;
  status: OperationStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  /** Epoch milliseconds after which the record may be deleted. Absent or `null` means never. */
  expiresAt?: number;
  /** Changes on every write, so instances can tell when another tab changed the record. */
  revision: string;
  /** The instance's scope when the operation was created. Absent or `null` means none. */
  scope?: string;
  /**
   * The tab sending the operation, and until when other tabs must leave it
   * alone. `locks` if that tab holds the operation's Web Lock, which tabs with
   * Web Locks wait for instead.
   */
  lease?: { owner: string; until: number; locks?: boolean };
  /** Present only when the definition sets `persistInput: true`. `null` counts as absent. */
  input?: unknown;
  error?: SerializedError;
}

/**
 * Persistence for operation records. Methods may reject; the instance wraps
 * failures in `StorageError`.
 */
export interface OperationStorage {
  /** Inserts or replaces the record with the same `id`. */
  set(record: OperationRecord): Promise<void>;
  /** Returns the record with this `id`, or `undefined`. */
  get(id: string): Promise<OperationRecord | undefined>;
  /** Deletes the record. Resolves even if it does not exist. */
  delete(id: string): Promise<void>;
  /** Returns every stored record. */
  list(): Promise<OperationRecord[]>;
}
