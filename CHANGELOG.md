# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0

Initial release.

- `createMutationGuard()`, `guard.define()`, `definition.create()` and the `Operation` handle.
- Operation identity: a random ID and idempotency key per operation, kept across retries.
- Lifecycle `created → pending → succeeded | failed | uncertain → recovering`, with invalid transitions rejected.
- Concurrency strategies `join` (default), `reject`, `ignore` and `queue`.
- Opt-in automatic retries with exponential backoff, and manual `retry()`.
- `isUncertainError()`, the default classification of unknown outcomes.
- Storage: `memoryStorage()` (default) and `indexedDBStorage()` from `mutation-guard/storage`.
- `restore()` and `reconcile()` for recovering operations after a reload.
