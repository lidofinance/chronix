import { bakeTag, type ProfileName, profileName, profiles } from "./profiles.ts";
import { readGenesis, validateGenesis } from "./genesis.ts";
import type { NetworkOptions } from "../client/types.d.ts";
export type { HistoryMode, NetworkOptions } from "../client/types.d.ts";
export const images = {
  geth:
    "ethereum/client-go@sha256:798b7eb1bcef6d4be7576232beea63bf291450f48b025dc8fb5c6e37840e4364",
  lighthouse:
    "sigp/lighthouse@sha256:870934e38931d1a0f6cf47ff976e246a08a4b5509b84ff585aa2233e76744aa8",
  genesis:
    "ethpandaops/ethereum-genesis-generator@sha256:683629884b35dce22e544663abd19ce5221ce65f9f0315e3971d66c67041bc1d",
} as const;
export const buildImages = {
  rust: "rust@sha256:e51d0265072d2d9d5d320f6a44dde6b9ef13653b035098febd68cce8fa7c0bc4",
  runtime: "debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251",
} as const;
// Public development keys only. Never fund on a public chain.
export const mnemonic = "test test test test test test test test test test test junk";
export const account = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
export const privateKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Every network option. A new option fails compilation until it is listed here. */
export const networkKeys: Record<keyof NetworkOptions, true> = {
  chainId: true,
  genesisTime: true,
  genesisForkVersion: true,
  validators: true,
  churnLimitQuotient: true,
  consolidationChurnLimitQuotient: true,
  history: true,
  genesis: true,
};

/** Options stored only when set; every other network option is always stored. */
export const optionalNetworkKeys: readonly (keyof NetworkOptions)[] = [
  "genesis",
  "genesisForkVersion",
  "history",
];

/**
 * The stored form of an option. A default is an absent key, so an explicit default and an
 * omitted option describe the same network, and v1.0.1 configurations keep their canonical value.
 */
export function storedOption<K extends keyof Config>(key: K, value: Config[K]): Config[K] {
  if (key === "history" && value === "pruned") return undefined as Config[K];
  if (key === "genesisForkVersion" && value === "0x10000000") return undefined as Config[K];
  return value;
}

/** A network: its options with defaults applied, plus where and how it runs. */
export interface Config
  extends
    Required<Omit<NetworkOptions, "genesis" | "genesisForkVersion" | "history">>,
    Pick<NetworkOptions, "genesis" | "genesisForkVersion" | "history"> {
  id: string;
  profile: ProfileName;
  bake: string;
  mode: "controlled" | "baseline";
}

/** CLI and container input: inline JSON or a path to a JSON file. */
export function readJsonInput(value: string, name: string): unknown {
  const text = value.trimStart().startsWith("{") ? value : Deno.readTextFileSync(value);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${name} JSON: ${error}`);
  }
}

/** Network options as one object; values are validated by `configuration()`. */
export function readNetwork(value: string): NetworkOptions {
  const options = readJsonInput(value, "network options");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Network options must be an object");
  }
  const unknown = Object.keys(options).find((key) => !Object.hasOwn(networkKeys, key));
  if (unknown !== undefined) throw new Error(`Unknown network option: ${unknown}`);
  return options as NetworkOptions;
}

/** Listener setting, not a network option: extra Host names ingress accepts besides loopback. */
export function allowedHosts(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    // Only a name that is its own canonical URL host: no port, scheme, path or uppercase.
    let host: string | undefined;
    try {
      host = new URL(`http://${entry}`).hostname;
    } catch {
      host = undefined;
    }
    if (host !== entry || entry.includes("*") || ["0.0.0.0", "[::]"].includes(entry)) {
      throw new Error(`Invalid allowed host: ${entry}`);
    }
    return entry;
  });
}

/** Entry-point network options; `genesis` alone may also come as its own input. */
export function entryNetwork(network?: string, genesis?: string): NetworkOptions {
  const options = network ? readNetwork(network) : {};
  if (genesis) {
    if (options.genesis !== undefined) {
      throw new Error("Set genesis in the network options or separately, not both");
    }
    options.genesis = readGenesis(genesis);
  }
  return options;
}
export function configuration(input: Partial<Config> = {}): Config {
  const profile = profileName(input.profile ?? Deno.env.get("CHRONIX_PROFILE") ?? "gloas");
  const result: Config = {
    profile,
    bake: bakeTag(input.bake ?? Deno.env.get("CHRONIX_BAKE") ?? "default"),
    id: "local",
    mode: "controlled",
    genesisTime: 2_000_000_000,
    validators: 64,
    chainId: 1337,
    churnLimitQuotient: profiles[profile].churnLimitQuotient,
    consolidationChurnLimitQuotient: 65536,
    ...input,
  };
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.id)) throw new Error("Invalid devnet id");
  if (
    !Number.isSafeInteger(result.genesisTime) || !Number.isSafeInteger(result.genesisTime * 1000) ||
    result.genesisTime < 0
  ) {
    throw new Error("Invalid genesis time");
  }
  if (result.mode !== "baseline" && result.mode !== "controlled") throw new Error("Invalid mode");
  result.history = storedOption("history", result.history);
  if (result.history === undefined) delete result.history;
  else if (result.history !== "archive") throw new Error("Invalid history mode");
  result.genesisForkVersion = storedOption("genesisForkVersion", result.genesisForkVersion);
  if (result.genesisForkVersion === undefined) delete result.genesisForkVersion;
  else if (!/^0x[0-9a-f]{8}$/.test(result.genesisForkVersion)) {
    throw new Error("Invalid genesis fork version: use four lowercase hex bytes");
  }
  if (result.genesis !== undefined) {
    const total = validateGenesis(result.genesis);
    if (total !== undefined) {
      if (input.validators !== undefined && input.validators !== total) {
        throw new Error("validators must equal the sum of genesis validator groups");
      }
      result.validators = total;
    }
  }
  if (
    !Number.isSafeInteger(result.validators) || result.validators < 64 || result.validators > 1024
  ) throw new Error("Use 64–1024 validators for this mainnet-preset topology");
  if (!Number.isSafeInteger(result.chainId) || result.chainId < 1) {
    throw new Error("Invalid chain ID");
  }
  if (!Number.isSafeInteger(result.churnLimitQuotient) || result.churnLimitQuotient < 1) {
    throw new Error("Invalid churn quotient");
  }
  if (
    !Number.isSafeInteger(result.consolidationChurnLimitQuotient) ||
    result.consolidationChurnLimitQuotient < 1
  ) throw new Error("Invalid consolidation churn quotient");
  return result;
}
