import assert from "node:assert/strict";
import { account, configuration, mnemonic } from "../src/config.ts";
import { genesisEnvironment } from "../src/genesis.ts";
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
});

Deno.test("an explicit account overrides the default funded account", () => {
  const result = env({ genesis: { accounts: { [account]: { balance: "7ETH" } } } });
  assert.deepEqual(JSON.parse(result.EL_PREMINE_ADDRS), { [account]: { balance: "7ETH" } });
});

Deno.test("validator groups use consecutive indices of the managed mnemonic", () => {
  const vault = "0x" + "aa".repeat(20);
  const config = configuration({
    profile: "gloas",
    genesis: {
      validators: [
        { count: 48 },
        { count: 16, balance: "2048ETH", withdrawal: { type: "0x02", address: vault } },
        { count: 8, withdrawal: { type: "0x00" } },
      ],
    },
  });
  assert.equal(config.validators, 72, "the network size is the sum of all groups");
  const result = env(config);
  assert.equal(result.NUMBER_OF_VALIDATORS, "48");
  assert.equal(result.WITHDRAWAL_TYPE, "0x01");
  assert.equal(result.WITHDRAWAL_ADDRESS, account);
  assert.equal(result.VALIDATOR_BALANCE, "32000000000");
  assert.deepEqual(JSON.parse(result.ADDITIONAL_VALIDATOR_MNEMONICS), [
    {
      mnemonic,
      name: "group-1",
      start: 48,
      count: 16,
      wd_prefix: "0x02",
      wd_address: vault,
      balance: 2048000000000,
      status: 0,
    },
    {
      mnemonic,
      name: "group-2",
      start: 64,
      count: 8,
      wd_prefix: "0x00",
      wd_address: null,
      balance: 32000000000,
      status: 0,
    },
  ]);
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
      [{ validators: [{ count: 32 }] }, /64–256 validators/],
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
