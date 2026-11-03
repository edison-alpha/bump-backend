import type { Address } from "viem";
import type { ProgressView } from "@bump/api-types";
import { progressSummary, replayProgress, type ProgressEvent } from "@bump/shared";
import { deps } from "./deps.ts";
import { allTrades } from "./trades.ts";
import { getUser, tzOffset } from "./users.ts";

/**
 * XP, missions and streak, rebuilt from the trade log on every read. The browser never sends XP: it only logs trades,
 * and on-chain trades are only logged with a confirmed transaction. The log is small (one row per trade), so a full
 * replay stays cheap and the rules can change without a data migration.
 */
export async function progressFor(address: Address): Promise<ProgressView> {
  const [trades, tz, user] = await Promise.all([allTrades(address), tzOffset(address), getUser(address)]);
  const events: ProgressEvent[] = [];
  for (const t of trades) {
    events.push({ kind: "open", tradeId: t.id, at: new Date(t.opened_at).getTime() });
    if (t.closed_at !== null) events.push({ kind: "close", tradeId: t.id, at: new Date(t.closed_at).getTime(), pnl: t.pnl ?? 0, reason: t.reason ?? "manual" });
  }
  // a player who has closed a trade has had the tutorial, whatever the flag says
  const closedOne = trades.some((t) => t.closed_at !== null);
  return { ...progressSummary(replayProgress(events, tz), deps().nowMs(), tz), tutorialDone: (user?.tutorialDone ?? false) || closedOne };
}
