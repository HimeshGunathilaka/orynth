import { afterEach, describe, expect, it, vi } from "vitest";
import { createMutationGuard, MutationGuardError, type ExecuteContext } from "../src/index.js";
import { generateId } from "../src/id.js";
import { connectionReset, HttpError } from "./helpers.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("operation identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives every new operation its own ID and idempotency key", () => {
    const guard = createMutationGuard();
    const createOrder = guard.define({ name: "create-order", execute: async () => "ok" });

    const input = { productId: "123", quantity: 2 };
    const a = createOrder.create(input);
    const b = createOrder.create(input);

    expect(a.id).toMatch(UUID_V4);
    expect(a.idempotencyKey).toMatch(UUID_V4);
    expect(a.id).not.toBe(a.idempotencyKey);
    // Identical payloads are still separate intentional operations.
    expect(b.id).not.toBe(a.id);
    expect(b.idempotencyKey).not.toBe(a.idempotencyKey);
  });

  it("keeps the ID, idempotency key and input across automatic and manual retries", async () => {
    const calls: ExecuteContext<{ n: number }>[] = [];
    const guard = createMutationGuard();
    const def = guard.define({
      name: "op",
      retry: { attempts: 2, delay: 0 },
      execute: async (ctx: ExecuteContext<{ n: number }>) => {
        calls.push(ctx);
        if (calls.length < 4) throw connectionReset();
        return "done";
      },
    });

    const op = def.create({ n: 1 });
    await expect(op.run()).rejects.toThrow(); // two attempts, both uncertain
    await expect(op.retry()).resolves.toBe("done"); // two more attempts

    expect(calls).toHaveLength(4);
    for (const ctx of calls) {
      expect(ctx.operationId).toBe(op.id);
      expect(ctx.idempotencyKey).toBe(op.idempotencyKey);
      expect(ctx.input).toBe(op.input);
    }
    expect(calls.map((ctx) => ctx.attempt)).toEqual([1, 2, 3, 4]);
  });

  it("accepts a custom ID and idempotency key", async () => {
    const execute = vi.fn(async ({ idempotencyKey }: ExecuteContext<unknown>) => idempotencyKey);
    const def = createMutationGuard().define({ name: "op", execute });

    const op = def.create(undefined, { id: "checkout-42", idempotencyKey: "cart-42-v1" });

    expect(op.id).toBe("checkout-42");
    await expect(op.run()).resolves.toBe("cart-42-v1");
  });

  it("rejects invalid custom identifiers", () => {
    const def = createMutationGuard().define({ name: "op", execute: async () => 1 });
    expect(() => def.create(undefined, { id: "" })).toThrow(TypeError);
    expect(() => def.create(undefined, { idempotencyKey: 42 as never })).toThrow(TypeError);
  });

  it("refuses a second live operation with the same ID", async () => {
    const def = createMutationGuard().define({
      name: "op",
      execute: async () => {
        throw connectionReset();
      },
    });
    const first = def.create(undefined, { id: "same" });
    const second = def.create(undefined, { id: "same" }); // not active yet, so allowed

    await expect(first.run()).rejects.toThrow(); // now uncertain, i.e. active
    expect(() => def.create(undefined, { id: "same" })).toThrow(MutationGuardError);
    await expect(second.run()).rejects.toThrow(/already active/);
  });

  it("sends the key in the default Idempotency-Key header", async () => {
    const def = createMutationGuard().define({
      name: "op",
      execute: async ({ headers }) => headers,
    });
    const op = def.create();
    await expect(op.run()).resolves.toEqual({ "Idempotency-Key": op.idempotencyKey });
  });

  it("uses a configurable header name, per guard and per definition", async () => {
    const guard = createMutationGuard({ idempotencyHeader: "X-Idempotency-Key" });
    const a = guard.define({ name: "a", execute: async ({ headers }) => headers });
    const b = guard.define({ name: "b", idempotencyHeader: "X-Request-Id", execute: async ({ headers }) => headers });

    const opA = a.create();
    const opB = b.create();
    await expect(opA.run()).resolves.toEqual({ "X-Idempotency-Key": opA.idempotencyKey });
    await expect(opB.run()).resolves.toEqual({ "X-Request-Id": opB.idempotencyKey });
    expect(() => createMutationGuard({ idempotencyHeader: "Bad Header" })).toThrow(TypeError);
  });

  it("does not derive keys from the payload when a failed operation is recreated", async () => {
    const keys: string[] = [];
    const def = createMutationGuard().define({
      name: "op",
      execute: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        throw new HttpError(400);
      },
    });
    await expect(def.create({ same: true }).run()).rejects.toThrow();
    await expect(def.create({ same: true }).run()).rejects.toThrow();
    expect(new Set(keys).size).toBe(2);
  });

  describe("generateId", () => {
    it("falls back to getRandomValues when randomUUID is unavailable", () => {
      const { crypto } = globalThis;
      const getRandomValues = vi.fn((bytes: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(bytes));
      vi.stubGlobal("crypto", { getRandomValues });
      const ids = new Set(Array.from({ length: 100 }, generateId));
      expect(ids.size).toBe(100);
      for (const id of ids) expect(id).toMatch(UUID_V4);
      expect(getRandomValues).toHaveBeenCalledTimes(100);
    });

    it("still produces v4 UUIDs without any crypto API", () => {
      vi.stubGlobal("crypto", undefined);
      expect(generateId()).toMatch(UUID_V4);
    });
  });
});
