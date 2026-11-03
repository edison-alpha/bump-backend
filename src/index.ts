import { createApp } from "./app.ts";
import { db } from "./lib/db/client.ts";
import { env } from "./lib/env.ts";
import { log, providerHost } from "./lib/log.ts";
import { watchOpenTrades } from "./lib/watcher.ts";

const e = env();
await db();
const app = createApp().listen(e.port);
log("server.started", { port: e.port, chainId: e.chainId, rpc: providerHost(e.rpcUrl), origins: e.allowedOrigins, privy: Boolean(e.privyAppId && e.privyAppSecret), faucet: Boolean(e.faucetKey), push: Boolean(e.vapid), verifyTx: e.verifyTx, devAuth: e.devAuth });

/** TP/SL fills and liquidations the app never reported, picked up from the indexer. */
if (e.watchIntervalSec > 0) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await watchOpenTrades();
    } catch (error) {
      log("watcher.failed", { error: (error as Error).message.split("\n")[0] }, "error");
    } finally {
      running = false;
    }
  }, e.watchIntervalSec * 1000);
}

export type App = typeof app;
