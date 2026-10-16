import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { scryptAsync } from "@noble/hashes/scrypt";
import { defaultTimeoutMs, HttpError, json } from "./http.ts";
import type { Manifest } from "./network.ts";
import { validatorKey } from "./validator_control.ts";

/**
 * The sync committee aggregator duty for slots where some committee seats are silent.
 *
 * Controlled bakes deliver sync contributions directly once every seat has voted and disable the
 * VC's own aggregation. When chosen validators are offline or their keys left the VC, that full
 * coverage never arrives. Chronix then performs exactly the duty an online aggregator performs on a
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
const DOMAIN_SELECTION_PROOF = Uint8Array.of(5, 0, 0, 0);
const TARGET_AGGREGATORS_PER_COMMITTEE = 16;

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

/** EIP-2335 version 4 keystores (pbkdf2/HMAC-SHA256 or scrypt, AES-128-CTR), as Lighthouse reads. */
export async function decryptKeystore(keystore: unknown, password: string): Promise<Uint8Array> {
  const value = keystore as {
    version?: number;
    crypto?: {
      kdf: { function: string; params: Record<string, unknown> };
      checksum: { function: string; message: string };
      cipher: { function: string; params: { iv: string }; message: string };
    };
  };
  const { kdf, checksum, cipher } = value.crypto ?? {} as never;
  if (
    value.version !== 4 || kdf?.params?.dklen !== 32 || checksum?.function !== "sha256" ||
    cipher?.function !== "aes-128-ctr"
  ) throw new Error("Unsupported validator keystore format");
  // EIP-2335: NFKD, then remove C0, C1 and Delete control codes.
  const normalized = new TextEncoder().encode(
    [...password.normalize("NFKD")].filter((character) => {
      const code = character.codePointAt(0)!;
      return code > 0x1f && (code < 0x7f || code > 0x9f);
    }).join(""),
  );
  const salt = bytes(String(kdf.params.salt));
  let key: Uint8Array;
  if (kdf.function === "pbkdf2" && kdf.params.prf === "hmac-sha256") {
    const iterations = Number(kdf.params.c);
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 2 ** 24) {
      throw new Error("Unsupported pbkdf2 iteration count");
    }
    const material = await crypto.subtle.importKey("raw", normalized, "PBKDF2", false, [
      "deriveBits",
    ]);
    key = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations },
        material,
        256,
      ),
    );
  } else if (kdf.function === "scrypt") {
    const [N, r, p] = [kdf.params.n, kdf.params.r, kdf.params.p].map(Number);
    if (
      ![N, r, p].every(Number.isSafeInteger) || N < 2 || N > 2 ** 18 || r < 1 || r > 8 ||
      p < 1 || p > 4
    ) throw new Error("Unsupported scrypt parameters: at most the EIP-2335 default cost");
    // EIP-2335's default cost (N=2^18, r=8) needs 256 MiB; nothing larger runs in a slot barrier.
    key = await scryptAsync(normalized, salt, { N, r, p, dkLen: 32, maxmem: 2 ** 29 });
  } else throw new Error("Unsupported validator keystore format");
  const message = bytes(cipher.message);
  if (hex(await sha256(key.slice(16, 32), message)) !== `0x${checksum.message.toLowerCase()}`) {
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

/** Attestation aggregators: `max(1, committee length / 16)`; 1 means every member aggregates. */
export function attestationModulo(committeeLength: number): number {
  return Math.max(1, Math.floor(committeeLength / TARGET_AGGREGATORS_PER_COMMITTEE));
}
export async function isAttestationAggregator(proof: Uint8Array, modulo: number) {
  const digest = await sha256(proof);
  return new DataView(digest.buffer).getBigUint64(0, true) % BigInt(modulo) === 0n;
}
export async function attestationSelectionRoot(slot: number): Promise<Uint8Array> {
  return await merkleize([uint64(slot)]);
}

interface ForkEntry {
  previous_version: string;
  current_version: string;
  epoch: string;
}
/** The fork version active at `epoch` according to the network's fork schedule. */
export function forkVersionAt(schedule: ForkEntry[], epoch: number): string {
  let version: string | undefined;
  for (const fork of [...schedule].sort((a, b) => Number(BigInt(a.epoch) - BigInt(b.epoch)))) {
    if (BigInt(fork.epoch) <= BigInt(epoch)) version = fork.current_version;
  }
  if (!version) throw new Error(`No fork scheduled for epoch ${epoch}`);
  return version;
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

  /**
   * Whether a validator that must act at `slot` is selected to aggregate this committee, with the
   * same deterministic selection proof its VC computes. Committees below 32 members always are.
   */
  async selectedAttestationAggregator(
    slot: number,
    committee: number[],
    required: (index: number) => boolean,
    pubkeys: Map<number, string>,
  ): Promise<boolean> {
    const modulo = attestationModulo(committee.length);
    const members = committee.filter(required);
    if (modulo === 1) return members.length > 0;
    const root = await signingRoot(
      await attestationSelectionRoot(slot),
      await this.domain(DOMAIN_SELECTION_PROOF, slot),
    );
    for (const index of members) {
      const pubkey = pubkeys.get(index);
      if (!pubkey) throw new Error(`Unknown committee validator ${index}`);
      if (await isAttestationAggregator(sign(await this.secret(pubkey), root), modulo)) {
        return true;
      }
    }
    return false;
  }

  private network?: Promise<{ root: Uint8Array; schedule: ForkEntry[] }>;
  /** Signing domain of a duty at `slot`: the scheduled fork of its epoch, like the clients. */
  private async domain(type: Uint8Array, slot: number): Promise<Uint8Array> {
    const beacon = this.manifest().beacon;
    // A failed lookup is not cached: a restarted beacon node answers the next attempt.
    this.network ??= (async () => ({
      root: bytes(
        (await json<{ data: { genesis_validators_root: string } }>(
          `${beacon}/eth/v1/beacon/genesis`,
        )).data.genesis_validators_root,
      ),
      schedule: (await json<{ data: ForkEntry[] }>(`${beacon}/eth/v1/config/fork_schedule`)).data,
    }))().catch((error) => {
      this.network = undefined;
      throw error;
    });
    const { root, schedule } = await this.network;
    return await computeDomain(type, bytes(forkVersionAt(schedule, Math.floor(slot / 32))), root);
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
        // A repeated publication is accepted as already known (HTTP 200) by the beacon node.
        await json(`${beacon}/eth/v1/validator/contribution_and_proofs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([{ message, signature: hex(signature) }]),
          signal: AbortSignal.timeout(defaultTimeoutMs()),
        });
        results[subcommittee].aggregator = index;
        break;
      }
    }
    return results;
  }
}
