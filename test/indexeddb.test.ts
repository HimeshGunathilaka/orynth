import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMutationGuard, StorageError, type OperationRecord } from "../src/index.js";
import { indexedDBStorage } from "../src/storage/index.js";
import { connectionReset, flush } from "./helpers.js";

const record = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "op-1",
  name: "create-order",
  idempotencyKey: "key-1",
  status: "pending",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

/** Wraps a fake IDBFactory to fail the next open or capture opened databases. */
function instrumentedFactory() {
  const factory = new IDBFactory();
  const opened: IDBDatabase[] = [];
  let failNextOpen = false;
  const wrapper = {
    open(name: string, version?: number) {
      if (failNextOpen) {
        failNextOpen = false;
        throw new DOMException("The user denied permission to access the database.", "SecurityError");
      }
      const request = factory.open(name, version);
      request.addEventListener("success", () => opened.push(request.result));
      return request;
    },
    deleteDatabase: (name: string) => factory.deleteDatabase(name),
  } as unknown as IDBFactory;
  return { factory: wrapper, opened, failNextOpen: () => (failNextOpen = true) };
}

describe("indexedDBStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores, updates, lists and deletes records", async () => {
    const storage = indexedDBStorage({ indexedDB: new IDBFactory() });
    await storage.set(record());
    await storage.set(record({ id: "op-2", input: { productId: "123" } }));
    await storage.set(record({ status: "uncertain", error: { name: "TypeError", message: "fetch failed" } }));

    expect(await storage.list()).toEqual([
      record({ status: "uncertain", error: { name: "TypeError", message: "fetch failed" } }),
      record({ id: "op-2", input: { productId: "123" } }),
    ]);
    await storage.delete("op-1");
    await storage.delete("missing");
    expect(await storage.list()).toEqual([record({ id: "op-2", input: { productId: "123" } })]);
  });

  it("keeps records across connections, like a page reload", async () => {
    const indexedDB = new IDBFactory();
    await indexedDBStorage({ indexedDB }).set(record());
    expect(await indexedDBStorage({ indexedDB }).list()).toEqual([record()]);
  });

  it("isolates databases by name", async () => {
    const indexedDB = new IDBFactory();
    await indexedDBStorage({ indexedDB, databaseName: "a" }).set(record());
    expect(await indexedDBStorage({ indexedDB, databaseName: "b" }).list()).toEqual([]);
  });

  it("uses globalThis.indexedDB by default and fails clearly without it", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const storage = indexedDBStorage();
    await storage.set(record());
    expect(await storage.list()).toHaveLength(1);

    vi.stubGlobal("indexedDB", undefined);
    await expect(indexedDBStorage().list()).rejects.toThrow("IndexedDB is not available in this environment");
  });

  it("retries opening the database after a failure", async () => {
    const { factory, failNextOpen } = instrumentedFactory();
    const storage = indexedDBStorage({ indexedDB: factory });
    failNextOpen();
    await expect(storage.set(record())).rejects.toMatchObject({ name: "SecurityError" });
    await storage.set(record());
    expect(await storage.list()).toEqual([record()]);
  });

  it("reopens after the browser closes the connection", async () => {
    const { factory, opened } = instrumentedFactory();
    const storage = indexedDBStorage({ indexedDB: factory });
    await storage.set(record());

    // fake-indexeddb declares the parameter as the class, but it takes an instance.
    forceCloseDatabase(opened[0] as unknown as typeof IDBDatabase);
    await flush();
    expect(await storage.list()).toEqual([record()]);
    expect(opened).toHaveLength(2);
  });

  it("reopens after a connection closed without a close event", async () => {
    const { factory, opened } = instrumentedFactory();
    const storage = indexedDBStorage({ indexedDB: factory });
    await storage.set(record());

    opened[0]!.close(); // no `close` event, like WebKit's silent closes
    await storage.set(record({ id: "op-2" }));
    expect(await storage.list()).toHaveLength(2);
    expect(opened).toHaveLength(2);
  });

  it("closes its connection so another tab can delete the database, then reopens", async () => {
    const indexedDB = new IDBFactory();
    const storage = indexedDBStorage({ indexedDB });
    await storage.set(record());

    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("mutation-guard");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked by an open connection"));
    });
    expect(await storage.list()).toEqual([]);
    await storage.set(record());
    expect(await storage.list()).toEqual([record()]);
  });

  it("rejects inputs that cannot be stored, without sending the request", async () => {
    const execute = vi.fn(async () => "ok");
    const guard = createMutationGuard({ storage: indexedDBStorage({ indexedDB: new IDBFactory() }) });
    const op = guard.define({ name: "op", persistInput: true, execute }).create({ callback: () => {} });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).cause).toMatchObject({ name: "DataCloneError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("restores an operation interrupted by a reload and reconciles it", async () => {
    const indexedDB = new IDBFactory();
    const serverOrders = new Map<string, string>();
    const execute = async ({ idempotencyKey }: { idempotencyKey: string }) => {
      serverOrders.set(idempotencyKey, "order-1");
      return new Promise<string>(() => {}); // the page is closed before the response arrives
    };
    const reconcile = async ({ idempotencyKey }: { idempotencyKey: string }) => {
      const order = serverOrders.get(idempotencyKey);
      return order ? { status: "succeeded" as const, result: order } : { status: "not-found" as const };
    };

    // Before the reload.
    const before = createMutationGuard({ storage: indexedDBStorage({ indexedDB }) });
    const op = before.define({ name: "create-order", execute, reconcile }).create();
    void op.run();
    await vi.waitFor(() => expect(serverOrders.size).toBe(1));

    // After the reload: a new guard, a new connection, the same database.
    const storage = indexedDBStorage({ indexedDB });
    const after = createMutationGuard({ storage });
    const createOrder = after.define({ name: "create-order", execute, reconcile });
    const [restored] = await createOrder.restore();

    expect(restored).toMatchObject({ id: op.id, idempotencyKey: op.idempotencyKey, status: "uncertain" });
    await expect(restored!.reconcile()).resolves.toEqual({ status: "succeeded", result: "order-1" });
    // Resolved records are deleted in the background.
    await vi.waitFor(async () => expect(await storage.list()).toEqual([]));
    expect(serverOrders.size).toBe(1);
  });

  it("restores a persisted input for an explicit retry", async () => {
    const indexedDB = new IDBFactory();
    const sent: { input: unknown; key: string }[] = [];
    const definition = {
      name: "create-order",
      persistInput: true,
      execute: async ({ input, idempotencyKey }: { input: { productId: string }; idempotencyKey: string }) => {
        sent.push({ input, key: idempotencyKey });
        if (sent.length === 1) throw connectionReset();
        return "order-1";
      },
    };
    const op = createMutationGuard({ storage: indexedDBStorage({ indexedDB }) })
      .define(definition)
      .create({ productId: "123" });
    await op.run().catch(() => {});

    const [restored] = await createMutationGuard({ storage: indexedDBStorage({ indexedDB }) })
      .define(definition)
      .restore();
    expect(restored!.input).toEqual({ productId: "123" });
    await expect(restored!.retry()).resolves.toBe("order-1");
    expect(sent).toEqual([
      { input: { productId: "123" }, key: op.idempotencyKey },
      { input: { productId: "123" }, key: op.idempotencyKey },
    ]);
  });

  it("deletes expired records on restore", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    try {
      const storage = indexedDBStorage({ indexedDB: new IDBFactory() });
      await storage.set(record({ id: "old", expiresAt: 1_000 }));
      await storage.set(record({ id: "fresh", expiresAt: 10_000 }));
      await storage.set(record({ id: "forever" }));
      vi.setSystemTime(5_000);

      const guard = createMutationGuard({ storage });
      guard.define({ name: "create-order", execute: async () => "ok" });
      const restored = await guard.restore();

      expect(restored.map((op) => op.id).sort()).toEqual(["forever", "fresh"]);
      expect((await storage.list()).map((r) => r.id).sort()).toEqual(["forever", "fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
