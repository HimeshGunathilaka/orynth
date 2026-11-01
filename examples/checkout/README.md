# Recover an interrupted checkout

Run `npm ci` and `npm run demo:checkout` at the repository root with Node 22.18 or later. Open http://127.0.0.1:4173. The demo uses the built Orynth package, browser IndexedDB, and Node's built-in SQLite driver.

1. Place an order with **Drop the confirmation after saving** selected. The server commits the order and closes the connection. The checkout is uncertain. The ledger counts one row.
2. Reload, or open the same URL (including its fragment) in another tab of the same browser. IndexedDB restores the checkout's operation and original key.
3. Choose **Check order status**. The client reads the order by key and shows the receipt.
4. Choose **Start another checkout** to create a fresh intent. Clear the checkbox to try a normal confirmation.

## What to copy

The [browser client](checkout.js) stores the checkout ID in the URL fragment and uses it as the operation ID and idempotency key. A production checkout can use its existing cart or booking intent ID. An anonymous session cookie identifies the shopper in this local demo. In your application, bind both endpoints and the Orynth storage scope to the authenticated account.

The [server](server.mjs) keeps the key, quantity, and order ID in one SQLite row. A unique constraint on the shopper and key makes creating the side effect and recording its receipt a single atomic insert. A matching replay reads back the original order. Reusing the key with a different quantity returns HTTP 422. Both the status lookup and the ledger count only read rows for the current shopper and checkout.

This example retains keys for the lifetime of the order database. Orynth's default client retry window is 24 hours. Set the client window within your backend's retention period. For external effects such as charging a card, propagate the key to the payment provider and reconcile against its receipt. A local database transaction alone only covers local writes.

The database is saved at `examples/checkout/orders.sqlite` and survives server restarts. You can inspect it from the repository root:

```sh
sqlite3 examples/checkout/orders.sqlite 'SELECT id, checkout, quantity FROM orders;'
```

## Browser tests

From the repository root, run `npx playwright install chromium firefox webkit`, then `npm run test:checkout`. The tests use their own in-memory database and loopback port 4174.
