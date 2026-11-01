import { isUncertainError } from "./classify.js";
import { OrynthError, OperationConflictError, OperationInProgressError, StorageError } from "./errors.js";
import { generateId } from "./id.js";
import { OperationHandle, reportError, withLock, type GuardContext, type OperationConfig } from "./operation.js";
import { isLive, restoreOperations, restoredState, type Hydrate } from "./recovery.js";
import { Registry } from "./registry.js";
import { resolveRetryPolicy } from "./retry.js";
import { memoryStorage } from "./storage/memory.js";
import type {
  CreateOptions,
  DefineOptions,
  GetOrCreateOptions,
  LockManagerLike,
  Orynth,
  OrynthOptions,
  Operation,
  OperationDefinition,
  OperationState,
} from "./types.js";
import {
  assertFunction,
  assertHeaderName,
  assertStrategy,
  assertString,
  assertTimestamp,
  assertTtl,
} from "./validate.js";

const DEFAULT_HEADER = "Idempotency-Key";
const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT = 10_000;

function webLocks(): LockManagerLike | undefined {
  return (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
}

export function createOrynth(options: OrynthOptions = {}): Orynth {
  const {
    storage: storageOption = "memory",
    idempotencyHeader = DEFAULT_HEADER,
    retry: defaultRetry = false,
    ttl = DEFAULT_TTL,
    scope: scopeOption,
    requireStorage: defaultRequireStorage = true,
    lockTimeout = DEFAULT_LOCK_TIMEOUT,
    onStorageError = (error: StorageError) => console.error(error),
  } = options;
  assertHeaderName(idempotencyHeader);
  resolveRetryPolicy(defaultRetry);
  assertTtl(ttl);
  assertTtl(lockTimeout, "lockTimeout");
  assertFunction("onStorageError", onStorageError);
  if (scopeOption !== undefined && typeof scopeOption !== "string") assertFunction("scope", scopeOption);
  const storage = storageOption === "memory" ? memoryStorage() : storageOption;
  for (const method of ["set", "get", "delete", "list"] as const) {
    assertFunction(`storage.${method}`, storage?.[method]);
  }
  const locks = options.locks === false ? undefined : (options.locks ?? webLocks());
  if (locks) assertFunction("locks.request", locks.request);

  const registry = new Registry();
  const definitions = new Map<string, Hydrate>();
  const context: GuardContext = {
    storage,
    registry,
    locks,
    lockTimeout,
    scope: () => {
      const scope: unknown = typeof scopeOption === "function" ? (scopeOption() ?? undefined) : scopeOption;
      // Anything else, such as a numeric user ID, would make stored records unreadable on the next restore().
      if (scope !== undefined && typeof scope !== "string") {
        throw new TypeError(`scope must return a string or undefined, got ${typeof scope}`);
      }
      return scope;
    },
    // A callback that throws must not interrupt the write or restore() that reported the error.
    onStorageError: (error) => {
      try {
        onStorageError(error);
      } catch (callbackError) {
        reportError(callbackError);
      }
    },
    keys: new Map(),
  };

  function define<TInput, TResult>(options: DefineOptions<TInput, TResult>): OperationDefinition<TInput, TResult> {
    const {
      name,
      execute,
      reconcile,
      concurrency = "join",
      retry = defaultRetry,
      isUncertain = isUncertainError,
      persistInput = false,
      idempotencyHeader: headerName = idempotencyHeader,
      ttl: operationTtl = ttl,
      requireStorage = defaultRequireStorage,
    } = options;
    assertString("name", name);
    if (definitions.has(name)) throw new TypeError(`An operation named "${name}" is already defined`);
    assertFunction("execute", execute);
    assertFunction("reconcile", reconcile, true);
    assertFunction("isUncertain", isUncertain);
    assertStrategy(concurrency);
    assertHeaderName(headerName);
    assertTtl(operationTtl);

    const config: OperationConfig<TInput, TResult> = {
      execute,
      reconcile,
      concurrency,
      retry: resolveRetryPolicy(retry),
      isUncertain,
      persistInput: persistInput === true,
      requireStorage: requireStorage !== false,
      headerName,
      ttl: operationTtl,
      guard: context,
    };

    definitions.set(name, (record) => {
      // Only trust a stored input if this definition persists inputs. Adapters may return `input: null` for none.
      const input =
        config.persistInput && "input" in record && record.input !== null ? { value: record.input as TInput } : undefined;
      // A later operation may reuse the restored key.
      return new OperationHandle(config, restoredState(record) as OperationState<TResult>, input, record.revision, {});
    });

    function create(input?: TInput, { id = generateId(), idempotencyKey, expiresAt }: CreateOptions = {}) {
      assertString("id", id);
      if (idempotencyKey !== undefined) assertString("idempotencyKey", idempotencyKey);
      if (expiresAt !== undefined) assertTimestamp("expiresAt", expiresAt);
      if (registry.get(id)) throw new OrynthError(`An operation with ID ${id} is already active`);
      const now = Date.now();
      const state: OperationState<TResult> = {
        id,
        name,
        idempotencyKey: idempotencyKey ?? generateId(),
        status: "created",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        scope: context.scope(),
      };
      // A key the app chose may have been sent before, by another operation.
      const key = idempotencyKey === undefined ? undefined : { expiresAt };
      return new OperationHandle(config, state, { value: input as TInput }, undefined, key);
    }

    function get(id: string) {
      const operation = registry.get(id);
      return operation?.name === name && operation.state.scope === context.scope()
        ? (operation as OperationHandle<TInput, TResult>)
        : undefined;
    }

    function getOrCreate(id: string, input?: TInput, { idempotencyKey, expiresAt }: GetOrCreateOptions = {}) {
      assertString("id", id);
      if (idempotencyKey !== undefined) assertString("idempotencyKey", idempotencyKey);
      if (expiresAt !== undefined) assertTimestamp("expiresAt", expiresAt);
      const tracked = get(id);
      if (!tracked) return create(input, { id, idempotencyKey: idempotencyKey ?? id, expiresAt });
      // Joining would hand the caller an operation for something other than what it asked for.
      if (idempotencyKey !== undefined && idempotencyKey !== tracked.idempotencyKey) {
        throw new OperationConflictError(id, `Operation ${id} is tracked with another idempotency key`);
      }
      if (tracked.differsFrom(input as TInput)) {
        throw new OperationConflictError(
          id,
          `Operation ${id} is tracked with different input; use a new ID for the new input`,
        );
      }
      return tracked;
    }

    return {
      name,
      create,
      get,
      getOrCreate,
      restore: () => restore(name) as Promise<Operation<TInput, TResult>[]>,
    };
  }

  function restore(name?: string): Promise<Operation[]> {
    let scope: string | undefined;
    try {
      scope = context.scope();
    } catch (error) {
      return Promise.reject(error);
    }
    return restoreOperations({ storage, registry, definitions, onStorageError: context.onStorageError, scope, name });
  }

  async function clear(): Promise<void> {
    const running = new Set<string>();
    for (const operation of registry.values()) {
      try {
        await operation.discard();
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) throw error;
        running.add(operation.id);
      }
    }
    let records: unknown[];
    try {
      records = await storage.list();
    } catch (cause) {
      throw new StorageError("Failed to clear stored operations", undefined, cause);
    }
    for (const record of records) {
      const { id, revision } = (record ?? {}) as { id?: unknown; revision?: unknown };
      if (typeof id !== "string" || running.has(id) || registry.get(id)) continue;
      try {
        // Leave operations that another tab is sending, or has changed since they were listed.
        await withLock(context, id, async () => {
          const current = await storage.get(id);
          if (current?.revision !== revision) return;
          if (isLive(current?.lease) && !(context.locks && current.lease.locks)) return;
          await storage.delete(id);
          registry.deleted(id);
        });
      } catch (cause) {
        // Another tab has held the operation for longer than lockTimeout.
        if (cause instanceof OperationInProgressError) continue;
        throw new StorageError(`Failed to clear operation ${id}`, id, cause);
      }
    }
  }

  return { define, restore: () => restore(), clear };
}
