import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { parseEther, type Address } from "viem";
import { rawPrice } from "@bump/dreamdex";
import { XP } from "@bump/shared";
import { MARKETS } from "@bump/testkit";
import type { PushMessage } from "@bump/api-types";
import { createApp } from "../src/app.ts";
import { resetDb } from "../src/lib/db/client.ts";
import { resetDeps, setDeps, type PushTarget } from "../src/lib/deps.ts";
import { resetEnv } from "../src/lib/env.ts";
import { AuthError } from "../src/lib/errors.ts";
import { watchOpenTrades } from "../src/lib/watcher.ts";
import { Client, DEV_KEYS, FakeChain, testEnv } from "./helpers.ts";

/**
 * The API without a network: dev login, a fake Hideki node whose receipts carry real order-book logs, a fake indexer,
 * faucet and push service. Covers sessions, profiles, trades verified from their fills (partial closes included), the
 * watcher, server-side progress, the leaderboard, the gas drip and push subscriptions.
 */
let app: ReturnType<typeof createApp>;
let chain: FakeChain;
let pushed: { target: PushTarget; message: PushMessage }[];
let goneEndpoints: Set<string>;
let alice: Client;
let bob: Client;
let carol: Client;

const btc = MARKETS.btc;
const pool = btc.poolAddress;
const REGISTRY = btc.stopRegistry as Address;
const usd = (n: number) => rawPrice(n, btc);
const draft = { marketId: "btc", side: "long", margin: 50, leverage: 2, targetPct: 1, stopPct: 0.5 } as const;

beforeAll(async () => {
  testEnv();
  resetEnv();
  await resetDb();
  resetDeps();
  chain = new FakeChain();
  pushed = [];
  goneEndpoints = new Set();
  setDeps({
    receipt: async (hash) => chain.receipts.get(hash) ?? null,
    markets: async () => ({ btc: MARKETS.btc, eth: MARKETS.eth }),
    closes: async (account, p, fromSec) => (chain.closes.get(`${account.toLowerCase()}:${p.toLowerCase()}`) ?? []).filter((c) => c.timestamp >= BigInt(fromSec)),
    sttBalance: async (address) => chain.balances.get(address.toLowerCase()) ?? 0n,
    sendStt: async (to, amount) => {
      chain.sent.push({ to, amount });
      return chain.tx(to);
    },
    faucetConfigured: () => true,
    push: async (target, message) => {
      pushed.push({ target, message });
      return !goneEndpoints.has(target.endpoint);
    },
    pushConfigured: () => true,
    verifyPrivy: async () => {
      throw new AuthError("Privy session could not be verified: test");
    },
  });
  app = createApp();
  alice = await new Client(app, DEV_KEYS[0]).login();
  bob = await new Client(app, DEV_KEYS[1]).login();
  carol = await new Client(app, DEV_KEYS[2]).login();
});

afterAll(async () => {
  await resetDb();
  resetDeps();
});

describe("session", () => {
  it("binds the dev-login wallet to an httpOnly cookie and reports the player", async () => {
    expect(alice.cookie).toMatch(/^bump_session=/);
    const me = await alice.get("/api/session");
    expect(me.body.user).toMatchObject({ address: alice.address, username: "", showOnLeaderboard: false, tutorialDone: false, guestImported: false });
    const anon = new Client(app, DEV_KEYS[3]);
    expect((await anon.get("/api/session")).body).toEqual({ user: null });
    expect((await anon.get("/api/me/progress")).status).toBe(401);
  });

  it("rejects a stale or forged dev login and an unverifiable Privy token", async () => {
    const c = new Client(app, DEV_KEYS[3]);
    const stale = `Bump dev login ${c.address} ${Math.floor(Date.now() / 1000) - 3_600}`;
    expect((await c.post("/api/session/dev", { address: c.address, message: stale, signature: await c.account.signMessage({ message: stale }) })).status).toBe(401);
    const fresh = `Bump dev login ${c.address} ${Math.floor(Date.now() / 1000)}`;
    expect((await c.post("/api/session/dev", { address: c.address, message: fresh, signature: await alice.account.signMessage({ message: fresh }) })).status).toBe(401);
    expect((await c.post("/api/session", {})).status).toBe(400);
    expect((await c.post("/api/session", { token: "fake", address: c.address })).status).toBe(401);
  });

  it("refuses writes from an origin outside the allowlist", async () => {
    expect((await alice.call("POST", "/api/me/prefs", { tutorialDone: true }, "https://evil.example")).status).toBe(403);
  });
});

describe("profile", () => {
  it("saves a profile and keeps usernames unique regardless of case", async () => {
    const saved = await alice.post("/api/me/profile", { name: "Alice", username: "Alice_1", showOnLeaderboard: false });
    expect(saved.status).toBe(200);
    expect(saved.body.user).toMatchObject({ name: "Alice", username: "Alice_1" });
    expect((await bob.post("/api/me/profile", { name: "Bob", username: "alice_1", showOnLeaderboard: true })).status).toBe(409);
    expect((await bob.post("/api/me/profile", { name: "Bob", username: "bob", showOnLeaderboard: true })).status).toBe(200);
    const bad = await carol.post("/api/me/profile", { name: "Carol", username: "c!", showOnLeaderboard: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/^username:/);
  });

  it("stores the timezone and tutorial flag, and validates them", async () => {
    expect((await alice.post("/api/me/prefs", { tzOffsetMin: -420, tutorialDone: true })).body.user.tutorialDone).toBe(true);
    expect((await alice.post("/api/me/prefs", { tzOffsetMin: 99_999 })).status).toBe(400);
  });
});

describe("trades verified from fills", () => {
  let tradeId: string;

  it("refuses an open whose transaction is unknown, reverted, someone else's or the wrong side", async () => {
    expect((await alice.post("/api/trades", { ...draft, txHash: chain.unknown() })).body.error).toMatch(/not on Hideki yet/);
    expect((await alice.post("/api/trades", { ...draft, txHash: chain.tx(alice.address, "reverted") })).body.error).toMatch(/failed on chain/);
    expect((await alice.post("/api/trades", { ...draft, txHash: chain.tx(bob.address) })).body.error).toMatch(/not sent from your wallet/);
    const short = chain.order(alice.address, { pool, isBid: false, fills: [{ quantity: 147_000n, price: usd(68_000) }] });
    expect((await alice.post("/api/trades", { ...draft, txHash: short })).body.error).toMatch(/did not open a long on BTC/);
    expect((await alice.post("/api/trades", { ...draft, leverage: 50, txHash: chain.tx(alice.address) })).status).toBe(400);
    expect((await alice.post("/api/trades", { ...draft, marketId: "sol", txHash: chain.tx(alice.address) })).status).toBe(503);
  });

  it("takes the entry from the fills, pays the call XP and allows one open trade at a time", async () => {
    const txHash = chain.order(alice.address, { pool, isBid: true, fills: [{ quantity: 100_000n, price: usd(67_990) }, { quantity: 47_000n, price: usd(68_021.27) }] });
    // the app's claimed entry is ignored
    const opened = await alice.post("/api/trades", { ...draft, entry: 1, txHash });
    expect(opened.status).toBe(200);
    expect(opened.body.trade).toMatchObject({ source: "chain", side: "long", openTx: txHash, openFraction: 1, realizedPnl: 0, closedAt: null });
    expect(opened.body.trade.entry).toBeCloseTo(68_000, 2);
    expect(opened.body.progress.xp).toBe(XP.call);
    tradeId = opened.body.trade.id;
    expect((await alice.post("/api/trades", { ...draft, txHash })).status).toBe(409);
    expect((await alice.post("/api/trades", { ...draft, txHash: chain.order(alice.address, { pool, isBid: true, fills: [{ quantity: 1000n, price: usd(1) }] }) })).body.error).toBe("Close your open trade first.");
  });

  it("closes on a stop-registry fill: PnL and reason come from the chain, not the app", async () => {
    expect((await alice.post(`/api/trades/${tradeId}/close`, { txHash: chain.tx(REGISTRY) })).body.error).toBe("That transaction did not close this trade.");
    const tp = chain.order(REGISTRY, { owner: alice.address, pool, isBid: false, fills: [{ quantity: 147_000n, price: usd(68_680) }] });
    const closed = await alice.post(`/api/trades/${tradeId}/close`, { txHash: tp, pnl: 999, reason: "manual" });
    expect(closed.status).toBe(200);
    // $680 × 0.00147 BTC
    expect(closed.body.trade).toMatchObject({ exit: 68_680, pnl: 1, reason: "target", openFraction: 0 });
    expect(closed.body.progress.xp).toBe(XP.call + XP.close + XP.win + XP.target + 30);
    expect(closed.body.progress.lastReward).toMatchObject({ tradeId, firstTrade: true, missions: ["Hit a profit target"], streak: 1 });
    expect((await alice.post(`/api/trades/${tradeId}/close`, { txHash: tp })).status).toBe(409);
  });

  it("records partial closes and finishes the trade on the last one", async () => {
    const opened = await bob.post("/api/trades", { ...draft, side: "short", txHash: chain.order(bob.address, { pool, isBid: false, fills: [{ quantity: 147_000n, price: usd(68_000) }] }) });
    const id = opened.body.trade.id;
    const half = await bob.post(`/api/trades/${id}/close`, { txHash: chain.order(bob.address, { pool, isBid: true, fills: [{ quantity: 73_000n, price: usd(67_000) }] }) });
    expect(half.body.trade).toMatchObject({ realizedPnl: 0.73, closedAt: null });
    expect(half.body.trade.openFraction).toBeCloseTo(0.5034, 4);
    expect((await alice.post(`/api/trades/${id}/close`, { txHash: chain.tx(alice.address) })).status).toBe(404);
    // more than is left: clamped to the open size
    const rest = await bob.post(`/api/trades/${id}/close`, { txHash: chain.order(bob.address, { pool, isBid: true, fills: [{ quantity: 80_000n, price: usd(67_000) }] }) });
    expect(rest.body.trade).toMatchObject({ pnl: 1.47, realizedPnl: 1.47, reason: "manual", openFraction: 0 });
    const list = await bob.get("/api/trades");
    expect(list.body.open).toBeNull();
    expect(list.body.history).toHaveLength(1);
  });
});

describe("limits", () => {
  it("stores re-armed TP/SL on an open trade only", async () => {
    const opened = await carol.post("/api/trades", { ...draft, txHash: chain.order(carol.address, { pool, isBid: true, fills: [{ quantity: 147_000n, price: usd(68_000) }] }) });
    const id = opened.body.trade.id;
    expect((await carol.post(`/api/trades/${id}/limits`, { targetPct: 2, stopPct: 1 })).body.trade).toMatchObject({ targetPct: 2, stopPct: 1 });
    expect((await carol.post(`/api/trades/${id}/limits`, { targetPct: 0, stopPct: 1 })).status).toBe(400);
    expect((await bob.post(`/api/trades/${id}/limits`, { targetPct: 2, stopPct: 1 })).status).toBe(404);
  });
});

describe("leaderboard", () => {
  it("ranks opted-in players and always shows the viewer, even while hidden", async () => {
    const forAlice = await alice.get("/api/leaderboard?period=week&kind=wins");
    expect(forAlice.body.entries.map((e: { id: string; isYou?: boolean }) => [e.id, e.isYou ?? false])).toEqual([["bob", false], ["Alice_1", true]]);
    expect(forAlice.body.entries[0]).toMatchObject({ rank: 1, pnl: 1.47, volume: 50, trades: 1 });
    const forCarol = await carol.get("/api/leaderboard?period=today&kind=wins");
    expect(forCarol.body.entries.map((e: { id: string }) => e.id)).toEqual(["bob"]);
    expect((await new Client(app, DEV_KEYS[3]).get("/api/leaderboard")).status).toBe(200);
    expect((await carol.get("/api/leaderboard?period=year")).status).toBe(400);
  });
});

describe("watcher and push", () => {
  it("stores a push subscription and serves the public key", async () => {
    expect((await alice.post("/api/me/push", { endpoint: "https://push.example/a1", keys: { p256dh: "p", auth: "a" } })).status).toBe(200);
    expect((await alice.post("/api/me/push", { endpoint: "https://push.example/gone", keys: { p256dh: "p", auth: "a" } })).status).toBe(200);
    expect((await alice.post("/api/me/push", { endpoint: "not a url", keys: { p256dh: "p", auth: "a" } })).status).toBe(400);
    expect((await alice.get("/api/push/key")).status).toBe(200);
  });

  it("closes a trade whose stop fired while the app was shut, and pushes it", async () => {
    const opened = await alice.post("/api/trades", { ...draft, txHash: chain.order(alice.address, { pool, isBid: true, fills: [{ quantity: 147_000n, price: usd(68_000) }] }) });
    const id = opened.body.trade.id;
    expect(await watchOpenTrades()).toBe(0);

    // the SL fired: the registry's tx, a loss of $340 × 0.00147
    const sl = chain.order(REGISTRY, { owner: alice.address, pool, isBid: false, fills: [{ quantity: 147_000n, price: usd(67_660) }] });
    chain.indexClose(alice.address, pool, { txHash: sl, orderId: 9n, closedSize: 147_000n, realizedPnl: -usd(0.4998), exitPrice: usd(67_660), timestamp: BigInt(Math.floor(Date.now() / 1000)) });
    goneEndpoints.add("https://push.example/gone");
    expect(await watchOpenTrades()).toBe(1);

    const list = await alice.get("/api/trades");
    expect(list.body.open).toBeNull();
    expect(list.body.history.find((t: { id: string }) => t.id === id)).toMatchObject({ reason: "stop", pnl: -0.5, exit: 67_660, closeTx: sl });
    expect(pushed.map((p) => p.message)).toEqual([
      { title: "Stopped out", body: "BTC long closed at -$0.50.", url: "/history", tag: `trade-${id}` },
      { title: "Stopped out", body: "BTC long closed at -$0.50.", url: "/history", tag: `trade-${id}` },
    ]);

    // nothing twice, and the dead subscription is gone
    expect(await watchOpenTrades()).toBe(0);
    expect((await alice.post(`/api/trades/${id}/close`, { txHash: sl })).status).toBe(409);
    pushed = [];
    const again = await alice.post("/api/trades", { ...draft, txHash: chain.order(alice.address, { pool, isBid: true, fills: [{ quantity: 147_000n, price: usd(68_000) }] }) });
    const tp = chain.order(REGISTRY, { owner: alice.address, pool, isBid: false, fills: [{ quantity: 147_000n, price: usd(68_680) }] });
    chain.indexClose(alice.address, pool, { txHash: tp, orderId: 10n, closedSize: 147_000n, realizedPnl: usd(0.9996), exitPrice: usd(68_680), timestamp: BigInt(Math.floor(Date.now() / 1000)) + 1n });
    expect(await watchOpenTrades()).toBe(1);
    expect(pushed.map((p) => [p.target.endpoint, p.message.title])).toEqual([["https://push.example/a1", "Target hit!"]]);
    expect((await alice.get("/api/trades")).body.history[0]).toMatchObject({ id: again.body.trade.id, reason: "target", pnl: 1 });
  });
});

describe("guest import", () => {
  const history = [
    { id: "g1", marketId: "eth", side: "long", leverage: 2, margin: 50, entry: 3200, exit: 3232, pnl: 1, closedAt: Date.now() - 60_000, reason: "target" },
    { id: "g2", marketId: "sol", side: "short", leverage: 5, margin: 20, entry: 150, exit: 151.5, pnl: -1, closedAt: Date.now() - 30_000 },
  ];

  it("imports once, earns XP and stays off the leaderboard", async () => {
    const r = await carol.post("/api/me/import", { history, tutorialDone: true });
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(2);
    expect(r.body.progress.xp).toBeGreaterThan(0);
    expect(r.body.progress.tutorialDone).toBe(true);
    expect((await carol.post("/api/me/import", { history, tutorialDone: true })).status).toBe(409);
    const board = await carol.get("/api/leaderboard?kind=wins");
    expect(board.body.entries.some((e: { isYou?: boolean }) => e.isYou)).toBe(false);
    expect((await carol.get("/api/session")).body.user.guestImported).toBe(true);
  });
});

describe("gas drip", () => {
  it("sends STT to an empty wallet once per cooldown and skips a funded one", async () => {
    const first = await carol.post("/api/gas/drip");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ amount: "0.5", balance: "0.5" });
    expect(first.body.txHash).toMatch(/^0x/);
    expect(chain.sent).toEqual([{ to: carol.address, amount: parseEther("0.5") }]);
    const again = await carol.post("/api/gas/drip");
    expect(again.status).toBe(429);
    expect(again.body.nextAt).toBeGreaterThan(Date.now());
    chain.balances.set(bob.address.toLowerCase(), parseEther("1"));
    expect((await bob.post("/api/gas/drip")).body).toMatchObject({ txHash: null, amount: "0" });
    expect(chain.sent).toHaveLength(1);
  });

  it("answers 503 when no faucet key is configured", async () => {
    setDeps({ faucetConfigured: () => false });
    expect((await alice.post("/api/gas/drip")).status).toBe(503);
    setDeps({ faucetConfigured: () => true });
  });
});
