# Multiple tabs

Tabs of the same origin share IndexedDB, so two tabs can restore the same operation, or one tab can restore an operation another tab is still sending. Orynth coordinates them:

- Every execution and reconciliation holds a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) for its operation (`navigator.locks`) until its writes have landed. A tab that wants to resend waits for the other tab to finish.
- Before sending, a tab checks that the stored record is still the one it last saw (each record has a `revision`). If another tab resolved, resent or reconciled the operation meanwhile, `retry()` rejects with `OperationConflictError` and sends nothing. Call `reconcile()` to catch up with the backend, then retry if it's still needed.
- Running a new operation whose custom ID is already stored (by another tab, or by an earlier session you haven't restored) is refused the same way.
- `discard()` and `clear()` leave a record that another tab has changed since, or is sending, including a new operation that reused the ID.

A tab waits at most `lockTimeout` (default 10 s) for another tab; then the call rejects with `OperationInProgressError` and nothing is sent. A tab whose request never ends would otherwise hold the operation forever, so give every `execute` a timeout.

**Without Web Locks** (Node.js 22 and earlier, Safari before 15.4, pages not served over https, React Native), or if `navigator.locks` refuses requests (sandboxed iframes and other opaque origins, reported once), tabs coordinate through **leases** instead. Every tab sending an operation stores a lease on its record and renews it every 10 seconds, with or without Web Locks; tabs without them refuse to resend while the lease is live (`OperationConflictError`) and keep it when they write, so they also stay clear of tabs that do have Web Locks. A lease from a tab that closed mid-request expires after 30 seconds; tabs with Web Locks don't wait for it. Two tabs without Web Locks that start resending within the same storage round trip can still both send; backend idempotency covers that case.

Pass `locks: false` to use leases always, or your own `LockManagerLike`.
