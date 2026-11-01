import { StorageError } from "./errors.js";
import type { Registry } from "./registry.js";
import type {
  Operation,
  OperationRecord,
  OperationState,
  OperationStatus,
  OperationStorage,
  SerializedError,
} from "./types.js";

/** Rebuilds an operation of a known definition from its stored record. */
export type Hydrate = (record: OperationRecord) => Operation;

const UNRESOLVED: ReadonlySet<OperationStatus> = new Set(["pending", "uncertain", "recovering"]);

export function serializeError(error: unknown): SerializedError {
  if (typeof error === "object" && error !== null && "message" in error) {
    const { name, message } = error as { name?: unknown; message: unknown };
    return { name: typeof name === "string" ? name : "Error", message: String(message) };
  }
  return { name: "Error", message: String(error) };
}

export function toRecord(
  state: OperationState,
  expiresAt: number | undefined,
  input: { value: unknown } | undefined,
): OperationRecord {
  const { id, name, idempotencyKey, status, attempts, createdAt, updatedAt, error } = state;
  const record: OperationRecord = { id, name, idempotencyKey, status, attempts, createdAt, updatedAt };
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  if (input) record.input = input.value;
  if (error !== undefined) record.error = serializeError(error);
  return record;
}

function isRecord(value: unknown): value is OperationRecord {
  const record = value as Partial<OperationRecord> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.status === "string" &&
    typeof record.attempts === "number" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

/**
 * A stored record describes what the operation was doing when it was written.
 * Whatever was in flight then (a request, a reconciliation) has an unknown
 * outcome now, so every restored operation starts as `uncertain`.
 */
export function restoredState(record: OperationRecord): OperationState {
  const { id, name, idempotencyKey, attempts, createdAt, updatedAt, error } = record;
  return { id, name, idempotencyKey, status: "uncertain", attempts, createdAt, updatedAt, error };
}

export function restoreOperations({
  storage,
  registry,
  definitions,
  onStorageError,
  name,
}: {
  storage: OperationStorage;
  registry: Registry;
  definitions: ReadonlyMap<string, Hydrate>;
  onStorageError: (error: StorageError) => void;
  /** Only restore operations of this definition. */
  name?: string;
}): Promise<Operation[]> {
  return registry.whileRestoring(async (released) => {
    let records: unknown[];
    try {
      records = await storage.list();
    } catch (cause) {
      throw new StorageError("Failed to load operations from storage", undefined, cause);
    }

    const now = Date.now();
    const operations: Operation[] = [];
    for (const record of records) {
      if (!isRecord(record)) {
        onStorageError(new StorageError("Ignored a malformed operation record", undefined, record));
        continue;
      }
      if (!UNRESOLVED.has(record.status)) continue;
      if (name !== undefined && record.name !== name) continue;

      // An operation this guard owns is newer than its stored record.
      const owner = registry.get(record.id);
      if (owner) {
        if (UNRESOLVED.has(owner.status)) operations.push(owner);
        continue;
      }
      // Resolved and deleted while storage was being read: the record is a stale snapshot.
      if (released.has(record.id)) continue;

      if (typeof record.expiresAt === "number" && record.expiresAt <= now) {
        try {
          await storage.delete(record.id);
        } catch (cause) {
          onStorageError(new StorageError(`Failed to delete expired operation ${record.id}`, record.id, cause));
        }
        continue;
      }

      // Leave records of definitions that are not defined (yet) untouched.
      const hydrate = definitions.get(record.name);
      if (!hydrate) continue;

      const operation = hydrate(record);
      registry.claim(operation);
      operations.push(operation);
    }
    return operations;
  });
}
