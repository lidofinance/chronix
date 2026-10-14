import assert from "node:assert/strict";
import { Automine, executable, type PoolTransaction } from "../src/automine.ts";
import { Timeline } from "../src/time.ts";
const tx: PoolTransaction = {
  hash: "0x01",
  from: "0xabc",
  nonce: "0x0",
  gas: "0x5208",
  value: "0x1",
  maxFeePerGas: "0x64",
  maxPriorityFeePerGas: "0x2",
};
Deno.test("automine eligibility excludes nonce gaps, insufficient funds, fee caps and oversized gas", () => {
  assert(executable(tx, 0n, 3_000_000n, 80n, 30_000_000n));
  assert(!executable({ ...tx, nonce: "0x2" }, 0n, 3_000_000n, 80n, 30_000_000n));
  assert(!executable(tx, 0n, 1n, 80n, 30_000_000n));
  assert(!executable(tx, 0n, 3_000_000n, 101n, 30_000_000n));
  assert(!executable(tx, 0n, 3_000_000n, 80n, 20_000n));
});

Deno.test("disabling automine waits for an in-flight pool check and prevents another slot", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string[]>();
  let moves = 0;
  const time = new Timeline(0, 11_500, {
    move: () => {
      moves++;
      return Promise.resolve();
    },
  });
  class DelayedPool extends Automine {
    override candidates(): Promise<string[]> {
      entered.resolve();
      return release.promise;
    }
  }
  const miner = new DelayedPool("unused", time);
  await miner.set(true);
  await entered.promise;
  let disabled = false;
  const stopping = miner.set(false).then(() => {
    disabled = true;
  });
  await Promise.resolve();
  assert.equal(disabled, false);
  release.resolve(["executable"]);
  await stopping;
  assert.equal(moves, 0);
  await miner.stop();
});

Deno.test("a notification during an empty pool check rechecks newly arrived work", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string[]>();
  const mined = Promise.withResolvers<void>();
  let checks = 0;
  const time = new Timeline(0, 11_500, {
    move: (_at, phase) => {
      if (phase === 11_500) mined.resolve();
      return Promise.resolve();
    },
  });
  class ConcurrentPool extends Automine {
    override candidates(): Promise<string[]> {
      checks++;
      if (checks === 1) {
        entered.resolve();
        return release.promise;
      }
      return Promise.resolve(checks === 2 ? ["new-transaction"] : []);
    }
    // Every slot of this fixture produces an execution block.
    override head(): Promise<string> {
      return Promise.resolve(String(time.slot));
    }
  }
  const miner = new ConcurrentPool("unused", time);
  await miner.set(true);
  await entered.promise;
  miner.notify();
  release.resolve([]);
  await mined.promise;
  await miner.set(false);
  assert.equal(time.slot, 1);
  await miner.stop();
});

Deno.test("automine follows the current EL endpoint after a restart", async () => {
  const el = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const call = await request.json();
    const result = call.method === "txpool_content"
      ? { pending: {} }
      : { gasLimit: "0x1c9c380", baseFeePerGas: "0x7", gasUsed: "0x0", hash: "0x01" };
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  });
  let endpoint = "http://127.0.0.1:9"; // The restarted EL no longer listens here.
  const miner = new Automine(() => endpoint, new Timeline(0, 11_500, { move: async () => {} }));
  try {
    endpoint = `http://127.0.0.1:${el.addr.port}`;
    assert.deepEqual(await miner.candidates(), []);
  } finally {
    await miner.stop();
    await el.shutdown();
  }
});

Deno.test("a slot without an execution block keeps automine stepping for pending work", async () => {
  let moves = 0;
  const done = Promise.withResolvers<void>();
  const time = new Timeline(0, 11_500, {
    move: (_at, phase) => {
      if (phase === 11_500) moves++;
      return Promise.resolve();
    },
  });
  // The first slot is missed (EL head unchanged); the second produces a block that still
  // cannot include the transaction, which ends this drain as before.
  const heads = ["0xa", "0xa", "0xa", "0xb"];
  class Pool extends Automine {
    override candidates(): Promise<string[]> {
      return Promise.resolve(["pending"]);
    }
    override head(): Promise<string> {
      const head = heads.shift() ?? "0xb";
      if (!heads.length) done.resolve();
      return Promise.resolve(head);
    }
  }
  const miner = new Pool("unused", time);
  await miner.set(true);
  await done.promise;
  await miner.set(false);
  assert.equal(moves, 2, "a missed slot ended automine with work still pending");
  await miner.stop();
});

Deno.test("automine stops after an epoch of slots without any execution block", async () => {
  let moves = 0;
  const time = new Timeline(0, 11_500, {
    move: (_at, phase) => Promise.resolve(void (phase === 11_500 && moves++)),
  });
  class Stalled extends Automine {
    override candidates(): Promise<string[]> {
      return Promise.resolve(["pending"]);
    }
    override head(): Promise<string> {
      return Promise.resolve("0xsame");
    }
  }
  const miner = new Stalled("unused", time);
  await miner.set(true);
  await time.queue.idle();
  while (miner.error === undefined && moves < 300) await time.queue.idle();
  await miner.set(false);
  assert.equal(moves, 32, "one notification may not drive more than an epoch of empty slots");
  assert.match(miner.error ?? "", /no execution block/);
  await miner.stop();
});
