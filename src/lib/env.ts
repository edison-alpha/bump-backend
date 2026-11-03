import { parseEther, type Hex } from "viem";
import { HIDEKI } from "@bump/dreamdex";

/**
 * Configuration comes only from the process environment (Bun loads .env automatically in development). Secrets are read
 * here and never logged; log.ts redacts any field that looks like one.
 */
function read() {
  const e = process.env;
  const production = e.NODE_ENV === "production";
  const faucetKey = e.FAUCET_PRIVATE_KEY?.trim();
  return {
    production,
    port: Number(e.PORT ?? 3300),
    chainId: HIDEKI.chainId,
    rpcUrl: e.HIDEKI_RPC_URL || HIDEKI.rpcUrl,
    /** postgres://… for a real server; empty means embedded PGlite in .bump-db (or memory:// in tests). */
    databaseUrl: e.DATABASE_URL || undefined,
    pgliteDir: e.BUMP_PGLITE_DIR || ".bump-db",
    sessionSecret: e.SESSION_SECRET || undefined,
    privyAppId: e.PRIVY_APP_ID || e.NEXT_PUBLIC_PRIVY_APP_ID || undefined,
    privyAppSecret: e.PRIVY_APP_SECRET || undefined,
    allowedOrigins: (e.BUMP_ALLOWED_ORIGINS ?? "http://localhost:3200").split(",").map((s) => s.trim()).filter(Boolean),
    /** Cross-site cookie (frontend and API on different sites) needs SameSite=None; Partitioned. */
    crossSiteCookie: e.BUMP_CROSS_SITE_COOKIE === "1",
    devAuth: e.BUMP_DEV_AUTH === "1" && !production,
    faucetKey: faucetKey ? (faucetKey.startsWith("0x") ? faucetKey : `0x${faucetKey}`) as Hex : undefined,
    dripAmount: parseEther(e.BUMP_DRIP_STT || "0.5"),
    dripMinBalance: parseEther(e.BUMP_DRIP_MIN_STT || "0.35"),
    dripCooldownMs: Number(e.BUMP_DRIP_COOLDOWN_HOURS ?? 24) * 3_600_000,
    /** Off only for local development without a chain; production always checks receipts. */
    verifyTx: e.BUMP_VERIFY_TX !== "0" || production,
    indexerUrl: e.HIDEKI_INDEXER_URL || HIDEKI.indexerUrl,
    vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT || "mailto:admin@bump.local" } : undefined,
    /** 0 turns the watcher off (tests). */
    watchIntervalSec: Number(e.BUMP_WATCH_INTERVAL_SEC ?? 15),
  };
}

export type Env = ReturnType<typeof read>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= read();
  return cached;
}

/** Tests change process.env between cases; this drops the cached view. */
export function resetEnv() {
  cached = undefined;
}
