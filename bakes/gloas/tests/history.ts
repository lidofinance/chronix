import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { account, type HistoryMode } from "../../../src/config.ts";
import { report } from "../../shared/tests/report.ts";

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

// EL: a pruned Geth answers "historical state is not available" at this depth.
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

await report(net, "history", {
  event: "history-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  history,
  depth,
  oldSlot,
  finalizedSlot,
  snapshot: snapshot.id,
  status: await net.status(),
});
