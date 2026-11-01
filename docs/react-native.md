# React Native

Orynth runs in React Native with Hermes. It was tested in Release builds of an Expo SDK 58 app (React Native 0.88.1, Hermes) on an iOS 26 simulator and an Android 14 emulator, with `fetch`, Axios, Ky and ofetch and the Expo SQLite adapter below. The tests covered lost confirmations, the app killed mid-request, account switches, network cuts, backgrounding and restarts.

What differs from a browser:

| | Browser | React Native |
| --- | --- | --- |
| Storage | `indexedDBStorage()` | An adapter over the app's storage, [below](#storage) |
| Cross-tab coordination | Web Locks | Leases on stored records |
| IDs and keys Orynth generates | `crypto.randomUUID()` | `Math.random()` unless you add a polyfill ([Random IDs](#random-ids)) |
| Network errors of `fetch` | `TypeError` | Expo's `fetch`: `Error: fetch failed: …` ([Errors](#errors-from-expos-fetch)) |

## Storage

There's no IndexedDB. Give Orynth an adapter over the app's own storage, such as Expo SQLite:

```ts
import * as SQLite from "expo-sqlite";
import type { OperationRecord, OperationStorage } from "orynth";

const db = SQLite.openDatabaseAsync("orynth.db").then(async (db) => {
  await db.execAsync("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY NOT NULL, record TEXT NOT NULL)");
  return db;
});

export const sqliteStorage: OperationStorage = {
  async set(record) {
    await (await db).runAsync("INSERT OR REPLACE INTO operations (id, record) VALUES (?, ?)", record.id, JSON.stringify(record));
  },
  async get(id) {
    const row = await (await db).getFirstAsync<{ record: string }>("SELECT record FROM operations WHERE id = ?", id);
    return row ? (JSON.parse(row.record) as OperationRecord) : undefined;
  },
  async delete(id) {
    await (await db).runAsync("DELETE FROM operations WHERE id = ?", id);
  },
  async list() {
    const rows = await (await db).getAllAsync<{ record: string }>("SELECT record FROM operations");
    return rows.map((row) => JSON.parse(row.record) as OperationRecord);
  },
};
```

```ts
const orynth = createOrynth({ storage: sqliteStorage, scope: () => session.userId });
```

Records go through JSON here, as with AsyncStorage or MMKV. A persisted input comes back with its `Date`s as strings and without its `undefined` fields. Orynth compares inputs by what JSON would send, so `getOrCreate()` still finds a restored checkout for the same form. `execute` and `reconcile` receive the restored input, so don't call `Date` methods on it after a restart.

## Random IDs

Hermes has neither `crypto.randomUUID()` nor `crypto.getRandomValues()`, so the operation IDs and idempotency keys Orynth generates come from `Math.random()`. They're unique in practice, but predictable. Either:

- polyfill `crypto.getRandomValues()`, for example with `react-native-get-random-values` imported before anything else; Orynth uses it when it exists, or
- create checkout IDs yourself with a secure generator, such as `expo-crypto`'s `randomUUID()`, and pass them to `getOrCreate()`, which also uses them as keys.

## Errors from Expo's fetch

Expo installs its own `fetch` as the global `fetch`, so Ky and ofetch use it too. It reports network failures and aborts as plain `Error`s whose message starts with `fetch failed:`, followed by the native message. They aren't the Fetch standard's `TypeError`, and an abort loses its reason. A timeout reads `fetch failed: Fetch request has been canceled`.

Orynth 1.2 classifies these as uncertain. Orynth 1.1 classified them as failed, so a lost confirmation told the customer the order wasn't placed and deleted its recovery record. A refused connection reads the same way and is uncertain too: reconciliation answers `not-found`, and a retry with the same key is safe.

Axios uses React Native's own `XMLHttpRequest`, whose network errors are Axios `ERR_NETWORK` errors. Use the strict JSON options from the [Axios and ofetch recipes](http-clients.md): on iOS, a response cut off mid-body was delivered as complete.

## The platform resends on its own

On Android, when the connection dropped after the server had committed an order, Expo's `fetch` sent the POST again by itself, with the same headers, within milliseconds. The server saw two writes for one tap. With an idempotent backend, the second write is a replay and the app gets the original receipt. Without one, it would be a second order. Browsers do the same ([Limitations](limitations.md)).

## Background and foreground

On iOS, sending the app to the background cancelled a request in flight, even though the server had completed it. The operation becomes uncertain. Android kept the request going. Check unresolved operations when the app comes back:

```ts
import { AppState } from "react-native";

AppState.addEventListener("change", async (state) => {
  if (state !== "active") return;
  for (const operation of await orders.restore()) await operation.reconcile();
});
```

A screen that mounts or comes to the foreground should look its checkout up with `orders.get(checkoutId)`, not create one: only a tap on **Place order** calls `getOrCreate()`.

## Inputs

`persistInput` needs plain data. React Native's `FormData` is a JavaScript object that `structuredClone` copies into something that can't be sent again, so Orynth refuses it, and `URLSearchParams`, with `StorageError`, as in browsers. Store the fields and build the `FormData` inside `execute`.

## Multiple instances

React Native has no `navigator.locks`, so instances coordinate through leases on stored records. Two instances on one store, such as the app and a headless task, don't both send an operation: the second rejects with `OperationConflictError` while the first instance's request is in flight.
