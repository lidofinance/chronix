import assert from "node:assert/strict";
import { assertFeeCappedTransactionPaused } from "../bakes/shared/tests/automine_assertions.ts";
import { Automine } from "../src/automine.ts";
import { Timeline } from "../src/time.ts";

for (const phases of [[0, 4_000, 6_000, 8_000, 9_000, 11_500], [0, 3_000, 6_000, 9_000, 11_500]]) {
  Deno.test(`fee-cap observation drains a receipted slot still in progress (${phases[1]}ms attestation)`, async () => {
    const receiptVisible = Promise.withResolvers<void>();
    const finishBlock = Promise.withResolvers<void>();
    const pauseRequested = Promise.withResolvers<void>();
    const submitted = Promise.withResolvers<void>();
    let eligible = true;
    let el = { hash: "block4", number: "0x4", timestamp: "0x30" };
    const time = new Timeline(0, 59_500, {
      move: async (_at, phase) => {
        if (phase === 0) {
          // EL receipts are visible while Consensus.move still awaits Beacon/VC barriers.
          el = { hash: "block5", number: "0x5", timestamp: "0x3c" };
          eligible = false;
          receiptVisible.resolve();
          await finishBlock.promise;
        }
      },
    }, phases);
    class Pool extends Automine {
      override candidates(): Promise<string[]> {
        return Promise.resolve(eligible ? ["previous-executable-tx"] : []);
      }
      override head(): Promise<string> {
        return Promise.resolve(el.hash);
      }
    }
    const miner = new Pool("unused", time, 0n);
    const net = {
      setAutomine(enabled: boolean) {
        if (!enabled) pauseRequested.resolve();
        return miner.set(enabled);
      },
      status: () => Promise.resolve({ now: time.timestamp, slot: time.slot, el }),
      rpc: <T>() => Promise.resolve(null as T),
    };
    let checking: Promise<void> | undefined;
    try {
      await miner.set(true);
      await receiptVisible.promise;
      assert.equal(time.slot, 4);
      assert.equal(el.number, "0x5");
      checking = assertFeeCappedTransactionPaused(net, () => {
        miner.notify();
        submitted.resolve();
        return Promise.resolve("fee-capped-tx");
      }, () => time.queue.idle());
      // Both the old and corrected sequence can progress without a timing-dependent sleep.
      await Promise.race([pauseRequested.promise, submitted.promise]);
      finishBlock.resolve();
      await checking;
      assert.equal(time.slot, 5);
      assert.equal(miner.enabled, false);
    } finally {
      finishBlock.resolve();
      await checking?.catch(() => {});
      await miner.stop();
    }
  });
}

Deno.test("fee-cap assertion still rejects a new slot and an EL-only change", async () => {
  for (const change of ["slot", "execution"] as const) {
    let moved = false;
    let enabled = true;
    const net = {
      setAutomine(value: boolean) {
        enabled = value;
        return Promise.resolve();
      },
      status: () =>
        Promise.resolve({
          now: moved && change === "slot" ? 71.5 : 59.5,
          slot: moved && change === "slot" ? 5 : 4,
          el: { hash: moved ? "block5" : "block4", number: "0x4", timestamp: "0x30" },
        }),
      rpc: <T>() => Promise.resolve(null as T),
    };
    await assert.rejects(() =>
      assertFeeCappedTransactionPaused(
        net,
        () => Promise.resolve("fee-capped-tx"),
        () => {
          assert(enabled, "the fee-capped transaction must be observed with automine enabled");
          moved = true;
          return Promise.resolve();
        },
      ), /fee-capped tx/);
    assert.equal(enabled, false);
  }
});
