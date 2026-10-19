import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { ChronixError, Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { Controller } from "../../../src/controller.ts";
import { delay, json } from "../../../src/http.ts";
import { StateStore } from "../../../src/storage.ts";
import { report } from "../../shared/tests/report.ts";

// Real clients: Fulu from genesis, Gloas at epoch 2. Every slot before and after the fork is
// produced with its own fork's duties; finality, EL/CL agreement and snapshots work across it,
// including a snapshot of a Fulu head that is restored, exported and imported before the fork.
const FORK_EPOCH = 2;
const OFFLINE = [60, 61, 62, 63];
const started = performance.now();
await using net = await Devnet.start({
  id: `fork-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
  // An offline group keeps validator control active across the fork.
  genesis: {
    gloasForkEpoch: FORK_EPOCH,
    validators: [{ count: 60 }, { count: 4, online: false }],
  },
});
type Block = {
  version: string;
  data: {
    message: {
      slot: string;
      body: {
        execution_payload?: { block_hash: string; block_number: string };
        signed_execution_payload_bid?: {
          message: { block_hash: string; parent_block_hash?: string };
        };
        payload_attestations?: { data: { slot: string; payload_present: boolean } }[];
      };
    };
  };
};
const block = (id: number | string) => net.beacon<Block>(`/eth/v2/beacon/blocks/${id}`);
const spec = (await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec")).data;
assert.equal(spec.GLOAS_FORK_EPOCH, String(FORK_EPOCH));

// Fulu slots: the payload is inside the block, and Gloas-only operations are refused.
await net.advanceSlots(3);
const fulu = await block("head");
assert.equal(fulu.version, "fulu");
assert(fulu.data.message.body.execution_payload, "a Fulu block must carry its payload");
assert.equal(
  (await net.status()).el.hash,
  fulu.data.message.body.execution_payload.block_hash,
  "EL head differs from the Fulu payload",
);
// Geth builds the pending block on the head while protocol time is ahead of the host clock.
const pending = () =>
  net.rpc<{ number: string; timestamp: string }>("eth_getBlockByNumber", ["pending", false])
    .catch((error) => assert.fail(`no pending block: ${error.message}`));
assert.equal(
  BigInt((await pending()).number),
  BigInt(fulu.data.message.body.execution_payload.block_number) + 1n,
  "Fulu pending block does not follow the head",
);
await assert.rejects(net.withholdPayload(10), /Gloas/);

// A Fulu head can be saved and exported; the network forks later after a restore or an import.
const fuluSnapshot = await net.createSnapshot();
assert.equal(fuluSnapshot.headSlot, Number(fulu.data.message.slot), "Fulu snapshot head");
const archives = `.cache/fork-transition/${crypto.randomUUID().slice(0, 8)}`;
await Deno.mkdir(archives, { recursive: true, mode: 0o700 });
await using _archives = {
  [Symbol.asyncDispose]: () => Deno.remove(archives, { recursive: true }).catch(() => {}),
};
const fuluArchive = await net.exportSnapshot(fuluSnapshot, `${archives}/fulu.gz`);

// Fulu slots work in every time mode a test uses: automine, 12-second slots and held time.
const genesisTime = Number(
  (await net.beacon<{ data: { genesis_time: string } }>("/eth/v1/beacon/genesis")).data
    .genesis_time,
);
const wallet = new Wallet(privateKey);
let nonce = Number(await net.rpc<string>("eth_getTransactionCount", [account, "pending"]));
const transfer = async () =>
  await net.rpc<string>("eth_sendRawTransaction", [
    await wallet.signTransaction({
      type: 2,
      chainId: 1337,
      nonce: nonce++,
      to: account,
      gasLimit: 21000,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 1n,
    }),
  ]);
/** The Fulu slot whose block carries the transaction's payload. */
const fuluSlotOf = async (hash: string) => {
  let receipt: { blockHash: string } | null = null;
  for (const deadline = Date.now() + 60_000; !receipt && Date.now() < deadline; await delay(200)) {
    receipt = await net.rpc<{ blockHash: string } | null>("eth_getTransactionReceipt", [hash]);
  }
  assert(receipt, `transaction ${hash} was not included`);
  const el = await net.rpc<{ timestamp: string }>("eth_getBlockByHash", [receipt.blockHash, false]);
  const slot = (Number(el.timestamp) - genesisTime) / 12;
  const carrier = await block(slot);
  assert.equal(carrier.version, "fulu", `slot ${slot} is not a Fulu slot`);
  assert.equal(carrier.data.message.body.execution_payload?.block_hash, receipt.blockHash);
  return slot;
};
/** Run 12-second slots until the head reaches `slot`. */
const intervalUntil = async (slot: number) => {
  await net.setIntervalMining(12_000);
  const deadline = Date.now() + (slot - (await net.lifecycle()).slot! + 2) * 12_000;
  while ((await net.lifecycle()).slot! < slot) {
    const { intervalMiningError } = await net.status();
    assert.equal(intervalMiningError, undefined, `interval mining stopped: ${intervalMiningError}`);
    assert(Date.now() < deadline, `12-second slots did not reach slot ${slot}`);
    await delay(500);
  }
  await net.setIntervalMining(0);
};
await net.setAutomine(true);
const automined = await fuluSlotOf(await transfer());
await net.setAutomine(false);
const beforeInterval = (await net.lifecycle()).slot!;
await intervalUntil(beforeInterval + 2);
// A held slot needs an online proposer: an offline proposer leaves the slot empty.
const nowSlot = (await net.lifecycle()).slot!;
const upcoming = (await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
  `/eth/v1/validator/duties/proposer/${Math.floor(nowSlot / 32)}`,
)).data.concat(
  (await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
    `/eth/v1/validator/duties/proposer/${Math.floor(nowSlot / 32) + 1}`,
  )).data,
);
const heldSlot = upcoming
  .filter((duty) => Number(duty.slot) > nowSlot && !OFFLINE.includes(Number(duty.validator_index)))
  .map((duty) => Number(duty.slot))[0];
if (heldSlot - 1 > nowSlot) await net.advanceSlots(heldSlot - 1 - nowSlot);
const held = await transfer();
await net.stepSlot();
assert.equal(await fuluSlotOf(held), heldSlot, "a held-time transaction missed its slot");

// Cross the fork epoch by epoch, recording proposer duties while they are current. Every slot of
// an online proposer has a block of its own fork; offline proposers' slots stay empty.
const forkSlot = FORK_EPOCH * 32;
const offline = OFFLINE;
const proposers = new Map<number, number>();
const target = forkSlot + 3;
while ((await net.lifecycle()).slot! < forkSlot - 2) {
  const current = Math.floor((await net.lifecycle()).slot! / 32);
  for (const epoch of [current, current + 1]) {
    const duties = await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
      `/eth/v1/validator/duties/proposer/${epoch}`,
    );
    for (const duty of duties.data) proposers.set(Number(duty.slot), Number(duty.validator_index));
  }
  const now = (await net.lifecycle()).slot!;
  await net.advanceSlots(Math.min(forkSlot - 2, (current + 1) * 32) - now);
}
// The fork itself passes under 12-second slots, as on a live network.
await intervalUntil(target);
// A slot already in flight when interval mining stops may end one slot past the target.
const lastSlot = (await net.lifecycle()).slot!;
let produced = 0;
for (let slot = 1; slot <= lastSlot; slot++) {
  const found = await block(slot).catch((error) => {
    if (error instanceof ChronixError && error.status === 404) return undefined;
    throw error;
  });
  const silent = offline.includes(proposers.get(slot)!);
  assert.equal(!found, silent, `slot ${slot}: block presence differs from its proposer`);
  if (!found) continue;
  produced++;
  assert.equal(found.version, slot < forkSlot ? "fulu" : "gloas", `slot ${slot} fork`);
}
const status = await net.status();
assert.equal(BigInt(status.el.number), BigInt(produced), "EL skipped a produced payload");
// Amsterdam is active on the EL head, the host clock has not reached it, and time is held.
assert(Number(status.el.timestamp) >= genesisTime + forkSlot * 12, "EL head is before Amsterdam");
const gloasPending = await pending();
assert.equal(
  BigInt(gloasPending.number),
  BigInt(status.el.number) + 1n,
  "Gloas pending block does not follow the head",
);
assert(
  BigInt(gloasPending.timestamp) > BigInt(status.el.timestamp),
  "Gloas pending block is not after the head",
);
await net.rpc("eth_estimateGas", [{ from: account, to: account, value: "0x1" }, "pending"])
  .catch((error) => assert.fail(`no pending state: ${error.message}`));
const optional = (slot: number) =>
  block(slot).catch((error) => {
    if (error instanceof ChronixError && error.status === 404) return undefined;
    throw error;
  });
const firstGloas = (await Promise.all(
  Array.from({ length: target - forkSlot + 1 }, (_, index) => optional(forkSlot + index)),
)).find((item) => item);
assert(firstGloas?.data.message.body.signed_execution_payload_bid, "Gloas block without a bid");

// Finality crosses the fork and EL agrees with the finalized Gloas checkpoint.
async function finalizeAfterFork(devnet: Devnet): Promise<void> {
  await devnet.advanceUntil(
    async () => BigInt((await devnet.status()).finality.data.finalized.epoch) > BigInt(FORK_EPOCH),
    { maxSlots: 224, timeoutMs: 900_000 },
  );
  const checkpoint = await devnet.beacon<Block>("/eth/v2/beacon/blocks/finalized");
  const finalizedEl = await devnet.rpc<{ hash: string }>("eth_getBlockByNumber", [
    "finalized",
    false,
  ]);
  const bid = checkpoint.data.message.body.signed_execution_payload_bid?.message;
  assert(bid, "finalized checkpoint is pre-Gloas");
  assert.equal(
    finalizedEl.hash,
    bid.parent_block_hash,
    "EL finalized differs from the Gloas checkpoint",
  );
}
await finalizeAfterFork(net);
// The pinned VC cannot learn fork-epoch PTC duties from a pre-Gloas head state; from the next
// epoch on the payload timeliness committee votes for present payloads.
const nextEpoch = (FORK_EPOCH + 1) * 32;
const nextBlocks = await Promise.all(
  Array.from({ length: 32 }, (_, index) => optional(nextEpoch + 1 + index)),
);
assert(
  nextBlocks.some((item) =>
    item?.data.message.body.payload_attestations?.some((vote) =>
      Number(vote.data.slot) >= nextEpoch && vote.data.payload_present
    )
  ),
  "no PTC vote for a present payload after the fork epoch",
);
const liveness = await json<{ data: { index: string; is_live: boolean }[] }>(
  `${net.url}/eth/v1/validator/liveness/${Math.floor((await net.lifecycle()).slot! / 32) - 1}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Array.from({ length: 64 }, (_, index) => String(index))),
  },
);
assert.deepEqual(
  liveness.data.filter((item) => !item.is_live).map((item) => Number(item.index)),
  [60, 61, 62, 63],
  "only the offline group may be silent after the fork",
);
// A Gloas head with a finalized Gloas checkpoint can be saved and restored.
const snapshot = await net.createSnapshot();
const savedSlot = Math.floor((snapshot.nowMs / 1000 - 2_000_000_000) / 12);
await net.advanceSlots(2);
await net.restoreSnapshot(snapshot);
assert.equal((await net.lifecycle()).slot, savedSlot, "restore did not return to the saved time");
assert.equal((await block("head")).data.message.slot, String(snapshot.headSlot));
await net.advanceSlots(4);
assert(
  Number((await block("head")).data.message.slot) > snapshot.headSlot,
  "no block after restore",
);

// Restoring the Fulu snapshot returns the network before the fork; it forks and finalizes again.
await net.restoreSnapshot(fuluSnapshot);
const restoredFulu = await block("head");
assert.equal(restoredFulu.version, "fulu", "restored head is not Fulu");
assert.equal(restoredFulu.data.message.slot, String(fuluSnapshot.headSlot));
await finalizeAfterFork(net);

// A network imported from the Fulu archive starts before the fork, forks and finalizes.
const importId = `fork-import-${crypto.randomUUID().slice(0, 8)}`;
let imported: { id: string; headSlot: string; finalized: unknown };
{
  const controller = await Controller.fromSnapshot(
    fuluArchive.path,
    { id: importId },
    { sha256: fuluArchive.sha256 },
  );
  try {
    const devnet = new Devnet(controller.serve(0));
    const head = await devnet.beacon<Block>("/eth/v2/beacon/blocks/head");
    assert.equal(head.version, "fulu", "imported head is not Fulu");
    assert.equal(head.data.message.slot, String(fuluSnapshot.headSlot));
    await finalizeAfterFork(devnet);
    imported = {
      id: importId,
      headSlot: head.data.message.slot,
      finalized: (await devnet.status()).finality.data.finalized,
    };
  } finally {
    await controller.close();
  }
}
await Deno.remove(new StateStore(importId).root, { recursive: true });

await report(net, "fork-transition", {
  event: "fork-transition-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  forkEpoch: FORK_EPOCH,
  fuluTimeModes: { automined, interval: [beforeInterval, beforeInterval + 2], heldSlot },
  fuluSnapshot: { id: fuluSnapshot.id, headSlot: fuluSnapshot.headSlot },
  imported,
  finalized: (await net.status()).finality.data.finalized,
  snapshot: snapshot.id,
  status: await net.status(),
});
