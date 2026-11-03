import { getAddress, type Address } from "viem";
import type { PrefsRequest, ProfileRequest, SessionUser } from "@bump/api-types";
import { db, isUniqueViolation } from "./db/client.ts";
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
};

const toUser = (r: UserRow): SessionUser => ({
  address: getAddress(r.address),
  username: r.username,
  name: r.name,
  email: r.email,
  showOnLeaderboard: r.show_on_leaderboard,
  tutorialDone: r.tutorial_done,
  guestImported: r.guest_imported,
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
