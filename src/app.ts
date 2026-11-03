import { randomUUID } from "node:crypto";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { getAddress, isAddress, verifyMessage, type Hex } from "viem";
import { encodeBigints, type PrefsRequest } from "@bump/api-types";
import { closeTradeSchema, guestImportSchema, limitsSchema, openTradeSchema, profileInputSchema, pushSubscriptionSchema } from "@bump/shared";
import { db } from "./lib/db/client.ts";
import { deps } from "./lib/deps.ts";
import { env } from "./lib/env.ts";
import { AuthError, classify, InputError, NotFoundError } from "./lib/errors.ts";
import { drip } from "./lib/gas.ts";
import { parse } from "./lib/input.ts";
import { leaderboard, parseBoard } from "./lib/leaderboard.ts";
import { log, requestContext } from "./lib/log.ts";
import { progressFor } from "./lib/progress.ts";
import { subscribe, unsubscribe } from "./lib/push.ts";
import { clearedSessionCookie, getSession, requireSession, sessionCookie, type Session } from "./lib/session.ts";
import { closeTrade, importGuest, listTrades, openTrade, updateLimits } from "./lib/trades.ts";
import { getUser, savePrefs, saveProfile, setTradingAccount, upsertUser } from "./lib/users.ts";

type Ctx = { request: Request; params: Record<string, string>; body: unknown; query: Record<string, string | undefined> };
type Input = { params: Record<string, string>; body: unknown; query: Record<string, string | undefined>; request: Request };
type Run = (input: Input & { session: Session }) => Promise<unknown>;
type PublicRun = (input: Input & { session: Session | undefined }) => Promise<unknown>;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(encodeBigints(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/**
 * Every route runs here: request id, structured log, session, and error classification. Expected failures become
 * 4xx/503 with a message the user can act on; anything else is logged and returned as 500 with its first line.
 */
async function handle(ctx: Ctx, fn: Run | PublicRun, auth: boolean): Promise<Response> {
  const requestId = ctx.request.headers.get("x-request-id") ?? randomUUID();
  const path = new URL(ctx.request.url).pathname;
  const started = performance.now();
  return requestContext.run({ requestId }, async () => {
    const respond = (response: Response) => {
      response.headers.set("x-request-id", requestId);
      log("api.request", { method: ctx.request.method, path, status: response.status, ms: Math.round(performance.now() - started) }, response.status >= 500 ? "error" : "info");
      return response;
    };
    try {
      const body = ctx.body === undefined || ctx.body === null || ctx.body === "" ? {} : ctx.body;
      const input = { params: ctx.params ?? {}, body, query: ctx.query ?? {}, request: ctx.request };
      const session = auth ? await requireSession(ctx.request) : await getSession(ctx.request);
      const store = requestContext.getStore();
      if (store && session) store.user = session.address;
      return respond(json(await (fn as PublicRun)({ ...input, session })));
    } catch (error) {
      const known = classify(error);
      if (known) return respond(json({ error: known.message, requestId, ...known.extra }, known.status));
      log("api.error", { path, error: (error as Error).message.split("\n")[0], stack: (error as Error).stack?.split("\n").slice(1, 4) }, "error");
      return respond(json({ error: `Unexpected server error (request ${requestId.slice(0, 8)}). ${(error as Error).message.split("\n")[0]}`, requestId }, 500));
    }
  });
}

const authed = (fn: Run) => (ctx: Ctx) => handle(ctx, fn as PublicRun, true);
const open = (fn: PublicRun) => (ctx: Ctx) => handle(ctx, fn, false);

export function createApp() {
  const e = env();
  return (
    new Elysia()
      .use(cors({ origin: e.allowedOrigins, credentials: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["content-type", "x-request-id"], exposeHeaders: ["x-request-id"] }))
      // A state-changing request from an origin outside the allowlist is refused before any handler runs. CORS alone
      // only stops the response from being read; this stops the side effect.
      .onBeforeHandle(({ request }) => {
        const origin = request.headers.get("origin");
        if (origin && !["GET", "HEAD", "OPTIONS"].includes(request.method) && !e.allowedOrigins.includes(origin)) return json({ error: "Origin not allowed." }, 403);
      })

      // Health ---------------------------------------------------------------------------------------------------------
      .get("/api/health", async () => {
        try {
          const d = await db();
          await d.query("select 1");
          return json({ ok: true, database: d.kind, chainId: e.chainId, privy: Boolean(e.privyAppId && e.privyAppSecret), faucet: deps().faucetConfigured(), push: deps().pushConfigured() });
        } catch {
          return json({ ok: false, database: "unreachable" }, 503);
        }
      })

      .get("/api/prices", open(async () => deps().prices()))
      .get("/api/markets/:id/candles", open(async ({ params, query }) => {
        const bucket = Number(query.bucket ?? 60);
        const limit = Number(query.limit ?? 60);
        if (![60, 300, 900, 3600, 14400, 86400].includes(bucket) || !Number.isInteger(limit) || limit < 1 || limit > 120) throw new InputError("Invalid candle range.");
        if (!params.id || !Object.hasOwn(await deps().markets(), params.id)) throw new NotFoundError("Unknown dreamDEX market.");
        return deps().candles(params.id, bucket, limit);
      }))

      // Session --------------------------------------------------------------------------------------------------------
      .post("/api/session", async (ctx) => {
        try {
          const { token, address } = (ctx.body ?? {}) as { token?: string; address?: string };
          if (!token || !address) return json({ error: "token and address are required" }, 400);
          const identity = await deps().verifyPrivy(token, address);
          const user = await upsertUser({ address: identity.address, privyUserId: identity.privyUserId, walletKind: identity.walletKind, email: identity.email });
          const cookie = await sessionCookie({ address: identity.address, privyUserId: identity.privyUserId, walletKind: identity.walletKind });
          return json({ user }, 200, { "set-cookie": cookie });
        } catch (error) {
          if (error instanceof AuthError) return json({ error: error.message }, 401);
          log("session.error", { error: (error as Error).message.split("\n")[0] }, "error");
          return json({ error: "Could not verify the Privy session." }, 401);
        }
      })
      .get("/api/session", open(async ({ session }) => ({ user: session ? await getUser(session.address) : null })))
      .delete("/api/session", () => json({ ok: true }, 200, { "set-cookie": clearedSessionCookie() }))
      // Local development and tests only: sign "Bump dev login <address> <unix seconds>" with the wallet's key.
      .post("/api/session/dev", async (ctx) => {
        if (!e.devAuth) return json({ error: "Not found" }, 404);
        const { address, message, signature } = (ctx.body ?? {}) as { address?: string; message?: string; signature?: Hex };
        if (!address || !message || !signature || !isAddress(address, { strict: false })) return json({ error: "address, message and signature are required" }, 400);
        const match = /^Bump dev login (0x[0-9a-fA-F]{40}) (\d+)$/.exec(message);
        if (!match || match[1]?.toLowerCase() !== address.toLowerCase() || Math.abs(deps().nowMs() / 1000 - Number(match[2])) > 300) return json({ error: "Stale or malformed dev login message." }, 401);
        if (!(await verifyMessage({ address: getAddress(address), message, signature }))) return json({ error: "Signature does not match the address." }, 401);
        const user = await upsertUser({ address: getAddress(address), walletKind: "dev" });
        return json({ user }, 200, { "set-cookie": await sessionCookie({ address: getAddress(address), privyUserId: null, walletKind: "dev" }) });
      })

      // Player -----------------------------------------------------------------------------------------------------------
      .post("/api/me/profile", authed(async ({ session, body }) => ({ user: await saveProfile(session.address, parse(profileInputSchema, body)) })))
      .post("/api/me/prefs", authed(async ({ session, body }) => ({ user: await savePrefs(session.address, body as PrefsRequest) })))
      .post("/api/me/account", authed(async ({ session, body }) => {
        const account = (body as { account?: unknown } | null)?.account;
        if (account !== null && typeof account !== "string") throw new InputError("account must be an address or null.");
        return { user: await setTradingAccount(session.address, account) };
      }))
      .get("/api/me/progress", authed(async ({ session }) => progressFor(session.address)))
      .post("/api/me/import", authed(async ({ session, body }) => {
        const imported = await importGuest(session.address, parse(guestImportSchema, body));
        return { imported, progress: await progressFor(session.address) };
      }))

      // Trades -----------------------------------------------------------------------------------------------------------
      .get("/api/trades", authed(async ({ session }) => listTrades(session.address)))
      .post("/api/trades", authed(async ({ session, body }) => {
        const trade = await openTrade(session.address, parse(openTradeSchema, body));
        return { trade, progress: await progressFor(session.address) };
      }))
      .post("/api/trades/:id/close", authed(async ({ session, params, body }) => {
        const trade = await closeTrade(session.address, params.id ?? "", parse(closeTradeSchema, body));
        return { trade, progress: await progressFor(session.address) };
      }))

      .post("/api/trades/:id/limits", authed(async ({ session, params, body }) => ({ trade: await updateLimits(session.address, params.id ?? "", parse(limitsSchema, body)) })))

      // Leaderboard (public; a signed-in viewer is always ranked) ------------------------------------------------------
      .get("/api/leaderboard", open(async ({ session, query }) => {
        const { period, kind } = parseBoard(query);
        return leaderboard(session?.address ?? null, period, kind);
      }))

      // Gas --------------------------------------------------------------------------------------------------------------
      .post("/api/gas/drip", authed(async ({ session }) => drip(session.address)))

      // Push ("Target hit!" while the app is shut) --------------------------------------------------------------------
      .get("/api/push/key", () => json({ publicKey: e.vapid?.publicKey ?? null }))
      .post("/api/me/push", authed(async ({ session, body }) => {
        await subscribe(session.address, parse(pushSubscriptionSchema, body));
        return { ok: true };
      }))
      .delete("/api/me/push", authed(async ({ session, body }) => {
        const { endpoint } = body as { endpoint?: unknown };
        if (typeof endpoint !== "string" || !endpoint) throw new InputError("endpoint is required.");
        await unsubscribe(session.address, endpoint);
        return { ok: true };
      }))
  );
}
