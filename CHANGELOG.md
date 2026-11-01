# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## 1.1.0

Added:

- `definition.getOrCreate(id, input, { idempotencyKey?, expiresAt? })`: the operation tracked under `id` (in flight, uncertain or restored after a reload), or a new one with `id` as both its ID and its idempotency key. Different input for a tracked operation throws `OperationConflictError` instead of joining it; so does an explicit `idempotencyKey` that differs from the tracked operation's. It replaces the `get(id) ?? create(input, { id, idempotencyKey: id })` pattern.
- Tested recipes for native `fetch`, Axios, Ky and ofetch. Each runs the same release test against a real server: a lost response recovered after a reload with no new request, a 422, `retry()` with the original key, a body cut off mid-stream, a timeout and a refused connection. The HTTP clients guide says which layer owns retries for each client, and how to check that the key reaches the backend.
- Recipes: preventing duplicate form submissions, recovering a submitted order after a reload, and using Orynth with TanStack Query's `useMutation`.

Fixed:

- `isUncertainError()` no longer treats an error carrying a 2xx status as a definitive failure. The server accepted the request, so the transport error decides. Axios in Node reports a response cut off mid-body as `ERR_BAD_RESPONSE` with the 201 attached, which 1.0 classified as failed, so the app would have reported a placed order as not placed. It is uncertain now.

## 1.0.0

Initial release.

- `createOrynth()`, `orynth.define()`, `definition.create()` and the `Operation` handle.
- Operation identity: a random ID and idempotency key per operation, kept across retries.
- Lifecycle `created → pending → succeeded | failed | uncertain → recovering`, with invalid transitions rejected.
- Concurrency strategies `join` (default), `reject`, `ignore` and `queue`.
- Opt-in automatic retries with exponential backoff, and manual `retry()`.
- `isUncertainError()`, the default classification of unknown outcomes. Every `TypeError` and `SyntaxError` is uncertain, and wrapped errors are followed through `networkError` and `originalError` as well as `cause`.
- An operation whose outcome is unknown stays `uncertain` until a request succeeds or `reconcile()` settles it, even if a later attempt fails definitively.
- Storage: `memoryStorage()` (default) and `indexedDBStorage()` from `orynth/storage`. The record is written before each request is sent.
- `restore()` and `reconcile()` for recovering operations after a reload. `restore()` returns only operations that need recovery, including expired ones (which can be reconciled but not resent), and reports malformed records instead of using them.
- Resending is refused after the backend's key lifetime (`ttl`, from the first request; `IdempotencyKeyExpiredError`), when the input changed after it was sent, and when the operation belongs to another scope. These are checked again right before each request leaves.
- Input change detection covers `Map`, `Set`, `FormData`, `URLSearchParams`, binary data, `BigInt`s, circular references and non-enumerable properties; `Blob` and `File` values are compared by identity.
- `persistInput` stores the input as it was sent; proxies (Vue, MobX) are copied part by part, and inputs that can't be stored reject with `StorageError`.
- `definition.get(id)` to tie an operation to the user's intent, and an instance-level `retry` default. A reused custom idempotency key keeps the expiry of its first use in the instance, or the one given with `create(input, { expiresAt })`.
- Cross-tab coordination: Web Locks per operation, leases on stored records (for tabs without Web Locks, or when lock requests fail), and a stored-record `revision` check before resending (`OperationConflictError`). `lockTimeout` bounds waits for another tab. `discard()` and `clear()` leave records that another tab is using.
- Shared devices: a `scope` option (e.g. the signed-in user) for `restore()`, `get()` and running operations; `orynth.clear()` for sign-out; `operation.discard()` for abandoned operations.
- `requireStorage: false` to send even when the record can't be saved.
- Error classes support `instanceof` across duplicate copies of the package.
