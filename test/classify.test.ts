import { describe, expect, it } from "vitest";
import { isUncertainError, OperationUncertainError } from "../src/index.js";
import { connectionRefused, connectionReset, HttpError } from "./helpers.js";

const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("isUncertainError", () => {
  it.each([
    ["a dropped connection (Node fetch)", connectionReset()],
    ["a network error (Chromium fetch)", new TypeError("Failed to fetch")],
    ["a network error (Firefox fetch)", new TypeError("NetworkError when attempting to fetch resource.")],
    ["a network error (Safari fetch)", new TypeError("Load failed")],
    ["a timeout (AbortSignal.timeout)", new DOMException("The operation timed out.", "TimeoutError")],
    ["an aborted request", new DOMException("This operation was aborted", "AbortError")],
    ["a socket reset", withCode("ECONNRESET", "socket hang up")],
    ["an Axios timeout", Object.assign(withCode("ECONNABORTED"), { isAxiosError: true })],
    ["an Axios network error", Object.assign(withCode("ERR_NETWORK"), { isAxiosError: true })],
    ["an Axios error without a response", { isAxiosError: true, message: "unknown" }],
    ["HTTP 408", new HttpError(408)],
    ["HTTP 409 (Idempotency-Key draft: same key still processing)", new HttpError(409)],
    ["HTTP 500", new HttpError(500)],
    ["HTTP 502", { statusCode: 502 }],
    ["HTTP 504 (Axios)", { isAxiosError: true, response: { status: 504 } }],
    ["status 0 (XHR-based clients such as Angular)", { name: "HttpErrorResponse", status: 0 }],
    ["a body that failed to arrive (Chromium fetch)", new TypeError("network error")],
    ["a wrapped network error", new Error("Saving failed", { cause: new TypeError("Failed to fetch") })],
    ["a wrapped timeout", new Error("Saving failed", { cause: new DOMException("timed out", "TimeoutError") })],
    ["a nested guarded operation", new OperationUncertainError("inner", new Error("unknown"))],
    // The Fetch standard reports all network errors as TypeErrors, whatever the message.
    ["a body cut off mid-stream (Firefox)", new TypeError("Content-Length header of network response exceeds response Body.")],
    ["any other TypeError", new TypeError("x is not a function")],
    ["a response body that isn't JSON (Response.json())", new SyntaxError("Unexpected end of JSON input")],
    ["an Apollo/urql network error", { name: "ApolloError", networkError: new TypeError("Load failed") }],
    ["a GraphQL error wrapping a timeout", { originalError: new DOMException("timed out", "TimeoutError") }],
    ["a dropped connection (Cloudflare Workers)", new Error("Network connection lost")],
    ["a legacy XHR network error", new DOMException("A network error occurred.", "NetworkError")],
  ])("uncertain: %s", (_, error) => {
    expect(isUncertainError(error)).toBe(true);
  });

  it.each([
    ["a refused connection (Node fetch)", connectionRefused()],
    ["a wrapped refused connection", new Error("Saving failed", { cause: connectionRefused() })],
    ["a DNS failure", withCode("ENOTFOUND")],
    ["HTTP 400", new HttpError(400)],
    ["HTTP 422 (Axios)", { isAxiosError: true, response: { status: 422 }, code: "ERR_BAD_REQUEST" }],
    ["HTTP 429", new HttpError(429)],
    ["an application error", new Error("Order creation failed")],
    ["a string", "boom"],
    ["undefined", undefined],
  ])("not uncertain: %s", (_, error) => {
    expect(isUncertainError(error)).toBe(false);
  });

  it("lets the HTTP status win over the transport code", () => {
    expect(isUncertainError({ status: 400, code: "ECONNRESET" })).toBe(false);
    expect(isUncertainError(new Error("x", { cause: new HttpError(422) }))).toBe(false);
  });

  it("survives cyclic cause chains", () => {
    const error: { cause?: unknown } = new Error("loop");
    error.cause = error;
    expect(isUncertainError(error)).toBe(false);
  });
});
