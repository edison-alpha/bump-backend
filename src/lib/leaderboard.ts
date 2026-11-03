import type { Address } from "viem";
import type { LeaderboardEntry, LeaderboardKind, LeaderboardPeriod, LeaderboardResponse } from "@bump/api-types";
import { db } from "./db/client.ts";
import { deps } from "./deps.ts";
import { InputError } from "./errors.ts";
import { key } from "./users.ts";

/** How far back each period reaches, matching the app's PERIOD_MS. */
const PERIOD_MS: Record<LeaderboardPeriod, number> = { today: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 };
const LIMIT = 50;

export function parseBoard(query: Record<string, string | undefined>): { period: LeaderboardPeriod; kind: LeaderboardKind } {
  const period = (query.period ?? "week") as LeaderboardPeriod;
  const kind = (query.kind ?? "wins") as LeaderboardKind;
  if (!(period in PERIOD_MS)) throw new InputError("period must be today, week or month.");
  if (kind !== "wins" && kind !== "losses") throw new InputError("kind must be wins or losses.");
  return { period, kind };
}

type BoardRow = { address: string; name: string; username: string; pnl: number; volume: number; trades: string | number };

/**
 * Net PnL of closed on-chain trades in the period, for players who opted in and picked a username. Guest imports never
 * count. The viewer is always ranked, on the side their PnL falls on, so they see where they'd stand while hidden.
 *
 * PnL here is what the app logged at close (gross, before funding and fees). The equity-based score from
 * listAccountEquities replaces it once the leaderboard cron runs.
 */
export async function leaderboard(viewer: Address | null, period: LeaderboardPeriod, kind: LeaderboardKind): Promise<LeaderboardResponse> {
  const since = new Date(deps().nowMs() - PERIOD_MS[period]).toISOString();
  const rows = await (await db()).query<BoardRow>(
    `select t.address, u.name, u.username, sum(t.pnl) as pnl, sum(t.margin) as volume, count(*) as trades
     from trades t join users u on u.address = t.address
     where t.source = 'chain' and t.closed_at >= $1 and ((u.show_on_leaderboard and u.username <> '') or t.address = $2)
     group by t.address, u.name, u.username
     having ${kind === "wins" ? "sum(t.pnl) >= 0" : "sum(t.pnl) < 0"}
     order by sum(t.pnl) ${kind === "wins" ? "desc" : "asc"}, t.address`,
    [since, viewer ? key(viewer) : null],
  );
  const you = viewer ? key(viewer) : null;
  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  // the top of the board, plus the viewer's own row wherever it falls
  const shown = ranked.filter((r) => r.rank <= LIMIT || r.address === you);
  const entries: LeaderboardEntry[] = shown.map((r) => ({
    rank: r.rank,
    id: r.username || r.address.slice(0, 8),
    name: r.name || r.username || "You",
    pnl: Math.round(Number(r.pnl) * 100) / 100,
    volume: Math.round(Number(r.volume) * 100) / 100,
    trades: Number(r.trades),
    ...(r.address === you ? { isYou: true } : {}),
  }));
  return { period, kind, entries };
}
