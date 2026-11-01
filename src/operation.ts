import { MutationGuardError, OperationInProgressError, OperationUncertainError, StorageError } from "./errors.js";
import { assertTransition, isBusy, isResolved } from "./lifecycle.js";
import { toRecord } from "./recovery.js";
import type { Registry } from "./registry.js";
import { backoffDelay, sleep, type RetryPolicy } from "./retry.js";
import type {
  ConcurrencyStrategy,
  DefineOptions,
  Operation,
  OperationState,
  OperationStatus,
  OperationStorage,
  ReconcileOptions,
  ReconcileResult,
} from "./types.js";
import { assertAttempts, assertBackoff, isReconcileResult } from "./validate.js";

/** Settings shared by every operation of one definition. */
export interface OperationConfig<TInput, TResult> {
  execute: DefineOptions<TInput, TResult>["execute"];
  reconcile: DefineOptions<TInput, TResult>["reconcile"];
  concurrency: ConcurrencyStrategy;
  retry: RetryPolicy;
  isUncertain: (error: unknown) => boolean;
  persistInput: boolean;
  headerName: string;
  /** Milliseconds a stored record lives after each execution starts. */
  ttl: number;
  storage: OperationStorage;
  registry: Registry;
  onStorageError: (error: StorageError) => void;
}

type Patch<TResult> = Partial<Pick<OperationState<TResult>, "status" | "attempts" | "result" | "error">>;

interface Task {
  kind: "execute" | "reconcile";
  promise: Promise<unknown>;
}

const noop = () => {};

/** Surfaces an error thrown by developer code without interrupting the operation (or crashing Node). */
function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}

export class OperationHandle<TInput, TResult> implements Operation<TInput, TResult> {
  readonly id: string;
  readonly name: string;
  readonly idempotencyKey: string;
  readonly #config: OperationConfig<TInput, TResult>;
  readonly #input: { value: TInput } | undefined;
  #expiresAt: number | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #listeners = new Set<(state: OperationState<TResult>) => void>();
  #state: OperationState<TResult>;
  /** The execution or reconciliation in flight. At most one exists at a time. */
  #task: Task | undefined;
  /** Storage writes are chained so they land in the order the states were produced. */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(
    config: OperationConfig<TInput, TResult>,
    state: OperationState<TResult>,
    input: { value: TInput } | undefined,
    expiresAt: number | undefined,
  ) {
    this.id = state.id;
    this.name = state.name;
    this.idempotencyKey = state.idempotencyKey;
    this.#config = config;
    this.#state = Object.freeze(state);
    this.#input = input;
    this.#expiresAt = expiresAt;
    this.#headers = Object.freeze({ [config.headerName]: state.idempotencyKey });
  }

  get status(): OperationStatus {
    return this.#state.status;
  }

  get state(): OperationState<TResult> {
    return this.#state;
  }

  get input(): TInput | undefined {
    return this.#input?.value;
  }

  run(): Promise<TResult> {
    return this.#schedule("run");
  }

  retry(): Promise<TResult> {
    return this.#schedule("retry");
  }

  reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult<TResult>> {
    const task = this.#task;
    if (task?.kind === "reconcile") return task.promise as Promise<ReconcileResult<TResult>>;
    if (task) return Promise.reject(new OperationInProgressError(this.id));
    const { status, result, error } = this.#state;
    if (status === "succeeded") return Promise.resolve({ status, result: result as TResult });
    if (status === "failed") return Promise.resolve({ status, error });
    return this.#track("reconcile", () => this.#reconcile(options));
  }

  subscribe(listener: (state: OperationState<TResult>) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #schedule(action: "run" | "retry"): Promise<TResult> {
    const task = this.#task;
    if (!task) return this.#start(action);
    const { concurrency } = this.#config;
    if (concurrency === "reject") return Promise.reject(new OperationInProgressError(this.id));
    // `define` widens the result type to include `undefined` for this strategy.
    if (concurrency === "ignore") return Promise.resolve(undefined as TResult);
    if (concurrency === "join" && task.kind === "execute") return task.promise as Promise<TResult>;
    // `queue`, or `join` during a reconciliation: wait for it, then decide afresh.
    return task.promise.then(noop, noop).then(() => this.#schedule(action));
  }

  #start(action: "run" | "retry"): Promise<TResult> {
    const { status, result, error } = this.#state;
    if (status === "succeeded") return Promise.resolve(result as TResult);
    if (action === "run" && status === "failed") return Promise.reject(error);
    if (action === "run" && status === "uncertain") {
      return Promise.reject(new OperationUncertainError(this.id, error));
    }
    const input = this.#input;
    if (!input) {
      return Promise.reject(
        new MutationGuardError(
          `Cannot retry operation ${this.id}: its input was not persisted, so it was not restored`,
        ),
      );
    }
    // Claim the ID synchronously, so no other handle can start or be restored for it meanwhile.
    if (!this.#config.registry.claim(this)) {
      return Promise.reject(new MutationGuardError(`Another operation with ID ${this.id} is already active`));
    }
    return this.#track("execute", () => this.#execute(input.value));
  }

  #track<T>(kind: Task["kind"], fn: () => Promise<T>): Promise<T> {
    // `fn` starts on the next microtask, after `#task` is set.
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.#task?.promise === promise) this.#task = undefined;
      });
    this.#task = { kind, promise };
    return promise;
  }

  async #execute(input: TInput): Promise<TResult> {
    const { execute, retry, ttl } = this.#config;
    for (let attempt = 1; ; attempt++) {
      const next = { status: "pending", attempts: this.#state.attempts + 1 } as const;
      if (attempt === 1) {
        // The record must outlive the request it describes.
        this.#expiresAt = Number.isFinite(ttl) ? Date.now() + ttl : undefined;
        // Persist before the first request leaves, so a crash mid-request can be recovered.
        await this.#commitDurably(next);
      } else {
        this.#commit(next);
      }

      try {
        const result = await execute({
          input,
          operationId: this.id,
          idempotencyKey: this.idempotencyKey,
          headers: this.#headers,
          attempt: this.#state.attempts,
        });
        this.#commit({ status: "succeeded", result, error: undefined });
        return result;
      } catch (error) {
        const { uncertain, again } = this.#judge(error, attempt);
        if (again) {
          this.#commit({ error });
          await sleep(backoffDelay(retry, attempt));
          continue;
        }
        this.#commit({ status: uncertain ? "uncertain" : "failed", error });
        throw uncertain ? new OperationUncertainError(this.id, error) : error;
      }
    }
  }

  /** Classifies a failed attempt. If a callback throws, err on the side of an unknown outcome and stop retrying. */
  #judge(error: unknown, attempt: number): { uncertain: boolean; again: boolean } {
    const { isUncertain, retry } = this.#config;
    let uncertain = true;
    try {
      uncertain = isUncertain(error);
      return { uncertain, again: attempt < retry.attempts && retry.shouldRetry(error, { attempt, uncertain }) };
    } catch (callbackError) {
      reportError(callbackError);
      return { uncertain, again: false };
    }
  }

  async #reconcile(options: ReconcileOptions): Promise<ReconcileResult<TResult>> {
    const { reconcile } = this.#config;
    if (!reconcile) throw new MutationGuardError(`Operation "${this.name}" has no reconcile function`);
    const { attempts = 1, ...backoff } = options;
    assertAttempts(attempts);
    assertBackoff(backoff);

    this.#commit({ status: "recovering" });
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#lookup(reconcile);
      if (outcome.status === "succeeded") {
        this.#commit({ status: "succeeded", result: outcome.result, error: undefined });
        return outcome;
      }
      if (outcome.status === "failed") {
        const error = outcome.error ?? new MutationGuardError(`The backend reported that operation ${this.id} failed`);
        this.#commit({ status: "failed", error });
        return { status: "failed", error };
      }
      // `pending`, `not-found` and `unknown` leave the operation unresolved. Never resubmit here.
      if (attempt >= attempts) {
        this.#commit({ status: "uncertain" });
        return outcome;
      }
      await sleep(backoffDelay(backoff, attempt));
    }
  }

  async #lookup(
    reconcile: NonNullable<OperationConfig<TInput, TResult>["reconcile"]>,
  ): Promise<ReconcileResult<TResult>> {
    try {
      const outcome = await reconcile({
        input: this.input,
        operationId: this.id,
        idempotencyKey: this.idempotencyKey,
        headers: this.#headers,
      });
      if (isReconcileResult(outcome)) return outcome;
      const error = new MutationGuardError(
        'reconcile must resolve to { status: "succeeded", result } or { status: "failed" | "pending" | "not-found" | "unknown" }',
      );
      return { status: "unknown", error };
    } catch (error) {
      // An unreachable status endpoint tells us nothing about the operation.
      return { status: "unknown", error };
    }
  }

  /** Applies a change and persists it in the background. Storage failures are reported, not thrown. */
  #commit(patch: Patch<TResult>): void {
    const next = this.#next(patch);
    this.#write(next).catch((cause: unknown) => {
      try {
        this.#config.onStorageError(new StorageError(`Failed to persist operation ${this.id}`, this.id, cause));
      } catch (error) {
        reportError(error);
      }
    });
    this.#apply(next);
  }

  /** Persists a change before applying it. On failure the state is left unchanged. */
  async #commitDurably(patch: Patch<TResult>): Promise<void> {
    const next = this.#next(patch);
    try {
      await this.#write(next);
    } catch (cause) {
      throw new StorageError(`Failed to persist operation ${this.id}; it was not executed`, this.id, cause);
    }
    this.#apply(next);
  }

  #next(patch: Patch<TResult>): OperationState<TResult> {
    const current = this.#state;
    if (patch.status !== undefined && patch.status !== current.status) {
      assertTransition(current.status, patch.status);
    }
    return Object.freeze({ ...current, ...patch, updatedAt: Date.now() });
  }

  #apply(next: OperationState<TResult>): void {
    this.#state = next;
    // Clear before notifying, so a listener can start the next step (e.g. reconcile on `uncertain`).
    if (!isBusy(next.status)) this.#task = undefined;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch (error) {
        reportError(error);
      }
    }
  }

  #write(state: OperationState<TResult>): Promise<void> {
    const { storage, persistInput, registry } = this.#config;
    const write = this.#writes.then(async () => {
      if (!isResolved(state.status)) {
        await storage.set(toRecord(state, this.#expiresAt, persistInput ? this.#input : undefined));
        return;
      }
      // Resolved operations need no recovery, so their records are removed.
      await storage.delete(this.id);
      // Give up the ID only if nothing has started since; a failed delete keeps it, since the record remains.
      if (this.#state === state && !this.#task) registry.release(this);
    });
    this.#writes = write.catch(noop);
    return write;
  }
}
