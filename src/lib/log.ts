import { AsyncLocalStorage } from "node:async_hooks";

type Context = { requestId: string; user?: string };
export const requestContext = new AsyncLocalStorage<Context>();

const SECRET_KEY = /(private|secret|password|apikey|api_key|token|cookie|mnemonic|authorization)/i;

/**
 * One JSON line per event with the current request id. Callers pass only safe fields: addresses, trade ids, tx hashes,
 * provider hosts, statuses. Keys that look like secrets are redacted as a second line of defence.
 */
export function log(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info") {
  if (process.env.BUMP_LOG === "silent") return;
  const ctx = requestContext.getStore();
  const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : v]));
  const line = JSON.stringify({ at: new Date().toISOString(), level, event, requestId: ctx?.requestId, user: ctx?.user, ...safe }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Host of an RPC URL without path or query, which may carry an API key. */
export function providerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
