# bump-backend

API for [bump](../bump): Bun + Elysia, Postgres (or embedded PGlite), Privy sign-in, and a trade log checked against
Somnia Hideki. Players sign their own trades in the browser; this server never holds a player's key. The only key it
can hold is the STT faucet's.

```sh
bun install            # also needs ../bump-packages installed
cp .env.example .env
bun run dev            # http://localhost:3300
bun test
bun run typecheck
```

Shared code comes from `../bump-packages` through the `@bump/*` path alias in `tsconfig.json`.

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/api/health` | – | Database, chain id, Privy and faucet configured |
| POST | `/api/session` | – | Privy access token + wallet → `bump_session` cookie |
| GET / DELETE | `/api/session` | – | Current player / sign out |
| POST | `/api/session/dev` | – | `BUMP_DEV_AUTH=1` only: sign `Bump dev login <address> <unix>` |
| POST | `/api/me/profile` | ✓ | Name, username (unique, case-insensitive), leaderboard visibility |
| POST | `/api/me/prefs` | ✓ | Timezone offset, tutorial flag, visibility |
| GET | `/api/me/progress` | ✓ | XP, level, streak, daily missions, last reward |
| POST | `/api/me/import` | ✓ | A guest's local history, once. Counts for XP, never for the leaderboard |
| GET | `/api/trades` | ✓ | Open trade and history |
| POST | `/api/trades` | ✓ | Log an open (tx must be mined, succeeded and sent by the player) |
| POST | `/api/trades/:id/close` | ✓ | Log a close, full or partial: just the tx hash, the rest is read from the fills |
| POST | `/api/trades/:id/limits` | ✓ | Record the TP/SL % the app re-armed on chain |
| GET | `/api/push/key` | – | VAPID public key (null when push is off) |
| POST / DELETE | `/api/me/push` | ✓ | Save / drop a browser push subscription |
| GET | `/api/leaderboard?period=&kind=` | – | Net PnL of on-chain trades; a signed-in viewer is always ranked |
| POST | `/api/gas/drip` | ✓ | STT from the faucet; one per cooldown, nothing for a funded wallet |

Errors are `{ error, requestId }` with 400 / 401 / 404 / 409 / 429 (`nextAt`) / 503.

## Trust model

Progress is rebuilt from the trade log on every read; the browser never sends XP. A trade is only logged with a mined,
successful Hideki receipt, and entry price, size, exit price, PnL and close reason are computed here from the order-book
fills in that receipt (the pool's `OrderPlaced` names the owner, `OrderFilled` the price), so a stop-registry fill proves it
belongs to that player and nothing the app reports is trusted. Partial closes are supported. A watcher polls the indexer
for TP/SL fills and liquidations the app never reported, records them, and sends a web push. The leaderboard ranks that
verified price PnL (not equity, which voucher credits and deposits would inflate). Not verified: funding and fees.

## Deploy (VPS + Semaphore)

bump-backend runs as `bump-backend.service` (Bun, port 7000) next to the other apps on the VPS, behind nginx on its own
host; the app (fe-bump) is on Vercel and calls it cross-site.

| File | What |
|---|---|
| `deploy/bump-backend.service` | systemd unit, `MemoryMax=450M` (the box is small and shared) |
| `deploy/nginx-bump.conf` | API-only vhost + Let's Encrypt (`API_HOST` placeholder) |
| `scripts/deploy-remote.sh` | on the VPS: pull bump-packages + bump-backend, `bun install`, restart, wait for `/api/health` |
| `deploy/bump.yml` | Semaphore UI template (Ansible) that runs the script, same shape as the sama one |
| `.semaphore/*.yml` | Semaphore CI: tests on every push, manual "Deploy to VPS" promotion (secret `bump-vps`: `VPS_HOST`, `VPS_USER`, deploy key) |

Production `.env` on the VPS (never committed): `NODE_ENV=production`, `PORT=7000`, `SESSION_SECRET`, `PRIVY_APP_ID`,
`PRIVY_APP_SECRET`, `VAPID_*`, `BUMP_ALLOWED_ORIGINS=https://<the Vercel origin>`, `BUMP_CROSS_SITE_COOKIE=1`. Receipt checks
are always on in production. The database is embedded PGlite in `.bump-db` unless `DATABASE_URL` is set.