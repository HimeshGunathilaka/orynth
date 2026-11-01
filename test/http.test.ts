/**
 * Fetch and Axios against a real HTTP server on a real socket, including
 * connections dropped after the server committed the order.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMutationGuard,
  OperationUncertainError,
  type ExecuteContext,
  type ReconcileContext,
  type ReconcileResult,
} from "../src/index.js";
import { HttpError } from "./helpers.js";

type OrderInput = { productId: string; quantity: number };
type Order = OrderInput & { id: string };
/** What the server does with the next POST /orders. */
type Behavior = "drop-after-commit" | "slow" | 422 | 503;

const KEY_HEADER = "x-idempotency-key";

let server: Server;
let baseUrl: string;
const orders = new Map<string, Order>(); // by idempotency key
const plan: Behavior[] = [];
let posts = 0;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, baseUrl);
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (req.method === "POST" && url.pathname === "/orders") {
      posts++;
      let body = "";
      for await (const chunk of req) body += chunk;
      const behavior = plan.shift();
      if (behavior === 422 || behavior === 503) return json(behavior, { error: "rejected" });

      const key = req.headers[KEY_HEADER];
      if (typeof key !== "string") return json(400, { error: `missing ${KEY_HEADER}` });
      // Idempotent: the same key returns the order created the first time.
      let order = orders.get(key);
      if (!order) {
        order = { id: `order-${orders.size + 1}`, ...(JSON.parse(body) as OrderInput) };
        orders.set(key, order);
      }
      if (behavior === "drop-after-commit") return void req.socket.destroy();
      if (behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
      return json(201, order);
    }

    if (req.method === "GET" && url.pathname.startsWith("/operations/")) {
      const order = orders.get(decodeURIComponent(url.pathname.slice("/operations/".length)));
      return json(200, order ? { status: "succeeded", result: order } : { status: "not-found" });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  orders.clear();
  plan.length = 0;
  posts = 0;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("fetch", () => {
  function fetchGuard(options: { retry?: boolean; timeout?: number; base?: string } = {}) {
    const guard = createMutationGuard({ idempotencyHeader: "X-Idempotency-Key" });
    return guard.define({
      name: "create-order",
      retry: options.retry && { attempts: 3, delay: 10 },
      execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
        const response = await fetch(`${options.base ?? baseUrl}/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(options.timeout ?? 5000),
        });
        if (!response.ok) throw new HttpError(response.status);
        return (await response.json()) as Order;
      },
      reconcile: async ({ idempotencyKey }: ReconcileContext<OrderInput>) => {
        const response = await fetch(`${baseUrl}/operations/${encodeURIComponent(idempotencyKey)}`);
        if (!response.ok) return { status: "unknown" };
        return (await response.json()) as ReconcileResult<Order>;
      },
    });
  }

  it("creates an order and sends the configured idempotency header", async () => {
    const op = fetchGuard().create({ productId: "123", quantity: 2 });
    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect([...orders.keys()]).toEqual([op.idempotencyKey]);
  });

  it("server commits, connection drops: uncertain, then reconciled without a duplicate", async () => {
    plan.push("drop-after-commit");
    const op = fetchGuard().create({ productId: "123", quantity: 2 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ message: "fetch failed" });
    expect(op.status).toBe("uncertain");

    await expect(op.reconcile()).resolves.toEqual({
      status: "succeeded",
      result: { id: "order-1", productId: "123", quantity: 2 },
    });
    expect(op.status).toBe("succeeded");
    expect(posts).toBe(1);
    expect(orders.size).toBe(1);
  });

  it("server commits, connection drops: an automatic retry reuses the key and the server deduplicates", async () => {
    plan.push("drop-after-commit");
    const op = fetchGuard({ retry: true }).create({ productId: "123", quantity: 2 });

    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect(posts).toBe(2);
    expect(orders.size).toBe(1);
  });

  it("a client timeout is uncertain, not a failure", async () => {
    plan.push("slow");
    const op = fetchGuard({ timeout: 50 }).create({ productId: "123", quantity: 1 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
    // The server went on to create the order.
    await expect(op.reconcile()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("HTTP 422 is a definitive failure", async () => {
    plan.push(422);
    const op = fetchGuard({ retry: true }).create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toMatchObject({ status: 422 });
    expect(op.status).toBe("failed");
    expect(posts).toBe(1);
  });

  it("HTTP 503 is uncertain", async () => {
    plan.push(503);
    const op = fetchGuard().create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    await expect(op.reconcile()).resolves.toEqual({ status: "not-found" });
  });

  it("a refused connection is a definitive failure: the request was never sent", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const op = fetchGuard({ base: `http://127.0.0.1:${port}` }).create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toMatchObject({ message: "fetch failed", cause: { code: "ECONNREFUSED" } });
    expect(op.status).toBe("failed");
  });
});

describe("axios", () => {
  function axiosGuard(timeout = 5000) {
    const client = axios.create({ baseURL: baseUrl, timeout });
    return createMutationGuard({ idempotencyHeader: "X-Idempotency-Key" }).define({
      name: "create-order",
      execute: async ({ input, headers }: ExecuteContext<OrderInput>) =>
        (await client.post<Order>("/orders", input, { headers })).data,
      reconcile: async ({ idempotencyKey }: ReconcileContext<OrderInput>) =>
        (await client.get<ReconcileResult<Order>>(`/operations/${encodeURIComponent(idempotencyKey)}`)).data,
    });
  }

  it("creates an order and sends the configured idempotency header", async () => {
    const op = axiosGuard().create({ productId: "123", quantity: 2 });
    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect([...orders.keys()]).toEqual([op.idempotencyKey]);
  });

  it("server commits, connection drops: uncertain, then reconciled without a duplicate", async () => {
    plan.push("drop-after-commit");
    const op = axiosGuard().create({ productId: "123", quantity: 2 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ isAxiosError: true, code: "ECONNRESET" });

    await expect(op.reconcile()).resolves.toMatchObject({ status: "succeeded", result: { id: "order-1" } });
    expect(posts).toBe(1);
  });

  it("a client timeout is uncertain", async () => {
    plan.push("slow");
    const op = axiosGuard(50).create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(op.status).toBe("uncertain");
  });

  it("HTTP 422 is a definitive failure, classified from error.response.status", async () => {
    plan.push(422);
    const op = axiosGuard().create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toMatchObject({ isAxiosError: true, response: { status: 422 } });
    expect(op.status).toBe("failed");
  });
});
