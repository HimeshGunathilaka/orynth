import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const port = Number(process.env.PORT ?? 4173);
const host = "127.0.0.1";
const db = new DatabaseSync(process.env.CHECKOUT_DB ?? fileURLToPath(new URL("./orders.sqlite", import.meta.url)));
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    checkout TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    UNIQUE (owner, checkout)
  )
`);
const insert = db.prepare("INSERT INTO orders (owner, checkout, quantity) VALUES (?, ?, ?) ON CONFLICT (owner, checkout) DO NOTHING");
const lookup = db.prepare("SELECT id, quantity FROM orders WHERE owner = ? AND checkout = ?");
const count = db.prepare("SELECT COUNT(*) AS total FROM orders WHERE owner = ? AND checkout = ?");
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const assets = new Map([
  ["/", ["./index.html", "text/html"]],
  ["/checkout.js", ["./checkout.js", "text/javascript"]],
  ["/style.css", ["./style.css", "text/css"]],
]);

const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const json = (status, value) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  try {
    if (req.headers.host !== `${host}:${port}`) return json(403, { error: "Use the printed loopback address." });
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
    const cookie = req.headers.cookie?.split("; ").find((part) => part.startsWith("checkout_session="))?.slice("checkout_session=".length);
    const session = uuid.test(cookie) ? cookie : undefined;

    if (req.method === "GET") {
      let asset = assets.get(pathname);
      // The ESM entry points can import additional chunks from the build.
      if (/^\/dist\/[\w-]+\.js$/.test(pathname)) asset = [`../..${pathname}`, "text/javascript"];
      if (asset) {
        const bytes = await readFile(new URL(asset[0], import.meta.url));
        if (pathname === "/" && !session) {
          res.setHeader("Set-Cookie", `checkout_session=${randomUUID()}; HttpOnly; SameSite=Strict; Path=/`);
        }
        return res.writeHead(200, { "Content-Type": asset[1] }).end(bytes);
      }
    }
    if (!session) return json(401, { error: "Open a new demo session." });
    // The browser may see the scope identifier, but only the cookie grants access.
    const owner = createHash("sha256").update(session).digest("hex");
    if (req.method === "GET" && pathname === "/api/session") return json(200, { scope: owner });
    const key = req.method === "POST" ? req.headers["idempotency-key"] : searchParams.get("key");
    if (!uuid.test(key)) return json(400, { error: "A checkout UUID is required." });

    if (req.method === "POST" && pathname === "/api/orders") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return json(413, { error: "Order too large." });
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(400, { error: "Invalid JSON." }); }
      if (!Number.isInteger(input?.quantity) || input.quantity < 1 || input.quantity > 10) {
        return json(422, { error: "Choose between one and ten notebooks." });
      }
      // The order itself is the receipt. Its unique key and its side effect commit together.
      insert.run(owner, key, input.quantity);
      const order = lookup.get(owner, key);
      if (order.quantity !== input.quantity) return json(422, { error: "This checkout already has a different quantity." });
      if (req.headers["x-drop-confirmation"] === "yes") {
        // Closing a reused connection can trigger a browser-level replay. Drop every
        // response carrying the fault flag, including a replay of the same key.
        return req.socket.destroy();
      }
      return json(200, order);
    }
    if (req.method === "GET" && pathname === "/api/outcome") {
      const order = lookup.get(owner, key);
      return json(200, order ? { status: "succeeded", result: order } : { status: "not-found" });
    }
    if (req.method === "GET" && pathname === "/api/count") return json(200, count.get(owner, key));
    return json(404, { error: "Unknown route." });
  } catch (error) {
    console.error(error.message);
    return json(500, { error: "The demo server could not finish the request." });
  }
});
server.listen(port, host, () => console.log(`Checkout demo running at http://${host}:${port}`));
