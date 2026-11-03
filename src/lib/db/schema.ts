/**
 * Product database schema. Offchain state only: players, their trade log, faucet drips and push subscriptions.
 * Balances, positions and prices are always re-read from Somnia. Each entry runs once, in order, and is recorded in
 * schema_migrations.
 */
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "001_bump",
    sql: `
create table users (
  address text primary key,
  privy_user_id text,
  email text,
  wallet_kind text,
  name text not null default '',
  username text not null default '',
  username_key text unique,
  show_on_leaderboard boolean not null default false,
  tz_offset_min integer not null default 0,
  tutorial_done boolean not null default false,
  guest_imported boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table trades (
  id text primary key,
  address text not null references users(address),
  source text not null,
  market_id text not null,
  pool text not null default '',
  side text not null,
  margin double precision not null,
  leverage double precision not null,
  target_pct double precision not null,
  stop_pct double precision not null,
  entry double precision not null,
  entry_raw text not null default '0',
  size_raw text not null default '0',
  closed_raw text not null default '0',
  realized_pnl double precision not null default 0,
  opened_at timestamptz not null,
  open_tx text unique,
  exit double precision,
  pnl double precision,
  reason text,
  closed_at timestamptz,
  close_tx text
);

create index trades_by_address on trades (address, opened_at);

create index trades_by_close on trades (closed_at) where closed_at is not null;

create unique index trades_one_open on trades (address) where closed_at is null;

create table trade_closes (
  tx_hash text not null,
  trade_id text not null references trades(id),
  qty_raw text not null,
  exit double precision not null,
  pnl double precision not null,
  reason text not null,
  closed_at timestamptz not null,
  primary key (tx_hash, trade_id)
);

create table gas_drips (
  id text primary key,
  address text not null references users(address),
  amount text not null,
  tx_hash text not null,
  created_at timestamptz not null default now()
);

create index gas_drips_by_address on gas_drips (address, created_at);

create table push_subscriptions (
  endpoint text primary key,
  address text not null references users(address),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
)
`,
  },
  {
    // A player can trade through their dreamDEX smart account instead of their sign-in wallet: the account holds the
    // balance and the positions, the sign-in wallet signs and pays gas. A trade remembers which account it was opened on.
    id: "002_trading_account",
    sql: `
alter table users add column trading_account text;

alter table trades add column account text
`,
  },
];
