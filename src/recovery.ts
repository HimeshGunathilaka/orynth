import { StorageError } from "./errors.js";
import { generateId } from "./id.js";
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

export type Lease = NonNullable<OperationRecord["lease"]>;

const UNRESOLVED: ReadonlySet<OperationStatus> = new Set(["pending", "uncertain", "recovering"]);

/** Never throws: an error can be anything, e.g. an object with a throwing getter or no prototype. */
export function serializeError(error: unknown): SerializedError {
  try {
    if (typeof error === "object" && error !== null && "message" in error) {
      const { name, message } = error as { name?: unknown; message: unknown };
      return { name: typeof name === "string" ? name : "Error", message: String(message) };
    }
    return { name: "Error", message: String(error) };
  } catch {
    return { name: "Error", message: "An error that can't be described" };
  }
}

export function isLive(lease: Lease | undefined): lease is Lease {
  return typeof lease?.until === "number" && lease.until > Date.now();
}

/** Builds the record to store for a state. Every record gets a new revision. */
export function toRecord(
  state: OperationState,
  input: { value: unknown } | undefined,
  lease: Lease | undefined,
): OperationRecord {
  const { id, name, idempotencyKey, status, attempts, createdAt, updatedAt, expiresAt, scope, error } = state;
  const record: OperationRecord = {
    id,
    name,
    idempotencyKey,
    status,
    attempts,
    createdAt,
    updatedAt,
    revision: generateId(),
  };
  if (expiresAt !== undefined) record.expiresAt = expiresAt;
  if (scope !== undefined) record.scope = scope;
  if (lease) record.lease = lease;
  if (input) record.input = input.value;
  if (error !== undefined) record.error = serializeError(error);
  return record;
}

const optional = (value: unknown, type: string) => value === undefined || value === null || typeof value === type;

function isRecord(value: unknown): value is OperationRecord {
  const record = value as Partial<OperationRecord> | null;
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.idempotencyKey === "string" &&
    typeof record.status === "string" &&
    // Every stored operation was sent at least once. Anything else would skip the checks before resending.
    typeof record.attempts === "number" &&
    Number.isInteger(record.attempts) &&
    record.attempts >= 1 &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    typeof record.revision === "string" &&
    optional(record.scope, "string") &&
    // Anything but a time would mean "never expires".
    optional(record.expiresAt, "number") &&
    !Number.isNaN(record.expiresAt)
  );
}

/** Adapters may store absent values as `null`. */
const present = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

/**
 * A stored record describes what the operation was doing when it was written.
 * Whatever was in flight then (a request, a reconciliation) has an unknown
 * outcome now, so every restored operation starts as `uncertain`.
 */
export function restoredState(record: OperationRecord): OperationState {
  const { id, name, idempotencyKey, attempts, createdAt, updatedAt, error } = record;
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  return {
    id,
    name,
    idempotencyKey,
    status: "uncertain",
    attempts,
    createdAt,
    updatedAt,
    expiresAt,
    scope: present(record.scope),
    error,
  };
}

export function restoreOperations({
  storage,
  registry,
  definitions,
  onStorageError,
  scope,
  name,
}: {
  storage: OperationStorage;
  registry: Registry;
  definitions: ReadonlyMap<string, Hydrate>;
  /** Must not throw, so one malformed record can't stop the others from being restored. */
  onStorageError: (error: StorageError) => void;
  /** Only restore operations of this scope. */
  scope: string | undefined;
  /** Only restore operations of this definition. */
  name?: string;
}): Promise<Operation[]> {
  return registry.whileRestoring(async (deleted) => {
    /** The operation to return for a stored record, if it needs recovery. */
    function recover(record: unknown): Operation | undefined {
      if (!isRecord(record)) {
        // Never log the record itself: it may hold a persisted input.
        const id = (record as { id?: unknown } | null)?.id;
        onStorageError(new StorageError("Ignored a malformed operation record", typeof id === "string" ? id : undefined));
        return undefined;
      }
      if (!UNRESOLVED.has(record.status) || present(record.scope) !== scope) return undefined;
      if (name !== undefined && record.name !== name) return undefined;
      // An operation this instance owns is newer than its stored record. Only
      // uncertain ones need recovery; the others are running or settled.
      const owner = registry.get(record.id);
      if (owner) return owner.status === "uncertain" ? owner : undefined;
      // Resolved and deleted while storage was being read: the record is a stale snapshot.
      if (deleted.has(record.id)) return undefined;
      // Leave records of definitions that are not defined (yet) untouched.
      const operation = definitions.get(record.name)?.(record);
      if (operation) registry.claim(operation);
      return operation;
    }

    let records: unknown[];
    try {
      records = await storage.list();
    } catch (cause) {
      throw new StorageError("Failed to load operations from storage", undefined, cause);
    }

    const operations: Operation[] = [];
    for (const record of records) {
      const operation = recover(record);
      if (operation) operations.push(operation);
    }
    return operations;
  });
}
