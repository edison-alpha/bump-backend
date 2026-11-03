import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import webpush from "web-push";
import type { PushMessage } from "@bump/api-types";
import { createReader, type PerpGrid, type PositionClose, type Reader } from "@bump/dreamdex";
import type { MarketId } from "@bump/shared";
import { env } from "./env.ts";
import { UnavailableError } from "./errors.ts";
import { verifyPrivyAccessToken, type PrivyIdentity } from "./privy.ts";

export type ReceiptLog = { address: string; topics: readonly Hex[]; data: Hex };
export type TxReceipt = { status: "success" | "reverted"; from: Address; logs: readonly ReceiptLog[] };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/**
 * Everything the server reads from or sends to the outside world, behind one seam so tests run the whole API against
 * a fake chain, indexer, faucet and push service without touching Somnia, Privy or a browser vendor.
 */
export type Deps = {
  verifyPrivy: (token: string, address: string) => Promise<PrivyIdentity>;
  /** The receipt of a mined Hideki transaction, or null when the node does not know the hash. */
  receipt: (hash: Hex) => Promise<TxReceipt | null>;
  /** dreamDEX perp rows for bump's markets, from the indexer (cached). */
  markets: () => Promise<Record<MarketId, PerpGrid>>;
  /** Position updates that realized PnL for `account` on `pool` since `fromSec`, from the indexer. */
  closes: (account: Address, pool: string, fromSec: number) => Promise<PositionClose[]>;
  sttBalance: (address: Address) => Promise<bigint>;
  /** Sends STT from the faucet key. Throws UnavailableError when FAUCET_PRIVATE_KEY is not set. */
  sendStt: (to: Address, amount: bigint) => Promise<Hex>;
  faucetConfigured: () => boolean;
  /** Delivers one web push. Resolves false when the subscription is gone (404/410) and should be dropped. */
  push: (target: PushTarget, message: PushMessage) => Promise<boolean>;
  pushConfigured: () => boolean;
  nowMs: () => number;
};

let publicClient: PublicClient | undefined;
let reader: Reader | undefined;

/** Hideki as a viem chain, built from the configured RPC so an override reaches every call. */
function hideki() {
  const e = env();
  return defineChain({ id: e.chainId, name: "Hideki Testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [e.rpcUrl] } } });
}

function client(): PublicClient {
  publicClient ??= createPublicClient({ chain: hideki(), transport: http(env().rpcUrl, { retryCount: 2, timeout: 10_000 }) });
  return publicClient;
}

const indexer = () => (reader ??= createReader(env().indexerUrl));

const live: Deps = {
  verifyPrivy: verifyPrivyAccessToken,
  receipt: async (hash) => {
    try {
      const r = await client().getTransactionReceipt({ hash });
      return { status: r.status, from: r.from, logs: r.logs };
    } catch (error) {
      if ((error as Error).name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
  },
  markets: () => indexer().markets(),
  closes: (account, pool, fromSec) => indexer().closes(account, pool, fromSec),
  sttBalance: (address) => client().getBalance({ address }),
  sendStt: async (to, amount) => {
    const key = env().faucetKey;
    if (!key) throw new UnavailableError("The STT faucet is not set up on this server.");
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: hideki(), transport: http(env().rpcUrl) });
    const hash = await wallet.sendTransaction({ to, value: amount });
    await client().waitForTransactionReceipt({ hash, timeout: 30_000 });
    return hash;
  },
  faucetConfigured: () => Boolean(env().faucetKey),
  push: async (target, message) => {
    const vapid = env().vapid;
    if (!vapid) return true;
    try {
      await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(message), {
        vapidDetails: vapid,
        TTL: 3_600,
      });
      return true;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return false;
      throw error;
    }
  },
  pushConfigured: () => Boolean(env().vapid),
  nowMs: () => Date.now(),
};

let current: Deps = live;

export const deps = () => current;

/** Tests swap in fakes for any subset. */
export function setDeps(overrides: Partial<Deps>) {
  current = { ...current, ...overrides };
}

export function resetDeps() {
  current = live;
  publicClient = undefined;
  void reader?.close();
  reader = undefined;
}
