import assert from "node:assert/strict";
import {
  computeDomain,
  decryptKeystore,
  isSyncAggregator,
  publicKey,
  sign,
  signingRoot,
  syncSelectionRoot,
} from "../src/sync_aggregator.ts";

const hex = (value: string) =>
  Uint8Array.from(value.replace(/^0x/, "").match(/../g)!.map((byte) => parseInt(byte, 16)));
const text = (bytes: Uint8Array) =>
  "0x" + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("EIP-2335 keystores from the genesis generator decrypt to their own public key", async () => {
  const fixture = JSON.parse(await Deno.readTextFile("tests/fixtures/dev-keystore-0.json"));
  const secret = await decryptKeystore(fixture.keystore, fixture.password);
  assert.equal(text(publicKey(secret)), `0x${fixture.keystore.pubkey}`);
  await assert.rejects(decryptKeystore(fixture.keystore, "wrong"), /checksum/);
});

Deno.test("BLS signatures follow the Ethereum proof-of-possession ciphersuite", () => {
  // consensus-spec-tests bls/sign: privkey 0x263d…, message 32 zero bytes.
  const signature = sign(
    hex("0x263dbd792f5b1be47ed85f8938c0f29586af0d3ac7b977f21c278fe1462040e3"),
    new Uint8Array(32),
  );
  assert.equal(
    text(signature),
    "0xb6ed936746e01f8ecf281f020953fbf1f01debd5657c4a383940b020b26507f6076334f91e2366c96e9ab279fb5158090352ea1c5b0c9274504f4f0e7053af24802e51e4568d164fe986834f41e55c8e850ce1f98458c0cfc9ab380b55285a55",
  );
});

Deno.test("signing domains and roots use the consensus SSZ definitions", async () => {
  // Mainnet deposit domain: DOMAIN_DEPOSIT, genesis fork version and a zero validators root.
  assert.equal(
    text(await computeDomain(hex("0x03000000"), hex("0x00000000"), new Uint8Array(32))),
    "0x03000000f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a9",
  );
  const chunk = (value: number) => {
    const bytes = new Uint8Array(32);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return bytes;
  };
  const sha = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  assert.deepEqual(
    await syncSelectionRoot(1234, 3),
    await sha(new Uint8Array([...chunk(1234), ...chunk(3)])),
  );
  const domain = new Uint8Array(32).fill(7);
  assert.deepEqual(
    await signingRoot(new Uint8Array(32).fill(1), domain),
    await sha(new Uint8Array([...new Uint8Array(32).fill(1), ...domain])),
  );
});

Deno.test("sync aggregator selection uses the spec modulo of 8 for mainnet subcommittees", async () => {
  let selected = 0;
  for (let index = 0; index < 400; index++) {
    const proof = new Uint8Array(96);
    new DataView(proof.buffer).setUint32(0, index, true);
    if (await isSyncAggregator(proof)) selected++;
  }
  // About one in eight proofs selects an aggregator.
  assert(selected > 20 && selected < 85, `selected ${selected} of 400`);
});
