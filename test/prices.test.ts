import { afterAll, beforeAll, expect, it } from "bun:test";
import { MARKETS } from "@bump/testkit";
import type { MarketPricesResponse } from "@bump/api-types";
import { createApp } from "../src/app.ts";
import { resetDeps, setDeps } from "../src/lib/deps.ts";
import { resetEnv } from "../src/lib/env.ts";
import { testEnv } from "./helpers.ts";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  testEnv(); resetEnv(); resetDeps();
  setDeps({
    markets: async () => ({ btc: MARKETS.btc }),
    prices: async () => ({ source: "dreamdex", chainId: 50383, generatedAt: 1000, prices: [{ id: "btc", symbol: "BTC", price: null, updatedAt: null, status: "unavailable", change24h: null }] }),
    candles: async (id, bucket) => ({ source: "dreamdex", marketId: id, bucket, samples: [] }),
  });
  app = createApp();
});
afterAll(resetDeps);

it("serves public price status as JSON nulls, without a fabricated fallback", async () => {
  const response = await app.handle(new Request("http://localhost/api/prices"));
  expect(response.status).toBe(200);
  const body = await response.json() as MarketPricesResponse;
  expect(body.source).toBe("dreamdex");
  expect(body.prices[0]?.price).toBeNull();
  expect(body.prices[0]?.status).toBe("unavailable");
});

it("bounds public chart requests and refuses unknown markets", async () => {
  for (const path of ["/api/markets/btc/candles?bucket=1", "/api/markets/btc/candles?limit=99999"]) {
    expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(400);
  }
  expect((await app.handle(new Request("http://localhost/api/markets/missing/candles"))).status).toBe(404);
  const response = await app.handle(new Request("http://localhost/api/markets/btc/candles?bucket=60"));
  expect(response.status).toBe(200);
  expect((await response.json() as { samples: unknown[] }).samples).toEqual([]);
});
