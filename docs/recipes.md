# Recipes

Application code for three common questions. The examples use this definition, with any client from [HTTP clients](http-clients.md):

```ts
import { createOrynth, OperationUncertainError, type ReconcileResult } from "orynth";
import { indexedDBStorage } from "orynth/storage";

const orynth = createOrynth({ storage: indexedDBStorage(), scope: () => session.userId });

export const orders = orynth.define<Items, Order>({
  name: "checkout",
  persistInput: true, // lets the app send a restored order again with retry()
  execute,
  reconcile,
});

export const restored = orders.restore(); // once, at startup
```

## Prevent duplicate form submissions

Disable the submit button while the request is in flight: that stops the ordinary double click. It doesn't stop the same checkout from being submitted again by:

- another button or a keyboard shortcut in a different component, with its own pending state,
- a click after a timeout, when the button is enabled again but the server may already have the order,
- the page reloaded, or the tab closed and reopened, while the request was in flight,
- a mutation library or retry wrapper calling your submit function again.

Each of these calls the submit code again, so the fix is in what that code creates:

```ts
// ✗ A new operation with a new idempotency key on every call: the backend sees separate orders.
const order = orders.create(items);

// ✓ The checkout's operation, with the checkout ID as its key, on every call.
const order = orders.getOrCreate(checkout.id, items);
```

`checkout.id` is the ID of the purchase the customer is making. Create it when checkout starts, keep it where a reload finds it (the URL, `sessionStorage`, or a server-side cart), and replace it once the order is confirmed or the customer starts another purchase. The submit handler:

```ts
async function submit(checkoutId: string, items: Items): Promise<ReconcileResult<Order>> {
  await restored;
  const order = orders.getOrCreate(checkoutId, items);
  try {
    return { status: "succeeded", result: await order.run() };
  } catch (error) {
    // The request may have reached the server: ask it before saying anything.
    if (error instanceof OperationUncertainError) return order.reconcile({ attempts: 3, delay: 1000 });
    throw error;
  }
}
```

What each repeat gets:

| The repeat | What happens |
| --- | --- |
| A double click, or a second button | It joins the request in flight. One request |
| A click after a timeout | The `uncertain` operation. Nothing is sent: `run()` rejects and the handler reconciles |
| A click after a reload | The restored operation, with the same key, reconciled the same way |
| A click after the order was confirmed, with the same checkout ID | A new operation with the same key. The backend returns the existing order |
| The quantity changed after the first submit | `OperationConflictError`, and nothing is sent. Show the pending order, or start a new checkout for the new quantity |

The last row matters most: without the input check, the second submit would quietly join the first order and show its receipt for a quantity the customer didn't ask for.

## Recover a submitted order after a page reload

When the checkout opens, look for an unresolved order before showing **Place order**, and ask the server for its receipt before offering to send anything again:

```ts
type View =
  | { show: "form" }
  | { show: "receipt"; order: Order }
  | { show: "rejected"; error: unknown } // start a new checkout
  | { show: "check-again" } // keep the checkout; don't send anything
  | { show: "send-again" }; // only now offer retry()

async function openCheckout(checkoutId: string): Promise<View> {
  await restored;
  const order = orders.get(checkoutId);
  if (!order) return { show: "form" }; // nothing was sent for this checkout

  // A request left the browser and its outcome is unknown.
  const outcome = await order.reconcile({ attempts: 3, delay: 1000 });
  switch (outcome.status) {
    case "succeeded":
      return { show: "receipt", order: outcome.result };
    case "failed":
      return { show: "rejected", error: outcome.error };
    case "not-found":
      return { show: "send-again" };
    default: // "pending" or "unknown"
      return { show: "check-again" };
  }
}

// Behind the "Send again" button, after a not-found.
const resend = (checkoutId: string) => orders.get(checkoutId)?.retry();
```

- **Only `not-found` offers to send again**, and `retry()` sends the original key, so an order that lands late is still not duplicated. It needs `persistInput: true`, and is refused once the backend may have forgotten the key (`IdempotencyKeyExpiredError`). [Retries](retries.md#when-orynth-refuses-to-resend)
- **`pending` and `unknown` don't resend.** The server is still working on it, or can't be reached. Keep the checkout and check again later.
- **`failed` means the server rejected it.** That key is used, so a corrected order needs a new checkout ID.
- **The checkout ID may be gone** if the app kept it only in memory. `restored` still resolves to every unresolved order of the signed-in user, so list them in a "previous orders" notice and handle each the same way.

## Compose with TanStack Query

TanStack Query drives the button and the order list; Orynth keeps the checkout's identity and decides whether anything is resent:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";

async function placeOrder(checkoutId: string, items: Items): Promise<Order> {
  await restored;
  const order = orders.getOrCreate(checkoutId, items);
  try {
    return await order.run();
  } catch (error) {
    if (!(error instanceof OperationUncertainError)) throw error;
    const outcome = await order.reconcile({ attempts: 3, delay: 1000 });
    if (outcome.status === "succeeded") return outcome.result;
    throw error; // still unknown: the next submit of this checkout asks again
  }
}

function PlaceOrderButton({ checkoutId, items, onConfirmed }: Props) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: ["place-order", checkoutId],
    mutationFn: (items: Items) => placeOrder(checkoutId, items),
    retry: false, // Orynth owns resending: see below
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      onConfirmed(); // e.g. start a new checkout ID
    },
  });
  return (
    <button disabled={mutation.isPending} onClick={() => mutation.mutate(items)}>
      Place order
    </button>
  );
}
```

- **Retries belong to one layer.** Mutations don't retry by default in TanStack Query 5, but a `QueryClient` with `defaultOptions.mutations.retry` would apply to this one, so set `retry: false` here. A TanStack retry calls `placeOrder` again: with `getOrCreate()` that joins the uncertain operation, which isn't resent, so it only adds delay. With `create()` inside `mutationFn`, every retry would be a new order. To resend writes, use Orynth's `retry` policy, which reuses the key and checks it hasn't expired.
- **`mutation.isPending`** disables this button. Other buttons for the same checkout have their own mutation, and `getOrCreate()` joins them all to one request.
- **Offline.** TanStack Query pauses a mutation while the browser is offline, before `mutationFn` runs, so nothing was sent and Orynth has nothing to recover. Orynth recovers the other case: a request that left the browser before the connection dropped. Paused mutations are lost on reload unless you persist them; Orynth's records survive it.
- **After a reload**, restore the checkout with the [previous recipe](#recover-a-submitted-order-after-a-page-reload) before rendering the button. Invalidate `["orders"]` when a restored order is confirmed too.
