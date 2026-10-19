import assert from "node:assert/strict";
import { Automine, executable, type PoolTransaction } from "../src/automine.ts";
import { configuration } from "../src/config.ts";
import { Controller } from "../src/controller.ts";
import { elClients, resolvedEl } from "../src/el_client.ts";
import { type Manifest, Network } from "../src/network.ts";
import { readBake } from "../src/profiles.ts";
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
  assert(executable(tx, 0n, 3_000_000n, 80n, 30_000_000n, 0n));
  assert(!executable({ ...tx, nonce: "0x2" }, 0n, 3_000_000n, 80n, 30_000_000n, 0n));
  assert(!executable(tx, 0n, 1n, 80n, 30_000_000n, 0n));
  assert(!executable(tx, 0n, 3_000_000n, 101n, 30_000_000n, 0n));
  assert(!executable(tx, 0n, 3_000_000n, 80n, 20_000n, 0n));
});

const hex = (value: bigint) => `0x${value.toString(16)}`;
const funds = 10n ** 18n;
Deno.test("automine waits only for transactions the EL's payload builder includes", () => {
  // Reth builds any transaction that pays the base fee; Geth needs a 1 Mwei effective tip.
  assert.equal(elClients.reth.minimumTip, 0n);
  assert.equal(elClients.geth.minimumTip, 1_000_000n);
  const tipped = (tip: bigint, fee = 80n + 2_000_000n) => ({
    ...tx,
    maxFeePerGas: hex(fee),
    maxPriorityFeePerGas: hex(tip),
  });
  const check = (value: PoolTransaction, minimumTip: bigint) =>
    executable(value, 0n, funds, 80n, 30_000_000n, minimumTip);
  // Wallets take a zero tip from eth_maxPriorityFeePerGas on empty Reth blocks.
  assert(check(tipped(0n), elClients.reth.minimumTip));
  assert(!check(tipped(0n), elClients.geth.minimumTip));
  assert(check(tipped(1n), elClients.reth.minimumTip));
  assert(!check(tipped(1n), elClients.geth.minimumTip));
  assert(check(tipped(1_000_000n), elClients.geth.minimumTip));
  // Geth compares the effective tip: the tip cap, limited by what the fee cap leaves.
  assert(check(tipped(2_000_000n, 80n + 1_000_000n), elClients.geth.minimumTip));
  assert(!check(tipped(2_000_000n, 80n + 999_999n), elClients.geth.minimumTip));
  // A legacy gas price pays its whole excess over the base fee as the tip.
  const legacy = (price: bigint) => ({ ...tx, maxFeePerGas: undefined, gasPrice: hex(price) });
  assert(check({ ...legacy(80n + 1_000_000n), maxPriorityFeePerGas: undefined }, 1_000_000n));
  assert(!check({ ...legacy(80n + 999_999n), maxPriorityFeePerGas: undefined }, 1_000_000n));
  assert(check({ ...legacy(80n), maxPriorityFeePerGas: undefined }, 0n));
});

Deno.test("automine asks the EL endpoint with the minimum tip it was built with", async () => {
  const pending = { ...tx, maxFeePerGas: hex(100n), maxPriorityFeePerGas: "0x0" };
  const el = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (request) => {
    const call = await request.json();
    const result = call.method === "txpool_content"
      ? { pending: { [pending.from]: { "0": pending } } }
      : call.method === "eth_getTransactionCount"
      ? "0x0"
      : call.method === "eth_getBalance"
      ? hex(funds)
      : { gasLimit: "0x1c9c380", baseFeePerGas: "0x7", gasUsed: "0xe4e1c0", hash: "0x01" };
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  });
  const time = () => new Timeline(0, 11_500, { move: async () => {} });
  const url = `http://127.0.0.1:${el.addr.port}`;
  const reth = new Automine(url, time(), elClients.reth.minimumTip);
  const geth = new Automine(url, time(), elClients.geth.minimumTip);
  try {
    assert.deepEqual(await reth.candidates(), [pending.hash]);
    assert.deepEqual(await geth.candidates(), []);
  } finally {
    await reth.stop();
    await geth.stop();
    await el.shutdown();
  }
});

Deno.test("a session's automine uses the minimum tip of the network's EL", async () => {
  const bake = await readBake("gloas", "snapshot-minimal-r1");
  for (const name of ["reth-main-f4676ea", "geth-master-5d8fd6b"] as const) {
    const config = configuration({
      id: "automine-tip",
      profile: "gloas",
      bake: bake.tag,
      el: name,
    });
    const manifest = {
      config,
      bake,
      execution: resolvedEl(name, bake.images.cl.platform),
      el: "http://127.0.0.1:9",
    } as Manifest;
    const controller = new Controller(new Network(config), manifest, time());
    assert.equal(
      controller.automine.minimumTip,
      elClients[name.startsWith("reth") ? "reth" : "geth"].minimumTip,
    );
    await controller.automine.stop();
  }
  function time() {
    return new Timeline(0, 11_500, { move: async () => {} });
  }
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
  const miner = new DelayedPool("unused", time, 0n);
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
  const miner = new ConcurrentPool("unused", time, 0n);
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
  const miner = new Automine(
    () => endpoint,
    new Timeline(0, 11_500, { move: async () => {} }),
    elClients.reth.minimumTip,
  );
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
  const miner = new Pool("unused", time, 0n);
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
  const miner = new Stalled("unused", time, 0n);
  await miner.set(true);
  await time.queue.idle();
  while (miner.error === undefined && moves < 300) await time.queue.idle();
  await miner.set(false);
  assert.equal(moves, 32, "one notification may not drive more than an epoch of empty slots");
  assert.match(miner.error ?? "", /no execution block/);
  await miner.stop();
});

Deno.test("a refused automine slot is not an automine error; a faulted timeline is", async () => {
  let moves = 0;
  const time = new Timeline(0, 11_500, { move: () => Promise.resolve(void moves++) });
  class Pool extends Automine {
    override candidates(): Promise<string[]> {
      return Promise.resolve(["pending"]);
    }
    override head(): Promise<string> {
      return Promise.resolve(String(time.slot));
    }
  }
  const miner = new Pool("unused", time, 0n);
  const drained = async (lost: () => Promise<string | undefined>) => {
    const checked = Promise.withResolvers<void>();
    time.lost = () => {
      checked.resolve();
      return lost();
    };
    await miner.set(true);
    await checked.promise;
    await time.queue.idle();
    await miner.set(false);
  };
  // An unanswered Docker query refuses the slot; the pool waits for the next request.
  await drained(() => Promise.reject(new Error("connect ENOENT /var/run/docker.sock")));
  assert.equal(miner.error, undefined, "a refused slot became a lasting automine error");
  assert.equal(moves, 0);
  // A client that exited on its own faults the timeline: automine reports it.
  await drained(() => Promise.resolve("Client bn exited on its own (exit 1)"));
  assert.match(miner.error ?? "", /Client bn exited on its own/);
  assert.equal(moves, 0);
  await miner.stop();
});
