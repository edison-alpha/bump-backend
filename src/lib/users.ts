import { getAddress, type Address } from "viem";
import type { PrefsRequest, ProfileRequest, SessionUser } from "@bump/api-types";
import { db, isUniqueViolation } from "./db/client.ts";
import { deps } from "./deps.ts";
import { ConflictError, InputError } from "./errors.ts";

/** Addresses are stored lowercase so lookups never depend on checksum casing. */
export const key = (address: string) => address.toLowerCase();

type UserRow = {
  address: string;
  email: string | null;
  name: string;
  username: string;
  show_on_leaderboard: boolean;
  tz_offset_min: number;
  tutorial_done: boolean;
  guest_imported: boolean;
  trading_account: string | null;
};

const toUser = (r: UserRow): SessionUser => ({
  address: getAddress(r.address),
  username: r.username,
  name: r.name,
  email: r.email,
  showOnLeaderboard: r.show_on_leaderboard,
  tutorialDone: r.tutorial_done,
  guestImported: r.guest_imported,
  tradingAccount: r.trading_account ? getAddress(r.trading_account) : null,
});

export async function upsertUser(input: { address: Address; privyUserId?: string | null; walletKind?: string; email?: string | null }): Promise<SessionUser> {
  const [row] = await (await db()).query<UserRow>(
    `insert into users (address, privy_user_id, wallet_kind, email) values ($1, $2, $3, $4)
     on conflict (address) do update set last_seen_at = now(),
       privy_user_id = coalesce(excluded.privy_user_id, users.privy_user_id),
       wallet_kind = coalesce(excluded.wallet_kind, users.wallet_kind),
       email = coalesce(excluded.email, users.email)
     returning *`,
    [key(input.address), input.privyUserId ?? null, input.walletKind ?? null, input.email ?? null],
  );
  return toUser(row as UserRow);
}

export async function getUser(address: Address): Promise<SessionUser | null> {
  const [row] = await (await db()).query<UserRow>("select * from users where address = $1", [key(address)]);
  return row ? toUser(row) : null;
}

/** The address whose balance and positions this player trades: their dreamDEX smart account when linked, else their wallet. */
export async function accountOf(address: Address): Promise<Address> {
  const [row] = await (await db()).query<{ trading_account: string | null }>("select trading_account from users where address = $1", [key(address)]);
  return getAddress(row?.trading_account ?? address);
}

/**
 * Links (or, with null, unlinks) the dreamDEX smart account `address` trades through. The account has to be a Safe the
 * sign-in wallet owns outright and can act for alone: that is what lets the wallet send the account's transactions
 * without anyone else signing. Not an open trade's account, so a player must close first.
 */
export async function setTradingAccount(address: Address, account: string | null): Promise<SessionUser> {
  const d = await db();
  if ((await d.query("select 1 from trades where address = $1 and closed_at is null", [key(address)])).length) throw new ConflictError("Close your open trade before switching accounts.");
  let linked: string | null = null;
  if (account !== null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new InputError("That is not a wallet address.");
    const safe = await deps().safeOwners(getAddress(account));
    if (!safe) throw new InputError("That address is not a dreamDEX smart account on Hideki.");
    if (!safe.owners.some((o) => o.toLowerCase() === key(address))) throw new InputError("Your bump wallet is not an owner of that account yet. Add it as an owner in dreamDEX first.");
    if (safe.threshold !== 1) throw new InputError("That account needs more than one signature, which bump can't send on its own.");
    linked = key(account);
  }
  const [row] = await d.query<UserRow>("update users set trading_account = $2, last_seen_at = now() where address = $1 returning *", [key(address), linked]);
  return toUser(row as UserRow);
}

export async function tzOffset(address: Address): Promise<number> {
  const [row] = await (await db()).query<{ tz_offset_min: number }>("select tz_offset_min from users where address = $1", [key(address)]);
  return row?.tz_offset_min ?? 0;
}

/** Usernames are unique case-insensitively; the stored spelling is the player's own. */
export async function saveProfile(address: Address, input: ProfileRequest): Promise<SessionUser> {
  try {
    const [row] = await (await db()).query<UserRow>(
      "update users set name = $2, username = $3, username_key = $4, show_on_leaderboard = $5, last_seen_at = now() where address = $1 returning *",
      [key(address), input.name, input.username, input.username.toLowerCase(), input.showOnLeaderboard],
    );
    return toUser(row as UserRow);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("That username is taken.");
    throw error;
  }
}

export async function savePrefs(address: Address, prefs: PrefsRequest): Promise<SessionUser> {
  if (prefs.tzOffsetMin !== undefined && (!Number.isInteger(prefs.tzOffsetMin) || Math.abs(prefs.tzOffsetMin) > 14 * 60)) throw new InputError("tzOffsetMin must be whole minutes within ±14 hours.");
  for (const flag of ["tutorialDone", "showOnLeaderboard"] as const) {
    if (prefs[flag] !== undefined && typeof prefs[flag] !== "boolean") throw new InputError(`${flag} must be true or false.`);
  }
  const [row] = await (await db()).query<UserRow>(
    `update users set tz_offset_min = coalesce($2, tz_offset_min), tutorial_done = coalesce($3, tutorial_done),
       show_on_leaderboard = coalesce($4, show_on_leaderboard), last_seen_at = now()
     where address = $1 returning *`,
    [key(address), prefs.tzOffsetMin ?? null, prefs.tutorialDone ?? null, prefs.showOnLeaderboard ?? null],
  );
  return toUser(row as UserRow);
}
