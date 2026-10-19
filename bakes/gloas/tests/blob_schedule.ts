import assert from "node:assert/strict";
import { Devnet } from "../../../src/api.ts";
import { report } from "../../shared/tests/report.ts";
import { blobTransaction, validSidecar } from "./blob_transaction.ts";

// Real clients: a genesis blob schedule is applied by both the EL and Lighthouse.
const started = performance.now();
await using net = await Devnet.start({
  id: `blobs-${crypto.randomUUID().slice(0, 8)}`,
  profile: "gloas",
  genesis: { blobSchedule: [{ epoch: 0, max: 1, target: 1 }] },
});
await net.advanceSlots(2);
const spec = (await net.beacon<{ data: Record<string, unknown> }>("/eth/v1/config/spec")).data;
const schedule = spec.BLOB_SCHEDULE as { EPOCH: string; MAX_BLOBS_PER_BLOCK: string }[];
assert.deepEqual(schedule.at(-1), { EPOCH: "0", MAX_BLOBS_PER_BLOCK: "1" }, "CL blob schedule");

const receipt = (hash: string) =>
  net.rpc<{ status: string; blobGasUsed?: string; blockNumber: string } | null>(
    "eth_getTransactionReceipt",
    [hash],
  );

// Two one-blob transactions submitted together go into separate blocks of one blob each.
const first = await blobTransaction(1337, { count: 1, nonce: 0 });
const second = await blobTransaction(1337, { count: 1, nonce: 1 });
for (const transaction of [first, second]) {
  assert.equal(
    await net.rpc<string>("eth_sendRawTransaction", [transaction.raw]),
    transaction.hash,
  );
}
await net.stepSlot();
const firstReceipt = await receipt(first.hash);
assert.equal(firstReceipt?.status, "0x1");
assert.equal(firstReceipt?.blobGasUsed, "0x20000");
assert.equal(await receipt(second.hash), null, "a block carried more blobs than the schedule");
await net.stepSlot();
const secondReceipt = await receipt(second.hash);
assert.equal(secondReceipt?.status, "0x1");
assert.equal(BigInt(secondReceipt!.blockNumber), BigInt(firstReceipt!.blockNumber) + 1n);
const blocks = await Promise.all(
  [firstReceipt!, secondReceipt!].map((item) =>
    net.rpc<{ blobGasUsed: string }>("eth_getBlockByNumber", [item.blockNumber, false])
  ),
);
assert.deepEqual(blocks.map((block) => block.blobGasUsed), ["0x20000", "0x20000"]);
for (const transaction of [first, second]) {
  const included = await net.rpc<{ blobVersionedHashes: string[] }>(
    "eth_getTransactionByHash",
    [transaction.hash],
  );
  assert.deepEqual(included.blobVersionedHashes, transaction.versionedHashes);
}

// A transaction with more blobs than a block may carry is never included. A pool may refuse it
// at once or keep it; no block may carry it either way.
const tooMany = await blobTransaction(1337, { count: 2, nonce: 2 });
// A broken proof must not pass for the blob limit: the sidecar itself is valid.
assert(validSidecar(tooMany), "the two-blob sidecar has an invalid cell proof");
const tooManyPooled = await net.rpc<string>("eth_sendRawTransaction", [tooMany.raw]).then(
  (hash) => {
    assert.equal(hash, tooMany.hash);
    return true;
  },
  (error) => {
    // Reth: "too many blobs in transaction" (transaction-pool/src/error.rs:197); Geth: "transaction
    // blob limit exceeded" (core/txpool/errors.go:68).
    assert.match(
      String(error),
      /too many blobs in transaction|transaction blob limit exceeded/,
      "a two-blob transaction was refused for another reason",
    );
    return false;
  },
);
await net.advanceSlots(3);
assert.equal(await receipt(tooMany.hash), null, "a two-blob transaction was included");

await report(net, "blob-schedule", {
  event: "blob-schedule-passed",
  passed: true,
  elapsedMs: performance.now() - started,
  schedule,
  receipts: [firstReceipt, secondReceipt],
  tooManyPooled,
  status: await net.status(),
});
