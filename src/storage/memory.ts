import type { OperationRecord, OperationStorage } from "../types.js";

/**
 * Keeps operation records in memory. This is the default storage. Records do
 * not survive a page reload or process restart; share one storage between
 * two Orynth instances to simulate a restart in tests.
 */
export function memoryStorage(): OperationStorage {
  const records = new Map<string, OperationRecord>();
  return {
    async set(record) {
      records.set(record.id, { ...record });
    },
    async get(id) {
      const record = records.get(id);
      return record && { ...record };
    },
    async delete(id) {
      records.delete(id);
    },
    async list() {
      return Array.from(records.values(), (record) => ({ ...record }));
    },
  };
}
