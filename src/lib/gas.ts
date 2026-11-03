import { randomUUID } from "node:crypto";
import { formatEther, type Address } from "viem";
import type { GasDripResponse } from "@bump/api-types";
import { db } from "./db/client.ts";
import { deps } from "./deps.ts";
import { env } from "./env.ts";
import { log } from "./log.ts";
import { RateLimitError, UnavailableError } from "./errors.ts";
import { key } from "./users.ts";

/** Drips being sent right now, so a double tap cannot send two before the first is recorded. */
const inflight = new Set<string>();

/**
 * STT for a player's gas and TP/SL trigger fees, from the faucet key. One drip per player per cooldown, and none for a
 * wallet that already holds enough. The faucet never touches the player's key or their USDso.
 */
export async function drip(address: Address): Promise<GasDripResponse> {
  const e = env();
  const d = deps();
  if (!d.faucetConfigured()) throw new UnavailableError("The STT faucet is not set up on this server.");
  const k = key(address);
  if (inflight.has(k)) throw new RateLimitError("A drip is already on its way.", d.nowMs() + 30_000);
  inflight.add(k);
  try {
    const [last] = await (await db()).query<{ created_at: Date | string }>("select created_at from gas_drips where address = $1 order by created_at desc limit 1", [k]);
    const nextAt = last ? new Date(last.created_at).getTime() + e.dripCooldownMs : null;
    const balance = await d.sttBalance(address);
    if (balance >= e.dripMinBalance) return { txHash: null, amount: "0", balance: formatEther(balance), nextAt };
    if (nextAt !== null && nextAt > d.nowMs()) throw new RateLimitError("You got STT recently. Try again later.", nextAt);
    const txHash = await d.sendStt(address, e.dripAmount);
    await (await db()).query("insert into gas_drips (id, address, amount, tx_hash, created_at) values ($1, $2, $3, $4, $5)", [randomUUID(), k, e.dripAmount.toString(), txHash, new Date(d.nowMs()).toISOString()]);
    log("gas.dripped", { address: k, amount: formatEther(e.dripAmount), txHash });
    return { txHash, amount: formatEther(e.dripAmount), balance: formatEther(balance + e.dripAmount), nextAt: d.nowMs() + e.dripCooldownMs };
  } finally {
    inflight.delete(k);
  }
}
