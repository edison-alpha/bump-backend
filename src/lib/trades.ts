import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { CloseReason, Side, Trade } from "@bump/api-types";
import { averagePrice, closePnlRaw, humanPrice, ownFills, type PerpGrid } from "@bump/dreamdex";
import { round2, type CloseTradeInput, type GuestImport, type OpenTradeInput } from "@bump/shared";
import { db, isUniqueViolation } from "./db/client.ts";
import { deps, type TxReceipt } from "./deps.ts";
import { env } from "./env.ts";
import { ConflictError, InputError, NotFoundError, UnavailableError } from "./errors.ts";
import { accountOf, key } from "./users.ts";

export type TradeRow = {
  id: string;
  address: string;
  source: "chain" | "guest";
  market_id: string;
  pool: string;
  side: Side;
  margin: number;
  leverage: number;
  target_pct: number;
  stop_pct: number;
  entry: number;
  entry_raw: string;
  size_raw: string;
  closed_raw: string;
  realized_pnl: number;
  opened_at: Date | string;
  open_tx: string | null;
  exit: number | null;
  pnl: number | null;
  reason: CloseReason | null;
  closed_at: Date | string | null;
  close_tx: string | null;
  /** The dreamDEX account the trade lives on; null for a trade on the player's own wallet (and for older rows). */
  account: string | null;
};

/** Whose positions to read for a trade: its smart account when it has one, else the player's wallet. */
export const accountOfTrade = (t: Pick<TradeRow, "address" | "account">) => t.account ?? t.address;

const ms = (v: Date | string) => new Date(v).getTime();

function openFraction(r: TradeRow): number {
  if (r.closed_at !== null) return 0;
  const size = BigInt(r.size_raw);
  if (size === 0n) return 1;
  return Number(((size - BigInt(r.closed_raw)) * 10_000n) / size) / 10_000;
}

export const toTrade = (r: TradeRow): Trade => ({
  id: r.id,
  source: r.source,
  marketId: r.market_id,
  side: r.side,
  margin: r.margin,
  leverage: r.leverage,
  targetPct: r.target_pct,
  stopPct: r.stop_pct,
  entry: r.entry,
  openedAt: ms(r.opened_at),
  openTx: r.open_tx,
  realizedPnl: round2(r.realized_pnl),
  openFraction: openFraction(r),
  exit: r.exit,
  pnl: r.pnl,
  reason: r.reason,
  closedAt: r.closed_at === null ? null : ms(r.closed_at),
  closeTx: r.close_tx,
});

/** Signed raw quote → USD. */
const usd = (raw: bigint, m: PerpGrid) => (raw < 0n ? -humanPrice(-raw, m) : humanPrice(raw, m));

export async function marketFor(marketId: string): Promise<PerpGrid> {
  const m = (await deps().markets())[marketId];
  if (!m) throw new UnavailableError(`dreamDEX does not list ${marketId.toUpperCase()} right now.`);
  return m;
}

/** A mined, successful receipt, or a 400 the app can show. */
async function minedReceipt(hash: string): Promise<TxReceipt> {
  const receipt = await deps().receipt(hash as Hex);
  if (!receipt) throw new InputError("That transaction is not on Hideki yet. Send it again once it is confirmed.");
  if (receipt.status !== "success") throw new InputError("That transaction failed on chain.");
  return receipt;
}

export async function openTrade(address: Address, input: OpenTradeInput): Promise<Trade> {
  const d = await db();
  const txHash = input.txHash.toLowerCase();
  if ((await d.query("select 1 from trades where open_tx = $1", [txHash])).length) throw new ConflictError("That transaction is already logged.");
  if ((await d.query("select 1 from trades where address = $1 and closed_at is null", [key(address)])).length) throw new ConflictError("Close your open trade first.");
  const m = await marketFor(input.marketId);
  const account = await accountOf(address);

  let entry = input.entry;
  let entryRaw = 0n;
  let sizeRaw = 0n;
  if (env().verifyTx) {
    // the fills are the truth: what the player got, at what price, whatever the app thought it sent
    const receipt = await minedReceipt(txHash);
    if (receipt.from.toLowerCase() !== key(address)) throw new InputError("That transaction was not sent from your wallet.");
    const fills = ownFills(receipt.logs, m.poolAddress, account);
    if (!fills || fills.isBid !== (input.side === "long")) throw new InputError(`That transaction did not open a ${input.side} on ${input.marketId.toUpperCase()}.`);
    entryRaw = averagePrice(fills);
    sizeRaw = fills.quantity;
    entry = humanPrice(entryRaw, m);
  }
  if (entry === undefined) throw new InputError("entry is required when receipt checks are off.");

  try {
    const [row] = await d.query<TradeRow>(
      `insert into trades (id, address, source, market_id, pool, side, margin, leverage, target_pct, stop_pct, entry, entry_raw, size_raw, opened_at, open_tx, account)
       values ($1, $2, 'chain', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
      [randomUUID(), key(address), input.marketId, m.poolAddress.toLowerCase(), input.side, input.margin, input.leverage, input.targetPct, input.stopPct, entry, entryRaw.toString(), sizeRaw.toString(), new Date(deps().nowMs()).toISOString(), txHash, key(account) === key(address) ? null : key(account)],
    );
    return toTrade(row as TradeRow);
  } catch (error) {
    // two requests raced past the checks above
    if (isUniqueViolation(error)) throw new ConflictError("That trade is already logged, or another one is open.");
    throw error;
  }
}

export type CloseFill = { txHash: string; qtyRaw: bigint; exit: number; pnl: number; reason: CloseReason; at: number };

/**
 * Adds one close to a trade: idempotent per transaction, so the app's report and the watcher can both see the same
 * close. The trade is closed once what is left is below the market's minimum order (a remainder nobody can trade), or at
 * once for a trade logged without receipt checks.
 */
export async function recordClose(trade: TradeRow, close: CloseFill, m: Pick<PerpGrid, "minQuantity"> | null): Promise<{ trade: Trade; recorded: boolean; closedNow: boolean }> {
  return (await db()).tx(async (t) => {
    const [current] = await t.query<TradeRow>("select * from trades where id = $1 for update", [trade.id]);
    if (!current) throw new NotFoundError("No such trade.");
    if (current.closed_at !== null) return { trade: toTrade(current), recorded: false, closedNow: false };
    const inserted = await t.query(
      "insert into trade_closes (tx_hash, trade_id, qty_raw, exit, pnl, reason, closed_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning tx_hash",
      [close.txHash.toLowerCase(), trade.id, close.qtyRaw.toString(), close.exit, close.pnl, close.reason, new Date(close.at).toISOString()],
    );
    if (!inserted.length) return { trade: toTrade(current), recorded: false, closedNow: false };

    const size = BigInt(current.size_raw);
    const closed = BigInt(current.closed_raw) + close.qtyRaw;
    const realized = current.realized_pnl + close.pnl;
    const done = size === 0n || size - closed < BigInt(m?.minQuantity ?? "1");
    const [row] = await t.query<TradeRow>(
      done
        ? "update trades set closed_raw = $2, realized_pnl = $3, exit = $4, pnl = $3, reason = $5, closed_at = $6, close_tx = $7 where id = $1 returning *"
        : "update trades set closed_raw = $2, realized_pnl = $3 where id = $1 returning *",
      done ? [trade.id, closed.toString(), round2(realized), close.exit, close.reason, new Date(close.at).toISOString(), close.txHash.toLowerCase()] : [trade.id, closed.toString(), round2(realized)],
    );
    return { trade: toTrade(row as TradeRow), recorded: true, closedNow: done };
  });
}

/** Reason for a close the player did not send: profit means the take-profit fired, a loss the stop (or a liquidation). */
export const autoReason = (pnl: number): CloseReason => (pnl > 0 ? "target" : "stop");

export async function closeTrade(address: Address, id: string, input: CloseTradeInput): Promise<Trade> {
  const d = await db();
  const [trade] = await d.query<TradeRow>("select * from trades where id = $1 and address = $2", [id, key(address)]);
  if (!trade) throw new NotFoundError("No such trade.");
  if (trade.closed_at !== null) throw new ConflictError("That trade is already closed.");
  const txHash = input.txHash.toLowerCase();
  if (txHash === trade.open_tx) throw new InputError("That is the transaction that opened this trade.");

  if (!env().verifyTx || BigInt(trade.size_raw) === 0n) {
    if (input.exit === undefined || input.pnl === undefined) throw new InputError("exit and pnl are required when receipt checks are off.");
    const r = await recordClose(trade, { txHash, qtyRaw: 0n, exit: input.exit, pnl: input.pnl, reason: input.reason ?? "manual", at: deps().nowMs() }, null);
    if (!r.recorded) throw new ConflictError("That transaction is already logged.");
    return r.trade;
  }

  const m = await marketFor(trade.market_id);
  const receipt = await minedReceipt(txHash);
  const fills = ownFills(receipt.logs, trade.pool || m.poolAddress, accountOfTrade(trade) as Address);
  if (!fills || fills.isBid !== (trade.side === "short")) throw new InputError("That transaction did not close this trade.");
  const remaining = BigInt(trade.size_raw) - BigInt(trade.closed_raw);
  const qtyRaw = fills.quantity < remaining ? fills.quantity : remaining;
  const exitRaw = averagePrice(fills);
  const pnl = round2(usd(closePnlRaw(trade.side, BigInt(trade.entry_raw), exitRaw, qtyRaw, m.baseDecimals), m));
  const reason = receipt.from.toLowerCase() === key(address) ? "manual" : autoReason(pnl);
  const r = await recordClose(trade, { txHash, qtyRaw, exit: humanPrice(exitRaw, m), pnl, reason, at: deps().nowMs() }, m);
  if (!r.recorded) throw new ConflictError("That transaction is already logged.");
  return r.trade;
}

/** Records new TP/SL percentages on an open trade (the stops themselves live on chain, armed by the app). */
export async function updateLimits(address: Address, id: string, limits: { targetPct: number; stopPct: number }): Promise<Trade> {
  const [row] = await (await db()).query<TradeRow>(
    "update trades set target_pct = $3, stop_pct = $4 where id = $1 and address = $2 and closed_at is null returning *",
    [id, key(address), limits.targetPct, limits.stopPct],
  );
  if (!row) throw new NotFoundError("No open trade with that id.");
  return toTrade(row);
}

export async function listTrades(address: Address, limit = 50): Promise<{ open: Trade | null; history: Trade[] }> {
  const d = await db();
  const [open] = await d.query<TradeRow>("select * from trades where address = $1 and closed_at is null", [key(address)]);
  const history = await d.query<TradeRow>("select * from trades where address = $1 and closed_at is not null order by closed_at desc limit $2", [key(address), limit]);
  return { open: open ? toTrade(open) : null, history: history.map(toTrade) };
}

/** Every trade of a player, oldest first, for rebuilding progress. */
export async function allTrades(address: Address): Promise<TradeRow[]> {
  return (await db()).query<TradeRow>("select * from trades where address = $1 order by opened_at", [key(address)]);
}

/** Open on-chain trades with a known size: the watcher's work list. */
export async function openChainTrades(): Promise<TradeRow[]> {
  return (await db()).query<TradeRow>("select * from trades where source = 'chain' and closed_at is null and size_raw <> '0' order by opened_at");
}

/**
 * Transactions already logged as closes of any of the player's trades. A close of an earlier trade on the same pool can
 * land in the same second the next one opens, so the watcher must not read it again for the new trade.
 */
export async function closedTxs(address: string): Promise<Set<string>> {
  const rows = await (await db()).query<{ tx_hash: string }>("select c.tx_hash from trade_closes c join trades t on t.id = c.trade_id where t.address = $1", [key(address)]);
  return new Set(rows.map((r) => r.tx_hash));
}

/**
 * A guest's practice history, accepted once per player. It earns XP like any trade but is marked "guest", so it never
 * reaches the leaderboard: these numbers come from the browser and cannot be checked.
 */
export async function importGuest(address: Address, input: GuestImport): Promise<number> {
  return (await db()).tx(async (t) => {
    const [user] = await t.query<{ guest_imported: boolean }>("select guest_imported from users where address = $1 for update", [key(address)]);
    if (!user) throw new NotFoundError("No such player.");
    if (user.guest_imported) throw new ConflictError("Guest progress was already imported.");
    const now = deps().nowMs();
    let imported = 0;
    for (const trade of input.history) {
      // practice trades have no open time; one second before the close keeps the open first when replayed
      const closedAt = Math.min(trade.closedAt, now);
      const inserted = await t.query(
        `insert into trades (id, address, source, market_id, side, margin, leverage, target_pct, stop_pct, entry, opened_at, exit, pnl, realized_pnl, reason, closed_at)
         values ($1, $2, 'guest', $3, $4, $5, $6, 0, 0, $7, $8, $9, $10, $10, $11, $12) on conflict (id) do nothing returning id`,
        [`guest:${key(address)}:${trade.id}`, key(address), trade.marketId, trade.side, trade.margin, trade.leverage, trade.entry, new Date(closedAt - 1000).toISOString(), trade.exit, trade.pnl, trade.reason ?? "manual", new Date(closedAt).toISOString()],
      );
      imported += inserted.length;
    }
    await t.query("update users set guest_imported = true, tutorial_done = tutorial_done or $2 where address = $1", [key(address), input.tutorialDone]);
    return imported;
  });
}
