# API reference

## `createOrynth(options?)`

| Option | Default | |
| --- | --- | --- |
| `storage` | `"memory"` | `"memory"` or an `OperationStorage` such as `indexedDBStorage()` |
| `idempotencyHeader` | `"Idempotency-Key"` | Header name used for `context.headers` |
| `retry` | `false` | Default `retry` for definitions |
| `ttl` | 24 hours | How long the backend remembers a key, from the first request. Afterward the operation is never resent. `Infinity` to disable |
| `scope` | none | A string, or a function returning a string or `undefined`: who new operations belong to. See [Sign-out and shared devices](persistence.md#sign-out-and-shared-devices) |
| `requireStorage` | `true` | Send nothing unless the record is saved first; `false` reports the failure and sends anyway |
| `locks` | `navigator.locks` | Web Locks for [cross-tab coordination](multiple-tabs.md); `false` to use leases instead |
| `lockTimeout` | `10000` | Milliseconds to wait for another tab before rejecting with `OperationInProgressError` |
| `onStorageError` | `console.error` | Receives `StorageError`s from writes that don't block execution, and malformed records found by `restore()`. If it throws, the error is reported and the operation carries on |

Returns a `Orynth`:

- **`orynth.define(options)`** → `OperationDefinition`
- **`orynth.restore()`** → `Promise<Operation[]>`. The current scope's operations that need recovery: unresolved stored records of defined definitions, plus uncertain operations already tracked. Rejects with `StorageError` if storage can't be read.
- **`orynth.clear()`** → `Promise<void>`. Discards every operation and deletes every stored record, in all scopes, except operations that are running.

## `orynth.define(options)`

| Option | Default | |
| --- | --- | --- |
| `name` | required | Unique per instance; links stored records to this definition |
| `execute(context)` | required | Performs the mutation; throw on failure |
| `reconcile(context)` | none | Asks the backend what happened; required for `reconcile()` |
| `concurrency` | `"join"` | `"join"`, `"reject"`, `"ignore"` or `"queue"` |
| `retry` | `false` | `true`, `false` or `RetryOptions` |
| `isUncertain(error)` | `isUncertainError` | `true` if the backend may have completed the operation |
| `persistInput` | `false` | Store the input so restored operations can be retried |
| `idempotencyHeader` | instance's | Per-definition header name |
| `ttl` | instance's | Per-definition key lifetime |
| `requireStorage` | instance's | Per-definition storage requirement |

`ExecuteContext`: `{ input, operationId, idempotencyKey, headers, attempt }`. `attempt` counts every execution of the operation, starting at 1.

`ReconcileContext`: `{ input, operationId, idempotencyKey, headers }`. `input` is `undefined` for restored operations without a persisted input.

`RetryOptions`: `{ attempts?, delay?, factor?, maxDelay?, jitter?, shouldRetry?(error, { attempt, uncertain }) }`.

## `OperationDefinition`

- **`definition.create(input?, { id?, idempotencyKey?, expiresAt? }?)`** → `Operation`. Starts a new logical operation in the current scope. The instance keeps one handle per ID while that ID is tracked: `create()` throws if the ID belongs to an operation that is executing, unresolved or restored, and of two handles created with the same ID only one can run at a time. Running an operation whose ID is already in storage rejects with `OperationConflictError`. IDs don't prevent duplicates over time; idempotency keys do. `expiresAt` is for a custom key that may have been sent before: when the backend forgets it (epoch milliseconds). It applies while it's in the future; the operation's own expiry is then the earlier of it and `ttl` after its first request.
- **`definition.getOrCreate(id, input?, { idempotencyKey?, expiresAt? }?)`** → `Operation`. The operation of this definition tracked under `id` in the current scope (in flight, unresolved or restored), or a new one with that ID and, by default, the ID as its idempotency key. Throws `OperationConflictError` if the tracked operation has different input (compared with the input as first sent) or, when `idempotencyKey` is given, another key. A restored operation without a persisted input is returned as it is. The options apply when it creates the operation. See [Double clicks and user intent](operations.md#double-clicks-and-user-intent).
- **`definition.get(id)`** → `Operation | undefined`. The operation of this definition, in the current scope, that the instance is running or tracking under that ID.
- **`definition.restore()`** → `Promise<Operation[]>`. Like `orynth.restore()`, for this definition only.

## `Operation`

| Member | |
| --- | --- |
| `id`, `idempotencyKey`, `name`, `input` | Identity, fixed for the operation's lifetime |
| `status` | `"created"`, `"pending"`, `"uncertain"`, `"recovering"`, `"succeeded"` or `"failed"` |
| `state` | Immutable snapshot: `{ id, name, idempotencyKey, status, attempts, result?, error?, expiresAt?, scope?, createdAt, updatedAt }`. `expiresAt` is when the key expires (first request + `ttl`) |
| `run()` | Executes; see the [state table](operations.md#running-operations) |
| `retry()` | Executes again with the same identity and input |
| `reconcile(options?)` | Asks the backend; `options`: `{ attempts?, delay?, factor?, maxDelay?, jitter? }` |
| `subscribe(listener)` | Calls `listener(state)` after every change; returns `unsubscribe` |
| `discard()` | Stops tracking it: deletes its record and frees its ID. Rejects while it is running. A record another tab has changed since, or is sending, is left to that tab |

## Errors

All extend `OrynthError`. `instanceof` works even when an app ends up with two copies of the package, such as its ESM and CommonJS builds.

| Error | When |
| --- | --- |
| `OperationUncertainError` | `run()`/`retry()` ended with an unknown outcome (including a definitive error after an earlier unknown one), or `run()` on an uncertain operation. `cause` is the latest error. |
| `OperationInProgressError` | Duplicate call with `concurrency: "reject"`, `reconcile()` or `discard()` during a request, or another tab held the operation longer than `lockTimeout` |
| `OperationConflictError` | Another tab or instance changed the stored operation or is sending it, or its ID is already stored. Nothing was sent. Also thrown by `getOrCreate()` for an ID tracked with other input or another key. `operationId` |
| `IdempotencyKeyExpiredError` | Resending after the key expired. Nothing was sent. `operationId`, `expiresAt` |
| `StorageError` | Storage failed. `operationId`, `cause` |
| `OrynthError` | Also on its own: an operation that was discarded, belongs to another scope, has no persisted input to retry, or whose input changed after it was sent (or can't be compared, or kept changing while it was being stored) |
| `InvalidTransitionError` | A lifecycle transition that isn't allowed. `from`, `to` |

Invalid options throw `TypeError` or `RangeError` from `createOrynth()`, `define()` and `create()`.

## Other exports

- **`isUncertainError(error)`**: the default classifier.
- **`memoryStorage()`**: in-memory storage (from `orynth` or `orynth/storage`).
- **`indexedDBStorage({ databaseName?, indexedDB? })`**: from `orynth/storage`. `indexedDB` accepts a custom `IDBFactory`, for example `fake-indexeddb` in tests. Its types don't need the DOM library, so Node projects can import the module.
- Types: `Operation`, `OperationDefinition`, `OperationState`, `OperationStatus`, `ExecuteContext`, `ReconcileContext`, `ReconcileResult`, `RetryOptions`, `ReconcileOptions`, `CreateOptions`, `GetOrCreateOptions`, `OperationStorage`, `OperationRecord`, `LockManagerLike`, and more.
