import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, type HistoryMode, privateKey } from "../../../src/config.ts";
import { executionAt } from "../../../src/consensus.ts";
import { deadline } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { profileReport, report } from "../../shared/tests/report.ts";

// Archive history: the EL serves the state of old blocks and the CL serves finalized historical
// states. An oracle reads its previous report's state and samples hundreds of blocks back.
const started = performance.now();
const history: HistoryMode = "archive";
await using net = await Devnet.start({
  id: `history-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
  history,
});

await net.advanceSlots(8);
const old = await net.rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]);
const oldHeader = await net.beacon<{
  data: { header: { message: { slot: string; state_root: string } } };
}>("/eth/v1/beacon/headers/head");
const oldSlot = Number(oldHeader.data.header.message.slot);
const oldStateRoot = oldHeader.data.header.message.state_root;

// The oracle's abnormal-rebase samples reach 23 epochs (736 blocks) back.
for (let advanced = 0; advanced < 800; advanced += 100) await net.advanceSlots(100);
const head = await net.rpc<{ number: string }>("eth_getBlockByNumber", ["latest", false]);
const depth = Number(BigInt(head.number) - BigInt(old.number));
assert(depth >= 736, `the old block is only ${depth} blocks deep`);
const finalizedSlot = Number((await net.status()).finality.data.finalized.epoch) * 32;
assert(finalizedSlot > oldSlot, "the old slot must be finalized");

// EL: a pruned EL no longer serves state this deep (Geth keeps recent states only).
const balance = BigInt(await net.rpc<string>("eth_getBalance", [account, old.number]));
assert(balance > 0n, "the funded account has no balance at the old block");
const depositCount = await net.rpc<string>("eth_call", [
  { to: "0x4242424242424242424242424242424242424242", data: "0x621fd130" },
  old.number,
]);
assert(depositCount.startsWith("0x"), "the deposit contract call at the old block failed");

// CL: a pruned Lighthouse answers 404 for finalized slots below its split.
const bySlot = await net.beacon<{ data: { slot: string } }>(
  `/eth/v2/debug/beacon/states/${oldSlot}`,
);
assert.equal(Number(bySlot.data.slot), oldSlot);
const byRoot = await net.beacon<{ data: unknown[] }>(
  `/eth/v1/beacon/states/${oldStateRoot}/validators?id=0`,
);
assert.equal(byRoot.data.length, 1, "the old state by root misses validator 0");

// The client logs of a long chain no longer hold the startup lines; a snapshot must still work.
const snapshot = await net.createSnapshot();

// A 72-hour fast jump on a longer archive chain stores every skipped state. On a Lido stand with
// its services running, the same jump from slot 1561 overflowed the default stack of a beacon node
// thread. This chain does not reproduce that crash; it guards the jump itself.
// That stand's registry also held active validators without a key in Chronix's VC. The jump spans
// more than two sync committee periods, so the duties of its destination are not in the head state
// from before the jump. Four keys go offline for the jump to keep validators silent.
const OFFLINE = [60, 61, 62, 63];
const headSlot = async () =>
  Number(
    (await net.beacon<{ data: { header: { message: { slot: string } } } }>(
      "/eth/v1/beacon/headers/head",
    )).data.header.message.slot,
  );
while (await headSlot() <= 1600) await net.advanceSlots(100);
await net.setValidatorsOnline(OFFLINE, false);
const jumpSeconds = 72 * 3600;
// A regression watchdog for a lost beacon node, not the fast-mode latency budget.
const watchdogMs = 120_000;
const before = await net.status();
const beforeHead = await headSlot();
const { el } = await net.lifecycle();
const manifest = await Network.manifest(before.id);
const jumpStarted = performance.now();
const jumpAndTransact = async () => {
  await net.advanceTime(jumpSeconds, { mode: "fast" });
  const advanceMs = performance.now() - jumpStarted;
  const advanced = await net.status();
  assert.equal(advanced.now, before.now + jumpSeconds);
  assert.equal(advanced.slot, before.slot + jumpSeconds / 12);
  // An offline proposer leaves the destination empty, as it leaves any of its slots.
  const destination = (await net.beacon<{ data: { slot: string; validator_index: string }[] }>(
    `/eth/v1/validator/duties/proposer/${Math.floor(advanced.slot / 32)}`,
  )).data.find((duty) => Number(duty.slot) === advanced.slot);
  assert(destination, "no proposer duty for the destination slot");
  const produced = !OFFLINE.includes(Number(destination.validator_index));
  const headAfter = produced ? advanced.slot : beforeHead;
  assert.equal(
    await headSlot(),
    headAfter,
    "the beacon head differs from the destination proposer",
  );
  assert.equal(
    BigInt(advanced.el.number) - BigInt(before.el.number),
    produced ? 1n : 0n,
    "Fast warp must produce the destination of an online proposer after the skipped gap",
  );
  assert.equal(
    Number(BigInt(advanced.el.timestamp)),
    manifest.config.genesisTime + headAfter * 12,
  );
  assert.equal((await executionAt(manifest, "head")).block_hash, advanced.el.hash);
  await net.setAutomine(true);
  const nonce = Number(
    BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"])),
  );
  const signed = await new Wallet(privateKey).signTransaction({
    chainId: manifest.config.chainId,
    nonce,
    to: account,
    value: 1n,
    gasLimit: 1_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    type: 2,
  });
  const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
  const receipt = await net.waitForService(
    "transaction after the archive jump",
    async () =>
      (await net.rpc<{ status: string; blockHash: string; blockNumber: string } | null>(
        "eth_getTransactionReceipt",
        [hash],
      )) ?? undefined,
    10_000,
  );
  assert.equal(receipt.status, "0x1");
  assert.equal(BigInt(receipt.blockNumber), BigInt(advanced.el.number) + 1n);
  await net.setAutomine(false);
  const readyMs = performance.now() - jumpStarted;
  assert.equal((await net.status()).el.hash, receipt.blockHash);
  assert.equal((await net.clients()).bn.running, true, "the beacon node stopped after the jump");
  return {
    seconds: jumpSeconds,
    fromSlot: before.slot,
    toSlot: advanced.slot,
    offline: OFFLINE,
    destinationProposer: Number(destination.validator_index),
    destinationProduced: produced,
    advanceMs,
    readyMs,
    receipt: { blockHash: receipt.blockHash, blockNumber: receipt.blockNumber },
  };
};
let jump: Awaited<ReturnType<typeof jumpAndTransact>>;
try {
  jump = await deadline(
    jumpAndTransact(),
    watchdogMs,
    "the 72-hour archive jump including its next transaction exceeded the regression watchdog",
  );
} catch (error) {
  // A lost beacon node also fails status(), so the failure is bound to the state before the jump.
  await profileReport(before, "history", {
    passed: false,
    history,
    watchdogMs,
    jump: {
      seconds: jumpSeconds,
      fromSlot: before.slot,
      elapsedMs: performance.now() - jumpStarted,
    },
    failure: String(error),
    clients: await net.clients().catch((cause) => String(cause)),
  }, el).catch((cause) =>
    console.error(JSON.stringify({ event: "report-failed", cause: `${cause}` }))
  );
  throw error;
}

await report(net, "history", {
  event: "history-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  history,
  depth,
  oldSlot,
  finalizedSlot,
  snapshot: snapshot.id,
  jump,
  status: await net.status(),
});
