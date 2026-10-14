import assert from "node:assert/strict";
import { decodeRlp, encodeRlp, hexlify, keccak256, sha256, toQuantity, Wallet } from "ethers";
import type { Devnet } from "../../../src/api.ts";
import { account, privateKey } from "../../../src/config.ts";

export type BlobTransaction = {
  raw: string;
  hash: string;
  blob: string;
  blobs: string[];
  commitment: string;
  chainId: number;
};

/** Geth computes real proofs; ethers only signs the EIP-4844 transaction body.
 * Geth 5d8fd6b6 core/types/tx_blob.go encodes its Osaka V1 network wrapper as
 * [transaction, version, blobs, commitments, cell_proofs]. Ethers 6.15 only parses V0.
 */
export async function blobTransaction(
  net: Devnet,
  chainId: number,
  options: { count?: number; nonce?: number } = {},
): Promise<BlobTransaction> {
  const count = options.count ?? 1;
  const nonce = options.nonce ?? 0;
  const blobs = Array.from({ length: count }, (_, index) => {
    const bytes = new Uint8Array(4096 * 32);
    const view = new DataView(bytes.buffer);
    // Distinct small field elements are canonical BLS scalar encodings, not an all-zero fixture.
    for (let i = 0; i < 4096; i++) view.setUint32(i * 32 + 28, i + 1 + index * 4096, false);
    return hexlify(bytes);
  });
  const fees = { maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
  const filled = await net.rpc<{ raw: string }>("eth_fillTransaction", [{
    from: account,
    to: account,
    chainId: toQuantity(chainId),
    nonce: toQuantity(nonce),
    gas: "0x5208",
    value: "0x1",
    maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}`,
    maxFeePerBlobGas: "0x2540be400",
    blobs,
  }]);
  assert(filled.raw.startsWith("0x03"), "Geth must construct a type-3 transaction");
  const wrapper = decodeRlp(`0x${filled.raw.slice(4)}`);
  assert(Array.isArray(wrapper) && wrapper.length === 5, "expected Osaka sidecar V1");
  const [unsigned, version, sidecarBlobs, commitments, proofs] = wrapper;
  assert(Array.isArray(unsigned) && unsigned.length === 14);
  assert.equal(version, "0x01");
  assert.deepEqual(sidecarBlobs, blobs);
  assert(Array.isArray(commitments) && commitments.length === count);
  assert(Array.isArray(proofs) && proofs.length === 128 * count);
  for (const commitment of commitments) {
    assert(typeof commitment === "string" && commitment.length === 2 + 48 * 2);
  }
  for (const proof of proofs) assert(typeof proof === "string" && proof.length === 2 + 48 * 2);
  const versionedHashes = (commitments as string[]).map((commitment) =>
    `0x01${sha256(commitment).slice(4)}`
  );
  assert.deepEqual(unsigned[10], versionedHashes);
  const signed = await new Wallet(privateKey).signTransaction({
    type: 3,
    chainId,
    nonce,
    to: account,
    value: 1n,
    gasLimit: 21_000n,
    ...fees,
    maxFeePerBlobGas: 10_000_000_000n,
    blobVersionedHashes: versionedHashes,
  });
  const body = decodeRlp(`0x${signed.slice(4)}`);
  assert(Array.isArray(body));
  assert.deepEqual(
    body.slice(0, 11),
    unsigned.slice(0, 11),
    "sign only Geth's exact prepared body",
  );
  return {
    raw: `0x03${encodeRlp([body, version, sidecarBlobs, commitments, proofs]).slice(2)}`,
    hash: keccak256(signed),
    blob: blobs[0],
    blobs,
    commitment: commitments[0] as string,
    chainId,
  };
}
