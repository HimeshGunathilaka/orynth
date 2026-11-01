# Persistence and recovery

Keeping operations across reloads, restoring them, shared devices, and writing your own storage adapter.

## Persistent storage

By default, operations are tracked in memory, which is enough for duplicate protection and retries within one page load. To survive reloads and browser restarts, use IndexedDB:

```ts
import { createOrynth } from "orynth";
import { indexedDBStorage } from "orynth/storage";

const orynth = createOrynth({
  storage: indexedDBStorage(), // database "orynth"; pass { databaseName } to change it
});
```

What gets stored:

- A record is written **before** each operation's first request is sent: ID, idempotency key, definition name, status, attempt count, timestamps and the last error's name and message.
- The **input is not stored** unless the definition opts in with `persistInput: true`. Without it, a restored operation can be reconciled but not retried. Only opt in for inputs you are comfortable keeping on the device. The input is stored as it was when first sent, and must be structured-cloneable; proxies such as Vue `reactive` objects and MobX observables are copied part by part. An input that can't be stored as it is, such as one holding functions, `FormData` or `URLSearchParams`, is treated like a failed write (below): convert it to plain data first, for example with `Object.fromEntries(formData)`.
- **Results are never stored.**
- A record is **deleted once the operation resolves** (`succeeded` or `failed`). Only unresolved operations remain.
- Operations **expire with the idempotency key**, `ttl` after their first request (default 24 hours). Set `ttl` to how long your backend remembers keys. After that, the operation is never resent, but `restore()` still returns it so you can reconcile it or tell the user; `discard()` it once handled. Use `ttl: Infinity` if keys never expire.

How storage failures are handled:

- If the record **cannot be saved before the request**, `run()` rejects with `StorageError` and **nothing is sent**. Sending a request that couldn't be recovered would defeat the point. The operation stays in its previous state and its ID is free, so you can call `run()` again. If a storage outage shouldn't stop orders, set `requireStorage: false` (on the instance or one definition): the failure goes to `onStorageError` and the request is sent without a recovery record.
- If a **later write** fails, the in-memory state is still updated and the error goes to `onStorageError` (default: `console.error`). The stored record is then older than the real state, which is safe: on restore it comes back as `uncertain` and reconciliation settles it.

```ts
createOrynth({
  storage: indexedDBStorage(),
  onStorageError: (error) => reportToMonitoring(error), // error.operationId, error.cause
});
```

## Recovery after a reload

Define your operations, then call `restore()` once at startup:

```ts
const orynth = createOrynth({ storage: indexedDBStorage() });
const createOrder = orynth.define({ name: "create-order", execute, reconcile });

for (const operation of await orynth.restore()) {
  const outcome = await operation.reconcile();
  if (outcome.status === "succeeded") notify("Your order went through.");
  else if ((operation.state.expiresAt ?? Infinity) < Date.now()) {
    notify("We couldn't confirm an earlier order. Please check your orders.");
    await operation.discard(); // its key has expired, so it can never be resent
  }
}
```

Restored operations:

- keep their **original ID and idempotency key**,
- are always **`uncertain`**, because whatever was in flight when the page closed has an unknown outcome,
- **never execute on their own**: `run()` rejects with `OperationUncertainError` until you `reconcile()` or explicitly `retry()`,
- are reconnected to definitions **by `name`**. Records whose definition isn't defined yet stay in storage for a later `restore()`.

`restore()` returns only operations that need recovery, so every one can be reconciled: operations still running in this page aren't included. `createOrder.restore()` restores only that definition's operations, typed with its input and result. Calling `restore()` again returns the same instances.

`operation.discard()` stops tracking an operation for good: its record is deleted, its ID is freed, and further `run()`, `retry()` and `reconcile()` calls reject. Use it for operations the user has given up on; otherwise they stay tracked until they resolve.

## Sign-out and shared devices

Stored operations belong to the browser profile, not to a user. Without more information, the next person to sign in on the same device would have the previous user's unconfirmed operations restored, and could resend them on their own account. Give the instance a **scope** and **clear** it on sign-out:

```ts
const orynth = createOrynth({
  storage: indexedDBStorage(),
  scope: () => session.userId, // called whenever the current user matters
});

async function signOut() {
  await orynth.clear(); // discard every operation and delete every record, in all scopes
  session.end();
}
```

- `scope` must return a string or `undefined`. Convert a numeric user ID with `String()`; otherwise `create()` throws a `TypeError`.
- New operations record the scope they were created in (`state.scope`).
- `restore()` and `definition.get()` only return operations of the current scope.
- An operation of another scope can't be run, retried or reconciled. The scope is checked again right before every request and reconciliation lookup, so an operation already waiting to be retried is not sent under the next user's session.
- `clear()` leaves operations that are running, in this tab or another, to finish, and deletes everything else. It waits up to `lockTimeout` for each operation another tab holds.

**On a server**, create an instance per request or job: an instance created at module level is shared by every request, so `get()` could return another user's operation.

## Custom storage adapters

A storage adapter has four methods:

```ts
interface OperationStorage {
  set(record: OperationRecord): Promise<void>; // insert or replace by record.id
  get(id: string): Promise<OperationRecord | undefined>;
  delete(id: string): Promise<void>; // no error if missing
  list(): Promise<OperationRecord[]>; // all records
}
```

Records are plain, structured-cloneable objects (`OperationRecord`). Store every field, including `revision` (how other tabs' changes are detected), `scope` and `lease`. Resolve `set` only once the record is durable, because the request is sent right after, and have `get` return the latest record. The instance serializes writes per operation, waits for its own writes before reading, and wraps adapter errors in `StorageError`. Missing values may come back as `null`; an `input` of `null` counts as not persisted. `restore()` reports records with an invalid shape to `onStorageError` (by ID only, never their contents) and skips them, for example an `expiresAt` that isn't a number or `attempts` below 1. If `onStorageError` throws, the error is reported and the other records are still restored.

If you serialize to JSON, note that an `input` of `undefined` is dropped, so such an operation can't be retried after a restore. For example, a `localStorage` adapter:

```ts
import type { OperationRecord, OperationStorage } from "orynth";

function localStorageAdapter(key = "orynth"): OperationStorage {
  const read = (): Record<string, OperationRecord> => JSON.parse(localStorage.getItem(key) ?? "{}");
  const write = (records: Record<string, OperationRecord>) => localStorage.setItem(key, JSON.stringify(records));
  return {
    async set(record) {
      write({ ...read(), [record.id]: record });
    },
    async get(id) {
      return read()[id];
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

`memoryStorage()` is exported too. Share one storage between two Orynth instances to simulate a restart in tests.
