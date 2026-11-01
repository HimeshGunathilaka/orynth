/**
 * Regression tests for the safety audits: outcomes that stay uncertain,
 * checks repeated right before sending, scope changes, stale handles, changed
 * and unstorable inputs, malformed records, and reused idempotency keys. Tests
 * involving other tabs run with Web Locks and with leases.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrynth,
  IdempotencyKeyExpiredError,
  memoryStorage,
  OperationConflictError,
  OperationUncertainError,
  StorageError,
  type ExecuteContext,
  type LockManagerLike,
  type OperationRecord,
  type OperationStorage,
  type ReconcileContext,
  type ReconcileResult,
} from "../src/index.js";
import { indexedDBStorage } from "../src/storage/index.js";
import { connectionRefused, connectionReset, deferred, flush, HttpError } from "./helpers.js";
import { startServer, type Order, type OrderInput, type TestServer } from "./server.js";

const MODES = [
  ["Web Locks", undefined],
  ["leases", false],
] as const;

const lost = async (): Promise<string> => {
  throw connectionReset();
};

const record = (overrides: Partial<OperationRecord> = {}): OperationRecord => ({
  id: "op-1",
  name: "create-order",
  idempotencyKey: "key-1",
  status: "pending",
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  revision: "rev-1",
  ...overrides,
});

/** Storage whose next write of a pending record waits for `gate`; `writing` resolves when it starts. */
function pausedStorage(inner: OperationStorage = memoryStorage()) {
  const writing = deferred();
  const gate = deferred();
  let pause = false;
  const storage: OperationStorage = {
    ...inner,
    async set(stored) {
      if (pause && stored.status === "pending") {
        pause = false;
        writing.resolve();
        await gate.promise;
      }
      await inner.set(stored);
    },
  };
  return { storage, inner, writing: writing.promise, release: () => gate.resolve(), pause: () => (pause = true) };
}

let server: TestServer | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await server?.close();
  server = undefined;
});

const postOrder = async ({ input, headers }: ExecuteContext<OrderInput>) => {
  const response = await fetch(`${server!.baseUrl}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new HttpError(response.status);
  return (await response.json()) as Order;
};

const lookupOrder = async ({ idempotencyKey }: ReconcileContext<OrderInput>) => {
  const response = await fetch(`${server!.baseUrl}/orders/by-key/${encodeURIComponent(idempotencyKey)}`);
  return (await response.json()) as ReconcileResult<Order>;
};

describe.each(MODES)("an uncertain outcome stays uncertain (%s)", (_mode, locks) => {
  it("when an automatic retry is rejected with 429", async () => {
    server = await startServer();
    server.plan.push("drop-after-commit", 429);
    const storage = memoryStorage();
    const op = createOrynth({ storage, locks })
      .define({
        name: "create-order",
        retry: {
          attempts: 2,
          delay: 10,
          shouldRetry: (error, { uncertain }) => uncertain || (error instanceof HttpError && error.status === 429),
        },
        execute: postOrder,
        reconcile: lookupOrder,
      })
      .create({ productId: "123", quantity: 1 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ status: 429 });
    await vi.waitFor(async () => expect(await storage.list()).toEqual([expect.objectContaining({ status: "uncertain" })]));
    await expect(op.reconcile()).resolves.toMatchObject({ status: "succeeded", result: { id: "order-1" } });
    expect(server.orders).toHaveLength(1);
  });

  it("when a manual retry is rejected before reaching the backend (401), and it can still be reconciled", async () => {
    const storage = memoryStorage();
    const orders = new Map<string, string>();
    let authorized = true;
    let dropResponse = true;
    const reconcile = vi.fn(async ({ idempotencyKey }: ReconcileContext<unknown>): Promise<ReconcileResult<string>> => {
      const order = orders.get(idempotencyKey);
      return order ? { status: "succeeded", result: order } : { status: "not-found" };
    });
    const guard = createOrynth({ storage, locks });
    const op = guard
      .define({
        name: "op",
        execute: async ({ idempotencyKey }) => {
          if (!authorized) throw new HttpError(401);
          if (!orders.has(idempotencyKey)) orders.set(idempotencyKey, `order-${orders.size + 1}`);
          if (dropResponse) {
            dropResponse = false;
            throw connectionReset();
          }
          return orders.get(idempotencyKey)!;
        },
        reconcile,
      })
      .create(1);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);

    authorized = false;
    const error = await op.retry().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ status: 401 });
    expect(op.status).toBe("uncertain");
    expect(await guard.restore()).toEqual([op]);
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: "order-1" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(orders.size).toBe(1);
  });

  it("when a restored operation's retry finds the server down", async () => {
    const storage = memoryStorage();
    await storage.set(record({ input: { productId: "1" } }));
    const guard = createOrynth({ storage, locks });
    guard.define({
      name: "create-order",
      persistInput: true,
      execute: async (): Promise<string> => {
        throw connectionRefused();
      },
    });
    const [op] = await guard.restore();
    await expect(op!.retry()).rejects.toBeInstanceOf(OperationUncertainError);
    await vi.waitFor(async () =>
      expect(await storage.list()).toEqual([expect.objectContaining({ status: "uncertain", attempts: 2 })]),
    );
  });

  it("while an operation that was never uncertain still fails definitively", async () => {
    const execute = vi.fn(async (): Promise<string> => {
      throw new HttpError(422);
    });
    const op = createOrynth({ locks }).define({ name: "op", execute }).create();
    await expect(op.run()).rejects.toMatchObject({ status: 422 });
    await expect(op.retry()).rejects.toMatchObject({ status: 422 });
    expect(op.status).toBe("failed");
  });
});

describe.each(MODES)("checks right before sending (%s)", (_mode, locks) => {
  it("refuses a resend whose key expired while its record was being written", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const { storage, inner, writing, release, pause } = pausedStorage();
    const execute = vi.fn(lost);
    const op = createOrynth({ storage, locks, ttl: 100 }).define({ name: "op", execute }).create({ n: 1 });
    await op.run().catch(() => {});

    vi.setSystemTime(99);
    pause();
    const retry = op.retry().catch((e: unknown) => e);
    await writing;
    vi.setSystemTime(101);
    release();

    expect(await retry).toBeInstanceOf(IdempotencyKeyExpiredError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(op.state).toMatchObject({ status: "uncertain", attempts: 1, expiresAt: 100 });
    await vi.waitFor(async () =>
      expect(await inner.list()).toEqual([expect.objectContaining({ status: "uncertain", attempts: 1 })]),
    );
  });

  it("sends nothing if the scope changes while the first record is being written", async () => {
    let user = "alice";
    const { storage, inner, writing, release, pause } = pausedStorage();
    pause();
    const execute = vi.fn(async () => "ok");
    const op = createOrynth({ storage, locks, scope: () => user }).define({ name: "op", execute }).create(1);
    const run = op.run().catch((e: unknown) => e);
    await writing;
    user = "bob";
    release();

    expect(await run).toMatchObject({ message: expect.stringMatching(/another scope/) });
    expect(execute).not.toHaveBeenCalled();
    expect(op.state).toMatchObject({ status: "created", attempts: 0 });
    await vi.waitFor(async () => expect(await inner.list()).toEqual([]));
  });

  it("stops automatic retries when the scope changes during the backoff", async () => {
    vi.useFakeTimers();
    let user = "alice";
    const accounts: string[] = [];
    const op = createOrynth({ locks, scope: () => user })
      .define({
        name: "op",
        retry: { attempts: 2, delay: 10, jitter: false },
        execute: async (): Promise<string> => {
          accounts.push(user);
          throw connectionReset();
        },
      })
      .create(1);
    const run = op.run().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    user = "bob";
    await vi.advanceTimersByTimeAsync(10);

    expect(await run).toBeInstanceOf(OperationUncertainError);
    expect(accounts).toEqual(["alice"]);
  });

  it("stops polling reconcile() when the scope changes", async () => {
    let user = "alice";
    const reconcile = vi.fn(async (): Promise<ReconcileResult<string>> => {
      user = "bob";
      return { status: "pending" };
    });
    const op = createOrynth({ locks, scope: () => user }).define({ name: "op", execute: lost, reconcile }).create();
    await op.run().catch(() => {});
    await expect(op.reconcile({ attempts: 3, delay: 0 })).rejects.toThrow(/another scope/);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(op.status).toBe("uncertain");
  });
});

describe("scope", () => {
  it("must be a string or undefined", async () => {
    const guard = createOrynth({ scope: () => 42 as never });
    const def = guard.define({ name: "op", execute: async () => "ok" });
    expect(() => def.create()).toThrow(TypeError);
    await expect(guard.restore()).rejects.toThrow(TypeError);
  });
});

describe.each(MODES)("stale handles (%s)", (_mode, locks) => {
  it("discard() leaves the record of another tab that is resending the operation", async () => {
    const storage = memoryStorage();
    const a = createOrynth({ storage, locks }).define({ name: "op", persistInput: true, execute: lost }).create(1);
    await a.run().catch(() => {});
    await vi.waitFor(async () => expect((await storage.list())[0]).toMatchObject({ status: "uncertain" }));
    const gate = deferred<string>();
    const sending = deferred();
    const [b] = await createOrynth({ storage, locks })
      .define({
        name: "op",
        persistInput: true,
        execute: () => {
          sending.resolve();
          return gate.promise;
        },
      })
      .restore();
    const retry = b!.retry().catch(() => {});
    await sending.promise;

    const discard = a.discard();
    await flush();
    expect(await storage.get(a.id)).toMatchObject({ status: "pending", attempts: 2 });
    gate.reject(connectionReset());
    await Promise.all([retry, discard]);
    await flush();
    expect(await storage.get(a.id)).toMatchObject({ status: "uncertain", attempts: 2 });
  });

  describe("after another operation reused the ID", () => {
    async function reused() {
      const storage = memoryStorage();
      const definition = {
        name: "op",
        persistInput: true,
        execute: lost,
        reconcile: async (): Promise<ReconcileResult<string>> => ({ status: "succeeded", result: "old-order" }),
      };
      const stale = createOrynth({ storage, locks }).define(definition).create(1, { id: "checkout" });
      await stale.run().catch(() => {});
      await vi.waitFor(async () => expect((await storage.list())[0]).toMatchObject({ status: "uncertain" }));
      // Another tab settles the old operation, then a new one is sent under the same ID.
      const [other] = await createOrynth({ storage, locks }).define(definition).restore();
      await other!.reconcile();
      await vi.waitFor(async () => expect(await storage.list()).toEqual([]));
      const gate = deferred<string>();
      const sending = deferred();
      const next = createOrynth({ storage, locks })
        .define({
          name: "op",
          execute: () => {
            sending.resolve();
            return gate.promise;
          },
        })
        .create(2, { id: "checkout" });
      const run = next.run().catch(() => {});
      await sending.promise;
      return { storage, stale, next, gate, run };
    }

    it("discard() leaves the new operation's record", async () => {
      const { storage, stale, next, gate, run } = await reused();
      const discard = stale.discard();
      await flush();
      expect(await storage.get("checkout")).toMatchObject({ idempotencyKey: next.idempotencyKey, status: "pending" });
      gate.reject(connectionReset());
      await Promise.all([run, discard]);
      await flush();
      expect(await storage.get("checkout")).toMatchObject({ idempotencyKey: next.idempotencyKey, status: "uncertain" });
    });

    it("reconcile() leaves the new operation's record", async () => {
      const { storage, stale, next, gate, run } = await reused();
      const reconcile = stale.reconcile();
      await flush();
      expect(await storage.get("checkout")).toMatchObject({ idempotencyKey: next.idempotencyKey, status: "pending" });
      gate.reject(connectionReset());
      await Promise.all([run, reconcile]);
      await flush();
      expect(await storage.get("checkout")).toMatchObject({ idempotencyKey: next.idempotencyKey, status: "uncertain" });
    });
  });

  it("a handle that saw another tab settle the operation stores its record again before resending", async () => {
    const storage = memoryStorage();
    const recordsWhenSent: number[] = [];
    const definition = {
      name: "op",
      persistInput: true,
      execute: async (): Promise<string> => {
        recordsWhenSent.push((await storage.list()).length);
        throw connectionReset();
      },
      reconcile: async (): Promise<ReconcileResult<string>> => ({ status: "failed" }),
    };
    const a = createOrynth({ storage, locks }).define(definition).create({ n: 1 });
    await a.run().catch(() => {});
    await vi.waitFor(async () => expect((await storage.list())[0]).toMatchObject({ status: "uncertain" }));
    const [b] = await createOrynth({ storage, locks }).define(definition).restore();
    // Tab A gives up on it; tab B then learns it failed, and the user retries.
    await a.discard();
    await expect(b!.reconcile()).resolves.toMatchObject({ status: "failed" });

    recordsWhenSent.length = 0;
    await b!.retry().catch(() => {});
    expect(recordsWhenSent).toEqual([1]);
    await vi.waitFor(async () => expect((await storage.list())[0]).toMatchObject({ status: "uncertain" }));
  });
});

describe.each(MODES)("restore() (%s)", (_mode, locks) => {
  it("returns a stored operation when a run() with its ID conflicts while restore() reads storage", async () => {
    const inner = memoryStorage();
    await createOrynth({ storage: inner, locks })
      .define({ name: "order", execute: lost })
      .create(undefined, { id: "checkout-1" })
      .run()
      .catch(() => {});
    await vi.waitFor(async () => expect((await inner.list())[0]).toMatchObject({ status: "uncertain" }));
    const gate = deferred();
    const storage: OperationStorage = {
      ...inner,
      async list() {
        const snapshot = await inner.list();
        await gate.promise;
        return snapshot;
      },
    };
    const orders = createOrynth({ storage, locks }).define({ name: "order", execute: lost });
    const restoring = orders.restore();
    await expect(orders.create(undefined, { id: "checkout-1" }).run()).rejects.toBeInstanceOf(OperationConflictError);
    gate.resolve();
    expect((await restoring).map((op) => op.id)).toEqual(["checkout-1"]);
  });

  it("restores the valid records when onStorageError throws on a malformed one", async () => {
    const reported: unknown[] = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    const storage = memoryStorage();
    await storage.set(record({ id: "a" }));
    await storage.set({ id: "broken" } as never);
    await storage.set(record({ id: "b" }));
    const guard = createOrynth({
      storage,
      locks,
      onStorageError: () => {
        throw new Error("reporter failed");
      },
    });
    guard.define({ name: "create-order", execute: lost });
    expect((await guard.restore()).map((op) => op.id)).toEqual(["a", "b"]);
    expect(reported).toEqual([expect.objectContaining({ message: "reporter failed" })]);
  });
});

describe.each(MODES)("errors that can't be described (%s)", (_mode, locks) => {
  it.each([
    ["a null-prototype message", { status: 503, message: Object.create(null) as unknown }],
    [
      "a throwing message getter",
      {
        name: "TypeError",
        get message(): string {
          throw new Error("getter failed");
        },
      },
    ],
  ])("%s: the operation becomes uncertain and run() never resends it", async (_name, thrown) => {
    vi.stubGlobal("reportError", () => {});
    const storage = memoryStorage();
    const execute = vi.fn(async (): Promise<string> => {
      throw thrown;
    });
    const guard = createOrynth({ storage, locks });
    const op = guard
      .define({ name: "op", execute, reconcile: async () => ({ status: "succeeded", result: "ok" }) })
      .create();

    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () =>
      expect((await storage.list())[0]).toMatchObject({ status: "uncertain", error: { name: "Error" } }),
    );
    expect(await guard.restore()).toEqual([op]);
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: "ok" });
  });
});

describe("changed inputs", () => {
  type Input = Record<string, unknown>;
  it.each<[string, () => Input, (input: Input) => void]>([
    ["a BigInt", () => ({ amount: 1n }), (input) => (input.amount = 2n)],
    [
      "a circular object",
      () => {
        const input: Input = { amount: 1 };
        input.self = input;
        return input;
      },
      (input) => (input.amount = 2),
    ],
    ["ArrayBuffer bytes", () => ({ file: new Uint8Array([1]).buffer }), (input) => (new Uint8Array(input.file as ArrayBuffer)[0] = 2)],
    ["typed array bytes", () => ({ file: new Uint8Array([1]) }), (input) => ((input.file as Uint8Array)[0] = 2)],
    [
      "a non-enumerable property",
      () => Object.defineProperty({}, "amount", { value: 1, writable: true }),
      (input) => (input.amount = 2),
    ],
    [
      "an equal-size Blob",
      () => ({ file: new Blob(["AAAA"], { type: "text/plain" }) }),
      (input) => (input.file = new Blob(["BBBB"], { type: "text/plain" })),
    ],
    ["a renamed File", () => ({ file: new File(["A"], "a.txt") }), (input) => (input.file = new File(["B"], "b.txt"))],
  ])("%s: an unchanged input is resent, a changed one is refused", async (_name, make, change) => {
    const execute = vi.fn(lost);
    const input = make();
    const op = createOrynth().define({ name: "op", execute }).create(input);
    await op.run().catch(() => {});
    await expect(op.retry()).rejects.toBeInstanceOf(OperationUncertainError);
    change(input);
    await expect(op.retry()).rejects.toThrow(/changed after it was sent/);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refuses to resend an input it can no longer read", async () => {
    const { proxy, revoke } = Proxy.revocable({ amount: 1 }, {});
    const execute = vi.fn(lost);
    const op = createOrynth().define({ name: "op", execute }).create(proxy);
    await op.run().catch(() => {});
    revoke();
    await expect(op.retry()).rejects.toThrow(/Can't tell whether the input/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe.each(["memory", "IndexedDB"] as const)("an input edited while its record is written (%s)", (kind) => {
  it("is stored again, so a restored retry sends what was sent", async () => {
    const { storage, inner, writing, release, pause } = pausedStorage(
      kind === "memory" ? memoryStorage() : indexedDBStorage({ indexedDB: new IDBFactory() }),
    );
    const sent: number[] = [];
    const definition = {
      name: "op",
      persistInput: true,
      execute: async ({ input }: ExecuteContext<{ amount: number }>): Promise<string> => {
        sent.push(input.amount);
        throw connectionReset();
      },
    };
    const input = { amount: 1 };
    pause();
    const op = createOrynth({ storage, locks: false }).define(definition).create(input);
    const run = op.run().catch(() => {});
    await writing;
    input.amount = 2;
    release();
    await run;

    await vi.waitFor(async () =>
      expect(await inner.get(op.id)).toMatchObject({ status: "uncertain", input: { amount: 2 } }),
    );
    const [restored] = await createOrynth({ storage, locks: false }).define(definition).restore();
    await restored!.retry().catch(() => {});
    expect(sent).toEqual([2, 2]);
  });
});

describe.each(MODES)("an input that keeps changing while it is stored (%s)", (_mode, locks) => {
  it("is not sent", async () => {
    const inner = memoryStorage();
    const input = { amount: 1 };
    const storage: OperationStorage = {
      ...inner,
      async set(stored) {
        await inner.set(stored);
        input.amount++;
      },
    };
    const execute = vi.fn(async () => "ok");
    const op = createOrynth({ storage, locks }).define({ name: "op", persistInput: true, execute }).create(input);
    await expect(op.run()).rejects.toThrow(/kept changing/);
    expect(execute).not.toHaveBeenCalled();
    expect(op.status).toBe("created");
    await vi.waitFor(async () => expect(await inner.list()).toEqual([]));
  });
});

describe("persisted inputs", () => {
  it.each([
    ["FormData", () => new FormData()],
    ["URLSearchParams", () => new URLSearchParams("productId=1")],
  ])("refuses to store %s instead of storing {}", async (_name, make) => {
    const execute = vi.fn(async () => "ok");
    const op = createOrynth().define({ name: "op", persistInput: true, execute }).create(make());
    await expect(op.run()).rejects.toBeInstanceOf(StorageError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("copies proxies part by part, keeping their Maps and Dates", async () => {
    const storage = memoryStorage();
    // Like Vue's reactive collections, whose methods run on the original.
    const items = new Proxy(new Map([["sku-1", 2]]), {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = new Proxy({ items, deliverOn: new Date(0) }, {});
    const op = createOrynth({ storage }).define({ name: "op", persistInput: true, execute: lost }).create(input);
    await op.run().catch(() => {});
    await flush();
    expect((await storage.list())[0]!.input).toEqual({ items: new Map([["sku-1", 2]]), deliverOn: new Date(0) });
  });
});

describe("malformed records", () => {
  it("reports records with an invalid expiresAt or attempts instead of resending them", async () => {
    const storage = memoryStorage();
    await storage.set(record({ id: "string-expiry", expiresAt: "5000" as never, input: {} }));
    await storage.set(record({ id: "zero-attempts", attempts: 0, input: {} }));
    const onStorageError = vi.fn();
    const execute = vi.fn(async () => "sent");
    const guard = createOrynth({ storage, onStorageError });
    guard.define({ name: "create-order", persistInput: true, execute });
    expect(await guard.restore()).toEqual([]);
    expect(onStorageError).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats input: null as an input that was not persisted", async () => {
    const storage = memoryStorage();
    await storage.set(record({ input: null }));
    const execute = vi.fn(async () => "sent");
    const guard = createOrynth({ storage });
    guard.define({ name: "create-order", persistInput: true, execute });
    const [op] = await guard.restore();
    expect(op!.input).toBeUndefined();
    await expect(op!.retry()).rejects.toThrow(/input was not persisted/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("describes an expiry outside the Date range", () => {
    expect(new IdempotencyKeyExpiredError("op", -1e20).message).toMatch(/expired at -100000000000000000000/);
  });
});

describe.skipIf(!globalThis.navigator?.locks)("leases next to Web Locks", () => {
  it("a tab whose lock requests fail does not resend what a tab with Web Locks is sending", async () => {
    vi.stubGlobal("reportError", () => {});
    const storage = memoryStorage();
    const gate = deferred<string>();
    const sends: string[] = [];
    const definition = (tab: string) => ({
      name: "op",
      persistInput: true,
      execute: async (): Promise<string> => {
        sends.push(tab);
        return tab === "A" ? gate.promise : "B";
      },
    });
    const run = createOrynth({ storage }).define(definition("A")).create({ n: 1 }).run();
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(1));

    const broken: LockManagerLike = {
      request: () => Promise.reject(new DOMException("not fully active", "InvalidStateError")),
    };
    const tabB = createOrynth({ storage, locks: broken });
    tabB.define(definition("B"));
    const [restored] = await tabB.restore();
    await expect(restored!.retry()).rejects.toBeInstanceOf(OperationConflictError);
    expect(sends).toEqual(["A"]);
    gate.resolve("A");
    await run;
  });

  it("a tab with Web Locks resends right after another tab crashed; one without waits for the lease", async () => {
    const storage = memoryStorage();
    const lease = { owner: "crashed-tab", until: Date.now() + 30_000, locks: true };
    await storage.set(record({ input: { n: 1 }, lease }));
    const execute = vi.fn(async () => "sent");
    const leases = createOrynth({ storage, locks: false });
    leases.define({ name: "create-order", persistInput: true, execute });
    const [waiting] = await leases.restore();
    await expect(waiting!.retry()).rejects.toThrow(/being sent by another tab/);

    const webLocks = createOrynth({ storage });
    webLocks.define({ name: "create-order", persistInput: true, execute });
    const [resending] = await webLocks.restore();
    await expect(resending!.retry()).resolves.toBe("sent");
  });
});

describe.each(MODES)("clear() (%s)", (_mode, locks) => {
  it("leaves an operation that another tab is sending", async () => {
    const storage = memoryStorage();
    const gate = deferred<string>();
    const run = createOrynth({ storage, locks }).define({ name: "op", execute: () => gate.promise }).create().run();
    await vi.waitFor(async () => expect(await storage.list()).toHaveLength(1));

    await createOrynth({ storage, locks, lockTimeout: 50 }).clear();
    expect(await storage.list()).toHaveLength(1);
    gate.resolve("ok");
    await run;
  });
});

describe("responses that can't be parsed", () => {
  it("a committed 201 whose body isn't JSON is uncertain, not failed", async () => {
    const http = createServer((request, response) => {
      request.resume().on("end", () => response.writeHead(201).end());
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/orders`;
    try {
      const op = createOrynth()
        .define({
          name: "create-order",
          execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
            const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(input) });
            if (!response.ok) throw new HttpError(response.status);
            return (await response.json()) as Order;
          },
        })
        .create({ productId: "1", quantity: 1 });
      const error = await op.run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OperationUncertainError);
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    } finally {
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  });
});

describe("reused idempotency keys", () => {
  it("keep the expiry of their first use in this guard", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    server = await startServer({ keyTtl: 60_000 });
    let loseResponse = false;
    const createOrder = createOrynth({ ttl: 60_000 }).define({
      name: "create-order",
      execute: async (context: ExecuteContext<OrderInput>) => {
        const order = await postOrder(context);
        if (loseResponse) {
          loseResponse = false;
          throw connectionReset();
        }
        return order;
      },
    });
    const placeOrder = (input: OrderInput) =>
      (createOrder.get("checkout-1") ??
        createOrder.create(input, { id: "checkout-1", idempotencyKey: "checkout-1" })).run();

    const firstUse = Date.now();
    await placeOrder({ productId: "1", quantity: 1 });
    await flush();
    vi.setSystemTime(firstUse + 50_000);
    loseResponse = true;
    await placeOrder({ productId: "1", quantity: 1 }).catch(() => {}); // replayed by the server, response lost
    const op = createOrder.get("checkout-1")!;
    expect(op.state.expiresAt).toBe(firstUse + 60_000);

    vi.setSystemTime(firstUse + 70_000); // the backend has forgotten the key
    await expect(op.retry()).rejects.toBeInstanceOf(IdempotencyKeyExpiredError);
    expect(server.orders).toHaveLength(1);
  });

  it("can be given the key's expiry explicitly, which only applies while it is in the future", async () => {
    vi.useFakeTimers({ now: 1_000, toFake: ["Date"] });
    const def = createOrynth({ ttl: 60_000 }).define({ name: "op", execute: lost });
    const known = def.create(undefined, { idempotencyKey: "k-1", expiresAt: 5_000 });
    await known.run().catch(() => {});
    expect(known.state.expiresAt).toBe(5_000);
    const forgotten = def.create(undefined, { idempotencyKey: "k-2", expiresAt: 500 });
    await forgotten.run().catch(() => {});
    expect(forgotten.state.expiresAt).toBe(61_000);
    expect(() => def.create(undefined, { idempotencyKey: "k-3", expiresAt: "soon" as never })).toThrow(TypeError);
  });
});
