import assert from "node:assert/strict";
import { Devnet, type Status } from "../../../src/api.ts";
import { activeClients, dockerClient, LABEL, ROLE } from "../../../src/docker.ts";
import { deadline, json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";

// Real clients: each managed client can be stopped, killed and restarted through the API. While a
// client is down, protocol time refuses to move; afterwards honest slots resume with every
// validator signing and EL/CL in agreement. A client that exits on its own is reported, not
// recovered, also while protocol time is moving.
const started = performance.now();
const id = `clients-${crypto.randomUUID().slice(0, 8)}`;
await using net = await Devnet.start({ id, profile: "gloas" });
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
/** Two honest slots after a restart; a crash is measured from the head right before it. */
const progress = async (label: string, crashed?: Status) => {
  const before = crashed ?? await net.status();
  await net.advanceSlots(2);
  const after = await net.status();
  assert.equal(after.slot, before.slot + 2, `${label}: time did not advance`);
  assert.equal(
    BigInt(after.el.number),
    BigInt(before.el.number) + 2n,
    crashed
      ? `${label}: blocks produced before the crash were lost`
      : `${label}: a block was missed after the client returned`,
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

// An abrupt crash of the VC recovers from its database without losing a block. The EL and the
// beacon node are not killed: neither recovers its unsaved head without peers; see docs/usage.md.
const crashed = await net.status();
await net.restartClient("vc", { kill: true });
evidence["vc-killed"] = await progress("vc killed", crashed);

// After the restarts every validator still signs and finality keeps advancing (an epoch is
// justified only after the next one, so allow three epochs of honest slots).
const finalizedBefore = BigInt((await net.status()).finality.data.finalized.epoch);
const slotsToFinality = await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) > finalizedBefore,
  { maxSlots: 96, timeoutMs: 900_000 },
);
assert.deepEqual(await live(), [], "a validator stopped signing after client restarts");
evidence.slotsToFinality = slotsToFinality;
const final = await net.status();

// A VC killed outside Chronix while an honest advance runs is detected, not recovered: the advance
// fails with the lost client within seconds, status names it, time is refused and the timeline
// needs a snapshot restore, or down and up. Only this network's VC is killed.
const docker = dockerClient();
const vc = activeClients(
  await docker.listContainers({ filters: { label: [`${LABEL}=${id}`, `${ROLE}=vc`] } }),
);
assert.equal(vc.length, 1, "expected this network's one running VC");
const head = BigInt(final.el.number);
const advancing = net.advanceSlots(64);
advancing.catch(() => {});
await net.waitForService("a block of the running advance", async () => {
  return BigInt((await net.status()).el.number) > head ? true : undefined;
}, 60_000);
await docker.getContainer(vc[0].Id).kill();
const killed = performance.now();
await assert.rejects(
  deadline(advancing, 60_000, "the advance reported the killed VC"),
  /Client vc exited on its own/,
);
const abortMs = performance.now() - killed;
const { clientError } = await net.waitForService("the killed VC reported", async () => {
  const status = await net.status();
  return status.clientError ? status : undefined;
}, 60_000);
assert.match(clientError!, /^Client vc exited on its own \(exit 137\); restore a snapshot/);
await assert.rejects(net.stepSlot(), /Client vc exited on its own/);
assert.equal((await net.lifecycle()).recoveryRequired, true, "the lost VC did not fault time");
evidence["vc-lost"] = { clientError, abortMs };

await report(net, "clients", {
  event: "clients-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  evidence,
  status: final,
});
