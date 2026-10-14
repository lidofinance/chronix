import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";

// Real clients: each managed client can be stopped, killed and restarted through the API. While a
// client is down, protocol time refuses to move; afterwards honest slots resume with every
// validator signing and EL/CL in agreement.
const started = performance.now();
await using net = await Devnet.start({
  id: `clients-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
});
const live = async () => {
  const epoch = Math.floor((await net.status()).slot / 32) - 1;
  const result = await json<{ data: { index: string; is_live: boolean }[] }>(
    `${net.url}/eth/v1/validator/liveness/${epoch}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.from({ length: 64 }, (_, index) => String(index))),
    },
  );
  return result.data.filter((item) => !item.is_live).map((item) => item.index);
};
const progress = async (label: string) => {
  const before = await net.status();
  await net.advanceSlots(2);
  const after = await net.status();
  assert.equal(after.slot, before.slot + 2, `${label}: time did not advance`);
  assert.equal(
    BigInt(after.el.number),
    BigInt(before.el.number) + 2n,
    `${label}: a block was missed after the client returned`,
  );
  return after;
};

await net.advanceSlots(40);
assert.deepEqual(Object.keys(await net.clients()).sort(), ["bn", "el", "vc"]);
for (const role of ["el", "bn", "vc"] as const) {
  assert.equal((await net.clients())[role].running, true, `${role} is not running at start`);
}

const evidence: Record<string, unknown> = {};
for (const role of ["vc", "bn", "el"] as const) {
  // A stopped client blocks every time mutation with a clear, non-faulting error.
  const before = await net.lifecycle();
  await net.stopClient(role);
  assert.equal((await net.clients())[role].running, false);
  await assert.rejects(net.stepSlot(), new RegExp(`Client ${role} is stopped`));
  await assert.rejects(net.createSnapshot(), new RegExp(`Client ${role} is stopped`));
  // lifecycle() reads only the controller, so it stays available while a client is down.
  assert.equal((await net.lifecycle()).slot, before.slot, `${role}: time moved while stopped`);
  await net.startClient(role);
  assert.equal((await net.clients())[role].running, true);
  evidence[`${role}-graceful`] = await progress(`${role} graceful restart`);
}

// An abrupt crash of the validator client and the beacon node recovers from their databases.
// A killed Geth loses its unpersisted head and, without peers, cannot fetch it again
// ("Could not retrieve unknown head from peers"); see docs/usage.md.
for (const role of ["vc", "bn"] as const) {
  await net.restartClient(role, { kill: true });
  evidence[`${role}-killed`] = await progress(`${role} killed`);
}

// After the restarts every validator still signs and finality keeps advancing (an epoch is
// justified only after the next one, so allow three epochs of honest slots).
const finalizedBefore = BigInt((await net.status()).finality.data.finalized.epoch);
const slotsToFinality = await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) > finalizedBefore,
  { maxSlots: 96, timeoutMs: 900_000 },
);
assert.deepEqual(await live(), [], "a validator stopped signing after client restarts");
evidence.slotsToFinality = slotsToFinality;

await report(net, "clients", {
  event: "clients-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  evidence,
  status: await net.status(),
});
