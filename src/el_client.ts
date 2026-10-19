import type { Config } from "./config.ts";
import { rpc, waitFor } from "./http.ts";
import type { BakedImage } from "./profiles.ts";

export type ElClientName = "geth" | "reth";
/** An entry of the EL catalog `clients/el/<name>.json`. */
export interface ElEntry {
  client: ElClientName;
  /** `<repository>@sha256:<digest>` in a registry, or the reference of a local build. */
  image: string;
  /** Image config id per platform; a local build has exactly one. */
  ids: Record<string, string>;
}

export function elName(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`Invalid EL catalog name: ${value}`);
  }
  return value;
}

export function elEntry(value: unknown, name: string): ElEntry {
  const entry = value as ElEntry;
  const object = (item: unknown) => !!item && typeof item === "object" && !Array.isArray(item);
  const ids = object(entry) && object(entry.ids) ? Object.entries(entry.ids) : [];
  const pinned = typeof entry?.image === "string" && entry.image.includes("@");
  if (
    !object(entry) || Object.keys(entry).sort().join() !== "client,ids,image" ||
    !["geth", "reth"].includes(entry.client) || typeof entry.image !== "string" ||
    !(pinned
      ? /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(entry.image)
      : /^[a-z0-9][a-z0-9._:/-]*$/.test(entry.image)) ||
    !ids.length || (!pinned && ids.length !== 1) ||
    ids.some(([platform, id]) =>
      !/^linux\/[a-z0-9]+(?:\/[a-z0-9]+)?$/.test(platform) || typeof id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(id)
    )
  ) throw new Error(`Invalid EL catalog entry: ${name}`);
  return entry;
}

/** The catalog is read next to this module, whatever the working directory. */
export function readEl(name: string): ElEntry {
  const path = new URL(`../clients/el/${elName(name)}.json`, import.meta.url);
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Unknown EL: ${name}; choose an entry of clients/el/`);
    }
    throw error;
  }
  return elEntry(JSON.parse(text), name);
}

/** The entry's image for the bake platform; only a registry image has a digest to pull. */
export function elImage(entry: ElEntry, platform: string): BakedImage {
  if (!Object.hasOwn(entry.ids, platform)) {
    throw new Error(`EL image ${entry.image} has no ${platform} build`);
  }
  return {
    ref: entry.image,
    id: entry.ids[platform],
    ...(entry.image.includes("@") ? { digest: entry.image } : {}),
    platform,
  };
}

/** The EL a network's data is written by: its client and the image ID at the bake platform. */
export interface ResolvedEl {
  client: ElClientName;
  id: string;
  platform: string;
}

/** Resolve a catalog entry once, when a network is created; later runs compare against it. */
export function resolvedEl(name: string, platform: string): ResolvedEl {
  const entry = readEl(name);
  return { client: entry.client, id: elImage(entry, platform).id, platform };
}

/** How Chronix drives one EL client; everything else is the standard Engine API and `eth_*`. */
export interface ElClient {
  /** A one-shot command that writes genesis before the first start, if the client needs one. */
  init(config: Config): string[] | undefined;
  start(config: Config): string[];
  /**
   * `log`: `engine_getPayload` waits for a JSON log line with this `msg` and the payload `id`.
   * `none`: the client's own `engine_getPayload` waits for the full payload.
   */
  gate: { mode: "log"; message: string } | { mode: "none" };
  /** The effective tip in wei below which the payload builder leaves a transaction out. */
  minimumTip: bigint;
  /** The logs of a stopped client prove that its database was persisted. */
  stopped(logs: string, archive: boolean): boolean;
}

const geth: ElClient = {
  // The state scheme is fixed at init; archive history needs the hash scheme.
  init: (config) => [
    "--datadir=/el",
    ...(config.history === "archive" ? ["--state.scheme=hash"] : []),
    "init",
    "/shared/metadata/genesis.json",
  ],
  start: (config) => [
    "--datadir=/el",
    "--ipcdisable",
    `--networkid=${config.chainId}`,
    "--http",
    "--http.addr=0.0.0.0",
    "--http.vhosts=*",
    // The controller forwards only read-only debug methods; see execution_rpc.ts.
    "--http.api=eth,net,web3,txpool,debug",
    "--authrpc.addr=0.0.0.0",
    "--authrpc.vhosts=*",
    "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
    "--nodiscover",
    "--maxpeers=0",
    "--syncmode=full",
    // Hash-scheme archive serves any historical state without a wall-clock indexer gate.
    ...(config.history === "archive" ? ["--state.scheme=hash", "--gcmode=archive"] : []),
    "--cache=64",
    "--verbosity=3",
    "--log.json",
    ...(config.genesis?.gasLimit === undefined
      ? []
      : [`--miner.gaslimit=${config.genesis.gasLimit}`]),
  ],
  // Geth first installs an empty payload and builds the full one asynchronously.
  gate: { mode: "log", message: "Updated payload" },
  // `miner.gasprice` defaults to 1 Mwei (go-ethereum miner/miner.go:58, used at worker.go:589-595).
  minimumTip: 1_000_000n,
  // An archive node commits every block, so it has no dirty state left to persist.
  stopped: (logs, archive) =>
    logs.includes("Blockchain stopped") &&
    (archive || /Persisted dirty state to (file|disk)/.test(logs)) &&
    !/Failed to (journal|commit recent state trie|close trie database)|Dangling trie nodes after full cleanup/
      .test(logs),
};

const reth: ElClient = {
  // `node` writes the genesis block on the first start.
  init: () => undefined,
  start: (config) => [
    "node",
    "--chain=/shared/metadata/genesis.json",
    "--datadir=/el",
    "--ipcdisable",
    "--http",
    "--http.addr=0.0.0.0",
    // The controller forwards only read-only debug methods; see execution_rpc.ts.
    "--http.api=eth,net,web3,txpool,debug",
    "--authrpc.addr=0.0.0.0",
    "--authrpc.jwtsecret=/shared/jwt/jwtsecret",
    "--disable-discovery",
    "--max-peers=0",
    "--nat=none",
    "--no-persist-peers",
    "--log.stdout.format=json",
    // The stop check reads the engine tree's persistence acknowledgement, a debug event.
    "--log.stdout.filter=info,engine::tree=debug",
    // File logging is on by default and fails in the controller user's unwritable home.
    "--log.file.max-files=0",
    // Every block is written to disk at once, so a stop has no in-memory blocks to lose.
    "--engine.persistence-threshold=0",
    // MDBX grows by 4 GiB by default, and snapshots hash and copy the whole file; 4 MB is the
    // step of Reth's own small test databases.
    "--db.growth-step=4MB",
    // Reth refuses to prune history less than 10,064 blocks behind the head.
    ...(config.history === "archive"
      ? []
      : ["--prune.account-history.distance=10064", "--prune.storage-history.distance=10064"]),
    ...(config.genesis?.gasLimit === undefined
      ? []
      : [`--builder.gaslimit=${config.genesis.gasLimit}`]),
  ],
  // At payload attributes Reth starts the full build, and getPayload waits for it.
  gate: { mode: "none" },
  // The builder takes any transaction paying the base fee (transaction-pool/src/pool/best.rs:66).
  minimumTip: 0n,
  stopped: (logs) =>
    logs.includes("persistence complete, signaling termination") &&
    !logs.includes("Termination failed"),
};

export const elClients: Record<ElClientName, ElClient> = { geth, reth };

/** A started or restarted EL is ready when its RPC answers; returns its chain ID. */
export async function elReady(url: string): Promise<string> {
  return await waitFor("EL RPC", () => rpc<string>(url, "eth_chainId"));
}
