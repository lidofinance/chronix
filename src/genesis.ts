import { account, type Config, mnemonic } from "./config.ts";
import type { Recipe } from "./profiles.ts";

/** One EL genesis allocation: a funded wallet, or a contract when code/storage are present. */
export interface GenesisAccount {
  /** Integer wei, or whole ether such as "1000ETH". */
  balance: string;
  code?: string;
  storage?: Record<string, string>;
  nonce?: number;
}
export type WithdrawalType = "0x00" | "0x01" | "0x02";
/** Genesis validators with shared parameters; keys continue the managed mnemonic's indices. */
export interface ValidatorGroup {
  count: number;
  /** Integer gwei, or whole ether such as "2048ETH". Defaults to 32 ETH. */
  balance?: string;
  /** Defaults to 0x01 credentials for the funded development account. */
  withdrawal?: { type: WithdrawalType; address?: string };
}
export interface Genesis {
  /** Explicit allocations; an entry for the default development account replaces it. */
  accounts?: Record<string, GenesisAccount>;
  /** Fund the first `count` addresses of the managed development mnemonic. */
  mnemonicAccounts?: { count: number; balance: string };
  gasLimit?: number;
  validators?: ValidatorGroup[];
  feeRecipient?: string;
  /** Network config values only; the mainnet preset stays fixed. */
  spec?: Partial<Record<SpecOverride, number>>;
}
export const specOverrides = [
  "SHARD_COMMITTEE_PERIOD",
  "MIN_VALIDATOR_WITHDRAWABILITY_DELAY",
  "EJECTION_BALANCE",
  "MIN_PER_EPOCH_CHURN_LIMIT",
  "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT",
  "MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA",
  "MAX_PER_EPOCH_ACTIVATION_EXIT_CHURN_LIMIT",
  "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT_GLOAS",
] as const;
export type SpecOverride = typeof specOverrides[number];

const GWEI_PER_ETH = 1_000_000_000n;
const MIN_ACTIVATION_GWEI = 32n * GWEI_PER_ETH;
const MAX_COMPOUNDING_GWEI = 2048n * GWEI_PER_ETH;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

function amount(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^\d+(ETH)?$/.test(value)) {
    throw new Error(`Invalid balance for ${name}: use an integer base unit or whole ETH`);
  }
  return value.endsWith("ETH") ? BigInt(value.slice(0, -3)) : BigInt(value);
}

function gwei(group: ValidatorGroup): bigint {
  if (group.balance === undefined) return MIN_ACTIVATION_GWEI;
  const value = amount(group.balance, "validator group");
  return group.balance.endsWith("ETH") ? value * GWEI_PER_ETH : value;
}

function hex(value: unknown, pattern: RegExp, error: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(error);
  return value;
}

function count(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Invalid ${name}`);
  }
  return value as number;
}

/** Validate genesis parameters; returns the total number of genesis validators, if grouped. */
export function validateGenesis(genesis: Genesis): number | undefined {
  if (!genesis || typeof genesis !== "object" || Array.isArray(genesis)) {
    throw new Error("Genesis parameters must be an object");
  }
  const seen = new Set<string>();
  for (const [address, entry] of Object.entries(genesis.accounts ?? {})) {
    if (!addressPattern.test(address)) {
      throw new Error(`Invalid genesis account address ${address}`);
    }
    if (seen.has(address.toLowerCase())) throw new Error(`Duplicate genesis account ${address}`);
    seen.add(address.toLowerCase());
    amount(entry?.balance, address);
    if (entry.code !== undefined) {
      hex(entry.code, /^0x([0-9a-fA-F]{2})*$/, `Invalid contract code for ${address}`);
    }
    for (const [key, value] of Object.entries(entry.storage ?? {})) {
      hex(key, /^0x[0-9a-fA-F]{1,64}$/, `Invalid storage key for ${address}`);
      hex(value, /^0x[0-9a-fA-F]{1,64}$/, `Invalid storage value for ${address}`);
    }
    if (entry.nonce !== undefined) count(entry.nonce, `nonce for ${address}`, 0, 2 ** 53 - 1);
  }
  if (genesis.mnemonicAccounts !== undefined) {
    count(genesis.mnemonicAccounts.count, "mnemonic account count", 0, 1000);
    amount(genesis.mnemonicAccounts.balance, "mnemonic accounts");
  }
  if (genesis.gasLimit !== undefined) {
    if (!Number.isSafeInteger(genesis.gasLimit) || genesis.gasLimit < 5000) {
      throw new Error("Invalid genesis gas limit");
    }
  }
  if (genesis.feeRecipient !== undefined && !addressPattern.test(genesis.feeRecipient)) {
    throw new Error("Invalid fee recipient");
  }
  for (const [key, value] of Object.entries(genesis.spec ?? {})) {
    if (!specOverrides.includes(key as SpecOverride)) {
      throw new Error(`Unsupported genesis spec override: ${key}`);
    }
    count(value, `genesis spec ${key}`, 0, Number.MAX_SAFE_INTEGER);
  }
  if (genesis.validators === undefined) return undefined;
  if (!Array.isArray(genesis.validators) || genesis.validators.length === 0) {
    throw new Error("Genesis validators must be a non-empty list of groups");
  }
  let total = 0;
  for (const group of genesis.validators) {
    total += count(group?.count, "validator group count", 1, 256);
    const type = group.withdrawal?.type ?? "0x01";
    if (!["0x00", "0x01", "0x02"].includes(type)) {
      throw new Error(`Invalid withdrawal type ${type}`);
    }
    if (type === "0x00" && group.withdrawal?.address !== undefined) {
      throw new Error("0x00 credentials have no address; they use the BLS withdrawal key");
    }
    if (group.withdrawal?.address !== undefined && !addressPattern.test(group.withdrawal.address)) {
      throw new Error("Invalid withdrawal address");
    }
    const balance = gwei(group);
    if (balance < MIN_ACTIVATION_GWEI) {
      throw new Error("Genesis validators need at least 32 ETH to be active");
    }
    if (type !== "0x02" && balance > MIN_ACTIVATION_GWEI) {
      throw new Error("Balances above 32 ETH are only compounding (0x02) validators");
    }
    if (balance > MAX_COMPOUNDING_GWEI) throw new Error("Validator balance exceeds 2048 ETH");
  }
  return total;
}

/** Environment for the pinned ethereum-genesis-generator. Defaults reproduce earlier networks. */
export function genesisEnvironment(config: Config, recipe: Recipe): string[] {
  const genesis = config.genesis ?? {};
  const [main, ...additional] = genesis.validators ?? [];
  const env = [
    `CHAIN_ID=${config.chainId}`,
    `NUMBER_OF_VALIDATORS=${main?.count ?? config.validators}`,
    `EL_AND_CL_MNEMONIC=${mnemonic}`,
    `CHURN_LIMIT_QUOTIENT=${config.churnLimitQuotient}`,
    `GENESIS_TIMESTAMP=${config.genesisTime}`,
    "GENESIS_DELAY=0",
    "DEPOSIT_CONTRACT_ADDRESS=0x4242424242424242424242424242424242424242",
    ...Object.entries(recipe.genesisEnv).map(([name, value]) => `${name}=${value}`),
    ...(config.profile === "gloas"
      ? [
        `CHURN_LIMIT_QUOTIENT_GLOAS=${config.churnLimitQuotient}`,
        `CONSOLIDATION_CHURN_LIMIT_QUOTIENT=${config.consolidationChurnLimitQuotient}`,
      ]
      : []),
    `WITHDRAWAL_TYPE=${main?.withdrawal?.type ?? "0x01"}`,
    `WITHDRAWAL_ADDRESS=${main?.withdrawal?.address ?? account}`,
    `EL_PREMINE_ADDRS=${
      JSON.stringify({ [account]: { balance: "1000000ETH" }, ...allocation(genesis.accounts) })
    }`,
  ];
  if (main) env.push(`VALIDATOR_BALANCE=${gwei(main)}`);
  if (additional.length) {
    let start = main.count;
    env.push(`ADDITIONAL_VALIDATOR_MNEMONICS=${
      JSON.stringify(additional.map((group, index) => {
        const type = group.withdrawal?.type ?? "0x01";
        const entry = {
          mnemonic,
          name: `group-${index + 1}`,
          start,
          count: group.count,
          wd_prefix: type,
          wd_address: type === "0x00" ? null : group.withdrawal?.address ?? account,
          balance: Number(gwei(group)),
          status: 0,
        };
        start += group.count;
        return entry;
      }))
    }`);
  }
  if (genesis.mnemonicAccounts) {
    env.push(
      `EL_PREMINE_COUNT=${genesis.mnemonicAccounts.count}`,
      `EL_PREMINE_BALANCE=${genesis.mnemonicAccounts.balance}`,
    );
  }
  if (genesis.gasLimit !== undefined) env.push(`GENESIS_GASLIMIT=${genesis.gasLimit}`);
  for (const [key, value] of Object.entries(genesis.spec ?? {})) env.push(`${key}=${value}`);
  return env;
}

/** Geth decodes genesis addresses case-insensitively, but storage only as exact 32-byte words. */
function allocation(accounts: Record<string, GenesisAccount> = {}): Record<string, GenesisAccount> {
  const word = (value: string) => "0x" + value.slice(2).toLowerCase().padStart(64, "0");
  return Object.fromEntries(
    Object.entries(accounts).map(([address, entry]) => [
      address.toLowerCase(),
      entry.storage === undefined ? entry : {
        ...entry,
        storage: Object.fromEntries(
          Object.entries(entry.storage).map(([key, value]) => [word(key), word(value)]),
        ),
      },
    ]),
  );
}

/** CLI and container input: inline JSON, or a path to a JSON file. Validated before startup. */
export function readGenesis(value: string): Genesis {
  const text = value.trimStart().startsWith("{") ? value : Deno.readTextFileSync(value);
  let genesis: Genesis;
  try {
    genesis = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid genesis JSON: ${error}`);
  }
  validateGenesis(genesis);
  return genesis;
}
