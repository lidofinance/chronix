import { report as writeReport } from "./report.ts";
import { finalizedExecutionHash } from "../../../src/consensus.ts";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { delay, json } from "../../../src/http.ts";
import { Network } from "../../../src/network.ts";
import { assertFeeCappedTransactionPaused } from "./automine_assertions.ts";

const started = performance.now();
await using net = await Devnet.start({ id: `e2e-${crypto.randomUUID().slice(0, 8)}` });
const wallet = new Wallet(privateKey);
const send = async (nonce: number, overrides: Record<string, unknown> = {}) => {
  const signed = await wallet.signTransaction({
    type: 2,
    chainId: 1337,
    nonce,
    to: account,
    gasLimit: 21000,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 1n,
    ...overrides,
  });
  return await net.rpc<string>("eth_sendRawTransaction", [signed]);
};
const receipt = (hash: string) =>
  net.rpc<{ blockNumber: string; status: string; contractAddress?: string } | null>(
    "eth_getTransactionReceipt",
    [hash],
  );
const initial = await net.status();
const manifest = await Network.manifest(initial.id);
for (
  const body of [
    JSON.stringify([{ jsonrpc: "2.0", id: 17, method: "eth_chainId", params: [] }, {
      jsonrpc: "2.0",
      id: 18,
      method: "unknown_method",
      params: [],
    }]),
    "{",
    JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", params: [] }),
  ]
) {
  const forward = async (url: string) => {
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    return { status: response.status, text: await response.text() };
  };
  assert.deepEqual(await forward(net.url), await forward(manifest.el));
}
await delay(1500);
assert.equal((await net.status()).el.hash, initial.el.hash, "paused head changed");
await net.advanceTime(24);
assert.equal((await net.status()).now, initial.now + 24);
await net.advanceTo(new Date((initial.now + 36) * 1000));
assert.equal((await net.status()).slot, 3);
assert(
  Number(BigInt((await net.status()).el.timestamp)) > Date.now() / 1000,
  "future timestamp was not tested",
);
const beforeLongPause = await net.status();
await delay(13_000); // Beyond Geth's real payload-builder deadline.
assert.equal((await net.status()).el.hash, beforeLongPause.el.hash);
await net.setAutomine(true);
const gapped = await send(1);
await delay(1000);
assert.equal((await net.status()).slot, 3, "nonce gap produced a block");
const first = await send(0);
await net.waitForService(
  "both nonce-ordered receipts",
  async () => (await receipt(first)) && (await receipt(gapped)) ? true : undefined,
);
const concurrent = await Promise.all([send(2), send(3), send(4)]);
await net.waitForService(
  "concurrent receipts",
  async () => (await Promise.all(concurrent.map(receipt))).every(Boolean) ? true : undefined,
);
await assertFeeCappedTransactionPaused(
  net,
  () => send(5, { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
);
// Deploy a nine-byte EVM runtime that returns TIMESTAMP. No compiler or mock EVM.
const deploy = await send(5, {
  to: null,
  value: 0,
  gasLimit: initial.profile === "gloas" ? 1_000_000 : 100_000,
  data: "0x6009600c60003960096000f34260005260206000f3",
});
await net.stepSlot();
const deployed = await receipt(deploy);
assert.equal(deployed?.status, "0x1");
const timestamp = await net.rpc<string>("eth_call", [
  { to: deployed!.contractAddress, data: "0x" },
  "latest",
]);
assert.equal(BigInt(timestamp), BigInt((await net.status()).el.timestamp));
// Interval mining moves the network without transactions; a transaction waits for its slot.
await net.setAutomine(false);
const beforeInterval = await net.status();
await net.setIntervalMining(2000);
await delay(5_000);
const ticking = await net.status();
assert.equal(ticking.intervalMining, 2000);
assert(
  ticking.slot >= beforeInterval.slot + 2,
  `interval mining produced ${ticking.slot - beforeInterval.slot} slots in 5 s`,
);
assert.notEqual(ticking.el.hash, beforeInterval.el.hash, "interval slots had no execution block");
const intervalMined = await send(6);
await net.waitForService(
  "interval-mined receipt",
  async () => (await receipt(intervalMined)) ? true : undefined,
);
await net.setIntervalMining(0);
const held = await net.status();
await delay(3_000);
assert.equal((await net.status()).el.hash, held.el.hash, "a slot after interval mining stopped");
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 2n,
  { maxSlots: 160, timeoutMs: 300_000 },
);
const cl = await finalizedExecutionHash(manifest);
const el = await net.rpc<{ hash: string }>("eth_getBlockByNumber", ["finalized", false]);
assert.equal(el.hash, cl);

const service = new Deno.Command(Deno.execPath(), {
  args: ["run", "--allow-net", "bakes/shared/tests/indexer.ts", net.url],
  stdout: "piped",
  stderr: "inherit",
}).spawn();
const reader = service.stdout.getReader();
try {
  const firstLine = await reader.read();
  const serviceUrl = JSON.parse(new TextDecoder().decode(firstLine.value)).url;
  await net.stepSlot();
  const expected = (await net.status()).el.hash;
  await net.waitForService(
    "external indexer processed head",
    async () => (await json<{ hash: string }>(serviceUrl)).hash === expected ? true : undefined,
  );
} finally {
  reader.releaseLock();
  service.kill("SIGTERM");
  await service.status;
}
const report = {
  event: "e2e-passed",
  elapsedMs: performance.now() - started,
  status: await net.status(),
};
await writeReport(net, "e2e", report);
