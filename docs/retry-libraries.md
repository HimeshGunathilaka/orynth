# How it differs from retry libraries

Retry libraries such as `p-retry` or `axios-retry` run a function again until it succeeds. That is fine for reads, but for writes they leave the hard questions unanswered:

| | Retry library | Orynth |
| --- | --- | --- |
| Identity across retries | None. Each attempt is just another call | One operation ID and idempotency key for every attempt |
| Timeout or dropped connection | Treated as a failure to retry | Treated as an **unknown outcome** (`uncertain`) |
| Double clicks / concurrent calls | Each call runs | Joined, rejected, ignored or queued per operation |
| Page reload mid-request | Lost | Restored with the same key; never auto-resubmitted |
| Two tabs recovering the same operation | Each one resends | Serialized with Web Locks; a stale tab refuses to resend |
| Retry after the backend forgot the key | Creates a duplicate | Refused (`IdempotencyKeyExpiredError`) |
| "Did it actually happen?" | Not addressed | `reconcile()` asks your backend |

Orynth is not an HTTP client and not server middleware. You keep your HTTP client and state management, and your backend remains the source of truth.
