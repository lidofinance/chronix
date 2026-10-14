import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { HttpError, json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";

// Real clients: Fulu from genesis, Gloas at epoch 2. Every slot before and after the fork is
// produced with its own fork's duties; finality, EL/CL agreement and snapshots work across it.
const FORK_EPOCH = 2;
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
await assert.rejects(net.createSnapshot(), /Gloas/);
await assert.rejects(net.withholdPayload(10), /Gloas/);

// Cross the fork epoch by epoch, recording proposer duties while they are current. Every slot of
// an online proposer has a block of its own fork; offline proposers' slots stay empty.
const forkSlot = FORK_EPOCH * 32;
const offline = [60, 61, 62, 63];
const proposers = new Map<number, number>();
const target = forkSlot + 3;
while ((await net.lifecycle()).slot! < target) {
  const current = Math.floor((await net.lifecycle()).slot! / 32);
  for (const epoch of [current, current + 1]) {
    const duties = await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
      `/eth/v1/validator/duties/proposer/${epoch}`,
    );
    for (const duty of duties.data) proposers.set(Number(duty.slot), Number(duty.validator_index));
  }
  const now = (await net.lifecycle()).slot!;
  await net.advanceSlots(Math.min(target, (current + 1) * 32) - now);
}
let produced = 0;
for (let slot = 1; slot <= target; slot++) {
  const found = await block(slot).catch((error) => {
    if (error instanceof HttpError && error.status === 404) return undefined;
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
const optional = (slot: number) =>
  block(slot).catch((error) => {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  });
const firstGloas = (await Promise.all(
  Array.from({ length: target - forkSlot + 1 }, (_, index) => optional(forkSlot + index)),
)).find((item) => item);
assert(firstGloas?.data.message.body.signed_execution_payload_bid, "Gloas block without a bid");

// Finality crosses the fork and EL agrees with the finalized Gloas checkpoint.
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) > BigInt(FORK_EPOCH),
  { maxSlots: 160, timeoutMs: 900_000 },
);
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
// EL agrees with the finalized Gloas checkpoint: its bid commits the execution parent.
const checkpoint = await block("finalized");
const finalizedEl = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
assert(
  checkpoint.data.message.body.signed_execution_payload_bid,
  "finalized checkpoint is pre-Gloas",
);
assert.equal(
  finalizedEl.hash,
  (checkpoint.data.message.body.signed_execution_payload_bid.message as {
    parent_block_hash: string;
  })
    .parent_block_hash,
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

await report(net, "fork-transition", {
  event: "fork-transition-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  forkEpoch: FORK_EPOCH,
  finalized: (await net.status()).finality.data.finalized,
  snapshot: snapshot.id,
  status: await net.status(),
});
