import { concat, decodeRlp, encodeRlp, hexlify, keccak256, sha256, Wallet } from "ethers";
import { KZG } from "micro-eth-signer/kzg.js";
import { trustedSetup } from "@paulmillr/trusted-setups/fast-peerdas.js";
import { account, privateKey } from "../../../src/config.ts";

export type BlobTransaction = {
  raw: string;
  hash: string;
  blob: string;
  blobs: string[];
  commitment: string;
  commitments: string[];
  /** The 128 cells of each blob and their proofs, blob after blob. */
  cells: string[][];
  proofs: string[];
  versionedHashes: string[];
  chainId: number;
};

// The mainnet KZG ceremony output with FK20 tables; built once, on first use.
let kzg: KZG | undefined;

/** A signed type-3 transaction in the EIP-7594 network form an EL accepts after Osaka:
 * 0x03 || rlp([body, 1, blobs, commitments, cell_proofs]) with 128 cell proofs per blob.
 * The test computes the sidecar itself; no EL builds it.
 */
export async function blobTransaction(
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
  kzg ??= new KZG(trustedSetup);
  const commitments = blobs.map((blob) => kzg!.blobToKzgCommitment(blob));
  const sidecar = blobs.map((blob) => kzg!.computeCellsAndProofs(blob));
  const cells = sidecar.map(([blobCells]) => blobCells);
  const proofs = sidecar.flatMap(([, blobProofs]) => blobProofs);
  const versionedHashes = commitments.map((commitment) => `0x01${sha256(commitment).slice(4)}`);
  const signed = await new Wallet(privateKey).signTransaction({
    type: 3,
    chainId,
    nonce,
    to: account,
    value: 1n,
    gasLimit: 21_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerBlobGas: 10_000_000_000n,
    blobVersionedHashes: versionedHashes,
  });
  const body = decodeRlp(`0x${signed.slice(4)}`);
  return {
    raw: concat(["0x03", encodeRlp([body, "0x01", blobs, commitments, proofs])]),
    // The transaction hash covers the signed body only, never the sidecar.
    hash: keccak256(signed),
    blob: blobs[0],
    blobs,
    commitment: commitments[0],
    commitments,
    cells,
    proofs,
    versionedHashes,
    chainId,
  };
}

/** Whether every cell proof of the sidecar verifies against its blob's commitment. */
export function validSidecar(transaction: BlobTransaction): boolean {
  kzg ??= new KZG(trustedSetup);
  return kzg.verifyCellKzgProofBatch(
    transaction.cells.flatMap((cells, blob) => cells.map(() => transaction.commitments[blob])),
    transaction.cells.flatMap((cells) => cells.map((_, index) => index)),
    transaction.cells.flat(),
    transaction.proofs,
  );
}
