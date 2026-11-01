import { memoryStorage, type OperationStorage } from "../src/index.js";

/** What Node's `fetch` throws when the connection drops mid-request. */
export function connectionReset(): TypeError {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return new TypeError("fetch failed", { cause });
}

/** What Node's `fetch` throws when the server cannot be reached at all. */
export function connectionRefused(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  return new TypeError("fetch failed", { cause });
}

/** An error carrying an HTTP status, as application code should throw for non-2xx responses. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Memory storage whose methods can be switched to fail. */
export function flakyStorage() {
  const inner = memoryStorage();
  const failing = new Set<keyof OperationStorage>();
  const guarded =
    <K extends keyof OperationStorage>(method: K) =>
    (...args: Parameters<OperationStorage[K]>) =>
      failing.has(method)
        ? Promise.reject(new Error(`${method} failed: quota exceeded`))
        : (inner[method] as (...a: typeof args) => ReturnType<OperationStorage[K]>)(...args);
  const storage: OperationStorage = {
    set: guarded("set"),
    get: guarded("get"),
    delete: guarded("delete"),
    list: guarded("list"),
  };
  return {
    storage,
    fail: (...methods: (keyof OperationStorage)[]) => methods.forEach((m) => failing.add(m)),
    heal: () => failing.clear(),
  };
}

/**
 * An in-memory order backend that honors idempotency keys, used to check what
 * actually happened server-side.
 */
export function orderBackend() {
  const orders = new Map<string, { id: string; productId: string; quantity: number }>();
  let dropNextResponse = false;
  return {
    orders,
    /** Commit the next order, then lose the response as a dropped connection would. */
    dropNextResponse() {
      dropNextResponse = true;
    },
    async createOrder(input: { productId: string; quantity: number }, idempotencyKey: string) {
      const existing = orders.get(idempotencyKey);
      if (existing) return existing;
      const order = { id: `order-${orders.size + 1}`, ...input };
      orders.set(idempotencyKey, order);
      if (dropNextResponse) {
        dropNextResponse = false;
        throw connectionReset();
      }
      return order;
    },
    async lookup(idempotencyKey: string) {
      const order = orders.get(idempotencyKey);
      return order ? ({ status: "succeeded", result: order } as const) : ({ status: "not-found" } as const);
    },
  };
}
