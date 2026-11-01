# HTTP clients

Orynth never sends anything itself: `execute` uses your client. Recipes for native `fetch`, Axios, Ky and ofetch, each tested against a real server with the same lost-response scenario.

## Who owns retries

One layer should resend a write. Orynth's [retry policy](retries.md) checks the key's expiry, the input and the signed-in user before every resend and counts each attempt. A client that retries on its own resends inside a single Orynth attempt, where none of that is checked. With an idempotent backend that is still harmless, but it is invisible.

| Client | Resends writes by default | In the recipe |
| --- | --- | --- |
| `fetch` | No | Nothing to do |
| Axios | No. Retries come from add-ons such as `axios-retry` | Don't attach a retry add-on to the instance that sends writes |
| Ky | Not POST. Its 2 default retries apply to GET, PUT, HEAD, DELETE, OPTIONS, TRACE and QUERY, so **PUT and DELETE writes are retried** | `retry: 0` on the write |
| ofetch | Not POST, PUT, PATCH or DELETE. With `retry: n`, on the request or the instance, it resends after 408, 409, 425, 429, 5xx, timeouts and dropped connections | `retry: 0` on the write |

Status lookups in `reconcile` are reads, so client retries there are fine.

Below the client, the platform can resend too. Chromium and Firefox resend a POST whose reused connection closed, and so does Android's HTTP stack under Expo's `fetch` ([React Native](react-native.md#the-platform-resends-on-its-own)). That's one more reason the backend must honor the key.

## Tested with your client

Each recipe below runs this release test against a local order API that honors idempotency keys ([`test/clients.test.ts`](../test/clients.test.ts), in CI on Node.js 22, 24 and 26):

| Scenario | `fetch` | Axios 1.21 | Ky 2.2 | ofetch 1.5 |
| --- | :-: | :-: | :-: | :-: |
| The server commits the order and the connection drops: `uncertain`. After a reload, `restore()` and `getOrCreate()` find the operation with its original key, and `reconcile()` confirms one order with no new request | ✓ | ✓ | ✓ | ✓ |
| HTTP 422: `failed`, sent once | ✓ | ✓ | ✓ | ✓ |
| `retry()` after the dropped response sends the original key, and the server returns the original order | ✓ | ✓ | ✓ | ✓ |
| A 201 whose body is cut off: `uncertain`, then reconciled | ✓ | ✓¹ | ✓ | ✓ |
| Client timeout: `uncertain` | ✓ | ✓ | ✓ | ✓ |
| Connection refused: `failed`, nothing was sent | ✓ | ✓ | ✓ | ✓ |

¹ Axios in Node reports a cut-off body as `ERR_BAD_RESPONSE` with the 201 attached. Orynth 1.0 classified it as a failure; 1.1 classifies it as uncertain.

The same file checks the other half of the retry table: with retries switched on for POST, Ky and ofetch resend a dropped request with the same key inside one Orynth attempt.

The same recipes were also run in Release builds of a React Native app on iOS and Android: see [React Native](react-native.md).

## Fetch

`context.headers` is `{ [idempotencyHeader]: idempotencyKey }`, ready to spread. `fetch` resolves for every HTTP status, so throw an error that carries it:

```ts
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const createOrder = orynth.define({
  name: "create-order",
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
  reconcile: async ({ idempotencyKey }) => {
    const response = await fetch(`/api/orders/by-key/${encodeURIComponent(idempotencyKey)}`);
    if (!response.ok) return { status: "unknown" };
    return (await response.json()) as ReconcileResult<Order>;
  },
});
```

## Axios

No adapter or interceptor needed. Axios throws for non-2xx statuses, and Orynth reads `error.response.status`:

```ts
const api = axios.create({
  baseURL: "/api",
  timeout: 10_000,
  // Strict JSON: a body cut off mid-response throws instead of resolving with partial text.
  responseType: "json",
  transitional: { silentJSONParsing: false },
});

const createOrder = orynth.define({
  name: "create-order",
  execute: async ({ input, headers }: ExecuteContext<OrderInput>) =>
    (await api.post<Order>("/orders", input, { headers })).data,
  reconcile: async ({ idempotencyKey }) =>
    (await api.get<ReconcileResult<Order>>(`/orders/by-key/${encodeURIComponent(idempotencyKey)}`)).data,
});
```

4xx responses are failures. Timeouts, dropped connections, bodies cut off mid-stream and 5xx responses are uncertain. Keep `silentJSONParsing: false`: by default Axios returns a body it can't parse as text, so when a response is cut off but delivered as complete, as React Native on iOS does, the operation would succeed with a fragment as its result.

## Ky

```ts
import ky from "ky";

const api = ky.create({ baseUrl: "/api/", timeout: 10_000 });

const createOrder = orynth.define({
  name: "create-order",
  execute: ({ input, headers }: ExecuteContext<OrderInput>) =>
    // Ky doesn't retry POST by default; `retry: 0` keeps it that way if the instance's defaults change.
    api.post("orders", { json: input, headers, retry: 0 }).json<Order>(),
  reconcile: ({ idempotencyKey }) =>
    api.get(`orders/by-key/${encodeURIComponent(idempotencyKey)}`).json<ReconcileResult<Order>>(),
});
```

Ky separates HTTP errors from network errors, and Orynth follows both. `HTTPError` carries `response.status`: 4xx is a failure, 5xx uncertain. `NetworkError` and `TimeoutError` keep the runtime's error as `cause`, so a refused connection is a failure and a dropped one is uncertain. Ky reads the error body for you: use `error.data` to show the server's message, because `error.response.json()` no longer works.

## ofetch

```ts
import { ofetch } from "ofetch";

// Strict JSON: ofetch's default parser returns a body it can't parse as text, e.g. one cut off mid-response.
const api = ofetch.create({ baseURL: "/api", timeout: 10_000, parseResponse: JSON.parse });

const createOrder = orynth.define({
  name: "create-order",
  execute: ({ input, headers }: ExecuteContext<OrderInput>) =>
    // ofetch doesn't retry POST by default; `retry: 0` keeps it that way if the instance's defaults change.
    api<Order>("/orders", { method: "POST", body: input, headers, retry: 0 }),
  reconcile: ({ idempotencyKey }) => api<ReconcileResult<Order>>(`/orders/by-key/${encodeURIComponent(idempotencyKey)}`),
});
```

`FetchError` carries `status` for HTTP errors, and the server's body as `error.data`. For network errors it has no status and keeps the runtime's error as `cause`. Its `timeout` option ends a request with a `TimeoutError`, which is uncertain. Setting `retry` on the instance, for example `ofetch.create({ retry: 2 })`, applies to POST as well, so keep `retry: 0` on writes.

## Header name and format

The header name defaults to `Idempotency-Key`. Change it for the whole instance or for one definition:

```ts
const orynth = createOrynth({ idempotencyHeader: "X-Idempotency-Key" });
orynth.define({ name: "legacy-import", idempotencyHeader: "X-Request-Id", execute });
```

To send the key in some other form (a body field, a query parameter, a prefixed value), use `context.idempotencyKey` directly.

## Check that the key reaches your backend

Orynth can only hand the key to your client. Check that it arrives:

- **In the browser.** Open the request in the dev tools' Network panel. Its request headers should include `Idempotency-Key` with the operation's key (the checkout ID when you use `getOrCreate()`).
- **Across origins.** A cross-origin API must allow the header in its CORS preflight response: `Access-Control-Allow-Headers: Content-Type, Idempotency-Key`. Otherwise the browser never sends the request, `fetch` throws a `TypeError`, and the operation stays `uncertain` for an order that never left.
- **Behind proxies.** API gateways, CDNs and proxies can drop headers they don't know. Log the key where the order is created, not only at the edge.
- **End to end.** Send the same order twice with one key. Both responses should describe the same order, and only one should exist. The same key with a different body should be rejected (422):

```sh
for i in 1 2; do
  curl -s -X POST https://staging.example.com/api/orders \
    -H 'Authorization: Bearer <test token>' -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: key-check-1' -d '{"productId":"123","quantity":1}'
  echo
done
```
