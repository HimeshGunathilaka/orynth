import {
  IdempotencyKeyExpiredError,
  OrynthError,
  OperationConflictError,
  OperationInProgressError,
  OperationUncertainError,
  StorageError,
} from "./errors.js";
import { generateId } from "./id.js";
import { assertTransition, isBusy, isResolved } from "./lifecycle.js";
import { isLive, toRecord, type Lease } from "./recovery.js";
import type { Registry } from "./registry.js";
import { backoffDelay, sleep, type RetryPolicy } from "./retry.js";
import type {
  ConcurrencyStrategy,
  DefineOptions,
  LockManagerLike,
  Operation,
  OperationRecord,
  OperationState,
  OperationStatus,
  OperationStorage,
  ReconcileOptions,
  ReconcileResult,
} from "./types.js";
import { assertAttempts, assertBackoff, isReconcileResult } from "./validate.js";

/** What every operation of one instance shares. */
export interface GuardContext {
  storage: OperationStorage;
  registry: Registry;
  /** Serializes work on one operation across tabs. `undefined` without Web Locks (or after they failed). */
  locks: LockManagerLike | undefined;
  lockTimeout: number;
  scope: () => string | undefined;
  /** Never throws: an error thrown by the developer's callback is reported instead. */
  onStorageError: (error: StorageError) => void;
  /** When the backend forgets idempotency keys that operations may share, as far as this instance knows. */
  keys: Map<string, number>;
}

/** Settings shared by every operation of one definition. */
export interface OperationConfig<TInput, TResult> {
  execute: DefineOptions<TInput, TResult>["execute"];
  reconcile: DefineOptions<TInput, TResult>["reconcile"];
  concurrency: ConcurrencyStrategy;
  retry: RetryPolicy;
  isUncertain: (error: unknown) => boolean;
  persistInput: boolean;
  requireStorage: boolean;
  headerName: string;
  /** How long the backend remembers an idempotency key, from the first request. */
  ttl: number;
  guard: GuardContext;
}

type Patch<TResult> = Partial<
  Pick<OperationState<TResult>, "status" | "attempts" | "result" | "error" | "expiresAt">
>;

interface Task {
  kind: "execute" | "reconcile";
  promise: Promise<unknown>;
}

// A tab sending an operation keeps a lease on its record, which tabs without Web Locks respect.
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
// How often an input edited while its record is being written is stored again, before giving up.
const MAX_CAPTURES = 3;

const noop = () => {};

/** Blobs can't change, so the same object means the same contents. */
const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 0;

/** A 53-bit hash (cyrb53) of some bytes, so binary inputs are compared without copying them. */
function hashBytes(bytes: Uint8Array): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${bytes.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * A description of an input, to detect changes before it is resent;
 * `undefined` if it can't be described (a throwing getter, a revoked proxy).
 * It covers what `execute` may read: collections, binary data, `BigInt`s,
 * shared and circular references, and non-enumerable properties. Blobs are
 * compared by identity, so replacing one is a change.
 */
function fingerprint(input: unknown): string | undefined {
  const seen = new Map<object, number>();
  const describe = (value: unknown): string => {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return "function";
    if (typeof value !== "object" || value === null) return String(value);
    // Repeated and circular references point back to the first occurrence.
    const index = seen.get(value);
    if (index !== undefined) return `@${index}`;
    seen.set(value, seen.size);
    const tag = Object.prototype.toString.call(value);
    const entries = (pairs: Iterable<[unknown, unknown]>) =>
      Array.from(pairs, ([key, item]) => `${describe(key)}:${describe(item)}`).join(",");

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      if (!blobIds.has(value)) blobIds.set(value, nextBlobId++);
      return `${tag}#${blobIds.get(value)}`;
    }
    if (ArrayBuffer.isView(value)) {
      return `${tag}(${hashBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))})`;
    }
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
      return `${tag}(${hashBytes(new Uint8Array(value as ArrayBufferLike))})`;
    }
    if (value instanceof Map) return `${tag}{${entries(value)}}`;
    if (value instanceof Set) return `${tag}[${Array.from(value, describe).join(",")}]`;
    if (typeof FormData !== "undefined" && value instanceof FormData) {
      return `${tag}{${entries(value as unknown as Iterable<[string, unknown]>)}}`;
    }
    if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
      return `${tag}(${JSON.stringify(value.toString())})`;
    }
    if (Array.isArray(value)) return `[${Array.from(value, describe).join(",")}]`;
    // What JSON would send for it, e.g. a Date's ISO string: equal to the string a JSON-backed store restores.
    const { toJSON } = value as { toJSON?: unknown };
    if (typeof toJSON === "function") return describe(toJSON.call(value));
    // Own properties in a stable order, including non-enumerable data properties `execute` may read.
    const properties: string[] = [];
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      // Hidden getters are left alone: reading them may have effects.
      if (descriptor?.enumerable) {
        const item = (value as Record<string, unknown>)[key];
        // Like JSON, which a store may restore the input through, `{ a: undefined }` equals `{}`.
        if (item !== undefined) properties.push(`${JSON.stringify(key)}:${describe(item)}`);
      } else if (descriptor && "value" in descriptor) properties.push(`${JSON.stringify(key)}:${describe(descriptor.value)}`);
    }
    return `{${properties.join(",")}}`;
  };
  try {
    return describe(input);
  } catch {
    return undefined;
  }
}

/** Whether a value holds a `FormData` or `URLSearchParams`, anywhere. */
function containsForm(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  seen.add(value);
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) return true;
  let items: Iterable<unknown> = Object.values(value);
  if (value instanceof Map) items = [...value.keys(), ...value.values()];
  else if (value instanceof Set) items = value;
  for (const item of items) if (containsForm(item, seen)) return true;
  return false;
}

/** A storable copy of an input as it is now, or a TypeError for one that can't be stored as it is. */
function storableCopy(input: unknown): unknown {
  // Browsers refuse to clone these, but React Native's FormData clones into a plain object that can't be sent again.
  if (containsForm(input)) throw new TypeError("A FormData or URLSearchParams can't be stored; store plain data instead");
  return toPlainData(input);
}

/**
 * A storable copy of a value as it is now. Proxies (Vue `reactive`, MobX)
 * can't be structured-cloned, so they are copied part by part. Throws for
 * values that can't be stored as they are, such as functions and `FormData`.
 */
function toPlainData(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol") throw new TypeError(`A ${typeof value} can't be stored`);
  if (typeof value !== "object" || value === null) return value;
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // A proxy, or something inside it that structured cloning can't copy.
  }
  if (Array.isArray(value)) return Array.from(value, toPlainData);
  if (value instanceof Map) return new Map(Array.from(value, ([key, item]) => [toPlainData(key), toPlainData(item)]));
  if (value instanceof Set) return new Set(Array.from(value, toPlainData));
  if (value instanceof Date) return new Date(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  // Typed arrays. A DataView has no `slice`, and is refused below.
  if (ArrayBuffer.isView(value) && "slice" in value) return (value as Uint8Array).slice();
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === "function") return toPlainData(toJSON.call(value));
  // Platform objects such as `FormData` keep their contents out of reach: a copy would be `{}`.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && Object.keys(value).length === 0) {
    throw new TypeError(`A ${Object.prototype.toString.call(value)} can't be stored`);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlainData(item)]));
}

/** Surfaces an error thrown by developer code without interrupting the operation (or crashing Node). */
export function reportError(error: unknown): void {
  const report = (globalThis as { reportError?: (error: unknown) => void }).reportError;
  if (typeof report === "function") report(error);
  else console.error(error);
}

/**
 * Runs `fn` under the Web Lock of operation `id`, if the instance has Web Locks.
 * The result is returned as soon as `fn` settles, but the lock is held until
 * `settled()` resolves (the operation's writes have landed), so the next
 * holder, in any tab, reads the final state.
 */
export function withLock<T>(
  guard: GuardContext,
  id: string,
  fn: () => Promise<T>,
  settled: () => Promise<unknown> = () => Promise.resolve(),
): Promise<T> {
  const { locks, lockTimeout } = guard;
  if (!locks) return fn();
  return new Promise<T>((resolve, reject) => {
    let started = false;
    const run = () => {
      started = true;
      return fn().then(resolve, reject);
    };
    const signal =
      Number.isFinite(lockTimeout) && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(lockTimeout)
        : undefined;
    let request: Promise<unknown>;
    try {
      request = locks.request(`orynth:${id}`, signal ? { signal } : {}, async () => {
        await run();
        await settled();
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.catch((error: unknown) => {
      if (started) return;
      if (signal?.aborted) {
        reject(new OperationInProgressError(id, `Operation ${id} is busy in another tab; try again later`));
        return;
      }
      // The Web Locks API is unusable here (e.g. an opaque origin): continue with leases.
      if (guard.locks === locks) {
        guard.locks = undefined;
        reportError(new OrynthError("Web Locks are unavailable; coordinating tabs with leases", { cause: error }));
      }
      void run();
    });
  });
}

export class OperationHandle<TInput, TResult> implements Operation<TInput, TResult> {
  readonly id: string;
  readonly name: string;
  readonly idempotencyKey: string;
  readonly #config: OperationConfig<TInput, TResult>;
  readonly #input: { value: TInput } | undefined;
  /** Identifies this handle as a lease owner. */
  readonly #instance = generateId();
  readonly #headers: Readonly<Record<string, string>>;
  readonly #listeners = new Set<(state: OperationState<TResult>) => void>();
  /** Set if other operations may share the key: when the app says the backend forgets it, if it knows. */
  readonly #key: { expiresAt?: number } | undefined;
  #state: OperationState<TResult>;
  /** Fingerprint of the input as first sent under the idempotency key. */
  #sent: string | undefined;
  /** The input as first sent, as stored with `persistInput`. */
  #persisted: { value: unknown } | undefined;
  /** Revision of the stored record as this handle last wrote or read it; `undefined` if none should exist. */
  #revision: string | undefined;
  /** Another tab settled the operation, or reused its ID: don't write its record back. */
  #detached = false;
  #discarded = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  /** The execution or reconciliation in flight. At most one exists at a time. */
  #task: Task | undefined;
  /** Storage writes are chained so they land in the order the states were produced. */
  #writes: Promise<unknown> = Promise.resolve();

  constructor(
    config: OperationConfig<TInput, TResult>,
    state: OperationState<TResult>,
    input: { value: TInput } | undefined,
    revision: string | undefined,
    key?: { expiresAt?: number },
  ) {
    this.id = state.id;
    this.name = state.name;
    this.idempotencyKey = state.idempotencyKey;
    this.#config = config;
    this.#state = Object.freeze(state);
    this.#input = input;
    this.#key = key;
    // A restored input is the one that was sent.
    if (input && state.attempts > 0) {
      this.#sent = fingerprint(input.value);
      this.#persisted = input;
    }
    this.#revision = revision;
    this.#headers = Object.freeze({ [config.headerName]: state.idempotencyKey });
    this.#rememberKey();
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

  /**
   * Whether `input` is not what this operation sent, or is about to send. A
   * restored operation without a persisted input has nothing to compare.
   */
  differsFrom(input: TInput): boolean {
    const own = this.#sent ?? (this.#input && fingerprint(this.#input.value));
    return own !== undefined && fingerprint(input) !== own;
  }

  run(): Promise<TResult> {
    return this.#schedule("run");
  }

  retry(): Promise<TResult> {
    return this.#schedule("retry");
  }

  reconcile(options: ReconcileOptions = {}): Promise<ReconcileResult<TResult>> {
    const unavailable = this.#unavailable();
    if (unavailable) return Promise.reject(unavailable);
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

  async discard(): Promise<void> {
    if (this.#task) throw new OperationInProgressError(this.id);
    if (this.#discarded) return;
    this.#discarded = true;
    const { storage, registry } = this.#config.guard;
    try {
      // A handle that never wrote a record (or saw it deleted) owns none to delete.
      if (this.#revision !== undefined) {
        await this.#locked(() =>
          this.#enqueue(async () => {
            // Another tab or instance may have moved on with the operation, or reused its ID: that record isn't this handle's.
            if ((await storage.get(this.id))?.revision !== this.#revision) return;
            await storage.delete(this.id);
            registry.deleted(this.id);
            this.#revision = undefined;
          }),
        );
      }
    } catch (cause) {
      // Another tab has held the operation for longer than lockTimeout: its record is that tab's.
      if (!(cause instanceof OperationInProgressError)) {
        throw new StorageError(`Failed to delete operation ${this.id}`, this.id, cause);
      }
    } finally {
      registry.release(this);
    }
  }

  /** Why the operation can't be worked on right now, if anything. */
  #unavailable(): Error | undefined {
    if (this.#discarded) return new OrynthError(`Operation ${this.id} was discarded`);
    let scope: string | undefined;
    try {
      scope = this.#config.guard.scope();
    } catch (error) {
      return error instanceof Error ? error : new OrynthError("The scope callback failed", { cause: error });
    }
    if (this.#state.scope !== scope) {
      return new OrynthError(`Operation ${this.id} belongs to another scope, such as another user`);
    }
    return undefined;
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
    const unavailable = this.#unavailable();
    if (unavailable) return Promise.reject(unavailable);
    const { status, result, error } = this.#state;
    if (status === "succeeded") return Promise.resolve(result as TResult);
    if (action === "run" && status === "failed") return Promise.reject(error);
    if (action === "run" && status === "uncertain") {
      return Promise.reject(new OperationUncertainError(this.id, error));
    }
    const input = this.#input;
    if (!input) {
      return Promise.reject(
        new OrynthError(
          `Cannot retry operation ${this.id}: its input was not persisted, so it was not restored`,
        ),
      );
    }
    // Claim the ID synchronously, so no other handle can start or be restored for it meanwhile.
    if (!this.#config.guard.registry.claim(this)) {
      return Promise.reject(new OrynthError(`Another operation with ID ${this.id} is already active`));
    }
    return this.#track("execute", () => this.#execute(input.value));
  }

  #track<T>(kind: Task["kind"], fn: () => Promise<T>): Promise<T> {
    // `fn` starts on the next microtask, after `#task` is set.
    const promise = Promise.resolve()
      .then(() => this.#locked(fn))
      .finally(() => {
        if (this.#task?.promise === promise) this.#task = undefined;
        // E.g. it failed before sending: nothing to recover, so the ID is free again.
        this.#releaseIfIdle();
      });
    this.#task = { kind, promise };
    return promise;
  }

  /** Gives up the ID when nothing is running and no record of this handle is stored. */
  #releaseIfIdle(): void {
    const { status } = this.#state;
    if (!this.#task && this.#revision === undefined && (status === "created" || isResolved(status))) {
      this.#config.guard.registry.release(this);
    }
  }

  /** Runs `fn` under the operation's Web Lock, held until this handle's writes have landed. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(this.#config.guard, this.id, fn, () => this.#writes);
  }

  async #execute(input: TInput): Promise<TResult> {
    const blocked = this.#resubmissionBlocker(input);
    if (blocked) throw blocked;
    await this.#checkStorage();
    // The stored operation is this handle's again, even if another tab had settled it before.
    this.#detached = false;
    try {
      return await this.#send(input);
    } finally {
      this.#stopHeartbeat();
    }
  }

  /** Sends the operation, retrying as the policy allows. */
  async #send(input: TInput): Promise<TResult> {
    const { execute, retry, persistInput } = this.#config;
    const previous = this.#state;
    const first = previous.attempts === 0;
    // Once a request may have reached the backend, only a success or reconcile() settles the
    // operation: a later request's rejection says nothing about the earlier one.
    let unknown = previous.status === "uncertain";
    for (let attempt = 1; ; attempt++) {
      const next: Patch<TResult> = {
        status: "pending",
        attempts: this.#state.attempts + 1,
        expiresAt: first && attempt === 1 ? this.#keyExpiry() : this.#state.expiresAt,
      };
      if (attempt === 1) {
        if (first) this.#capture(input);
        // Persist before the request leaves, so a crash mid-request can be recovered.
        await this.#commitDurably(next);
        try {
          // The input may have been edited while it was being stored: store it again, so the stored copy is the one sent.
          let captures = 1;
          while (first && this.#sent !== undefined && fingerprint(input) !== this.#sent) {
            if (captures++ === MAX_CAPTURES) {
              throw new OrynthError(`The input of operation ${this.id} kept changing while it was being stored`);
            }
            this.#capture(input);
            if (persistInput) await this.#commitDurably({});
          }
          // Writing takes time: the key may have expired, or the user changed, meanwhile.
          const blocked = first ? this.#unavailable() : this.#resubmissionBlocker(input);
          if (blocked) throw blocked;
        } catch (error) {
          this.#rollback(previous);
          throw error;
        }
        this.#rememberKey();
        this.#startHeartbeat();
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
        unknown ||= uncertain;
        if (again) {
          this.#commit({ error });
          await sleep(backoffDelay(retry, attempt));
          // The key may have expired, the input changed, or the user signed out while waiting.
          if (!this.#resubmissionBlocker(input)) continue;
        }
        this.#commit({ status: unknown ? "uncertain" : "failed", error });
        throw unknown ? new OperationUncertainError(this.id, error) : error;
      }
    }
  }

  /** Takes the input as first sent: its fingerprint, and the copy to store, at the same moment. */
  #capture(input: TInput): void {
    this.#sent = fingerprint(input);
    if (!this.#config.persistInput) return;
    try {
      this.#persisted = { value: storableCopy(input) };
    } catch (cause) {
      this.#persisted = undefined;
      this.#storageFailed(new StorageError(`The input of operation ${this.id} can't be stored`, this.id, cause));
    }
  }

  /** Why the operation must not be sent (again) right now, if anything. */
  #resubmissionBlocker(input: TInput): Error | undefined {
    const unavailable = this.#unavailable();
    if (unavailable) return unavailable;
    const { attempts, expiresAt } = this.#state;
    if (attempts === 0) return undefined;
    if (expiresAt !== undefined && Date.now() >= expiresAt) return new IdempotencyKeyExpiredError(this.id, expiresAt);
    const current = fingerprint(input);
    if (current === undefined || this.#sent === undefined) {
      return new OrynthError(
        `Can't tell whether the input of operation ${this.id} changed after it was sent, so it is not sent again; create a new operation instead`,
      );
    }
    if (current !== this.#sent) {
      return new OrynthError(
        `The input of operation ${this.id} changed after it was sent; create a new operation for the new input`,
      );
    }
    return undefined;
  }

  /**
   * Checks that the stored record is the one this handle last saw, and that no
   * other tab is sending it. Another tab or instance may have resolved,
   * resubmitted or created the operation.
   */
  async #checkStorage(): Promise<void> {
    const { storage, locks } = this.#config.guard;
    let stored: OperationRecord | undefined;
    try {
      // Let this handle's own writes land first, so the record read is current.
      await this.#writes;
      stored = await storage.get(this.id);
    } catch (cause) {
      this.#storageFailed(new StorageError(`Failed to read operation ${this.id}`, this.id, cause));
      return;
    }
    // A tab holding the Web Lock can ignore the leases of tabs that held it before.
    if (isLive(stored?.lease) && stored.lease.owner !== this.#instance && !(locks && stored.lease.locks)) {
      throw new OperationConflictError(this.id, `Operation ${this.id} is being sent by another tab; try again later`);
    }
    if (stored?.revision === this.#revision) return;
    throw new OperationConflictError(
      this.id,
      this.#state.status === "created"
        ? `An operation with ID ${this.id} is already stored; restore it instead of creating it again`
        : `Operation ${this.id} was changed by another tab or instance; reconcile it before retrying`,
    );
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
    if (!reconcile) throw new OrynthError(`Operation "${this.name}" has no reconcile function`);
    const { attempts = 1, ...backoff } = options;
    assertAttempts(attempts);
    assertBackoff(backoff);
    await this.#detectResolvedElsewhere();

    this.#commit({ status: "recovering" });
    for (let attempt = 1; ; attempt++) {
      // Checked before every lookup: the user may have signed out while this one waited.
      const unavailable = this.#unavailable();
      if (unavailable) {
        this.#commit({ status: "uncertain" });
        throw unavailable;
      }
      const outcome = await this.#lookup(reconcile);
      if (outcome.status === "succeeded") {
        this.#commit({ status: "succeeded", result: outcome.result, error: undefined });
        return outcome;
      }
      if (outcome.status === "failed") {
        const error = outcome.error ?? new OrynthError(`The backend reported that operation ${this.id} failed`);
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

  /**
   * A record that disappeared since this handle last saw it was resolved or
   * discarded by another tab. One with another key belongs to a new operation
   * that reused the ID.
   */
  async #detectResolvedElsewhere(): Promise<void> {
    if (this.#revision === undefined) return;
    try {
      await this.#writes;
      const stored = await this.#config.guard.storage.get(this.id);
      if (stored?.idempotencyKey !== this.idempotencyKey) this.#detached = true;
    } catch {
      // Can't tell; reconcile as usual.
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
      const error = new OrynthError(
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
    this.#save(this.#next(patch));
  }

  /** Persists a change before applying it. If that fails, nothing is sent unless `requireStorage` is off. */
  async #commitDurably(patch: Patch<TResult>): Promise<void> {
    const next = this.#next(patch);
    try {
      await this.#write(next);
    } catch (cause) {
      this.#storageFailed(new StorageError(`Failed to persist operation ${this.id}`, this.id, cause));
    }
    this.#apply(next);
  }

  /** Restores the state a request started from, when it was not sent after all. */
  #rollback({ status, attempts, expiresAt, error }: OperationState<TResult>): void {
    this.#save(Object.freeze({ ...this.#state, status, attempts, expiresAt, error, updatedAt: Date.now() }));
  }

  #save(next: OperationState<TResult>): void {
    this.#write(next).catch((cause: unknown) => {
      this.#report(new StorageError(`Failed to persist operation ${this.id}`, this.id, cause));
    });
    this.#apply(next);
  }

  /** Handles a storage failure before sending: stop (the default), or report it and carry on. */
  #storageFailed(error: StorageError): void {
    if (this.#config.requireStorage) {
      throw new StorageError(`${error.message}; it was not executed`, this.id, error.cause);
    }
    this.#report(error);
  }

  #report(error: StorageError): void {
    this.#config.guard.onStorageError(error);
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

  /**
   * When the backend will forget the idempotency key, if a first request is
   * sent now: after `ttl`, or earlier if another operation sent the key before.
   */
  #keyExpiry(): number | undefined {
    const now = Date.now();
    let expiresAt = now + this.#config.ttl;
    if (this.#key) {
      for (const known of [this.#key.expiresAt, this.#config.guard.keys.get(this.idempotencyKey)]) {
        // A key the backend still remembers keeps its lifetime; a forgotten one starts afresh.
        if (known !== undefined && known > now) expiresAt = Math.min(expiresAt, known);
      }
    }
    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  }

  /** Tells later operations that reuse the key when the backend forgets it. */
  #rememberKey(): void {
    const { expiresAt } = this.#state;
    const { keys } = this.#config.guard;
    if (!this.#key || expiresAt === undefined) return;
    const known = keys.get(this.idempotencyKey);
    if (known === undefined || known <= Date.now() || expiresAt < known) keys.set(this.idempotencyKey, expiresAt);
  }

  /** Keeps this handle's lease on the record fresh while a request is in flight. */
  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      if (this.#state.status !== "pending") return;
      this.#write(this.#state).catch((cause: unknown) => {
        this.#report(new StorageError(`Failed to renew the lease of operation ${this.id}`, this.id, cause));
      });
    }, HEARTBEAT_MS);
    (this.#heartbeat as { unref?: () => void }).unref?.();
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  /**
   * The lease to store: this handle's while it is sending. Tabs without Web
   * Locks (or whose lock requests fail) respect it, in either mode.
   */
  #lease(state: OperationState<TResult>): Lease | undefined {
    if (state.status !== "pending" || this.#task?.kind !== "execute") return undefined;
    const lease: Lease = { owner: this.#instance, until: Date.now() + LEASE_MS };
    // Tabs that hold the Web Lock next know it's stale, e.g. after this tab crashed.
    if (this.#config.guard.locks) lease.locks = true;
    return lease;
  }

  #enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.#writes.then(write);
    this.#writes = next.catch(noop);
    return next;
  }

  #write(state: OperationState<TResult>): Promise<void> {
    const { storage, registry } = this.#config.guard;
    if (isResolved(state.status) || state.status === "created") {
      // Resolved operations need no recovery, and unsent ones have nothing to recover: their records are removed.
      return this.#enqueue(async () => {
        // A detached handle's record is gone, or belongs to an operation that reused the ID.
        if (!this.#detached) {
          await storage.delete(this.id);
          if (this.#revision !== undefined) registry.deleted(this.id);
        }
        this.#revision = undefined;
        this.#releaseIfIdle();
      });
    }
    // Another tab settled this operation; writing it back would resurrect it.
    if (this.#detached) return Promise.resolve();
    // Built now, so the record reflects this exact state.
    const record = toRecord(state, this.#config.persistInput ? this.#persisted : undefined, this.#lease(state));
    return this.#enqueue(async () => {
      if (!record.lease) {
        // Don't clear the lease of a tab that is still sending this operation.
        const stored = await storage.get(this.id);
        if (isLive(stored?.lease) && stored.lease.owner !== this.#instance) record.lease = stored.lease;
      }
      await storage.set(record);
      this.#revision = record.revision;
    });
  }
}
