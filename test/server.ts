/**
 * A real order API on a local socket, with switches for the failure modes the
 * tests need. It behaves like the IETF Idempotency-Key draft describes: it
 * replays the first result for a repeated key, answers 409 while a request
 * with the same key is still processing, and forgets keys after `keyTtl`.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type OrderInput = { productId: string; quantity: number };
export type Order = OrderInput & { id: string };
/** What the server does with the next POST /orders. */
export type Behavior = "drop-after-commit" | "slow" | 422 | 429 | 503;

export interface ServerOptions {
  /** Honor idempotency keys. Default `true`. */
  idempotent?: boolean;
  /** Header carrying the key. Default `idempotency-key`. */
  keyHeader?: string;
  /** Require `Authorization: Bearer <token>` on POST. */
  token?: string;
  /** How long keys are remembered, in milliseconds. Default: forever. */
  keyTtl?: number;
}

export async function startServer(options: ServerOptions = {}) {
  const { idempotent = true, keyHeader = "idempotency-key", keyTtl = Infinity } = options;
  const orders: Order[] = [];
  /** Keys seen, with their order once committed. */
  const keys = new Map<string, { order?: Order; body: string; at: number }>();
  const plan: Behavior[] = [];
  const posts: { key: string | undefined; body: string }[] = [];
  let token = options.token;

  const live = (key: string) => {
    const entry = keys.get(key);
    return entry && Date.now() - entry.at < keyTtl ? entry : undefined;
  };

  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url!, "http://localhost");

    if (req.method === "POST" && url.pathname === "/orders") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const key = req.headers[keyHeader] as string | undefined;
      posts.push({ key, body });

      if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
        return json(401, { error: "session expired" });
      }
      const behavior = plan.shift();
      if (typeof behavior === "number") return json(behavior, { error: "rejected" });

      const existing = idempotent && key ? live(key) : undefined;
      if (existing && existing.body !== body) return json(422, { error: "key reused with a different payload" });
      if (existing?.order) return json(201, existing.order);
      if (existing) return json(409, { error: "a request with this key is still being processed" });

      const entry: { order?: Order; body: string; at: number } = { body, at: Date.now() };
      if (key) keys.set(key, entry);
      if (behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
      entry.order = { id: `order-${orders.length + 1}`, ...(JSON.parse(body) as OrderInput) };
      orders.push(entry.order);
      if (behavior === "drop-after-commit") return void req.socket.destroy();
      return json(201, entry.order);
    }

    if (req.method === "GET" && url.pathname.startsWith("/orders/by-key/")) {
      const entry = live(decodeURIComponent(url.pathname.slice("/orders/by-key/".length)));
      if (!entry) return json(200, { status: "not-found" });
      return json(200, entry.order ? { status: "succeeded", result: entry.order } : { status: "pending" });
    }
    json(404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    orders,
    plan,
    posts,
    setToken(value: string) {
      token = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export type TestServer = Awaited<ReturnType<typeof startServer>>;
