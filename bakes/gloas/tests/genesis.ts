import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";
import { json } from "../../../src/http.ts";
import { report } from "../../shared/tests/report.ts";
import { validator } from "../../shared/tests/validators.ts";

// Real clients: parametrized genesis allocations, validator groups and config values, plus Geth
// read-only tracing. Each value is observed through EL/CL behavior, not only reported config.
const started = performance.now();
const wallet = "0x" + "11".repeat(20);
const vault = "0x" + "aa".repeat(20);
const recipient = "0x" + "cd".repeat(20);
const contract = "0x" + "22".repeat(20);
// PUSH1 0 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN: returns storage slot 0.
const code = "0x60005460005260206000f3";
const mnemonicAccount = (index: number) =>
  [
    "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  ][index - 1];
const ETH = 10n ** 18n;
const other =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GWEI_PER_ETH = 1_000_000_000n;

const chainId = 32382;
const genesisForkVersion = "0x10000038";
await using net = await Devnet.start({
  id: `genesis-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
  chainId,
  genesisForkVersion,
  genesis: {
    accounts: {
      [wallet]: { balance: "1000ETH" },
      [contract]: { balance: "0", code, storage: { "0x00": "0x2a" }, nonce: 1 },
    },
    mnemonicAccounts: { count: 3, balance: "10ETH" },
    gasLimit: 45_000_000,
    feeRecipient: recipient,
    validators: [
      { count: 48 },
      { count: 16, balance: "2048ETH", withdrawal: { type: "0x02", address: vault } },
      { count: 8, withdrawal: { type: "0x00" } },
      { count: 8, mnemonic: other, start: 5 },
      { count: 8, online: false },
    ],
    spec: { SHARD_COMMITTEE_PERIOD: 1, MIN_VALIDATOR_WITHDRAWABILITY_DELAY: 1 },
  },
});
const balance = async (address: string) =>
  BigInt(await net.rpc<string>("eth_getBalance", [address, "latest"]));

// EL allocations.
assert.equal(await balance(wallet), 1000n * ETH);
assert.equal(await balance(account), 1_000_000n * ETH, "default funded account changed");
assert.equal(await balance(mnemonicAccount(1)), 10n * ETH);
assert.equal(await balance(mnemonicAccount(2)), 10n * ETH);
assert.equal(await balance(mnemonicAccount(3)), 0n, "mnemonic account count was not applied");
assert.equal(await net.rpc("eth_getCode", [contract, "latest"]), code);
assert.equal(BigInt(await net.rpc<string>("eth_getTransactionCount", [contract, "latest"])), 1n);
assert.equal(BigInt(await net.rpc<string>("eth_call", [{ to: contract }, "latest"])), 42n);
const genesisBlock = await net.rpc<{ gasLimit: string }>("eth_getBlockByNumber", ["0x0", false]);
assert.equal(BigInt(genesisBlock.gasLimit), 45_000_000n);

// Chain identity reaches both clients: EL chain ID, CL deposit chain and fork version.
assert.equal(BigInt(await net.rpc<string>("eth_chainId")), BigInt(chainId));
const spec = (await net.beacon<{ data: Record<string, string> }>("/eth/v1/config/spec")).data;
assert.equal(spec.DEPOSIT_CHAIN_ID, String(chainId));
assert.equal(spec.GENESIS_FORK_VERSION, genesisForkVersion);
const beaconGenesis = await net.beacon<{ data: { genesis_fork_version: string } }>(
  "/eth/v1/beacon/genesis",
);
assert.equal(beaconGenesis.data.genesis_fork_version, genesisForkVersion);

// CL validator groups, in index order.
assert.equal(spec.SHARD_COMMITTEE_PERIOD, "1");
assert.equal(spec.MIN_VALIDATOR_WITHDRAWABILITY_DELAY, "1");
const registry = await net.beacon<{ data: unknown[] }>("/eth/v1/beacon/states/head/validators");
assert.equal(registry.data.length, 88);
const groups = [
  { index: 0, prefix: "0x01", address: account, balance: 32n },
  { index: 47, prefix: "0x01", address: account, balance: 32n },
  { index: 48, prefix: "0x02", address: vault, balance: 2048n },
  { index: 63, prefix: "0x02", address: vault, balance: 2048n },
  { index: 64, prefix: "0x00", balance: 32n },
  { index: 71, prefix: "0x00", balance: 32n },
  { index: 72, prefix: "0x01", address: account, balance: 32n },
  { index: 87, prefix: "0x01", address: account, balance: 32n },
];
for (const group of groups) {
  const record = await validator(net, group.index);
  const credentials = record.validator.withdrawal_credentials;
  assert(credentials.startsWith(group.prefix), `validator ${group.index}: ${credentials}`);
  if (group.address) assert.equal(`0x${credentials.slice(26)}`, group.address.toLowerCase());
  assert.equal(BigInt(record.balance), group.balance * GWEI_PER_ETH, `validator ${group.index}`);
  assert.equal(record.status, "active_ongoing");
}

// Every genesis key is managed by the VC: all groups vote and the chain finalizes.
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 1n,
  { maxSlots: 160, timeoutMs: 900_000 },
);
const epoch = Math.floor((await net.status()).slot / 32) - 1;
const liveness = await json<{ data: { index: string; is_live: boolean }[] }>(
  `${net.url}/eth/v1/validator/liveness/${epoch}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(Array.from({ length: 88 }, (_, index) => String(index))),
  },
);
// The custom-mnemonic group signs; only the offline group is silent from genesis.
assert.deepEqual(
  liveness.data.filter((item) => !item.is_live).map((item) => Number(item.index)),
  Array.from({ length: 8 }, (_, index) => 80 + index),
  "genesis groups do not sign as configured",
);
const managed = await net.validators();
assert(managed.slice(72, 80).every((entry) => entry.managed && entry.online));
assert(managed.slice(80, 88).every((entry) => entry.managed && !entry.online));
// The custom group's keys are the mnemonic's indices 5..12, not the managed mnemonic's.
const managedKeys = new Set(managed.slice(0, 72).map((entry) => entry.pubkey));
assert(managed.slice(72, 80).every((entry) => !managedKeys.has(entry.pubkey)));
const head = await net.rpc<{ gasLimit: string; miner: string }>("eth_getBlockByNumber", [
  "latest",
  false,
]);
assert.equal(BigInt(head.gasLimit), 45_000_000n, "Geth moved away from the genesis gas limit");
assert.equal(head.miner.toLowerCase(), recipient, "VC fee recipient was not applied");

// Config overrides change protocol behavior: an exit is accepted after one epoch, and the
// validator becomes withdrawable one epoch after its exit.
await net.exitValidator((await validator(net, 0)).validator.pubkey);
await net.stepSlot();
const exiting = await validator(net, 0);
assert.equal(exiting.status, "active_exiting");
assert.equal(
  Number(exiting.validator.withdrawable_epoch),
  Number(exiting.validator.exit_epoch) + 1,
);

// Read-only Geth tracing through the controller; mutating debug methods never reach Geth.
await net.setAutomine(true);
const signed = await new Wallet(privateKey).signTransaction({
  type: 2,
  chainId,
  nonce: Number(BigInt(await net.rpc<string>("eth_getTransactionCount", [account, "latest"]))),
  to: contract,
  gasLimit: 100_000,
  maxFeePerGas: 10_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
});
const hash = await net.rpc<string>("eth_sendRawTransaction", [signed]);
await net.waitForService("traced transaction receipt", async () => {
  const receipt = await net.rpc<{ status: string } | null>("eth_getTransactionReceipt", [hash]);
  if (receipt) assert.equal(receipt.status, "0x1");
  return receipt ?? undefined;
}, 300_000);
await net.setAutomine(false);
const trace = await net.rpc<{ failed: boolean; structLogs: { op: string }[] }>(
  "debug_traceTransaction",
  [hash],
);
assert.equal(trace.failed, false);
assert(trace.structLogs.some((log) => log.op === "SLOAD"), "trace misses the contract's SLOAD");
const before = await net.status();
const refused = await fetch(net.url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_setHead", params: ["0x1"] }),
});
assert.equal(refused.status, 403);
await refused.body?.cancel();
assert.equal((await net.status()).el.hash, before.el.hash, "debug_setHead reached Geth");

await report(net, "genesis", {
  event: "genesis-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  finalized: (await net.status()).finality.data.finalized,
  liveEpoch: epoch,
  exiting,
  traceSteps: trace.structLogs.length,
  status: await net.status(),
});
