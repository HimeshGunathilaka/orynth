# Uncertain outcomes

How a failed request is classified, and how to find out from your backend what happened to an operation whose outcome is unknown.

## Uncertain vs. failed

When `execute` throws, Orynth decides whether the backend might still have completed the operation:

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

- any `TypeError`: the Fetch standard reports every network failure as one, in every browser and runtime, including a response cut off mid-body (Firefox: "Content-Length header of network response exceeds response Body.")
- any `SyntaxError`: how `Response.json()` reports a body it can't parse. A response arrived, so the request was processed
- `TimeoutError` and `AbortError` (for example from `AbortSignal.timeout()`), and Axios cancellations
- dropped connections (`ECONNRESET`, `UND_ERR_SOCKET`, Axios `ECONNABORTED` / `ERR_NETWORK`, …)
- Axios errors without a response, and runtime messages such as "Network connection lost" (Cloudflare Workers)
- HTTP **408** and **5xx** (a 500 may arrive after the server committed), and status **0**, which XHR-based clients such as Angular's `HttpClient` use for network failures
- HTTP **409**, which the [IETF Idempotency-Key draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) uses for "a request with this key is still being processed"
- an error carrying a **2xx** status, when its transport error is uncertain: the server accepted the request and the failure came after it. Axios in Node reports a body cut off after the status as `ERR_BAD_RESPONSE`, which is uncertain. An error for a complete 2xx response, such as a GraphQL error, is still a failure
- an `OperationUncertainError` from a guarded operation called inside `execute`

It follows wrapped errors through `cause`, Apollo's and urql's `networkError`, and GraphQL's `originalError`, so Ky's `NetworkError` and ofetch's `FetchError` are judged by the runtime error they wrap. Everything else is a **failure**: HTTP 4xx, refused connections and DNS failures (the request never left), **and any other error it doesn't recognize**. Other errors your own code throws after reading a response are treated as the server's answer. Because every `TypeError` and `SyntaxError` counts as uncertain, validate input before calling `run()` rather than throwing either from `execute`. If you use a transport whose network errors look different, add them with `isUncertain` (below).

**Uncertain stays uncertain.** Once a request may have reached the backend, only a successful request or `reconcile()` settles the operation. If a later attempt fails definitively (an automatic retry gets a 429, a `retry()` after a reload finds the server down, a session expired in between), that failure says nothing about the earlier request. The operation stays `uncertain` and stored, and `run()` or `retry()` rejects with `OperationUncertainError` whose `cause` is the latest error.

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
import { isUncertainError } from "orynth";

orynth.define({
  name: "register-user",
  execute,
  // This API answers 409 for "email already registered", which is a definitive answer.
  isUncertain: (error) => !(error instanceof HttpError && error.status === 409) && isUncertainError(error),
});
```

## Backend reconciliation

Orynth cannot find out on its own whether your backend completed an operation. You provide a `reconcile` function that asks:

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

Don't call `run()`, `retry()` or `reconcile()` of the same operation from inside `reconcile`: they would wait for the reconciliation that is calling them. Return the outcome, and retry afterward.

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
