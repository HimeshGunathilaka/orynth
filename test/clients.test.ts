/**
 * The release test for every HTTP client in docs/http-clients.md, against a
 * real server on a real socket. Each recipe is copied from the docs.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import ky from "ky";
import { ofetch } from "ofetch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOrynth,
  isUncertainError,
  memoryStorage,
  OperationUncertainError,
  type ExecuteContext,
  type OperationStorage,
  type ReconcileContext,
  type ReconcileResult,
} from "../src/index.js";
import { flush, HttpError } from "./helpers.js";
import { startServer, type Order, type OrderInput, type TestServer } from "./server.js";

type Recipe = (baseUrl: string, timeout: number) => {
  execute: (context: ExecuteContext<OrderInput>) => Promise<Order>;
  reconcile: (context: ReconcileContext<OrderInput>) => Promise<ReconcileResult<Order>>;
};

const recipes: Record<string, Recipe> = {
  fetch: (baseUrl, timeout) => ({
    async execute({ input, headers }) {
      const response = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeout),
      });
      // fetch resolves for any HTTP status: throw one Orynth can classify.
      if (!response.ok) throw new HttpError(response.status);
      return (await response.json()) as Order;
    },
    async reconcile({ idempotencyKey }) {
      const response = await fetch(`${baseUrl}/orders/by-key/${encodeURIComponent(idempotencyKey)}`);
      if (!response.ok) return { status: "unknown" };
      return (await response.json()) as ReconcileResult<Order>;
    },
  }),

  axios: (baseUrl, timeout) => {
    const api = axios.create({ baseURL: baseUrl, timeout, responseType: "json", transitional: { silentJSONParsing: false } });
    return {
      execute: async ({ input, headers }) => (await api.post<Order>("/orders", input, { headers })).data,
      reconcile: async ({ idempotencyKey }) =>
        (await api.get<ReconcileResult<Order>>(`/orders/by-key/${encodeURIComponent(idempotencyKey)}`)).data,
    };
  },

  ky: (baseUrl, timeout) => {
    const api = ky.create({ baseUrl: `${baseUrl}/`, timeout });
    return {
      // Ky doesn't retry POST by default; `retry: 0` keeps it that way if the instance's defaults change.
      execute: ({ input, headers }) => api.post("orders", { json: input, headers, retry: 0 }).json<Order>(),
      reconcile: ({ idempotencyKey }) =>
        api.get(`orders/by-key/${encodeURIComponent(idempotencyKey)}`).json<ReconcileResult<Order>>(),
    };
  },

  ofetch: (baseUrl, timeout) => {
    const api = ofetch.create({ baseURL: baseUrl, timeout, parseResponse: JSON.parse });
    return {
      // ofetch doesn't retry POST by default; `retry: 0` keeps it that way if the instance's defaults change.
      execute: ({ input, headers }) => api<Order>("/orders", { method: "POST", body: input, headers, retry: 0 }),
      reconcile: ({ idempotencyKey }) =>
        api<ReconcileResult<Order>>(`/orders/by-key/${encodeURIComponent(idempotencyKey)}`),
    };
  },
};

const CHECKOUT = "checkout-7f3a";
const INPUT: OrderInput = { productId: "notebook", quantity: 1 };
const ORDER: Order = { id: "order-1", ...INPUT };

let server: TestServer;

beforeEach(async () => {
  server = await startServer();
});

afterEach(() => server.close());

/** A base URL on which nothing listens: connections are refused. */
async function closedPort(): Promise<string> {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise((resolve) => closed.close(resolve));
  return `http://127.0.0.1:${port}`;
}

describe.each(Object.entries(recipes))("%s", (_name, recipe) => {
  /** One page load of the app: an instance and its checkout definition. */
  function page(storage: OperationStorage = memoryStorage(), { timeout = 5000, baseUrl = server.baseUrl } = {}) {
    return createOrynth({ storage }).define({ name: "checkout", persistInput: true, ...recipe(baseUrl, timeout) });
  }

  it("lost response: uncertain, then reconciled after a reload, with one order and no new request", async () => {
    const storage = memoryStorage();
    server.plan.push("drop-after-commit");
    const before = page(storage).getOrCreate(CHECKOUT, INPUT);
    await expect(before.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await flush();
    expect(await storage.list()).toMatchObject([{ id: CHECKOUT, idempotencyKey: CHECKOUT, status: "uncertain" }]);

    // The reload: a new instance on the same storage.
    const orders = page(storage);
    const [restored] = await orders.restore();
    const op = orders.getOrCreate(CHECKOUT, INPUT);
    expect(op).toBe(restored);
    expect(op).toMatchObject({ idempotencyKey: CHECKOUT, status: "uncertain" });
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: ORDER });

    expect(server.orders).toEqual([ORDER]);
    expect(server.posts.map((post) => post.key)).toEqual([CHECKOUT]);
    await flush();
    expect(await storage.list()).toEqual([]);
  });

  it("HTTP 422 is a definitive failure, sent once", async () => {
    server.plan.push(422);
    const op = page().getOrCreate(CHECKOUT, INPUT);
    const error = await op.run().catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(OperationUncertainError);
    expect(isUncertainError(error)).toBe(false);
    expect(op.status).toBe("failed");
    expect(server.posts).toHaveLength(1);
    expect(server.orders).toEqual([]);
  });

  it("an explicit retry() carries the original key, and the backend returns the original order", async () => {
    server.plan.push("drop-after-commit");
    const op = page().getOrCreate(CHECKOUT, INPUT);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);

    await expect(op.retry()).resolves.toEqual(ORDER);
    expect(server.posts.map((post) => post.key)).toEqual([CHECKOUT, CHECKOUT]);
    expect(server.orders).toEqual([ORDER]);
  });

  it("a response cut off mid-body is uncertain, and reconciled", async () => {
    server.plan.push("drop-mid-body");
    const op = page().getOrCreate(CHECKOUT, INPUT);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.reconcile()).resolves.toEqual({ status: "succeeded", result: ORDER });
    expect(server.posts).toHaveLength(1);
  });

  it("a client timeout is uncertain", async () => {
    server.plan.push("slow");
    const op = page(undefined, { timeout: 50 }).getOrCreate(CHECKOUT, INPUT);
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(server.posts).toHaveLength(1);
  });

  it("a refused connection is a definitive failure: nothing was sent", async () => {
    const op = page(undefined, { baseUrl: await closedPort() }).getOrCreate(CHECKOUT, INPUT);
    const error = await op.run().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(OperationUncertainError);
    expect(op.status).toBe("failed");
  });
});

describe("retries inside the HTTP client", () => {
  // Safe only because the backend honors the key. Orynth sees one attempt and can't check the
  // key's expiry, the input or the user before the client resends.
  it("Ky resends a POST within one Orynth attempt when its retry methods include POST", async () => {
    server.plan.push("drop-after-commit");
    const api = ky.create({ baseUrl: `${server.baseUrl}/`, retry: { limit: 1, methods: ["post"], delay: () => 0 } });
    const orders = createOrynth().define({
      name: "checkout",
      execute: ({ input, headers }: ExecuteContext<OrderInput>) => api.post("orders", { json: input, headers }).json<Order>(),
    });
    const op = orders.getOrCreate(CHECKOUT, INPUT);

    await expect(op.run()).resolves.toEqual(ORDER);
    expect(op.state.attempts).toBe(1);
    expect(server.posts.map((post) => post.key)).toEqual([CHECKOUT, CHECKOUT]);
  });

  it("ofetch resends a POST within one Orynth attempt when given a retry count, even after a dropped connection", async () => {
    server.plan.push("drop-after-commit");
    const orders = createOrynth().define({
      name: "checkout",
      execute: ({ input, headers }: ExecuteContext<OrderInput>) =>
        ofetch<Order>(`${server.baseUrl}/orders`, { method: "POST", body: input, headers, retry: 1 }),
    });
    const op = orders.getOrCreate(CHECKOUT, INPUT);

    await expect(op.run()).resolves.toEqual(ORDER);
    expect(op.state.attempts).toBe(1);
    expect(server.posts.map((post) => post.key)).toEqual([CHECKOUT, CHECKOUT]);
  });
});
