import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { defaultTimeoutMs, HttpError, json } from "./http.ts";
import type { Manifest } from "./network.ts";
import { validatorKey } from "./validator_control.ts";

/**
 * The sync committee aggregator duty for slots where some committee seats are silent.
 *
 * Controlled bakes deliver sync contributions directly once every seat has voted and disable the
 * VC's own aggregation. When chosen validators are offline or their keys left the VC, that full
 * coverage never arrives. Panda then performs exactly the duty an online aggregator performs on a
 * real network: it reads the beacon node's aggregate of the verified votes, proves aggregator
 * selection with an online member's real key and publishes a signed contribution through the
 * standard Beacon API, where the beacon node validates it as any gossip contribution.
 */

const DST = "BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";
const SYNC_COMMITTEE_SIZE = 512;
const SYNC_COMMITTEE_SUBNET_COUNT = 4;
const TARGET_AGGREGATORS_PER_SYNC_SUBCOMMITTEE = 16;
const SUBCOMMITTEE_SIZE = SYNC_COMMITTEE_SIZE / SYNC_COMMITTEE_SUBNET_COUNT;
const DOMAIN_SYNC_COMMITTEE_SELECTION_PROOF = Uint8Array.of(8, 0, 0, 0);
const DOMAIN_CONTRIBUTION_AND_PROOF = Uint8Array.of(9, 0, 0, 0);

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/^0x/, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("Invalid hex value");
  return Uint8Array.from(clean.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
function hex(value: Uint8Array): string {
  return "0x" + [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

/** EIP-2335 version 4 keystores with pbkdf2/HMAC-SHA256 and AES-128-CTR, as eth2-val-tools writes. */
export async function decryptKeystore(keystore: unknown, password: string): Promise<Uint8Array> {
  const crypto_ = keystore as {
    version?: number;
    crypto?: {
      kdf: { function: string; params: { c: number; dklen: number; prf: string; salt: string } };
      checksum: { function: string; message: string };
      cipher: { function: string; params: { iv: string }; message: string };
    };
  };
  const { kdf, checksum, cipher } = crypto_.crypto ?? {} as never;
  if (
    crypto_.version !== 4 || kdf?.function !== "pbkdf2" || kdf.params.prf !== "hmac-sha256" ||
    kdf.params.dklen !== 32 || checksum?.function !== "sha256" || cipher?.function !== "aes-128-ctr"
  ) throw new Error("Unsupported validator keystore format");
  // EIP-2335: NFKD, then remove C0, C1 and Delete control codes.
  const normalized = [...password.normalize("NFKD")].filter((character) => {
    const code = character.codePointAt(0)!;
    return code > 0x1f && (code < 0x7f || code > 0x9f);
  }).join("");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalized),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const key = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: bytes(kdf.params.salt), iterations: kdf.params.c },
      material,
      256,
    ),
  );
  const message = bytes(cipher.message);
  if (hex(await sha256(key.slice(16, 32), message)) !== `0x${checksum.message}`) {
    throw new Error("Validator keystore checksum mismatch");
  }
  const aes = await crypto.subtle.importKey("raw", key.slice(0, 16), "AES-CTR", false, [
    "decrypt",
  ]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: bytes(cipher.params.iv), length: 128 },
      aes,
      message,
    ),
  );
}
export function publicKey(secret: Uint8Array): Uint8Array {
  return bls.getPublicKey(secret);
}
export function sign(secret: Uint8Array, message: Uint8Array): Uint8Array {
  return bls.sign(message, secret, { DST });
}

// Minimal SSZ merkleization for the fixed containers used below.
function uint64(value: number | bigint): Uint8Array {
  const chunk = new Uint8Array(32);
  new DataView(chunk.buffer).setBigUint64(0, BigInt(value), true);
  return chunk;
}
function padded(value: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(32);
  chunk.set(value);
  return chunk;
}
async function merkleize(chunks: Uint8Array[]): Promise<Uint8Array> {
  let layer = [...chunks];
  let width = 1;
  while (width < layer.length) width *= 2;
  while (layer.length < width) layer.push(new Uint8Array(32));
  while (layer.length > 1) {
    const next = [];
    for (let index = 0; index < layer.length; index += 2) {
      next.push(await sha256(layer[index], layer[index + 1]));
    }
    layer = next;
  }
  return layer[0];
}
async function signatureRoot(signature: Uint8Array): Promise<Uint8Array> {
  return await merkleize([signature.slice(0, 32), signature.slice(32, 64), signature.slice(64)]);
}
export async function computeDomain(
  type: Uint8Array,
  forkVersion: Uint8Array,
  genesisValidatorsRoot: Uint8Array,
): Promise<Uint8Array> {
  const forkData = await merkleize([padded(forkVersion), genesisValidatorsRoot]);
  return new Uint8Array([...type, ...forkData.slice(0, 28)]);
}
export async function signingRoot(objectRoot: Uint8Array, domain: Uint8Array) {
  return await merkleize([objectRoot, domain]);
}
export async function syncSelectionRoot(slot: number, subcommittee: number) {
  return await merkleize([uint64(slot), uint64(subcommittee)]);
}
export async function isSyncAggregator(selectionProof: Uint8Array): Promise<boolean> {
  const modulo = Math.max(
    1,
    SYNC_COMMITTEE_SIZE / SYNC_COMMITTEE_SUBNET_COUNT / TARGET_AGGREGATORS_PER_SYNC_SUBCOMMITTEE,
  );
  const digest = await sha256(selectionProof);
  return new DataView(digest.buffer).getBigUint64(0, true) % BigInt(modulo) === 0n;
}

interface Contribution {
  slot: string;
  beacon_block_root: string;
  subcommittee_index: string;
  aggregation_bits: string;
  signature: string;
}
async function contributionAndProofRoot(
  aggregator: number,
  contribution: Contribution,
  selectionProof: Uint8Array,
): Promise<Uint8Array> {
  const contributionRoot = await merkleize([
    uint64(BigInt(contribution.slot)),
    bytes(contribution.beacon_block_root),
    uint64(BigInt(contribution.subcommittee_index)),
    padded(bytes(contribution.aggregation_bits)),
    await signatureRoot(bytes(contribution.signature)),
  ]);
  return await merkleize([
    uint64(aggregator),
    contributionRoot,
    await signatureRoot(selectionProof),
  ]);
}

export interface AggregationResult {
  subcommittee: number;
  online: number;
  aggregator?: number;
}

export class SyncAggregator {
  private readonly secrets = new Map<string, Uint8Array>();
  constructor(readonly manifest: () => Manifest) {}

  private async secret(pubkey: string): Promise<Uint8Array> {
    const cached = this.secrets.get(pubkey);
    if (cached) return cached;
    const key = await validatorKey(this.manifest(), pubkey);
    if (!key) throw new Error(`No local key for sync aggregator ${pubkey}`);
    const keystore = JSON.parse(key.keystore);
    const password = key.password;
    const secret = await decryptKeystore(keystore, password);
    if (hex(publicKey(secret)) !== pubkey) throw new Error(`Keystore does not match ${pubkey}`);
    this.secrets.set(pubkey, secret);
    return secret;
  }

  private async domain(type: Uint8Array, slot: number): Promise<Uint8Array> {
    const beacon = this.manifest().beacon;
    const genesis = await json<{ data: { genesis_validators_root: string } }>(
      `${beacon}/eth/v1/beacon/genesis`,
    );
    const fork = await json<
      { data: { previous_version: string; current_version: string; epoch: string } }
    >(`${beacon}/eth/v1/beacon/states/head/fork`);
    const version = Math.floor(slot / 32) >= Number(fork.data.epoch)
      ? fork.data.current_version
      : fork.data.previous_version;
    return await computeDomain(type, bytes(version), bytes(genesis.data.genesis_validators_root));
  }

  /**
   * Publish one contribution per subcommittee for the verified votes at `slot` on `root`.
   * `seats` are the 512 validator indices of the committee signing at this slot; `online` returns
   * whether a validator's key is enabled in the VC (it may vote), `required` whether it must have
   * voted, and `pubkeys` maps indices to their public keys.
   */
  async publish(
    slot: number,
    root: string,
    seats: number[],
    online: (index: number) => boolean,
    pubkeys: Map<number, string>,
    required: (index: number) => boolean = online,
  ): Promise<AggregationResult[]> {
    const beacon = this.manifest().beacon;
    const selectionDomain = await this.domain(DOMAIN_SYNC_COMMITTEE_SELECTION_PROOF, slot);
    const proofDomain = await this.domain(DOMAIN_CONTRIBUTION_AND_PROOF, slot);
    const results: AggregationResult[] = [];
    for (let subcommittee = 0; subcommittee < SYNC_COMMITTEE_SUBNET_COUNT; subcommittee++) {
      const members = seats.slice(
        subcommittee * SUBCOMMITTEE_SIZE,
        (subcommittee + 1) * SUBCOMMITTEE_SIZE,
      );
      const allowed = new Uint8Array(SUBCOMMITTEE_SIZE / 8);
      const needed = new Uint8Array(SUBCOMMITTEE_SIZE / 8);
      members.forEach((index, position) => {
        if (online(index)) allowed[position >> 3] |= 1 << (position & 7);
        if (required(index)) needed[position >> 3] |= 1 << (position & 7);
      });
      const count = members.filter(online).length;
      results.push({ subcommittee, online: count });
      if (!count) continue;
      let contribution: Contribution;
      try {
        contribution = (await json<{ data: Contribution }>(
          `${beacon}/eth/v1/validator/sync_committee_contribution?slot=${slot}&subcommittee_index=${subcommittee}&beacon_block_root=${root}`,
        )).data;
      } catch (error) {
        // No verified vote at all: acceptable only when no seat had to vote.
        if (error instanceof HttpError && error.status === 404 && !needed.some(Boolean)) continue;
        throw error;
      }
      // Every required seat must have voted, and no silent seat may appear.
      const actual = bytes(contribution.aggregation_bits);
      if (
        actual.length !== needed.length ||
        actual.some((byte, i) => (byte & needed[i]) !== needed[i] || (byte & ~allowed[i]) !== 0)
      ) {
        throw new Error(
          `Unexpected sync votes at slot ${slot} subcommittee ${subcommittee}: ${contribution.aggregation_bits} (required ${
            hex(needed)
          }, allowed ${hex(allowed)})`,
        );
      }
      const selectionRoot = await signingRoot(
        await syncSelectionRoot(slot, subcommittee),
        selectionDomain,
      );
      for (const index of new Set(members.filter(online))) {
        const pubkey = pubkeys.get(index);
        if (!pubkey) throw new Error(`Unknown sync committee validator ${index}`);
        const secret = await this.secret(pubkey);
        const proof = sign(secret, selectionRoot);
        // As on a real network, a subcommittee without a selected aggregator contributes nothing.
        if (!await isSyncAggregator(proof)) continue;
        const message = {
          aggregator_index: String(index),
          contribution,
          selection_proof: hex(proof),
        };
        const signature = sign(
          secret,
          await signingRoot(
            await contributionAndProofRoot(index, contribution, proof),
            proofDomain,
          ),
        );
        try {
          await json(`${beacon}/eth/v1/validator/contribution_and_proofs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([{ message, signature: hex(signature) }]),
            signal: AbortSignal.timeout(defaultTimeoutMs()),
          });
        } catch (error) {
          // A repeated publication for this slot (after a restart) is already in the pool.
          if (!(error instanceof HttpError && /known|superset/i.test(error.message))) throw error;
        }
        results[subcommittee].aggregator = index;
        break;
      }
    }
    return results;
  }
}
