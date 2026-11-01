# HTTP clients

Orynth never sends anything itself: `execute` uses your client. Examples for `fetch` and Axios.

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

The header name defaults to `Idempotency-Key`. Change it for the whole instance or for one definition:

```ts
const orynth = createOrynth({ idempotencyHeader: "X-Idempotency-Key" });
orynth.define({ name: "legacy-import", idempotencyHeader: "X-Request-Id", execute });
```

To send the key in some other form (a body field, a query parameter, a prefixed value), use `context.idempotencyKey` directly. Orynth never sends anything itself.

## Axios

The same interface works with Axios, with no adapter or interceptor needed:

```ts
const api = axios.create({ baseURL: "/api", timeout: 10_000 });

const createOrder = orynth.define({
  name: "create-order",
  execute: async ({ input, headers }: ExecuteContext<OrderInput>) =>
    (await api.post<Order>("/orders", input, { headers })).data,
  reconcile: async ({ idempotencyKey }) =>
    (await api.get<ReconcileResult<Order>>(`/orders/by-key/${idempotencyKey}`)).data,
});
```

Axios errors are classified out of the box: 4xx responses are failures, while timeouts, dropped connections and 5xx responses are uncertain.
