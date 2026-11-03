import type { Address, Hex } from "viem";
import { humanPrice, type PositionClose } from "@bump/dreamdex";
import { round2, signedUsdText } from "./format.ts";
import { deps } from "./deps.ts";
import { log } from "./log.ts";
import { notify } from "./push.ts";
import { autoReason, closedTxs, marketFor, openChainTrades, recordClose, type TradeRow } from "./trades.ts";

/**
 * Closes the app never reported: a TP/SL fired by the stop registry, a liquidation, or a close sent while the app was
 * shut. Each pass reads the indexer's position updates for every open trade and records the ones not yet logged, then
 * pushes "Target hit!" / "Stopped out" to the player's devices when a trade is done.
 */
export async function watchOpenTrades(): Promise<number> {
  let closed = 0;
  for (const trade of await openChainTrades()) {
    try {
      if (await syncTrade(trade)) closed++;
    } catch (error) {
      log("watcher.trade_failed", { trade: trade.id, error: (error as Error).message.split("\n")[0] }, "warn");
    }
  }
  return closed;
}

async function syncTrade(trade: TradeRow): Promise<boolean> {
  const m = await marketFor(trade.market_id);
  const openedSec = Math.floor(new Date(trade.opened_at).getTime() / 1000);
  const rows = await deps().closes(trade.address as Address, trade.pool || m.poolAddress, openedSec - 1);
  const seen = await closedTxs(trade.address);
  // one transaction can fill across several levels: one close per transaction
  const byTx = new Map<string, PositionClose[]>();
  for (const r of rows) {
    const tx = r.txHash.toLowerCase();
    if (tx === trade.open_tx || seen.has(tx)) continue;
    byTx.set(tx, [...(byTx.get(tx) ?? []), r]);
  }
  const ordered = [...byTx.entries()].sort((a, b) => Number((a[1][0]?.timestamp ?? 0n) - (b[1][0]?.timestamp ?? 0n)));
  for (const [txHash, parts] of ordered) {
    const qtyRaw = parts.reduce((s, p) => s + p.closedSize, 0n);
    const pnlRaw = parts.reduce((s, p) => s + p.realizedPnl, 0n);
    const pnl = round2(pnlRaw < 0n ? -humanPrice(-pnlRaw, m) : humanPrice(pnlRaw, m));
    const last = parts[parts.length - 1] as PositionClose;
    const exit = last.exitPrice === null ? trade.entry : humanPrice(last.exitPrice, m);
    // a close with an order behind it may be the player's own; a takeover or ADL never is
    const own = last.orderId !== null && (await deps().receipt(txHash as Hex))?.from.toLowerCase() === trade.address;
    const reason = own ? "manual" : autoReason(pnl);
    const { trade: updated, closedNow } = await recordClose(trade, { txHash, qtyRaw, exit, pnl, reason, at: Number(last.timestamp) * 1000 }, m);
    if (!closedNow) continue;
    log("watcher.closed", { trade: trade.id, txHash, reason, pnl });
    if (!own) {
      const market = trade.market_id.toUpperCase();
      await notify(trade.address, {
        title: reason === "target" ? "Target hit!" : "Stopped out",
        body: `${market} ${trade.side} closed at ${signedUsdText(updated.pnl ?? pnl)}.`,
        // History, not the Closed screen: the app may not hold this trade yet when the push is opened
        url: "/history",
        tag: `trade-${trade.id}`,
      });
    }
    return true;
  }
  return false;
}
