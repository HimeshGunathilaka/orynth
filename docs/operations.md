# Operations

Creating and running operations, their states, and what happens when the same operation is called twice or the user clicks twice.

## Running operations

`define()` describes a kind of mutation once. `create()` starts a new logical operation, and `run()` executes it:

```ts
const operation = createOrder.create(input); // new ID, new idempotency key
operation.id; // "4f9c…"
operation.idempotencyKey; // "b1e2…" — random, never derived from the input
operation.status; // "created"

const order = await operation.run();
operation.status; // "succeeded"
operation.state.result; // the order
```

Calling `create()` twice with the same input makes two operations, because the user did two things. Use the same handle for a retry; use `create()` for a new intent.

Each operation moves through these states:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/lifecycle-dark.png">
    <img alt="Operation states: created moves to pending with run(). From pending, a response leads to succeeded, a network error, timeout, 408, 409 or 5xx to uncertain, and a definitive error to failed. retry() goes from uncertain or failed back to pending. reconcile() goes from uncertain to recovering, which ends in succeeded when the backend completed it, failed when it did not, or back to uncertain when it is still unknown." src="images/lifecycle-light.png" width="860">
  </picture>
</p>

Any other transition throws `InvalidTransitionError`. Both the transitions and `run()` depend on the current state:

| State | `run()` | `retry()` | `reconcile()` |
| --- | --- | --- | --- |
| `created` | executes | executes | throws `InvalidTransitionError` |
| `pending` / `recovering` | [concurrency strategy](#duplicate-execution-prevention) | concurrency strategy | joins a reconciliation; rejects during a request |
| `succeeded` | returns the stored result | returns the stored result | returns `{ status: "succeeded", result }` |
| `failed` | rejects with the stored error | executes again, [if safe](retries.md#when-orynth-refuses-to-resend) | returns `{ status: "failed", error }` |
| `uncertain` | rejects with `OperationUncertainError` | executes again, [if safe](retries.md#when-orynth-refuses-to-resend) | asks the backend |

Subscribe to state changes, for example to update UI:

```ts
const unsubscribe = operation.subscribe((state) => {
  render(state.status, state.result, state.error);
});
```

Listeners are called synchronously after every change with an immutable snapshot. A listener that throws doesn't affect the operation; the error goes to `reportError` (browsers, Deno) or `console.error` (Node). `operation.state` always returns the latest snapshot, so `subscribe` and `state` work directly with `useSyncExternalStore` and similar store APIs.

## Duplicate execution prevention

Protection is scoped to an operation, not to its payload. Two operations with identical input run independently. Calling `run()` or `retry()` on an operation that is already executing applies its `concurrency` strategy:

| Strategy | Duplicate call |
| --- | --- |
| `join` (default) | Returns the in-flight promise. Every caller gets the same result. |
| `reject` | Rejects with `OperationInProgressError`. |
| `ignore` | Resolves with `undefined` and does nothing. |
| `queue` | Waits until the current execution settles, then proceeds based on the new state. |

```ts
const submitPayment = orynth.define({ name: "submit-payment", concurrency: "reject", execute });

const payment = submitPayment.create(details);
button.onclick = () => payment.run().then(showReceipt, showError); // second click → OperationInProgressError
```

A succeeded operation never executes again, whatever the strategy: `run()` returns the stored result. `join` and `queue` callers that arrive during a `reconcile()` wait for it, so a `retry()` queued behind a reconciliation that finds the order does nothing.

## Double clicks and user intent

Protection works per operation, so a click handler that calls `create()` on every click gets none: each click starts a new operation with a new idempotency key. Mutation libraries that deduplicate nothing behave the same way. Tie the operation to the user's intent instead, such as a checkout or form ID, with `getOrCreate()`:

```ts
const restored = createOrder.restore(); // at startup

async function placeOrder(checkoutId: string, input: OrderInput) {
  await restored; // an order left over from a reload is found, not created again
  return createOrder.getOrCreate(checkoutId, input).run(); // a second click joins the first
}
```

`definition.getOrCreate(id, input)` returns the operation the instance tracks under `id`, or creates one with `id` as both its ID and its idempotency key:

| The checkout's operation is… | `getOrCreate(checkoutId, input)` | Then `run()` |
| --- | --- | --- |
| not tracked | creates it, with `checkoutId` as its key | sends it |
| in flight: a double click, another component | returns it | joins the request in flight |
| `uncertain`: a timeout or a lost response | returns it, with the same key | rejects with `OperationUncertainError`: reconcile it |
| restored after a reload | returns it, with the same key | rejects with `OperationUncertainError`: reconcile it |
| tracked with different input: the quantity changed | throws `OperationConflictError`, and nothing is sent | |
| resolved, and its record deleted | creates a new operation with the same key | sends it again; the backend returns the original order |

- **Input** is compared with the input as first sent, the same check `retry()` makes, so editing the submitted form object counts as a change. A new intent needs a new ID. A restored operation whose input wasn't persisted (`persistInput`) has nothing to compare, so it's returned; it can only be reconciled.
- **A deliberate second purchase** gets a fresh checkout ID. Rotate it once the order is confirmed.
- **The key** is the ID unless you pass one: `getOrCreate(id, input, { idempotencyKey })`, for example when the backend expects UUIDs. If the tracked operation has another key, `getOrCreate()` throws `OperationConflictError`.
- **An ID only protects while its operation is tracked.** Once the operation resolves and its record is deleted, the ID is free, and `getOrCreate()` starts a new operation under the same key. From then on the backend's key retention prevents a second order. A reused key keeps the expiry of its first use in this instance, so the new operation isn't resent after the backend may have forgotten it. If the key may have been sent in an earlier session, pass when the backend forgets it: `getOrCreate(id, input, { expiresAt: checkout.startedAt + KEY_TTL })`.
- **Await `restore()` first.** Before it, an operation stored by an earlier page load isn't tracked yet, so `getOrCreate()` creates a new one. That one is never sent: `run()` finds the stored record and rejects with `OperationConflictError`.
- **Call `run()` right away**, as a click handler does. An operation is tracked once it starts, so two handles that `getOrCreate()` returns before either runs are separate: the first to run sends, and the other rejects because the ID is already active.

`getOrCreate()` is `get(id) ?? create(input, { id, idempotencyKey: id })` plus the input check. `definition.get(id)` alone looks up the tracked operation without creating one, for example to decide whether a checkout page shows **Place order** or **Check order status**. [Recipes](recipes.md) shows both in an app.

## TypeScript

Annotate the execute context and the input and result types are inferred everywhere:

```ts
const createOrder = orynth.define({
  name: "create-order",
  execute: async ({ input }: ExecuteContext<OrderInput>): Promise<Order> => { /* … */ },
});

const operation = createOrder.create({ productId: "123", quantity: 2 }); // Operation<OrderInput, Order>
const order = await operation.run(); // Order
createOrder.create({ productId: "123" }); // ✗ type error: quantity is missing
```

Or pass the types explicitly: `orynth.define<OrderInput, Order>({ … })`.

- The `reconcile` function's `result` is checked against the result type.
- Operations without input (`unknown` or `void`) can be created with `create()`.
- With `concurrency: "ignore"`, `run()` returns `Promise<Result | undefined>`, because a duplicate call resolves with `undefined`. The same applies when the strategy is a variable of type `ConcurrencyStrategy`.
- `orynth.restore()` returns `Operation[]` (untyped). Use `definition.restore()` for typed operations.
- `operation.input` is `Input | undefined`, because a restored operation has no input unless it was persisted.
