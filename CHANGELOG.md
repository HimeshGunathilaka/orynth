# Changelog

This project follows [Semantic Versioning](https://semver.org/).

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
