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

Deno.test("attestation aggregator selection follows the committee-length modulo", async () => {
  const { attestationModulo, isAttestationAggregator, attestationSelectionRoot } = await import(
    "../src/sync_aggregator.ts"
  );
  assert.deepEqual([1, 8, 31, 32, 48, 64].map(attestationModulo), [1, 1, 1, 2, 3, 4]);
  // Modulo 1 always selects; larger moduli select about 1/modulo of proofs.
  assert.equal(await isAttestationAggregator(new Uint8Array(96), 1), true);
  let selected = 0;
  for (let index = 0; index < 400; index++) {
    const proof = new Uint8Array(96);
    new DataView(proof.buffer).setUint32(0, index, true);
    if (await isAttestationAggregator(proof, 4)) selected++;
  }
  assert(selected > 60 && selected < 140, `selected ${selected} of 400`);
  // The selection signs the slot itself: hash_tree_root(uint64).
  const chunk = new Uint8Array(32);
  new DataView(chunk.buffer).setBigUint64(0, 77n, true);
  assert.deepEqual(await attestationSelectionRoot(77), chunk);
});

Deno.test("signing domains use the scheduled fork of the slot's epoch, not the head state", async () => {
  const { forkVersionAt } = await import("../src/sync_aggregator.ts");
  const schedule = [
    { previous_version: "0x60000000", current_version: "0x70000000", epoch: "0" },
    { previous_version: "0x70000000", current_version: "0x80000000", epoch: "2" },
  ];
  assert.equal(forkVersionAt(schedule, 1), "0x70000000");
  assert.equal(forkVersionAt(schedule, 2), "0x80000000");
  assert.equal(forkVersionAt(schedule, 9), "0x80000000");
});

// EIP-2335 reference vectors: password "𝔱𝔢𝔰𝔱𝔭𝔞𝔰𝔰𝔴𝔬𝔯𝔡🔑".
const referenceSecret = "0x000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const referencePassword =
  "\u{1d531}\u{1d522}\u{1d530}\u{1d531}\u{1d52d}\u{1d51e}\u{1d530}\u{1d530}\u{1d534}\u{1d52c}\u{1d52f}\u{1d521}\u{1f511}";
const referenceSalt = "d4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3";
const referenceIv = "264daa3f303d7259501c93d997d84fe6";

Deno.test("EIP-2335 scrypt keystores and upper-case checksums decrypt like Lighthouse", async () => {
  const scrypt = {
    version: 4,
    crypto: {
      kdf: {
        function: "scrypt",
        params: { dklen: 32, n: 262144, p: 1, r: 8, salt: referenceSalt },
        message: "",
      },
      checksum: {
        function: "sha256",
        params: {},
        message: "D2217FE5F3E9A1E34581EF8A78F7C9928E436D36DACC5E846690A5581E8EA484",
      },
      cipher: {
        function: "aes-128-ctr",
        params: { iv: referenceIv },
        message: "06ae90d55fe0a6e9c5c3bc5b170827b2e5cce3929ed3f116c2811e6366dfe20f",
      },
    },
  };
  assert.equal(text(await decryptKeystore(scrypt, referencePassword)), referenceSecret);
  const pbkdf2 = {
    version: 4,
    crypto: {
      kdf: {
        function: "pbkdf2",
        params: { dklen: 32, c: 262144, prf: "hmac-sha256", salt: referenceSalt },
        message: "",
      },
      checksum: {
        function: "sha256",
        params: {},
        message: "8a9f5d9912ed7e75ea794bc5a89bca5f193721d30868ade6f73043c6ea6febf1",
      },
      cipher: {
        function: "aes-128-ctr",
        params: { iv: referenceIv },
        message: "cee03fde2af33149775b7223e7845e4fb2c8ae1792e5f99fe9ecf474cc8c16ad",
      },
    },
  };
  assert.equal(text(await decryptKeystore(pbkdf2, referencePassword)), referenceSecret);
});

Deno.test("aggregator domains follow the fork schedule and recover from a failed lookup", async () => {
  const { SyncAggregator } = await import("../src/sync_aggregator.ts");
  let failures = 1;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const path = new URL(request.url).pathname;
    if (failures-- > 0) return new Response("transient", { status: 503 });
    if (path === "/eth/v1/beacon/genesis") {
      return Response.json({ data: { genesis_validators_root: "0x" + "00".repeat(32) } });
    }
    if (path === "/eth/v1/config/fork_schedule") {
      return Response.json({
        data: [
          { previous_version: "0x60000000", current_version: "0x70000000", epoch: "0" },
          { previous_version: "0x70000000", current_version: "0x80000000", epoch: "2" },
        ],
      });
    }
    // The head state still reports the earlier fork; it must not be used.
    return Response.json({
      data: { previous_version: "0x60000000", current_version: "0x70000000", epoch: "0" },
    });
  });
  try {
    const aggregator = new SyncAggregator(() =>
      ({ beacon: `http://127.0.0.1:${server.addr.port}` }) as never
    );
    const type = Uint8Array.of(8, 0, 0, 0);
    await assert.rejects(aggregator["domain"](type, 64));
    assert.deepEqual(
      await aggregator["domain"](type, 64),
      await computeDomain(type, hex("0x80000000"), new Uint8Array(32)),
      "a transient failure must not be cached",
    );
    assert.deepEqual(
      await aggregator["domain"](type, 63),
      await computeDomain(type, hex("0x70000000"), new Uint8Array(32)),
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("scrypt parameters are bounded to the EIP-2335 default cost", async () => {
  const keystore = {
    version: 4,
    crypto: {
      kdf: { function: "scrypt", params: { dklen: 32, n: 2 ** 20, p: 1, r: 8, salt: "00" } },
      checksum: { function: "sha256", params: {}, message: "00" },
      cipher: { function: "aes-128-ctr", params: { iv: "00" }, message: "00" },
    },
  };
  await assert.rejects(decryptKeystore(keystore, "x"), /scrypt parameters/);
});
