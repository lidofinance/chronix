import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { report } from "../../shared/tests/report.ts";

// Gloas Beacon API shapes that accounting oracles read: v2 proposer duties and the withdrawals a
// state expects in its payload. Values are checked against v1 duties and the EL payload.
const started = performance.now();
await using net = await Devnet.start({
  id: `beacon-api-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
});
// Rewards lift 32 ETH validators above the maximum, so the sweep produces partial withdrawals.
await net.advanceEpochs(3);

type Duties = { dependent_root: string; data: { slot: string; validator_index: string }[] };
const epoch = Math.floor((await net.status()).slot / 32);
const v2 = await net.beacon<Duties>(`/eth/v2/validator/duties/proposer/${epoch}`);
const v1 = await net.beacon<Duties>(`/eth/v1/validator/duties/proposer/${epoch}`);
assert.match(v2.dependent_root, /^0x[0-9a-f]{64}$/);
assert.deepEqual(
  v2.data.map((duty) => Number(duty.slot)),
  Array.from({ length: 32 }, (_, index) => epoch * 32 + index),
  "v2 duties must cover the epoch's slots in order",
);
assert.deepEqual(
  v2.data.map((duty) => duty.validator_index),
  v1.data.map((duty) => duty.validator_index),
);

const header = await net.beacon<{
  data: { header: { message: { slot: string; state_root: string } } };
}>("/eth/v1/beacon/headers/head");
const { slot, state_root: stateRoot } = header.data.header.message;
const state = await net.beacon<{
  data: { payload_expected_withdrawals?: { validator_index: string; amount: string }[] };
}>(`/eth/v2/debug/beacon/states/${stateRoot}`);
const expected = state.data.payload_expected_withdrawals;
assert(Array.isArray(expected), "the state has no payload_expected_withdrawals");
assert(expected.length > 0, "rewarded 0x01 validators produced no expected withdrawals");
const block = await net.beacon<{
  data: {
    message: { body: { signed_execution_payload_bid: { message: { block_hash: string } } } };
  };
}>(`/eth/v2/beacon/blocks/${slot}`);
const payload = await net.rpc<{ withdrawals: { validatorIndex: string; amount: string }[] }>(
  "eth_getBlockByHash",
  [block.data.message.body.signed_execution_payload_bid.message.block_hash, false],
);
assert.deepEqual(
  expected.map((item) => [BigInt(item.validator_index), BigInt(item.amount)]),
  payload.withdrawals.map((item) => [BigInt(item.validatorIndex), BigInt(item.amount)]),
  "expected withdrawals differ from the payload of the state's bid",
);

await report(net, "beacon-api", {
  event: "beacon-api-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  epoch,
  slot: Number(slot),
  expectedWithdrawals: expected.length,
  status: await net.status(),
});
