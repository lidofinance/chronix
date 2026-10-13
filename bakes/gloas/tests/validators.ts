import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { HttpError, json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";
import { validator } from "../../shared/tests/validators.ts";

// Real clients: validator control through the API. Every property is observed in chain data:
// proposals, liveness, sync aggregates, balances, finality, payload status and fee recipients.
const started = performance.now();
await using net = await Devnet.start({
  id: `validators-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
});
const ALL = Array.from({ length: 64 }, (_, index) => index);
const range = (from: number, to: number) => ALL.slice(from, to);
const slot = async () => (await net.lifecycle()).slot!;
const notLive = async (epoch: number) => {
  const result = await json<{ data: { index: string; is_live: boolean }[] }>(
    `${net.url}/eth/v1/validator/liveness/${epoch}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ALL.map(String)),
    },
  );
  return result.data.filter((item) => !item.is_live).map((item) => Number(item.index));
};
type Block = {
  data: {
    message: {
      slot: string;
      proposer_index: string;
      body: {
        sync_aggregate: { sync_committee_bits: string };
        payload_attestations: { data: { slot: string; payload_present: boolean } }[];
        signed_execution_payload_bid: { message: { parent_block_hash: string } };
      };
    };
  };
};
const block = async (id: number | string): Promise<Block | undefined> => {
  try {
    return await net.beacon<Block>(`/eth/v2/beacon/blocks/${id}`);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
};
const bits = (hex: string) =>
  [...hex.slice(2).match(/../g)!].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (parseInt(byte, 16) >> bit) & 1)
  );
const seats = async () =>
  (await net.beacon<{ data: { validators: string[] } }>(
    "/eth/v1/beacon/states/head/sync_committees",
  ))
    .data.validators.map(Number);
const finalized = async () => Number((await net.status()).finality.data.finalized.epoch);
const evidence: Record<string, unknown> = {};

await net.advanceSlots(40);
const listed = await net.validators();
assert.equal(listed.length, 64);
assert(listed.every((entry) => entry.managed && entry.online), "genesis keys are not all online");

// 1. Eight offline validators: missed proposals, no votes, no sync seats, lower balances, while
console.log(
  JSON.stringify({ event: "validators-step", step: 1, slot: (await net.lifecycle()).slot }),
);
// the remaining 87.5% keep finalizing.
const offline = range(56, 64);
const balancesBefore = await Promise.all(
  ALL.map(async (index) => BigInt((await validator(net, index)).balance)),
);
await net.setValidatorsOnline(offline, false);
assert.deepEqual(
  (await net.validators()).filter((entry) => !entry.online).map((entry) => entry.index),
  offline,
);
const first = await slot();
const finalizedBefore = await finalized();
// Duties of past epochs need historical states; record them while they are current.
const proposers = new Map<number, number>();
for (let epoch = 0; epoch < 3; epoch++) {
  const current = Math.floor((await slot()) / 32);
  for (const target of [current, current + 1]) {
    const duties = await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
      `/eth/v1/validator/duties/proposer/${target}`,
    );
    for (const duty of duties.data) proposers.set(Number(duty.slot), Number(duty.validator_index));
  }
  await net.advanceEpochs(1);
}
const last = await slot();
let missed = 0;
let expectedMissed = 0;
const committee = await seats();
const onlineSeats: number[] = committee.map((index) => offline.includes(index) ? 0 : 1);
let syncBits = 0;
let syncPossible = 0;
for (let current = first + 1; current <= last; current++) {
  const proposer = proposers.get(current);
  assert(proposer !== undefined, `missing proposer duty for slot ${current}`);
  const produced = await block(current);
  if (offline.includes(proposer)) expectedMissed++;
  if (!produced) {
    missed++;
    continue;
  }
  assert(!offline.includes(proposer), `offline validator ${proposer} proposed slot ${current}`);
  // A block carries the previous slot's sync votes, signed before the switch at `first`.
  if (current === first + 1) continue;
  const aggregate = bits(produced.data.message.body.sync_aggregate.sync_committee_bits);
  aggregate.forEach((bit, seat) => {
    assert(!(bit && !onlineSeats[seat]), `offline sync seat ${seat} signed at ${current}`);
  });
  syncBits += aggregate.reduce((sum, bit) => sum + bit, 0);
  syncPossible += onlineSeats.reduce((sum, bit) => sum + bit, 0);
}
assert.equal(missed, expectedMissed, "missed proposals differ from offline proposer duties");
assert(expectedMissed > 0, "fixture had no offline proposer duty");
// Online seats are aggregated by Panda; a subcommittee without a selected aggregator can skip.
assert(syncBits >= syncPossible * 0.75, `sync participation ${syncBits}/${syncPossible}`);
const idleEpoch = Math.floor(last / 32) - 1;
assert.deepEqual(await notLive(idleEpoch), offline, "liveness differs from the offline set");
for (const index of ALL) {
  const balance = BigInt((await validator(net, index)).balance);
  if (offline.includes(index)) {
    assert(balance < balancesBefore[index], `${index} was not penalized`);
  }
}
assert(await finalized() > finalizedBefore, "87.5% participation stopped finality");
evidence.offline = { first, last, missed, syncBits, syncPossible, idleEpoch };

// 2. Back online: the same validators vote in the next full epoch.
console.log(
  JSON.stringify({ event: "validators-step", step: 2, slot: (await net.lifecycle()).slot }),
);
await net.setValidatorsOnline(offline, true);
await net.advanceEpochs(2);
assert.deepEqual(await notLive(Math.floor((await slot()) / 32) - 1), []);

// 3. A missed proposal: no block at that slot, every validator still attests.
console.log(
  JSON.stringify({ event: "validators-step", step: 3, slot: (await net.lifecycle()).slot }),
);
const skipped = (await slot()) + 2;
await net.missProposal(skipped);
await net.advanceSlots(3);
assert.equal(await block(skipped), undefined, "the scheduled missed slot has a block");
assert(await block(skipped + 1), "the chain did not continue after the missed slot");
evidence.missedSlot = skipped;

// 4. A withheld payload: the block exists, EL stays at its parent; the next slot builds on it and
console.log(
  JSON.stringify({ event: "validators-step", step: 4, slot: (await net.lifecycle()).slot }),
);
// the payload timeliness committee reports the payload as absent.
const withheld = (await slot()) + 2;
await net.withholdPayload(withheld);
await net.advanceSlots(2);
const withheldBlock = await block(withheld);
assert(withheldBlock, "withheld slot has no beacon block");
const el = await net.rpc<{ hash: string; timestamp: string }>("eth_getBlockByNumber", [
  "latest",
  false,
]);
assert.equal(
  el.hash,
  withheldBlock.data.message.body.signed_execution_payload_bid.message.parent_block_hash,
  "the withheld payload reached the execution layer",
);
await net.advanceSlots(1);
const after = (await block(withheld + 1))!;
assert(
  after.data.message.body.payload_attestations.some((vote) =>
    Number(vote.data.slot) === withheld && vote.data.payload_present === false
  ),
  "PTC did not report the withheld payload",
);
const resumed = await net.rpc<{ timestamp: string }>("eth_getBlockByNumber", ["latest", false]);
assert(BigInt(resumed.timestamp) > BigInt(el.timestamp), "EL did not continue after the gap");
evidence.withheldSlot = withheld;

// 5. A fee recipient for one validator applies to its next proposal.
console.log(
  JSON.stringify({ event: "validators-step", step: 5, slot: (await net.lifecycle()).slot }),
);
// Beacon nodes compute proposer duties up to the next epoch.
const targetEpoch = Math.floor((await slot()) / 32) + 1;
const duties = await net.beacon<
  { data: { slot: string; validator_index: string; pubkey: string }[] }
>(
  `/eth/v1/validator/duties/proposer/${targetEpoch}`,
);
const duty = duties.data[0];
const recipient = "0x" + "be".repeat(20);
await net.configureValidator(duty.pubkey, { feeRecipient: recipient, graffiti: "panda-scenario" });
await net.advanceSlots(Number(duty.slot) - (await slot()));
const proposed = await net.rpc<{ miner: string }>("eth_getBlockByNumber", ["latest", false]);
assert.equal(proposed.miner.toLowerCase(), recipient, "validator fee recipient was not used");
evidence.feeRecipient = { slot: duty.slot, validator: duty.validator_index };

// 6. A removed key leaves with its history; the validator is silent until imported again.
console.log(
  JSON.stringify({ event: "validators-step", step: 6, slot: (await net.lifecycle()).slot }),
);
const removedIndex = 10;
const removed = await net.removeValidator((await validator(net, removedIndex)).validator.pubkey);
assert(removed.keystore && removed.password, "removed key was not returned");
assert(JSON.parse(removed.slashingProtection).data.length === 1, "missing signing history");
assert.equal((await net.validators())[removedIndex].managed, false);
await net.advanceEpochs(2);
assert.deepEqual(await notLive(Math.floor((await slot()) / 32) - 1), [removedIndex]);
await net.importValidator(removed.keystore, removed.password);
await net.advanceEpochs(2);
assert.deepEqual(await notLive(Math.floor((await slot()) / 32) - 1), []);

// 7. More than a third offline: justification stops; it resumes once they return.
console.log(
  JSON.stringify({ event: "validators-step", step: 7, slot: (await net.lifecycle()).slot }),
);
const third = range(0, 24);
await net.setValidatorsOnline(third, false);
await net.advanceEpochs(1);
const stalled = await finalized();
await net.advanceEpochs(3);
assert.equal(await finalized(), stalled, "finality advanced with 37.5% offline");
await net.setValidatorsOnline(third, true);
await net.advanceUntil(async () => await finalized() > stalled, {
  maxSlots: 128,
  timeoutMs: 900_000,
});
evidence.finality = { stalled, recovered: await finalized() };

// 8. Offline state belongs to the saved network: a restored snapshot keeps it.
console.log(
  JSON.stringify({ event: "validators-step", step: 8, slot: (await net.lifecycle()).slot }),
);
await net.setValidatorsOnline([1, 2, 3], false);
await net.stepSlot();
const snapshot = await net.createSnapshot();
await net.setValidatorsOnline([1, 2, 3], true);
await net.advanceSlots(2);
await net.restoreSnapshot(snapshot);
assert.deepEqual(
  (await net.validators()).filter((entry) => !entry.online).map((entry) => entry.index),
  [1, 2, 3],
);
const restoredFrom = await slot();
await net.advanceEpochs(1);
const restoredBlock = (await block("head"))!;
const restoredSeats = await seats();
bits(restoredBlock.data.message.body.sync_aggregate.sync_committee_bits).forEach((bit, seat) =>
  assert(!(bit && [1, 2, 3].includes(restoredSeats[seat])), `restored offline seat ${seat}`)
);
await net.setValidatorsOnline([1, 2, 3], true);
evidence.snapshot = { id: snapshot.id, restoredFrom };

await report(net, "validators", {
  event: "validators-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  evidence,
  status: await net.status(),
});
