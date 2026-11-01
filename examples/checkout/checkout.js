import { createOrynth, OperationUncertainError } from "/dist/index.js";
import { indexedDBStorage } from "/dist/storage.js";

const el = (id) => document.getElementById(id);
const checkout = location.hash.slice(1) || crypto.randomUUID();
history.replaceState(null, "", `#${checkout}`);
el("key").textContent = checkout;

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return response.json();
}

async function start() {
  const { scope } = await request("/api/session");
  const orynth = createOrynth({ scope, storage: indexedDBStorage() });
  const outcomeUrl = (key) => `/api/outcome?key=${encodeURIComponent(key)}`;
  const orders = orynth.define({
    name: "checkout",
    execute: ({ input, headers }) => request("/api/orders", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "X-Drop-Confirmation": el("drop").checked ? "yes" : "no" },
      body: JSON.stringify(input),
    }),
    reconcile: ({ idempotencyKey }) => request(outcomeUrl(idempotencyKey)),
  });
  const refreshLedger = async () => {
    const { total } = await request(`/api/count?key=${encodeURIComponent(checkout)}`);
    el("total").textContent = total;
  };

  await orders.restore();
  let operation = orders.get(checkout);
  function display(action, message) {
    el("message").textContent = message;
    for (const id of ["place", "recover", "again"]) el(id).hidden = id !== action;
    el("drop").disabled = action !== "place";
    el("place").disabled = action !== "place";
  }
  function confirm(order) {
    display("again", `Order #${order.id} confirmed.`);
  }
  await refreshLedger();
  if (operation) {
    display("recover", "Unconfirmed checkout restored. Check its status.");
  } else {
    const outcome = await request(outcomeUrl(checkout));
    if (outcome.status === "succeeded") confirm(outcome.result);
    else display("place", "Ready to place your order.");
  }

  el("place").onclick = async () => {
    display(null, "Sending order…");
    try {
      operation = orders.get(checkout) ?? orders.create({ quantity: 1 }, { id: checkout, idempotencyKey: checkout });
      confirm(await operation.run());
    } catch (error) {
      if (error instanceof OperationUncertainError) display("recover", "Confirmation lost. Check the order or reload this page.");
      else display(null, `Could not finish checkout. Reload to check its status. ${error.message}`);
    }
    await refreshLedger().catch(() => { el("total").textContent = "Unavailable"; });
  };
  el("recover").onclick = async () => {
    display(null, "Checking the server…");
    try {
      const outcome = await operation.reconcile();
      if (outcome.status === "succeeded") confirm(outcome.result);
      else display("recover", "Still unconfirmed. Check again when the server is reachable.");
    } catch (error) {
      display("recover", `Could not check the order. ${error.message}`);
    }
    await refreshLedger().catch(() => { el("total").textContent = "Unavailable"; });
  };
  el("again").onclick = () => location.assign(location.pathname);
}

start().catch((error) => {
  el("place").disabled = true;
  el("message").textContent = `Could not open checkout. Reload to try again. ${error.message}`;
});
