import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";

// Real clients: 1024 genesis validators give 32-member committees in which only selected members
// aggregate. Honest advancement must finalize with every validator signing, also with part of
// the network offline, and its speed is recorded.
const VALIDATORS = 1024;
const started = performance.now();
await using net = await Devnet.start({
  id: `large-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
  validators: VALIDATORS,
});
const startup = performance.now() - started;
const notLive = async (epoch: number) => {
  const result = await json<{ data: { index: string; is_live: boolean }[] }>(
    `${net.url}/eth/v1/validator/liveness/${epoch}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.from({ length: VALIDATORS }, (_, index) => String(index))),
    },
  );
  return result.data.filter((item) => !item.is_live).map((item) => Number(item.index));
};
const committee = await net.beacon<{ data: { validators: string[] }[] }>(
  "/eth/v1/beacon/states/head/committees?slot=1",
);
assert.equal(committee.data[0].validators.length, 32, "fixture must exceed one aggregator each");

const clock = performance.now();
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 1n,
  { maxSlots: 160, timeoutMs: 3_600_000 },
);
const honest = { slots: (await net.lifecycle()).slot!, ms: performance.now() - clock };
assert.deepEqual(await notLive(Math.floor(honest.slots / 32) - 1), [], "validators not signing");

// One sixteenth offline: aggregation barriers wait only for selected enabled members.
const offline = Array.from({ length: 64 }, (_, index) => 960 + index);
await net.setValidatorsOnline(offline, false);
const before = await net.lifecycle();
const finalized = BigInt((await net.status()).finality.data.finalized.epoch);
await net.advanceEpochs(3);
assert.deepEqual(await notLive(Math.floor((await net.lifecycle()).slot! / 32) - 1), offline);
assert(
  BigInt((await net.status()).finality.data.finalized.epoch) > finalized,
  "finality stopped with 15/16 online",
);
const partial = { slots: (await net.lifecycle()).slot! - before.slot!, ms: 0 };
partial.ms = performance.now() - clock - honest.ms;

await report(net, "large-network", {
  event: "large-network-passed",
  passed: true,
  validators: VALIDATORS,
  startupMs: startup,
  honest: { ...honest, slotsPerSecond: honest.slots / (honest.ms / 1000) },
  offline: { ...partial, slotsPerSecond: partial.slots / (partial.ms / 1000) },
  elapsedMs: performance.now() - started,
  status: await net.status(),
});
