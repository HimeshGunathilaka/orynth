# mutation-guard

Client-side reliability for mutations. MutationGuard gives each operation a stable identity and idempotency key, stops it from running twice by accident, retries it with the same key, and helps you find out what happened when a request's outcome is unknown.

It works with `fetch`, Axios, or any async function. It has no runtime dependencies and needs no framework.

```ts
const operation = createOrder.create({ productId: "123", quantity: 2 });
const order = await operation.run();
```

- [What it solves](#what-it-solves)
- [How it differs from retry libraries](#how-it-differs-from-retry-libraries)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Running operations](#running-operations)
- [Uncertain vs. failed](#uncertain-vs-failed)
- [Duplicate execution prevention](#duplicate-execution-prevention)
- [Retries](#retries)
- [Fetch](#fetch) · [Axios](#axios)
- [Persistent storage](#persistent-storage)
- [Recovery after a reload](#recovery-after-a-reload)
- [Backend reconciliation](#backend-reconciliation)
- [Complete example: the order that was created but never confirmed](#complete-example-the-order-that-was-created-but-never-confirmed)
- [TypeScript](#typescript)
- [Custom storage adapters](#custom-storage-adapters)
- [API reference](#api-reference)
- [Limitations and backend requirements](#limitations-and-backend-requirements)

## What it solves

A user clicks "Place order". The request reaches your server and the order is created, but the connection drops before the response arrives. The client sees a network error.

What should the app do next?

- **Report a failure?** The order exists. The user will try again and be charged twice.
- **Retry automatically?** Without an idempotency key, the server creates a second order.
- **Retry with a new key?** Same result. A new key means a new operation to the server.
- **Reload the page?** The app has forgotten the request was ever made.

MutationGuard handles each of these:

1. Every operation gets an ID and an idempotency key when it is **created**, and keeps them for every retry.
2. A network error or timeout makes the operation **`uncertain`**, which is different from **`failed`**.
3. An uncertain operation is **never resubmitted automatically**. You ask your backend what happened (`reconcile()`).
4. Unresolved operations can be **persisted** (IndexedDB) and **restored** after a reload or browser restart, with their original identity.

## How it differs from retry libraries

Retry libraries such as `p-retry` or `axios-retry` run a function again until it succeeds. That is fine for reads, but for writes they leave the hard questions unanswered:

| | Retry library | MutationGuard |
| --- | --- | --- |
| Identity across retries | None. Each attempt is just another call | One operation ID and idempotency key for every attempt |
| Timeout or dropped connection | Treated as a failure to retry | Treated as an **unknown outcome** (`uncertain`) |
| Double clicks / concurrent calls | Each call runs | Joined, rejected, ignored or queued per operation |
| Page reload mid-request | Lost | Restored with the same key; never auto-resubmitted |
| "Did it actually happen?" | Not addressed | `reconcile()` asks your backend |

MutationGuard is not an HTTP client and not server middleware. You keep your HTTP client and state management, and your backend remains the source of truth.

## Installation

```sh
npm install mutation-guard
```

Requires an ES2022 runtime: current browsers, Node.js 18+, Deno or Bun. Ships ESM and CommonJS builds with TypeScript declarations.

## Quick start

```ts
import { createMutationGuard } from "mutation-guard";

const guard = createMutationGuard();

const createOrder = guard.define({
  name: "create-order",
  execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers }, // adds Idempotency-Key
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new HttpError(response.status);
    return (await response.json()) as Order;
  },
  reconcile: async ({ idempotencyKey }) => {
    const response = await fetch(`/api/orders/by-key/${idempotencyKey}`);
    if (!response.ok) return { status: "unknown" };
    return response.json(); // { status: "succeeded", result } | { status: "not-found" } | ...
  },
});

const operation = createOrder.create({ productId: "123", quantity: 2 });
const order = await operation.run();
```

`HttpError` here is your own error class with a `status` property; see [Uncertain vs. failed](#uncertain-vs-failed).

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

```
created ──run()──▶ pending ──▶ succeeded
                      │
                      ├──▶ failed ──retry()──▶ pending
                      │
                      └──▶ uncertain ──reconcile()──▶ recovering ──▶ succeeded | failed
                               │                          │
                               └──retry()──▶ pending      └──▶ uncertain (still unknown)
```

Any other transition throws `InvalidTransitionError`. Both the transitions and `run()` depend on the current state:

| State | `run()` | `retry()` | `reconcile()` |
| --- | --- | --- | --- |
| `created` | executes | executes | throws `InvalidTransitionError` |
| `pending` / `recovering` | [concurrency strategy](#duplicate-execution-prevention) | concurrency strategy | joins a reconciliation; rejects during a request |
| `succeeded` | returns the stored result | returns the stored result | returns `{ status: "succeeded", result }` |
| `failed` | rejects with the stored error | executes again | returns `{ status: "failed", error }` |
| `uncertain` | rejects with `OperationUncertainError` | executes again | asks the backend |

Subscribe to state changes, for example to update UI:

```ts
const unsubscribe = operation.subscribe((state) => {
  render(state.status, state.result, state.error);
});
```

Listeners are called synchronously after every change with an immutable snapshot. A listener that throws doesn't affect the operation; the error goes to `reportError` (browsers, Deno) or `console.error` (Node). `operation.state` always returns the latest snapshot, so `subscribe` and `state` work directly with `useSyncExternalStore` and similar store APIs.

## Uncertain vs. failed

When `execute` throws, MutationGuard decides whether the backend might still have completed the operation:

- **`uncertain`**: the request may have been processed. `run()` rejects with `OperationUncertainError` (the original error is its `cause`).
- **`failed`**: the backend definitively did not complete it. `run()` rejects with your original error.

```ts
try {
  await operation.run();
} catch (error) {
  if (error instanceof OperationUncertainError) {
    showMessage("We couldn't confirm your order. Checking…");
    await operation.reconcile();
  } else {
    showMessage("Your order was not placed.");
  }
}
```

The default classifier, `isUncertainError`, treats these as **uncertain**:

- network errors from `fetch` in Node, Chromium, Firefox and Safari
- `TimeoutError` and `AbortError` (for example from `AbortSignal.timeout()`), and Axios cancellations
- dropped connections (`ECONNRESET`, `UND_ERR_SOCKET`, Axios `ECONNABORTED` / `ERR_NETWORK`, …)
- Axios errors without a response
- HTTP **408** and **5xx** (a 500 may arrive after the server committed), and status **0**, which XHR-based clients such as Angular's `HttpClient` use for network failures
- an `OperationUncertainError` from a guarded operation called inside `execute`

It follows `error.cause` chains, so wrapped errors are classified by what they wrap. Everything else is a **failure**: HTTP 4xx, refused connections and DNS failures (the request never left), **and any error it doesn't recognize**. Errors your own code throws after reading a response are treated as the server's answer. If you use a transport whose network errors look different, add them with `isUncertain` (below).

It reads HTTP statuses from `error.status`, `error.statusCode` or `error.response.status`, so throw an error carrying the status:

```ts
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}
```

Use your own rules if your backend differs:

```ts
import { isUncertainError } from "mutation-guard";

guard.define({
  name: "charge",
  execute,
  // A 409 from this API means "a request with this key is still being processed".
  isUncertain: (error) => (error instanceof HttpError && error.status === 409) || isUncertainError(error),
});
```

## Duplicate execution prevention

Protection is scoped to an operation, not to its payload. Two operations with identical input run independently. Calling `run()` or `retry()` on an operation that is already executing applies its `concurrency` strategy:

| Strategy | Duplicate call |
| --- | --- |
| `join` (default) | Returns the in-flight promise. Every caller gets the same result. |
| `reject` | Rejects with `OperationInProgressError`. |
| `ignore` | Resolves with `undefined` and does nothing. |
| `queue` | Waits until the current execution settles, then proceeds based on the new state. |

```ts
const submitPayment = guard.define({ name: "submit-payment", concurrency: "reject", execute });

const payment = submitPayment.create(details);
button.onclick = () => payment.run().then(showReceipt, showError); // second click → OperationInProgressError
```

A succeeded operation never executes again, whatever the strategy: `run()` returns the stored result. `join` and `queue` callers that arrive during a `reconcile()` wait for it, so a `retry()` queued behind a reconciliation that finds the order does nothing.

## Retries

**Automatic retries are off by default.** Resending a mutation is only safe if your backend honors the idempotency key. Otherwise, a retry after a dropped connection creates a duplicate. Turn them on once that's true:

```ts
const createOrder = guard.define({
  name: "create-order",
  execute,
  retry: {
    attempts: 3, // per run() or retry() call, including the first. Default 3
    delay: 1000, // before the 2nd attempt. Default 1000 ms
    factor: 2, // exponential backoff. Default 2
    maxDelay: 30_000, // cap. Default 30 s
    jitter: true, // randomize each delay to 50–100%. Default true
  },
});
```

`retry: true` uses those defaults; `retry: false` disables retries. Every attempt reuses the operation ID, idempotency key and input. The state stays `pending` between attempts, with `state.error` holding the last error.

By default only **uncertain** outcomes are retried, never definitive failures. Use `shouldRetry` to change that:

```ts
retry: {
  attempts: 5,
  // Rate limiting is safe to retry: the server did not process the request.
  shouldRetry: (error, { uncertain }) =>
    uncertain || (error instanceof HttpError && error.status === 429),
},
```

**Manual retry** executes a `failed` or `uncertain` operation again with the same identity, and gets a fresh automatic-retry budget:

```ts
await operation.retry();
```

For an `uncertain` operation, prefer `reconcile()` first. `retry()` is how you resubmit once you've decided it is safe.

## Fetch

`context.headers` is `{ [idempotencyHeader]: idempotencyKey }`, ready to spread:

```ts
execute: async ({ input, headers }: ExecuteContext<OrderInput>) => {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000), // a timeout makes the outcome uncertain, not failed
  });
  if (!response.ok) throw new HttpError(response.status);
  return (await response.json()) as Order;
},
```

The header name defaults to `Idempotency-Key`. Change it for the whole guard or for one definition:

```ts
const guard = createMutationGuard({ idempotencyHeader: "X-Idempotency-Key" });
guard.define({ name: "legacy-import", idempotencyHeader: "X-Request-Id", execute });
```

To send the key in some other form (a body field, a query parameter, a prefixed value), use `context.idempotencyKey` directly. MutationGuard never sends anything itself.

## Axios

The same interface works with Axios, with no adapter or interceptor needed:

```ts
const api = axios.create({ baseURL: "/api", timeout: 10_000 });

const createOrder = guard.define({
  name: "create-order",
  execute: async ({ input, headers }: ExecuteContext<OrderInput>) =>
    (await api.post<Order>("/orders", input, { headers })).data,
  reconcile: async ({ idempotencyKey }) =>
    (await api.get<ReconcileResult<Order>>(`/orders/by-key/${idempotencyKey}`)).data,
});
```

Axios errors are classified out of the box: 4xx responses are failures, while timeouts, dropped connections and 5xx responses are uncertain.

## Persistent storage

By default, operations are tracked in memory, which is enough for duplicate protection and retries within one page load. To survive reloads and browser restarts, use IndexedDB:

```ts
import { createMutationGuard } from "mutation-guard";
import { indexedDBStorage } from "mutation-guard/storage";

const guard = createMutationGuard({
  storage: indexedDBStorage(), // database "mutation-guard"; pass { databaseName } to change it
});
```

What gets stored:

- A record is written **before** each operation's first request is sent: ID, idempotency key, definition name, status, attempt count, timestamps and the last error's name and message.
- The **input is not stored** unless the definition opts in with `persistInput: true`. Without it, a restored operation can be reconciled but not retried. Only opt in for inputs you are comfortable keeping on the device, and make sure they're structured-cloneable.
- **Results are never stored.**
- A record is **deleted once the operation resolves** (`succeeded` or `failed`). Only unresolved operations remain.
- Records **expire** `ttl` after the operation's request was last sent (default 24 hours, matching common idempotency-key retention). `restore()` deletes expired records. Use `ttl: Infinity` to keep them until they resolve.

How storage failures are handled:

- If the record **cannot be saved before the request**, `run()` rejects with `StorageError` and **nothing is sent**. Sending a request that couldn't be recovered would defeat the point. The operation stays in its previous state, so you can call `run()` again.
- If a **later write** fails, the in-memory state is still updated and the error goes to `onStorageError` (default: `console.error`). The stored record is then older than the real state, which is safe: on restore it comes back as `uncertain` and reconciliation settles it.

```ts
createMutationGuard({
  storage: indexedDBStorage(),
  onStorageError: (error) => reportToMonitoring(error), // error.operationId, error.cause
});
```

## Recovery after a reload

Define your operations, then call `restore()` once at startup:

```ts
const guard = createMutationGuard({ storage: indexedDBStorage() });
const createOrder = guard.define({ name: "create-order", execute, reconcile });

const pending = await guard.restore();
for (const operation of pending) {
  const outcome = await operation.reconcile();
  if (outcome.status === "succeeded") notify(`Your order went through.`);
}
```

Restored operations:

- keep their **original ID and idempotency key**,
- are always **`uncertain`**, because whatever was in flight when the page closed has an unknown outcome,
- **never execute on their own**: `run()` rejects with `OperationUncertainError` until you `reconcile()` or explicitly `retry()`,
- are reconnected to definitions **by `name`**. Records whose definition isn't defined yet stay in storage for a later `restore()`.

`createOrder.restore()` restores only that definition's operations, typed with its input and result. Calling `restore()` again returns the same instances. An operation that is still running in the current page is returned as-is and is not marked uncertain.

## Backend reconciliation

MutationGuard cannot find out on its own whether your backend completed an operation. You provide a `reconcile` function that asks:

```ts
reconcile: async ({ operationId, idempotencyKey, input, headers }) => {
  const response = await fetch(`/api/orders/by-key/${idempotencyKey}`);
  if (!response.ok) return { status: "unknown" };
  return response.json();
},
```

It must resolve to one of:

| Result | Meaning | New state |
| --- | --- | --- |
| `{ status: "succeeded", result }` | The backend completed it. `result` is required; use `null` if there is none | `succeeded`, `result` stored |
| `{ status: "failed", error? }` | The backend definitively did not | `failed` |
| `{ status: "pending" }` | Still processing | `uncertain` |
| `{ status: "not-found" }` | The backend has no record of it | `uncertain` |
| `{ status: "unknown", error? }` | Can't tell right now | `uncertain` |

If `reconcile` throws (the status endpoint is down, for example) or returns anything else, including a success without `result`, the result is `{ status: "unknown", error }` and the operation stays `uncertain`. You can call `reconcile()` again later.

**`not-found` does not mean "safe to resubmit".** The request may still be in flight, the backend's read path may lag behind its write path, or the lookup may not cover every case. Resubmitting is your decision:

```ts
const outcome = await operation.reconcile();
if (outcome.status === "not-found" && backendHonorsIdempotencyKeys) {
  await operation.retry(); // same key: the backend deduplicates if the first request did land
}
```

**Polling.** Pass `attempts` to keep asking while the answer is `pending`, `not-found` or `unknown`, with the same backoff options as retries:

```ts
await operation.reconcile({ attempts: 10, delay: 2000, maxDelay: 30_000 });
```

The status stays `recovering` while polling. Concurrent `reconcile()` calls share one lookup.

The backend only knows what you send it. The idempotency key reaches it in the request header, so a status lookup keyed by idempotency key is usually the simplest. To look up by `operationId` instead, send it with the request too.

## Complete example: the order that was created but never confirmed

The full story, from a lost response to a confirmed order with no duplicate.

**Backend requirements.** `POST /api/orders` stores the `Idempotency-Key` with the order and returns the same order if the key is seen again. `GET /api/orders/by-key/:key` returns `{ status: "succeeded", result: order }` or `{ status: "not-found" }`.

```ts
// orders.ts
import { createMutationGuard, OperationUncertainError, type ExecuteContext } from "mutation-guard";
import { indexedDBStorage } from "mutation-guard/storage";

type OrderInput = { productId: string; quantity: number };
type Order = { id: string; productId: string; quantity: number };

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export const guard = createMutationGuard({ storage: indexedDBStorage() });

export const createOrder = guard.define({
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

export async function placeOrder(input: OrderInput): Promise<Order | undefined> {
  const operation = createOrder.create(input);
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

1. `create()` assigns ID `4f9c…` and key `b1e2…`. `run()` saves a `pending` record to IndexedDB, then sends `POST /api/orders` with `Idempotency-Key: b1e2…`.
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

Had the backend answered `not-found` (the request never arrived), `operation.retry()` would resend the stored input with the same key `b1e2…`, so even if the first request had landed after all, the backend would return `order-1` instead of creating `order-2`.

## TypeScript

Annotate the execute context and the input and result types are inferred everywhere:

```ts
const createOrder = guard.define({
  name: "create-order",
  execute: async ({ input }: ExecuteContext<OrderInput>): Promise<Order> => { /* … */ },
});

const operation = createOrder.create({ productId: "123", quantity: 2 }); // Operation<OrderInput, Order>
const order = await operation.run(); // Order
createOrder.create({ productId: "123" }); // ✗ type error: quantity is missing
```

Or pass the types explicitly: `guard.define<OrderInput, Order>({ … })`.

- The `reconcile` function's `result` is checked against the result type.
- Operations without input (`unknown` or `void`) can be created with `create()`.
- With `concurrency: "ignore"`, `run()` returns `Promise<Result | undefined>`, because a duplicate call resolves with `undefined`. The same applies when the strategy is a variable of type `ConcurrencyStrategy`.
- `guard.restore()` returns `Operation[]` (untyped). Use `definition.restore()` for typed operations.
- `operation.input` is `Input | undefined`, because a restored operation has no input unless it was persisted.

## Custom storage adapters

A storage adapter has three methods:

```ts
interface OperationStorage {
  set(record: OperationRecord): Promise<void>; // insert or replace by record.id
  delete(id: string): Promise<void>; // no error if missing
  list(): Promise<OperationRecord[]>; // all records
}
```

Records are plain, structured-cloneable objects (`OperationRecord`). Resolve `set` only once the record is durable, because the request is sent right after. The guard serializes writes per operation, wraps adapter errors in `StorageError`, and handles expiry itself. A missing or `null` `expiresAt` means the record never expires. `restore()` reports records with an invalid shape to `onStorageError` and skips them.

If you serialize to JSON, note that an `input` of `undefined` is dropped, so such an operation can't be retried after a restore. For example, a `localStorage` adapter:

```ts
import type { OperationRecord, OperationStorage } from "mutation-guard";

function localStorageAdapter(key = "mutation-guard"): OperationStorage {
  const read = (): Record<string, OperationRecord> => JSON.parse(localStorage.getItem(key) ?? "{}");
  const write = (records: Record<string, OperationRecord>) => localStorage.setItem(key, JSON.stringify(records));
  return {
    async set(record) {
      write({ ...read(), [record.id]: record });
    },
    async delete(id) {
      const { [id]: _removed, ...rest } = read();
      write(rest);
    },
    async list() {
      return Object.values(read());
    },
  };
}
```

`memoryStorage()` is exported too. Share one instance between two guards to simulate a restart in tests.

## API reference

### `createMutationGuard(options?)`

| Option | Default | |
| --- | --- | --- |
| `storage` | `"memory"` | `"memory"` or an `OperationStorage` such as `indexedDBStorage()` |
| `idempotencyHeader` | `"Idempotency-Key"` | Header name used for `context.headers` |
| `ttl` | 24 hours | Milliseconds before an unresolved record expires; `Infinity` to disable |
| `onStorageError` | `console.error` | Receives `StorageError`s from writes that don't block execution |

Returns a `MutationGuard`:

- **`guard.define(options)`** → `OperationDefinition`
- **`guard.restore()`** → `Promise<Operation[]>`. Loads unresolved operations of defined definitions, deletes expired records, and rejects with `StorageError` if storage can't be read.

### `guard.define(options)`

| Option | Default | |
| --- | --- | --- |
| `name` | required | Unique per guard; links stored records to this definition |
| `execute(context)` | required | Performs the mutation; throw on failure |
| `reconcile(context)` | none | Asks the backend what happened; required for `reconcile()` |
| `concurrency` | `"join"` | `"join"`, `"reject"`, `"ignore"` or `"queue"` |
| `retry` | `false` | `true`, `false` or `RetryOptions` |
| `isUncertain(error)` | `isUncertainError` | `true` if the backend may have completed the operation |
| `persistInput` | `false` | Store the input so restored operations can be retried |
| `idempotencyHeader` | guard's | Per-definition header name |
| `ttl` | guard's | Per-definition record expiry |

`ExecuteContext`: `{ input, operationId, idempotencyKey, headers, attempt }`. `attempt` counts every execution of the operation, starting at 1.

`ReconcileContext`: `{ input, operationId, idempotencyKey, headers }`. `input` is `undefined` for restored operations without a persisted input.

`RetryOptions`: `{ attempts?, delay?, factor?, maxDelay?, jitter?, shouldRetry?(error, { attempt, uncertain }) }`.

### `OperationDefinition`

- **`definition.create(input?, { id?, idempotencyKey? }?)`** → `Operation`. Starts a new logical operation. Custom IDs and keys must be unique. The guard enforces one handle per ID among the operations it knows about: `create()` throws if the ID belongs to an operation that is executing, unresolved or restored, and of two handles created with the same ID only one can run. `create()` can't see records that haven't been restored yet, so call `restore()` before creating operations whose custom IDs may already be in storage.
- **`definition.restore()`** → `Promise<Operation[]>`. Like `guard.restore()`, for this definition only.

### `Operation`

| Member | |
| --- | --- |
| `id`, `idempotencyKey`, `name`, `input` | Identity, fixed for the operation's lifetime |
| `status` | `"created"`, `"pending"`, `"uncertain"`, `"recovering"`, `"succeeded"` or `"failed"` |
| `state` | Immutable snapshot: `{ id, name, idempotencyKey, status, attempts, result?, error?, createdAt, updatedAt }` |
| `run()` | Executes; see the [state table](#running-operations) |
| `retry()` | Executes again with the same identity and input |
| `reconcile(options?)` | Asks the backend; `options`: `{ attempts?, delay?, factor?, maxDelay?, jitter? }` |
| `subscribe(listener)` | Calls `listener(state)` after every change; returns `unsubscribe` |

### Errors

All extend `MutationGuardError`:

| Error | When |
| --- | --- |
| `OperationUncertainError` | `run()`/`retry()` ended with an unknown outcome, or `run()` on an uncertain operation. `cause` is the original error. |
| `OperationInProgressError` | Duplicate call with `concurrency: "reject"`, or `reconcile()` during a request |
| `StorageError` | Storage failed. `operationId`, `cause` |
| `InvalidTransitionError` | A lifecycle transition that isn't allowed. `from`, `to` |

Invalid options throw `TypeError` or `RangeError` from `createMutationGuard()`, `define()` and `create()`.

### Other exports

- **`isUncertainError(error)`**: the default classifier.
- **`memoryStorage()`**: in-memory storage (from `mutation-guard` or `mutation-guard/storage`).
- **`indexedDBStorage({ databaseName?, indexedDB? })`**: from `mutation-guard/storage`. `indexedDB` accepts a custom `IDBFactory`, for example `fake-indexeddb` in tests.
- Types: `Operation`, `OperationDefinition`, `OperationState`, `OperationStatus`, `ExecuteContext`, `ReconcileContext`, `ReconcileResult`, `RetryOptions`, `ReconcileOptions`, `OperationStorage`, `OperationRecord`, and more.

## Limitations and backend requirements

**MutationGuard does not provide exactly-once execution, and nothing on the client can.** It gives each operation a stable identity and keeps the client from resubmitting carelessly. Real duplicate protection has to happen on the server.

What your backend needs:

- **To make retries safe, honor the idempotency key.** Store the key with the result of the first request, in the same transaction as the side effect, and return that result for repeated keys. Reject a reused key with a different payload, and answer concurrent requests with the same key with a conflict. Keep keys at least as long as the client's `ttl`. Without this, leave retries off and resolve uncertain operations through reconciliation and your users.
- **To reconcile, provide a status lookup**, ideally by idempotency key, that can tell completed operations from unknown ones.
- **Treat the backend as authoritative.** MutationGuard records what the client observed, not what happened.

Client-side limits:

- **Browser storage is local and can disappear.** IndexedDB data is per origin and per browser profile, is not synced across devices, can be cleared by the user or evicted under storage pressure, and may be unavailable or temporary in private browsing.
- **No cross-tab coordination.** Two tabs can restore and reconcile the same operation, and the last write wins in storage. With an idempotent backend this is harmless. To avoid it, run recovery in one tab at a time, for example with the Web Locks API:
  ```ts
  await navigator.locks.request("mutation-guard-recovery", async () => {
    for (const operation of await guard.restore()) await operation.reconcile();
  });
  ```
- **Final-state writes are asynchronous.** If the page closes in the instant between an operation resolving and its record being deleted, it is restored as `uncertain` and settled by reconciliation.
- **Execution can't be cancelled from outside.** Timeouts belong in your `execute` function (`AbortSignal.timeout()`, Axios `timeout`).
- **Classification is a heuristic.** The default recognizes the network errors of `fetch`, Axios and Node, but treats errors it doesn't recognize as definitive failures. Only your backend knows what its errors mean. Throw errors with an HTTP `status`, and override `isUncertain` for other transports.

## License

MIT
