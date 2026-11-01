# Limitations and backend requirements

**Orynth does not provide exactly-once execution, and nothing on the client can.** It gives each operation a stable identity and keeps the client from resubmitting carelessly. Real duplicate protection has to happen on the server.

What your backend needs:

- **To make retries safe, honor the idempotency key.** Store the key with the result of the first request, in the same transaction as the side effect, and return that result for repeated keys. As the IETF draft describes, answer 409 while a request with the same key is still processing and 422 when a key is reused with a different payload. Set the client's `ttl` to how long you keep keys. Without this, leave retries off and resolve uncertain operations through reconciliation and your users.
- **To reconcile, provide a status lookup**, ideally by idempotency key, that can tell completed operations from unknown ones.
- **Treat the backend as authoritative.** Orynth records what the client observed, not what happened.

Client-side limits:

- **Browser storage is local and can disappear.** IndexedDB data is per origin and per browser profile, is not synced across devices, can be cleared by the user or evicted under storage pressure, and may be unavailable or temporary in private browsing.
- **Cross-tab coordination spans one browser profile.** It's strongest with Web Locks; with leases, two tabs that start resending within the same storage round trip can both send. Nothing on the client coordinates devices; that takes backend idempotency.
- **Browsers and native HTTP stacks resend requests on their own.** In testing, Chromium and Firefox sent a POST twice, with one `fetch()` call and Orynth's retries off, when a reused keep-alive connection closed before the response. The `Idempotency-Key` header goes with the resent request, so an idempotent backend handles it. Turning retries off doesn't mean the server sees one request. Android's HTTP stack does the same under Expo's `fetch` ([React Native](react-native.md#the-platform-resends-on-its-own)).
- **Final-state writes are asynchronous.** If the page closes in the instant between an operation resolving and its record being deleted, it is restored as `uncertain` and settled by reconciliation.
- **Execution can't be cancelled from outside.** Timeouts belong in your `execute` function (`AbortSignal.timeout()`, Axios `timeout`). Without one, a request that never ends keeps its operation busy.
- **Tracked operations stay in memory** until they resolve or are discarded. Long-lived pages and servers should `discard()` operations they give up on.
- **Classification is a heuristic.** The default treats every `TypeError` and the network errors of Axios, Node and GraphQL clients as uncertain, but other errors it doesn't recognize as definitive failures. Only your backend knows what its errors mean. Throw errors with an HTTP `status`, and override `isUncertain` for other transports.
