import { log } from "./log.ts";

/** No valid session cookie, or the Privy token could not be verified. 401. */
export class AuthError extends Error {}
/** Bad input from the client. 400. */
export class InputError extends Error {}
/** The thing does not exist or the viewer may not see it. 404. */
export class NotFoundError extends Error {}
/** The request conflicts with what is stored (taken username, trade already logged). 409. */
export class ConflictError extends Error {}
/** Too soon to ask again. 429; `nextAt` (ms) says when. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly nextAt: number,
  ) {
    super(message);
  }
}
/** A feature this server is not configured for (no faucet key). 503. */
export class UnavailableError extends Error {}

/** Failures with a known cause get a specific status and a message the user can act on. */
export function classify(error: unknown): { status: number; message: string; extra?: Record<string, unknown> } | undefined {
  if (error instanceof AuthError) return { status: 401, message: error.message };
  if (error instanceof InputError) return { status: 400, message: error.message };
  if (error instanceof NotFoundError) return { status: 404, message: error.message };
  if (error instanceof ConflictError) return { status: 409, message: error.message };
  if (error instanceof RateLimitError) return { status: 429, message: error.message, extra: { nextAt: error.nextAt } };
  if (error instanceof UnavailableError) return { status: 503, message: error.message };
  const e = error as { name?: string; code?: string; message?: string };
  const message = e.message ?? "";
  if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND" || e.code === "CONNECTION_ENDED" || e.code === "CONNECTION_CLOSED" || e.code === "57P01" || /database|postgres|PGlite/i.test(message)) {
    log("dependency.down", { dependency: "database", code: e.code, error: message.split("\n")[0] }, "error");
    return { status: 503, message: "bump lost its database connection. Try again shortly." };
  }
  if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "RpcRequestError" || /HTTP request failed|fetch failed/i.test(message)) {
    log("dependency.down", { dependency: "rpc", error: message.split("\n")[0] }, "error");
    return { status: 503, message: "Somnia's RPC is not responding right now. Try again shortly." };
  }
  return undefined;
}
