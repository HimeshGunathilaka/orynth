# Retries

Automatic and manual retries, and when Orynth refuses to resend.

## Automatic retries

**Automatic retries are off by default.** Resending a mutation is only safe if your backend honors the idempotency key. Otherwise, a retry after a dropped connection creates a duplicate. Turn them on once that's true:

```ts
const createOrder = orynth.define({
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

`retry: true` uses those defaults; `retry: false` disables retries. To set a default for every definition, pass `retry` to `createOrynth()`; a definition's own `retry` overrides it. Every attempt reuses the operation ID, idempotency key and input. The state stays `pending` between attempts, with `state.error` holding the last error.

By default only **uncertain** outcomes are retried, never definitive failures. That includes HTTP 409, which the Idempotency-Key draft uses for "still processing"; if your API also uses 409 for business conflicts, exclude it in `isUncertain` (see [Uncertain vs. failed](outcomes.md#uncertain-vs-failed)). Use `shouldRetry` to change what is retried:

```ts
retry: {
  attempts: 5,
  // Rate limiting is safe to retry: the server did not process the request.
  shouldRetry: (error, { uncertain }) =>
    uncertain || (error instanceof HttpError && error.status === 429),
},
```

## Manual retries

`retry()` executes a `failed` or `uncertain` operation again with the same identity, and gets a fresh automatic-retry budget:

```ts
await operation.retry();
```

For an `uncertain` operation, prefer `reconcile()` first. `retry()` is how you resubmit once you've decided it is safe.

**Expired sessions.** A 401 is a definitive failure. After the app refreshes the session, `retry()` resends with the same key. `execute` runs for every attempt, so it picks up the new credentials. (For an operation that was already `uncertain`, the 401 arrives as the `cause` of an `OperationUncertainError`.)

## When Orynth refuses to resend

Resending under the same idempotency key is only safe while the backend would recognize the request. Orynth sends nothing, and leaves the operation's state unchanged, when:

| Situation | Error |
| --- | --- |
| The backend has forgotten the key: `ttl` has passed since the first request (see `state.expiresAt`) | `IdempotencyKeyExpiredError` |
| The input object was changed after it was first sent, or can no longer be read to compare it (a revoked proxy, a throwing getter) | `OrynthError` |
| The operation belongs to another [scope](persistence.md#sign-out-and-shared-devices): the user signed out | `OrynthError` |
| Another tab or instance resolved, resent or reconciled the operation since this handle last saw it, or is sending it right now ([Multiple tabs](multiple-tabs.md)) | `OperationConflictError` |

Automatic retries stop for the same reasons. These conditions are checked again right before each request leaves, after its record is written, so a slow write can't let an expired key or a signed-out user's operation through. In each case the original request may still have succeeded, so reconcile the operation. To send different input, or to try again after the key expired, create a new operation.

Edits to the input before the first request are fine. If it changes while its record is being written, the record is written again, so the stored copy is what was sent. Treat it as read-only after that. Changes inside `Map`, `Set`, `FormData` and `URLSearchParams` values, to `ArrayBuffer` and typed array bytes, and to `BigInt`s and non-enumerable properties are detected too. `Blob` and `File` values are compared by identity, because their contents can't change, so replacing one counts as a change. Private fields of class instances can't be seen.
