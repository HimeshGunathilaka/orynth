import type { OperationRecord, OperationStorage } from "../types.js";

/** An `IDBFactory`, typed without the DOM library so Node projects can import this module. */
export interface IDBFactoryLike {
  open(name: string, version?: number): unknown;
}

export interface IndexedDBStorageOptions {
  /** Database name. Use different names to keep separate instances apart. Default `"orynth"`. */
  databaseName?: string;
  /** The `IDBFactory` to use, e.g. from `fake-indexeddb`. Default `globalThis.indexedDB`. */
  indexedDB?: IDBFactoryLike;
}

const STORE = "operations";
const VERSION = 1;

/**
 * Persists operation records in IndexedDB so unresolved operations survive
 * page reloads and browser restarts. The database is opened on first use;
 * if opening fails, the next call tries again.
 *
 * Inputs are stored only for definitions with `persistInput: true`, and must
 * be structured-cloneable.
 */
export function indexedDBStorage(options: IndexedDBStorageOptions = {}): OperationStorage {
  const { databaseName = "orynth" } = options;
  let connection: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = (options.indexedDB ?? globalThis.indexedDB) as IDBFactory | undefined;
      if (!factory) throw new Error("IndexedDB is not available in this environment");
      const request = factory.open(databaseName, VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        const forget = () => {
          if (connection === opening) connection = undefined;
        };
        // Let other tabs upgrade or delete the database; reopen on next use.
        db.onversionchange = () => {
          db.close();
          forget();
        };
        // Closed by the browser, e.g. when site data is cleared.
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
    connection = opening;
    opening.catch(() => {
      if (connection === opening) connection = undefined;
    });
    return opening;
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
    retried = false,
  ): Promise<T> {
    const opening = open();
    const db = await opening;
    let transaction: IDBTransaction;
    try {
      // Strict durability: resolve only after the write is flushed, since
      // a request may be sent as soon as the record is saved.
      transaction = db.transaction(STORE, mode, mode === "readwrite" ? { durability: "strict" } : {});
    } catch (error) {
      // Some browsers (WebKit) close connections without a `close` event. Reopen once.
      if (connection === opening) connection = undefined;
      if (!retried && (error as { name?: unknown }).name === "InvalidStateError") {
        return transact(mode, action, true);
      }
      throw error;
    }
    return new Promise<T>((resolve, reject) => {
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    });
  }

  return {
    async set(record) {
      await transact("readwrite", (store) => store.put(record));
    },
    get(id) {
      return transact("readonly", (store) => store.get(id) as IDBRequest<OperationRecord | undefined>);
    },
    async delete(id) {
      await transact("readwrite", (store) => store.delete(id));
    },
    list() {
      return transact("readonly", (store) => store.getAll() as IDBRequest<OperationRecord[]>);
    },
  };
}
