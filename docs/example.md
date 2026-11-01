# Example: the order that was created but never confirmed

The full story, from a lost response to a confirmed order with no duplicate.

**Backend requirements.** `POST /api/orders` stores the `Idempotency-Key` with the order and returns the same order if the key is seen again. `GET /api/orders/by-key/:key` returns `{ status: "succeeded", result: order }` or `{ status: "not-found" }`.

```ts
// orders.ts
import { createOrynth, OperationUncertainError, type ExecuteContext } from "orynth";
import { indexedDBStorage } from "orynth/storage";

type OrderInput = { productId: string; quantity: number };
type Order = { id: string; productId: string; quantity: number };

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export const orynth = createOrynth({ storage: indexedDBStorage() });

export const createOrder = orynth.define({
  name: "create-order",
  persistInput: true, // allows an explicit retry after a reload
  execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new HttpError(response.status);
    return (await response.json()) as Order;
  },
  reconcile: async ({ idempotencyKey }) => {
    const response = await fetch(`/api/orders/by-key/${idempotencyKey}`);
    if (!response.ok) return { status: "unknown" };
    return response.json();
  },
});

const restored = createOrder.restore();

export async function placeOrder(checkoutId: string, input: OrderInput): Promise<Order | undefined> {
  await restored;
  const operation = createOrder.getOrCreate(checkoutId, input);
  try {
    return await operation.run();
  } catch (error) {
    if (!(error instanceof OperationUncertainError)) throw error; // a real failure, e.g. HTTP 422
    // ❶ The connection dropped after the server created the order.
    const outcome = await operation.reconcile({ attempts: 3, delay: 1000 });
    // ❷ The backend confirms it: no second order is created.
    if (outcome.status === "succeeded") return outcome.result;
    // ❸ Still unknown: the operation stays uncertain and stored; it's checked again on next start.
    return undefined;
  }
}
```

What happens:

1. `getOrCreate()` creates the operation with the checkout ID `b1e2…` as both ID and key. `run()` saves a `pending` record to IndexedDB, then sends `POST /api/orders` with `Idempotency-Key: b1e2…`.
2. The server creates order `order-1`. The connection drops before the response arrives, so `fetch` throws `TypeError: Failed to fetch`.
3. The operation becomes `uncertain`, not `failed`, and `run()` rejects with `OperationUncertainError`. The app does not tell the user the order failed.
4. `reconcile()` calls `GET /api/orders/by-key/b1e2…`, which returns `order-1`. The operation becomes `succeeded` with `result: order-1`, and its record is deleted. One order exists.

If the tab is closed between steps 2 and 4, the record survives. On the next start:

```ts
// app startup
const [operation] = await createOrder.restore(); // same ID 4f9c…, same key b1e2…, status "uncertain"
await operation?.run(); // ✗ rejects with OperationUncertainError: nothing is resubmitted
const outcome = await operation?.reconcile(); // { status: "succeeded", result: order-1 }
```

A `not-found` result leaves the operation uncertain. If the application explicitly chooses to retry within the key retention window, `operation.retry()` resends the stored input with the same key `b1e2…`, so even if the first request had landed after all, the backend would return `order-1` instead of creating `order-2`.
