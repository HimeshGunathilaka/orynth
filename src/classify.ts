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

// Messages of the `TypeError` that `fetch` throws on network failure, per runtime.
const FETCH_NETWORK_MESSAGES = new Set([
  "fetch failed", // Node.js (undici)
  "Failed to fetch", // Chromium
  "network error", // Chromium, when the response body fails to arrive
  "NetworkError when attempting to fetch resource.", // Firefox
  "Load failed", // Safari
  "Network request failed", // React Native, older polyfills
]);

// Aborted or timed-out requests (DOM, Axios), and nested guarded operations.
const UNCERTAIN_NAMES = new Set(["AbortError", "TimeoutError", "CanceledError", "OperationUncertainError"]);

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

/** What a transport-level error says about the outcome, or `undefined` if it says nothing. */
function transportVerdict(error: Bag): boolean | undefined {
  const { code, name, message } = error;
  if (typeof code === "string" && NOT_SENT_CODES.has(code)) return false;
  if (typeof code === "string" && INTERRUPTED_CODES.has(code)) return true;
  if (typeof name === "string" && UNCERTAIN_NAMES.has(name)) return true;
  if (name === "TypeError" && typeof message === "string" && FETCH_NETWORK_MESSAGES.has(message)) return true;
  // An Axios error without a response: the request was sent but no answer arrived.
  if (error.isAxiosError === true && error.response === undefined) return true;
  return undefined;
}

/**
 * Default classification of execution errors.
 *
 * Returns `true` when the backend may have completed the operation despite
 * the error: network interruptions, timeouts, aborted requests, and HTTP 408,
 * 5xx or 0 (how XHR-based clients report network failures). Returns `false`
 * for other HTTP statuses, for connections that were never established, and
 * for errors it does not recognize, which are treated as definitive failures.
 *
 * Errors are followed through their `cause` chain. HTTP statuses are read
 * from `error.status`, `error.statusCode` or `error.response.status`, so throw
 * errors carrying the status to get an accurate classification.
 */
export function isUncertainError(error: unknown): boolean {
  const chain: Bag[] = [];
  for (let e = error; isBag(e) && chain.length < 8 && !chain.includes(e); e = e.cause) chain.push(e);

  // An HTTP status is the server's own answer, so it decides.
  for (const e of chain) {
    const status = statusOf(e);
    if (status !== undefined) return status === 0 || status === 408 || status >= 500;
  }
  // Otherwise the innermost transport error is the most specific, e.g. `ECONNREFUSED` under "fetch failed".
  for (const e of chain.reverse()) {
    const verdict = transportVerdict(e);
    if (verdict !== undefined) return verdict;
  }
  return false;
}
