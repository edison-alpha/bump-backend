import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { PositionClose } from "@bump/dreamdex";
import { orderLogs } from "@bump/testkit";
import type { createApp } from "../src/app.ts";
import type { ReceiptLog, TxReceipt } from "../src/lib/deps.ts";

type App = ReturnType<typeof createApp>;

/** Anvil's well-known development keys. Tests only. */
export const DEV_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

/** Test process environment: in-memory database, dev login, silent logs, receipts checked against the fake chain. */
export function testEnv(overrides: Record<string, string> = {}) {
  Object.assign(process.env, {
    BUMP_PGLITE_DIR: "memory://",
    BUMP_DEV_AUTH: "1",
    BUMP_LOG: "silent",
    BUMP_VERIFY_TX: "1",
    SESSION_SECRET: "test-session-secret-test-session-secret",
    BUMP_ALLOWED_ORIGINS: "http://localhost:3200",
    BUMP_WATCH_INTERVAL_SEC: "0",
    NODE_ENV: "test",
    ...overrides,
  });
}

/** Transactions the fake Hideki node knows, position updates its fake indexer serves, and STT it has sent. */
export class FakeChain {
  receipts = new Map<string, TxReceipt>();
  balances = new Map<string, bigint>();
  closes = new Map<string, PositionClose[]>();
  sent: { to: Address; amount: bigint }[] = [];
  private next = 1;
  private orderId = 1n;

  /** A mined transaction from `from`, with optional logs; returns its hash. */
  tx(from: Address, status: TxReceipt["status"] = "success", logs: ReceiptLog[] = []): Hex {
    const hash = `0x${(this.next++).toString(16).padStart(64, "0")}` as Hex;
    this.receipts.set(hash, { status, from, logs });
    return hash;
  }

  /** A transaction from `from` placing an order owned by `owner` that fills at the given levels. */
  order(from: Address, o: { owner?: Address; pool: Address; isBid: boolean; fills: { quantity: bigint; price: bigint }[] }): Hex {
    return this.tx(from, "success", orderLogs({ pool: o.pool, owner: o.owner ?? from, orderId: this.orderId++, isBid: o.isBid, fills: o.fills }));
  }

  /** The indexer reports a position update for `account` on `pool`. */
  indexClose(account: Address, pool: string, close: PositionClose) {
    const k = `${account.toLowerCase()}:${pool.toLowerCase()}`;
    this.closes.set(k, [...(this.closes.get(k) ?? []), close]);
  }

  /** A hash no node has seen. */
  unknown(): Hex {
    return `0x${"f".repeat(48)}${(this.next++).toString(16).padStart(16, "0")}` as Hex;
  }
}

/** One signed-in wallet talking to the app in-process, with its own cookie jar. */
export class Client {
  cookie = "";
  readonly account: PrivateKeyAccount;

  constructor(
    private readonly app: App,
    key: `0x${string}`,
  ) {
    this.account = privateKeyToAccount(key);
  }

  get address() {
    return this.account.address;
  }

  async login() {
    const message = `Bump dev login ${this.address} ${Math.floor(Date.now() / 1000)}`;
    const signature = await this.account.signMessage({ message });
    const r = await this.call("POST", "/api/session/dev", { address: this.address, message, signature });
    if (r.status !== 200) throw new Error(`dev login failed: ${JSON.stringify(r.body)}`);
    return this;
  }

  async call<T = any>(method: string, path: string, body?: unknown, origin = "http://localhost:3200"): Promise<{ status: number; body: T }> {
    const response = await this.app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.cookie ? { cookie: this.cookie } : {}), origin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const set = response.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0] as string;
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  get = <T = any>(path: string) => this.call<T>("GET", path);
  post = <T = any>(path: string, body: unknown = {}) => this.call<T>("POST", path, body);
}
