import type { Address } from "viem";
import type { PushMessage } from "@bump/api-types";
import type { PushSubscriptionInput } from "@bump/shared";
import { db } from "./db/client.ts";
import { deps, type PushTarget } from "./deps.ts";
import { log } from "./log.ts";
import { key } from "./users.ts";

export async function subscribe(address: Address, sub: PushSubscriptionInput) {
  await (await db()).query(
    `insert into push_subscriptions (endpoint, address, p256dh, auth) values ($1, $2, $3, $4)
     on conflict (endpoint) do update set address = excluded.address, p256dh = excluded.p256dh, auth = excluded.auth`,
    [sub.endpoint, key(address), sub.keys.p256dh, sub.keys.auth],
  );
}

export async function unsubscribe(address: Address, endpoint: string) {
  await (await db()).query("delete from push_subscriptions where endpoint = $1 and address = $2", [endpoint, key(address)]);
}

/** Sends to every device the player subscribed. Gone subscriptions are dropped; other failures are logged, never thrown. */
export async function notify(address: Address | string, message: PushMessage) {
  if (!deps().pushConfigured()) return;
  const d = await db();
  const targets = await d.query<PushTarget>("select endpoint, p256dh, auth from push_subscriptions where address = $1", [key(address)]);
  await Promise.all(
    targets.map(async (t) => {
      try {
        if (!(await deps().push(t, message))) await d.query("delete from push_subscriptions where endpoint = $1", [t.endpoint]);
      } catch (error) {
        log("push.failed", { host: new URL(t.endpoint).host, error: (error as Error).message.split("\n")[0] }, "warn");
      }
    }),
  );
}
