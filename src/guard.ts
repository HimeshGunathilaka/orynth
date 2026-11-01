import { isUncertainError } from "./classify.js";
import { MutationGuardError, type StorageError } from "./errors.js";
import { generateId } from "./id.js";
import { OperationHandle, type OperationConfig } from "./operation.js";
import { restoreOperations, restoredState, type Hydrate } from "./recovery.js";
import { Registry } from "./registry.js";
import { resolveRetryPolicy } from "./retry.js";
import { memoryStorage } from "./storage/memory.js";
import type {
  CreateOptions,
  DefineOptions,
  MutationGuard,
  MutationGuardOptions,
  Operation,
  OperationDefinition,
  OperationState,
} from "./types.js";
import { assertFunction, assertHeaderName, assertStrategy, assertString, assertTtl } from "./validate.js";

const DEFAULT_HEADER = "Idempotency-Key";
const DEFAULT_TTL = 24 * 60 * 60 * 1000;

export function createMutationGuard(options: MutationGuardOptions = {}): MutationGuard {
  const {
    storage: storageOption = "memory",
    idempotencyHeader = DEFAULT_HEADER,
    ttl = DEFAULT_TTL,
    onStorageError = (error: StorageError) => console.error(error),
  } = options;
  assertHeaderName(idempotencyHeader);
  assertTtl(ttl);
  assertFunction("onStorageError", onStorageError);
  const storage = storageOption === "memory" ? memoryStorage() : storageOption;
  for (const method of ["set", "delete", "list"] as const) {
    assertFunction(`storage.${method}`, storage?.[method]);
  }

  const registry = new Registry();
  const definitions = new Map<string, Hydrate>();

  function define<TInput, TResult>(options: DefineOptions<TInput, TResult>): OperationDefinition<TInput, TResult> {
    const {
      name,
      execute,
      reconcile,
      concurrency = "join",
      retry,
      isUncertain = isUncertainError,
      persistInput = false,
      idempotencyHeader: headerName = idempotencyHeader,
      ttl: operationTtl = ttl,
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
      headerName,
      ttl: operationTtl,
      storage,
      registry,
      onStorageError,
    };

    definitions.set(name, (record) => {
      // Only trust a stored input if this definition persists inputs; adapters may return `input: null`.
      const input = config.persistInput && "input" in record ? { value: record.input as TInput } : undefined;
      const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
      return new OperationHandle(config, restoredState(record) as OperationState<TResult>, input, expiresAt);
    });

    return {
      name,
      create(input?: TInput, { id = generateId(), idempotencyKey = generateId() }: CreateOptions = {}) {
        assertString("id", id);
        assertString("idempotencyKey", idempotencyKey);
        if (registry.get(id)) throw new MutationGuardError(`An operation with ID ${id} is already active`);
        const now = Date.now();
        const state = { id, name, idempotencyKey, status: "created", attempts: 0, createdAt: now, updatedAt: now } as const;
        return new OperationHandle(config, state, { value: input as TInput }, undefined);
      },
      restore: () => restore(name) as Promise<Operation<TInput, TResult>[]>,
    };
  }

  function restore(name?: string): Promise<Operation[]> {
    return restoreOperations({ storage, registry, definitions, onStorageError, name });
  }

  return { define, restore: () => restore() };
}
