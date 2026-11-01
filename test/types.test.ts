import { describe, expectTypeOf, it } from "vitest";
import {
  createOrynth,
  type ConcurrencyStrategy,
  type ExecuteContext,
  type LockManagerLike,
  type Operation,
  type OperationDefinition,
  type OperationState,
  type ReconcileResult,
} from "../src/index.js";

type OrderInput = { productId: string; quantity: number };
type Order = { id: string };

const guard = createOrynth();

// Assertions use method references so nothing executes at runtime.
describe("type inference", () => {
  it("infers input and result types from an annotated execute function", () => {
    const createOrder = guard.define({
      name: "inferred",
      execute: async ({ input }: ExecuteContext<OrderInput>): Promise<Order> => ({ id: input.productId }),
      reconcile: async ({ input }) => {
        expectTypeOf(input).toEqualTypeOf<OrderInput | undefined>();
        return { status: "succeeded", result: { id: "1" } };
      },
    });
    expectTypeOf(createOrder).toEqualTypeOf<OperationDefinition<OrderInput, Order>>();

    const op = createOrder.create({ productId: "1", quantity: 1 });
    expectTypeOf(op).toEqualTypeOf<Operation<OrderInput, Order>>();
    expectTypeOf(op.run).returns.toEqualTypeOf<Promise<Order>>();
    expectTypeOf(op.retry).returns.toEqualTypeOf<Promise<Order>>();
    expectTypeOf(op.reconcile).returns.toEqualTypeOf<Promise<ReconcileResult<Order>>>();
    expectTypeOf(op.state).toEqualTypeOf<OperationState<Order>>();
    expectTypeOf(op.state.result).toEqualTypeOf<Order | undefined>();
    expectTypeOf(createOrder.restore).returns.toEqualTypeOf<Promise<Operation<OrderInput, Order>[]>>();
    expectTypeOf(createOrder.get).returns.toEqualTypeOf<Operation<OrderInput, Order> | undefined>();

    // @ts-expect-error input is required
    createOrder.create();
    // @ts-expect-error quantity is missing
    createOrder.create({ productId: "1" });
  });

  it("accepts explicit type arguments", () => {
    const createOrder = guard.define<OrderInput, Order>({
      name: "explicit",
      execute: async ({ input, idempotencyKey, headers }) => {
        expectTypeOf(input).toEqualTypeOf<OrderInput>();
        expectTypeOf(idempotencyKey).toEqualTypeOf<string>();
        expectTypeOf(headers).toEqualTypeOf<Readonly<Record<string, string>>>();
        return { id: "1" };
      },
    });
    expectTypeOf(createOrder.create({ productId: "1", quantity: 1 }).run).returns.toEqualTypeOf<Promise<Order>>();
  });

  it("makes the input optional when the operation takes none", () => {
    const ping = guard.define({ name: "no-input", execute: async () => "pong" });
    expectTypeOf(ping.create().run).returns.toEqualTypeOf<Promise<string>>();
    const voidInput = guard.define<void, number>({ name: "void-input", execute: async () => 1 });
    voidInput.create();
  });

  it("includes undefined in the result with the ignore strategy", () => {
    const ignoring = guard.define({ name: "ignore", concurrency: "ignore", execute: async () => 1 });
    expectTypeOf(ignoring.create().run).returns.toEqualTypeOf<Promise<number | undefined>>();
    const joining = guard.define({ name: "join", concurrency: "join", execute: async () => 1 });
    expectTypeOf(joining.create().run).returns.toEqualTypeOf<Promise<number>>();
    // A strategy only known at runtime might be "ignore".
    const strategy = "join" as ConcurrencyStrategy;
    const dynamic = guard.define({ name: "dynamic", concurrency: strategy, execute: async () => 1 });
    expectTypeOf(dynamic.create().run).returns.toEqualTypeOf<Promise<number | undefined>>();
  });

  it("types reconcile results against the operation result", () => {
    guard.define({
      name: "reconcile-typed",
      execute: async (): Promise<Order> => ({ id: "1" }),
      // @ts-expect-error result must be an Order
      reconcile: async () => ({ status: "succeeded", result: 42 }),
    });
  });

  it("accepts the browser's navigator.locks", () => {
    expectTypeOf(navigator.locks).toMatchTypeOf<LockManagerLike>();
  });

  it("returns untyped operations from guard.restore()", () => {
    expectTypeOf(guard.restore).returns.toEqualTypeOf<Promise<Operation[]>>();
  });
});
