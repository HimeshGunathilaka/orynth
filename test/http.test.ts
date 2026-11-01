/**
 * Fetch and Axios against a real HTTP server on a real socket, including
 * connections dropped after the server committed the order.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOrynth,
  OperationUncertainError,
  type ExecuteContext,
  type ReconcileContext,
  type ReconcileResult,
} from "../src/index.js";
import { HttpError } from "./helpers.js";
import { startServer, type Order, type OrderInput, type TestServer } from "./server.js";

let server: TestServer;
let baseUrl: string;

beforeEach(async () => {
  server = await startServer({ keyHeader: "x-idempotency-key" });
  baseUrl = server.baseUrl;
});

afterEach(() => server.close());

describe("fetch", () => {
  function fetchGuard(options: { retry?: boolean; timeout?: number; base?: string } = {}) {
    const guard = createOrynth({ idempotencyHeader: "X-Idempotency-Key" });
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
        const response = await fetch(`${baseUrl}/orders/by-key/${encodeURIComponent(idempotencyKey)}`);
        if (!response.ok) return { status: "unknown" };
        return (await response.json()) as ReconcileResult<Order>;
      },
    });
  }

  it("creates an order and sends the configured idempotency header", async () => {
    const op = fetchGuard().create({ productId: "123", quantity: 2 });
    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect(server.posts.map((post) => post.key)).toEqual([op.idempotencyKey]);
  });

  it("server commits, connection drops: uncertain, then reconciled without a duplicate", async () => {
    server.plan.push("drop-after-commit");
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
    expect(server.posts.length).toBe(1);
    expect(server.orders.length).toBe(1);
  });

  it("server commits, connection drops: an automatic retry reuses the key and the server deduplicates", async () => {
    server.plan.push("drop-after-commit");
    const op = fetchGuard({ retry: true }).create({ productId: "123", quantity: 2 });

    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect(server.posts.length).toBe(2);
    expect(server.orders.length).toBe(1);
  });

  it("a client timeout is uncertain, not a failure", async () => {
    server.plan.push("slow");
    const op = fetchGuard({ timeout: 50 }).create({ productId: "123", quantity: 1 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ name: "TimeoutError" });
    // The server is still processing; poll until it finishes creating the order.
    await expect(op.reconcile()).resolves.toEqual({ status: "pending" });
    await expect(op.reconcile({ attempts: 10, delay: 100, jitter: false })).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(server.orders).toHaveLength(1);
  });

  it("HTTP 422 is a definitive failure", async () => {
    server.plan.push(422);
    const op = fetchGuard({ retry: true }).create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toMatchObject({ status: 422 });
    expect(op.status).toBe("failed");
    expect(server.posts.length).toBe(1);
  });

  it("HTTP 503 is uncertain", async () => {
    server.plan.push(503);
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
    return createOrynth({ idempotencyHeader: "X-Idempotency-Key" }).define({
      name: "create-order",
      execute: async ({ input, headers }: ExecuteContext<OrderInput>) =>
        (await client.post<Order>("/orders", input, { headers })).data,
      reconcile: async ({ idempotencyKey }: ReconcileContext<OrderInput>) =>
        (await client.get<ReconcileResult<Order>>(`/orders/by-key/${encodeURIComponent(idempotencyKey)}`)).data,
    });
  }

  it("creates an order and sends the configured idempotency header", async () => {
    const op = axiosGuard().create({ productId: "123", quantity: 2 });
    await expect(op.run()).resolves.toEqual({ id: "order-1", productId: "123", quantity: 2 });
    expect(server.posts.map((post) => post.key)).toEqual([op.idempotencyKey]);
  });

  it("server commits, connection drops: uncertain, then reconciled without a duplicate", async () => {
    server.plan.push("drop-after-commit");
    const op = axiosGuard().create({ productId: "123", quantity: 2 });

    const error = await op.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OperationUncertainError);
    expect((error as Error).cause).toMatchObject({ isAxiosError: true, code: "ECONNRESET" });

    await expect(op.reconcile()).resolves.toMatchObject({ status: "succeeded", result: { id: "order-1" } });
    expect(server.posts.length).toBe(1);
  });

  it("a client timeout is uncertain", async () => {
    server.plan.push("slow");
    const op = axiosGuard(50).create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toBeInstanceOf(OperationUncertainError);
    expect(op.status).toBe("uncertain");
  });

  it("HTTP 422 is a definitive failure, classified from error.response.status", async () => {
    server.plan.push(422);
    const op = axiosGuard().create({ productId: "123", quantity: 1 });
    await expect(op.run()).rejects.toMatchObject({ isAxiosError: true, response: { status: 422 } });
    expect(op.status).toBe("failed");
  });
});
