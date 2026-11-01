// The connection was never established, so the request cannot have reached the server.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

// The connection broke or timed out after the request may have been sent.
const INTERRUPTED_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ERR_NETWORK",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// Network failures some runtimes report with a plain `Error` (Cloudflare Workers, WebKit wrappers).
const NETWORK_MESSAGES = new Set([
  "Network connection lost",
  "The network connection was lost.",
  "The request timed out.",
]);

// Aborted or timed-out requests (DOM, Axios), legacy XHR network errors, and nested guarded operations.
const UNCERTAIN_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "CanceledError",
  "NetworkError",
  "OperationUncertainError",
]);

// Where wrapper errors keep the error they wrap: standard `cause`, Apollo/urql `networkError`, GraphQL `originalError`.
const WRAPPED = ["cause", "networkError", "originalError"] as const;

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null;
}

function statusOf(error: Bag): number | undefined {
  for (const value of [error.status, error.statusCode, isBag(error.response) ? error.response.status : undefined]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** The error and everything it wraps, outermost first. */
function unwrap(error: unknown): Bag[] {
  const chain: Bag[] = [];
  const pending = [error];
  while (pending.length > 0 && chain.length < 16) {
    const next = pending.shift();
    if (!isBag(next) || chain.includes(next)) continue;
    chain.push(next);
    for (const key of WRAPPED) pending.push(next[key]);
  }
  return chain;
}

/** What a transport-level error says about the outcome, or `undefined` if it says nothing. */
function transportVerdict(error: Bag): boolean | undefined {
  const { code, name, message } = error;
  if (typeof code === "string" && NOT_SENT_CODES.has(code)) return false;
  if (typeof code === "string" && INTERRUPTED_CODES.has(code)) return true;
  if (typeof name === "string" && UNCERTAIN_NAMES.has(name)) return true;
  // The Fetch standard reports every network error, including a body cut off mid-stream, as a TypeError.
  if (name === "TypeError") return true;
  // How `Response.json()` reports a body it can't parse: a response arrived, so the request was processed.
  if (name === "SyntaxError") return true;
  if (typeof message === "string" && NETWORK_MESSAGES.has(message)) return true;
  // Expo's fetch, the global `fetch` in Expo apps, reports every network failure and abort as a plain
  // Error "fetch failed: <native message>", with no code; the native message is localized.
  if (typeof message === "string" && message.startsWith("fetch failed: ")) return true;
  // An Axios error without a response: the request was sent but no answer arrived.
  if (error.isAxiosError === true && error.response === undefined) return true;
  // Axios couldn't read a response the server sent, e.g. the connection dropped mid-body (Node).
  if (error.isAxiosError === true && error.code === "ERR_BAD_RESPONSE") return true;
  return undefined;
}

/**
 * Default classification of execution errors.
 *
 * Returns `true` when the backend may have completed the operation despite
 * the error: any `TypeError` (how `fetch` reports network failures in every
 * runtime), any `SyntaxError` (how `Response.json()` reports a body it can't
 * parse), dropped or timed-out connections, aborted requests, and HTTP 408,
 * 409 (under the IETF Idempotency-Key draft: a request with the same key is
 * still being processed), 5xx or 0 (how XHR-based clients report network
 * failures), and Expo's `fetch` errors (`fetch failed: …`, plain `Error`s).
 * Returns `false` for other HTTP statuses, for connections that
 * were never established, and for errors it does not recognize, which are
 * treated as definitive failures. A 2xx status on an error means the server
 * accepted the request, so the transport error decides, e.g. a body cut off
 * after the status arrived is uncertain.
 *
 * Wrapped errors are followed through `cause`, `networkError` and
 * `originalError`. HTTP statuses are read from `error.status`,
 * `error.statusCode` or `error.response.status`, so throw errors carrying the
 * status to get an accurate classification.
 */
export function isUncertainError(error: unknown): boolean {
  const chain = unwrap(error);

  // An HTTP status is the server's own answer, so it decides.
  for (const e of chain) {
    const status = statusOf(e);
    if (status === undefined) continue;
    // Except a success: the server accepted the request, and what failed came after it, such as reading the body.
    if (status >= 200 && status < 300) break;
    return status === 0 || status === 408 || status === 409 || status >= 500;
  }
  // Otherwise the innermost transport error is the most specific, e.g. `ECONNREFUSED` under "fetch failed".
  for (const e of chain.reverse()) {
    const verdict = transportVerdict(e);
    if (verdict !== undefined) return verdict;
  }
  return false;
}
