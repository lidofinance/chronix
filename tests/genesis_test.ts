import assert from "node:assert/strict";
import { account, configuration, mnemonic } from "../src/config.ts";
import { genesisEnvironment, genesisScript, offlineGenesisIndices } from "../src/genesis.ts";
import { identityMismatch } from "../src/network.ts";
import { profiles } from "../src/profiles.ts";

const recipe = profiles.gloas;
const env = (input: Parameters<typeof configuration>[0]) =>
  Object.fromEntries(
    genesisEnvironment(configuration({ profile: "gloas", ...input }), recipe).map((entry) => {
      const index = entry.indexOf("=");
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );

Deno.test("default genesis keeps the established generator environment", () => {
  assert.deepEqual(genesisEnvironment(configuration({ profile: "gloas" }), recipe), [
    "CHAIN_ID=1337",
    "NUMBER_OF_VALIDATORS=64",
    `EL_AND_CL_MNEMONIC=${mnemonic}`,
    "CHURN_LIMIT_QUOTIENT=32768",
    "GENESIS_TIMESTAMP=2000000000",
    "GENESIS_DELAY=0",
    "DEPOSIT_CONTRACT_ADDRESS=0x4242424242424242424242424242424242424242",
    ...Object.entries(recipe.genesisEnv).map(([name, value]) => `${name}=${value}`),
    "CHURN_LIMIT_QUOTIENT_GLOAS=32768",
    "CONSOLIDATION_CHURN_LIMIT_QUOTIENT=65536",
    "WITHDRAWAL_TYPE=0x01",
    `WITHDRAWAL_ADDRESS=${account}`,
    `EL_PREMINE_ADDRS={"${account}":{"balance":"1000000ETH"}}`,
  ]);
});

Deno.test("the genesis fork version reaches the generator only when set", () => {
  assert.equal(env({}).GENESIS_FORK_VERSION, undefined);
  assert.equal(env({ genesisForkVersion: "0x10000038" }).GENESIS_FORK_VERSION, "0x10000038");
});

Deno.test("startup refuses clients whose chain identity differs from the configuration", () => {
  const config = configuration({ chainId: 32382, genesisForkVersion: "0x10000038" });
  const live = {
    chainId: "0x7e7e",
    genesis: { genesis_time: String(config.genesisTime), genesis_fork_version: "0x10000038" },
  };
  assert.equal(identityMismatch(config, live), undefined);
  assert.match(identityMismatch(config, { ...live, chainId: "0x539" })!, /chain ID 1337/);
  assert.match(
    identityMismatch(config, { ...live, genesis: { ...live.genesis, genesis_time: "1" } })!,
    /genesis time 1/,
  );
  assert.match(
    identityMismatch(config, {
      ...live,
      genesis: { ...live.genesis, genesis_fork_version: "0x10000000" },
    })!,
    /genesis fork version 0x10000000/,
  );
  // Without an explicit fork version the generator default is accepted as is.
  const defaults = configuration({});
  assert.equal(
    identityMismatch(defaults, {
      chainId: "0x539",
      genesis: { genesis_time: String(defaults.genesisTime), genesis_fork_version: "0x10000000" },
    }),
    undefined,
  );
});

Deno.test("genesis parameters reject unknown keys at every level", () => {
  const address = "0x" + "11".repeat(20);
  for (
    const [genesis, error] of [
      [{ chainId: 32382 }, /Unknown genesis parameter: chainId/],
      [{ accounts: { [address]: { balance: "1", label: "x" } } }, /Unknown genesis account/],
      [{ mnemonicAccounts: { count: 1, balance: "1", start: 0 } }, /Unknown mnemonic accounts/],
      [{ validators: [{ count: 64, name: "x" }] }, /Unknown validator group parameter: name/],
      [
        { validators: [{ count: 64, withdrawal: { type: "0x01", chain: 1 } }] },
        /Unknown withdrawal parameter: chain/,
      ],
      [
        { blobSchedule: [{ epoch: 0, max: 9, target: 6, label: "x" }] },
        /Unknown blob schedule parameter: label/,
      ],
    ] as const
  ) assert.throws(() => configuration({ genesis: genesis as never }), error);
});

Deno.test("the genesis fork version is four lowercase hex bytes", () => {
  for (const value of ["0x1000003", "0x1000003G", "0X10000038", "0x1000003A", 0x10000038]) {
    assert.throws(
      () => configuration({ genesisForkVersion: value as never }),
      /Invalid genesis fork version/,
    );
  }
});

Deno.test("genesis accounts and contracts become one EL allocation", () => {
  const contract = "0x" + "22".repeat(20);
  const result = env({
    genesis: {
      accounts: {
        ["0x" + "11".repeat(20)]: { balance: "1000ETH" },
        [contract]: {
          balance: "5",
          code: "0x6001600055",
          storage: { "0x00": "0x01" },
          nonce: 1,
        },
      },
      mnemonicAccounts: { count: 3, balance: "10ETH" },
      gasLimit: 60_000_000,
    },
  });
  assert.deepEqual(JSON.parse(result.EL_PREMINE_ADDRS), {
    [account]: { balance: "1000000ETH" },
    ["0x" + "11".repeat(20)]: { balance: "1000ETH" },
    [contract]: {
      balance: "5",
      code: "0x6001600055",
      // Geth decodes genesis storage only as exact 32-byte words.
      storage: { ["0x" + "0".repeat(64)]: "0x" + "0".repeat(63) + "1" },
      nonce: 1,
    },
  });
  assert.equal(result.EL_PREMINE_COUNT, "3");
  assert.equal(result.EL_PREMINE_BALANCE, "10ETH");
  assert.equal(result.GENESIS_GASLIMIT, "60000000");
  // Gloas targets the CL gas limit schedule (EIP-8261), not Geth's miner setting.
  assert.deepEqual(JSON.parse(result.GAS_LIMIT_SCHEDULE), [{ epoch: 0, gas_limit: 60_000_000 }]);
});

Deno.test("an explicit account overrides the default funded account", () => {
  const result = env({ genesis: { accounts: { [account]: { balance: "7ETH" } } } });
  assert.deepEqual(JSON.parse(result.EL_PREMINE_ADDRS), { [account]: { balance: "7ETH" } });
});

const other =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

Deno.test("validator groups keep index order; managed keys continue one mnemonic range", () => {
  const vault = "0x" + "aa".repeat(20);
  const config = configuration({
    profile: "gloas",
    genesis: {
      validators: [
        { count: 48 },
        { count: 16, balance: "2048ETH", withdrawal: { type: "0x02", address: vault } },
        { count: 8, mnemonic: other, start: 100, online: false },
        { count: 8, withdrawal: { type: "0x00" } },
      ],
    },
  });
  assert.equal(config.validators, 80, "the network size is the sum of all groups");
  const result = env(config);
  // Every group is an explicit generator entry, in index order.
  assert.equal(result.NUMBER_OF_VALIDATORS, "0");
  const entry = (name: string, words: string, start: number, count: number, extra = {}) => ({
    mnemonic: words,
    name,
    start,
    count,
    wd_prefix: "0x01",
    wd_address: account,
    balance: 32000000000,
    status: 0,
    ...extra,
  });
  assert.deepEqual(JSON.parse(result.ADDITIONAL_VALIDATOR_MNEMONICS), [
    entry("group-0", mnemonic, 0, 48),
    entry("group-1", mnemonic, 48, 16, {
      wd_prefix: "0x02",
      wd_address: vault,
      balance: 2048000000000,
    }),
    entry("group-2", other, 100, 8),
    entry("group-3", mnemonic, 64, 8, { wd_prefix: "0x00", wd_address: null }),
  ]);
  // A group mnemonic reaches the key generator only through the environment.
  assert.equal(result.PANDA_GROUP_2_MNEMONIC, other);
  const script = genesisScript(config);
  assert(!script.includes("abandon"), "a mnemonic must never be part of the shell text");
  assert.match(script, /--source-min 0 --source-max 72 --source-mnemonic "\$EL_AND_CL_MNEMONIC"/);
  assert.match(
    script,
    /--source-min 100 --source-max 108 --source-mnemonic "\$PANDA_GROUP_2_MNEMONIC" --out-loc \/data\/validator-keys-group-2/,
  );
  assert.deepEqual(offlineGenesisIndices(config), [64, 65, 66, 67, 68, 69, 70, 71]);
});

Deno.test("managed-mnemonic groups default to the established single generator entry", () => {
  const result = env({ genesis: { validators: [{ count: 64 }] } });
  assert.equal(result.NUMBER_OF_VALIDATORS, "0");
  assert.equal(JSON.parse(result.ADDITIONAL_VALIDATOR_MNEMONICS).length, 1);
  assert.deepEqual(offlineGenesisIndices(configuration({ profile: "gloas" })), []);
  assert.match(genesisScript(configuration({ profile: "gloas" })), /--source-max 64 /);
  // eth2-val-tools refuses an existing output directory: create it only without managed keys.
  assert(!genesisScript(configuration({ profile: "gloas" })).includes("mkdir"));
  const custom = genesisScript(
    configuration({ profile: "gloas", genesis: { validators: [{ count: 64, mnemonic: other }] } }),
  );
  assert.match(custom, /mkdir -p \/data\/validator-keys\/keys \/data\/validator-keys\/secrets/);
  assert(!custom.includes("$EL_AND_CL_MNEMONIC"));
});

Deno.test("group mnemonics are validated and ranges of one mnemonic never overlap", () => {
  for (
    const [validators, error] of [
      [[{ count: 64, mnemonic: "not a mnemonic" }], /Invalid group mnemonic/],
      [[{ count: 64, start: 3 }], /start needs its own mnemonic/],
      [[{ count: 32, mnemonic: other }, { count: 32, mnemonic: other, start: 10 }], /overlap/],
      [[{ count: 32 }, { count: 32, mnemonic, start: 0 }], /overlap/],
      [[{ count: 64, online: "no" }], /online must be a boolean/],
    ] as const
  ) assert.throws(() => configuration({ genesis: { validators: validators as never } }), error);
});

Deno.test("protocol config overrides are explicit and limited to config values", () => {
  const result = env({
    genesis: { spec: { SHARD_COMMITTEE_PERIOD: 1, MIN_VALIDATOR_WITHDRAWABILITY_DELAY: 2 } },
  });
  assert.equal(result.SHARD_COMMITTEE_PERIOD, "1");
  assert.equal(result.MIN_VALIDATOR_WITHDRAWABILITY_DELAY, "2");
  assert.throws(
    () => configuration({ genesis: { spec: { SLOTS_PER_EPOCH: 8 } as never } }),
    /Unsupported genesis spec override: SLOTS_PER_EPOCH/,
  );
});

Deno.test("invalid genesis parameters are rejected before any container starts", () => {
  const address = "0x" + "11".repeat(20);
  for (
    const [genesis, error] of [
      [{ accounts: { "0x1234": { balance: "1" } } }, /Invalid genesis account address/],
      [{ accounts: { [address]: { balance: "1.5ETH" } } }, /Invalid balance/],
      [{ accounts: { [address]: { balance: "1", code: "0xzz" } } }, /Invalid contract code/],
      [{ validators: [{ count: 64, balance: "31ETH" }] }, /at least 32 ETH/],
      [{ validators: [{ count: 64, balance: "33ETH" }] }, /only compounding/],
      [
        { validators: [{ count: 64, withdrawal: { type: "0x00", address } }] },
        /0x00 credentials have no address/,
      ],
      [{ validators: [{ count: 32 }] }, /64–1024 validators/],
      [{ validators: [{ count: 1000 }, { count: 25 }] }, /64–1024 validators/],
      [{ gasLimit: 0 }, /Invalid genesis gas limit/],
      [{ feeRecipient: "0x12" }, /Invalid fee recipient/],
    ] as const
  ) assert.throws(() => configuration({ genesis: genesis as never }), error);
  assert.throws(
    () => configuration({ validators: 100, genesis: { validators: [{ count: 64 }] } }),
    /validators must equal the sum of genesis validator groups/,
  );
});

Deno.test("CLI and container genesis input accepts inline JSON or a JSON file", async () => {
  const { readGenesis } = await import("../src/genesis.ts");
  const value = { gasLimit: 60_000_000, mnemonicAccounts: { count: 2, balance: "1ETH" } };
  assert.deepEqual(readGenesis(JSON.stringify(value)), value);
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, JSON.stringify(value));
    assert.deepEqual(readGenesis(path), value);
  } finally {
    await Deno.remove(path);
  }
  assert.throws(() => readGenesis("{"), /Invalid genesis JSON/);
  assert.throws(() => readGenesis('{"gasLimit":1}'), /Invalid genesis gas limit/);
});

Deno.test("a blob schedule replaces the generator's BPO entries for both EL and CL", () => {
  const result = env({
    genesis: {
      blobSchedule: [
        { epoch: 0, max: 1, target: 1 },
        { epoch: 4, max: 3, target: 2, baseFeeUpdateFraction: 1_000_000 },
      ],
    },
  });
  assert.equal(result.BPO_1_EPOCH, "0");
  assert.equal(result.BPO_1_MAX_BLOBS, "1");
  assert.equal(result.BPO_1_TARGET_BLOBS, "1");
  assert.equal(result.BPO_1_BASE_FEE_UPDATE_FRACTION, "0", "0 lets the generator derive it");
  assert.equal(result.BPO_2_EPOCH, "4");
  assert.equal(result.BPO_2_BASE_FEE_UPDATE_FRACTION, "1000000");
  for (const index of [3, 4, 5]) {
    assert.equal(result[`BPO_${index}_EPOCH`], "18446744073709551615", "unused BPO stays inactive");
  }
  assert.equal(env({}).BPO_1_EPOCH, undefined, "defaults keep the generator schedule");
  for (
    const [blobSchedule, error] of [
      [[], /non-empty/],
      [[{ epoch: 0, max: 1, target: 2 }], /target/],
      [[{ epoch: 2, max: 1, target: 1 }, { epoch: 1, max: 1, target: 1 }], /increasing/],
      [Array(6).fill({ epoch: 0, max: 1, target: 1 }), /at most 5/],
      [[{ epoch: 0, max: 0, target: 0 }], /max/],
    ] as const
  ) assert.throws(() => configuration({ genesis: { blobSchedule: blobSchedule as never } }), error);
});

Deno.test("networks of up to 1024 genesis validators are accepted", () => {
  assert.equal(configuration({ validators: 1024 }).validators, 1024);
  assert.equal(
    configuration({ genesis: { validators: [{ count: 1000 }, { count: 24 }] } }).validators,
    1024,
  );
  assert.throws(() => configuration({ validators: 1025 }), /64–1024 validators/);
});

Deno.test("the Gloas fork epoch replaces the recipe's genesis fork", () => {
  const entries = genesisEnvironment(
    configuration({ profile: "gloas", genesis: { gloasForkEpoch: 2 } }),
    recipe,
  ).filter((entry) => entry.startsWith("GLOAS_FORK_EPOCH="));
  assert.deepEqual(entries, ["GLOAS_FORK_EPOCH=2"], "exactly one, overriding the recipe");
  assert.deepEqual(
    genesisEnvironment(configuration({ profile: "gloas" }), recipe)
      .filter((entry) => entry.startsWith("GLOAS_FORK_EPOCH=")),
    ["GLOAS_FORK_EPOCH=0"],
  );
  assert.throws(
    () => configuration({ genesis: { gloasForkEpoch: -1 } }),
    /Invalid Gloas fork epoch/,
  );
});
