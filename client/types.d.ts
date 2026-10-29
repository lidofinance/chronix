// Every public type of the Chronix client. `mod.js` is checked against these declarations, and
// `openapi.json` is generated from them.

export type ProfileName = "gloas" | "pectra";
export type WarpMode = "honest" | "fast";
export interface WarpOptions {
  /** Honest executes every duty; fast permits empty slots and their inactivity penalties. */
  mode?: WarpMode;
}
/** Protocol time after a time command. */
export interface Step {
  /** Protocol time in seconds. */
  now: number;
  slot: number;
}

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
  /** Keys from this BIP-39 mnemonic instead of the managed development mnemonic. */
  mnemonic?: string;
  /** First key index of `mnemonic` (default 0); managed keys continue from earlier groups. */
  start?: number;
  /** false: the keys are in the VC but disabled from genesis, so the group never signs. */
  online?: boolean;
}
export type SpecOverride =
  | "SHARD_COMMITTEE_PERIOD"
  | "MIN_VALIDATOR_WITHDRAWABILITY_DELAY"
  | "EJECTION_BALANCE"
  | "MIN_PER_EPOCH_CHURN_LIMIT"
  | "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT"
  | "MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA"
  | "MAX_PER_EPOCH_ACTIVATION_EXIT_CHURN_LIMIT"
  | "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT_GLOAS";
export interface Genesis {
  /** Explicit allocations; an entry for the default development account replaces it. */
  accounts?: Record<string, GenesisAccount>;
  /** Fund the first `count` addresses of the managed development mnemonic. */
  mnemonicAccounts?: { count: number; balance: string };
  /** Genesis block gas limit and the EL builder's target before Gloas. */
  gasLimit?: number;
  /** Gas limit that Gloas proposers target from the fork (EIP-8261 schedule); default `gasLimit`. */
  gloasGasLimit?: number;
  validators?: ValidatorGroup[];
  feeRecipient?: string;
  /** Network config values only; the mainnet preset stays fixed. */
  spec?: Partial<Record<SpecOverride, number>>;
  /** Epoch at which Gloas activates; earlier epochs run Fulu. Defaults to genesis. */
  gloasForkEpoch?: number;
  /**
   * Blob parameter only (BPO) schedule for EL and CL, at most 5 entries in epoch order. Replaces
   * the generator's default schedule; `baseFeeUpdateFraction` 0 or omitted lets it be derived.
   */
  blobSchedule?: { epoch: number; max: number; target: number; baseFeeUpdateFraction?: number }[];
}

/** Historical state storage. Both clients fix it at genesis. */
export type HistoryMode = "pruned" | "archive";
/**
 * Network parameters fixed at genesis. `Devnet.start`, the CLI (`--network`) and the CI image
 * (`CHRONIX_NETWORK`) accept this one object; `CHRONIX_GENESIS` is a shorthand for `genesis`.
 */
export interface NetworkOptions {
  /** Default 1337. */
  chainId?: number;
  /** Unix seconds. Default 2,000,000,000 (2033), ahead of the host clock on purpose. */
  genesisTime?: number;
  /** Four lowercase hex bytes; sets the deposit signing domain. Default "0x10000000". */
  genesisForkVersion?: string;
  /** 64–1024; with genesis validator groups it equals their total. Default 64. */
  validators?: number;
  /** Default: the profile's mainnet value. */
  churnLimitQuotient?: number;
  /** Default 65536. */
  consolidationChurnLimitQuotient?: number;
  /** "archive" keeps every historical EL and CL state. Default "pruned". */
  history?: HistoryMode;
  /**
   * EL `--rpc.gascap`: the most gas `eth_call` and `eth_estimateGas` may use. Default: the client's
   * own, 50,000,000 on Reth and Geth. EIP-8037 state gas lets a valid Amsterdam transaction need
   * more; 4,294,967,295 (2^32 - 1, its largest transaction gas) leaves the block gas limit as the
   * bound of an estimate.
   */
  rpcGasCap?: number;
  genesis?: Genesis;
  /** EL client: an entry name of Chronix's `clients/el/` catalog. Default "reth-main-f4676ea". */
  el?: string;
}

export interface SnapshotRef {
  id: string;
  createdAt: string;
  profile: ProfileName;
  bakeKey: string;
  /** Protocol time in milliseconds. */
  nowMs: number;
  headSlot: number;
  headBlockRoot: string;
}
export interface SnapshotRestoreResult {
  snapshot: SnapshotRef;
  generation: string;
  /** Reset external providers and indexers for this replacement session. */
  sessionId: string;
  nowMs: number;
}
export interface SnapshotRequest {
  kind: "create" | "restore" | "remove";
  snapshotId?: string;
}
/** Stored operation metadata, including partial failure and independent cleanup. */
export interface SnapshotOperationRecord {
  schema: 1;
  owner: string;
  id: string;
  request: SnapshotRequest;
  state: "running" | "succeeded" | "failed";
  stage: string;
  createdAt: string;
  updatedAt: string;
  snapshot?: SnapshotRef;
  sourceGeneration?: string;
  candidateGeneration?: string;
  automine?: boolean;
  intervalMining?: number;
  result?: unknown;
  error?: string;
  cleanup?: { state: "pending" | "succeeded" | "failed"; error?: string };
}
/** Readiness and the current session; available without live clients. */
export interface SnapshotLifecycle {
  phase: "ready" | "maintenance" | "parked" | "faulted";
  ready: boolean;
  id: string;
  profile: ProfileName;
  bake: string;
  /** EL catalog entry of the network. */
  el: string;
  generation?: string;
  sessionId: string;
  now?: number;
  slot?: number;
  recoveryRequired: boolean;
  active: number;
  streams: number;
  operation?: string;
  error?: string;
  cleanup?: { state: "succeeded" | "failed"; error?: string };
}
export interface SnapshotExportOptions {
  /** Refuse a larger archive. Defaults to 8 GiB. */
  maxBytes?: number;
}
export interface SnapshotExportResult {
  path: string;
  sha256: string;
  bytes: number;
}

export type ClientRole = "el" | "bn" | "vc";
export interface ClientState {
  running: boolean;
  exitCode?: number;
  startedAt: string;
}
export type Clients = Record<ClientRole, ClientState>;
export interface ClientOptions {
  /** `stopClient`/`restartClient`: crash the client instead of a graceful stop. */
  kill?: boolean;
}
export interface ManagedValidator {
  index?: number;
  pubkey: string;
  status?: string;
  /** The key is present in the managed VC. */
  managed: boolean;
  /** The key is present and enabled, so the validator performs its duties. */
  online: boolean;
}
export interface RemovedValidator {
  pubkey: string;
  keystore?: string;
  password?: string;
  /** EIP-3076 slashing protection interchange JSON. */
  slashingProtection: string;
}
export interface ValidatorSettings {
  feeRecipient?: string;
  gasLimit?: number;
  graffiti?: string;
}
export interface Status {
  id: string;
  profile: ProfileName;
  bake: string;
  bakeKey: string;
  sessionId: string;
  /** Protocol time in seconds. */
  now: number;
  slot: number;
  automine: boolean;
  automineError?: string;
  /** Milliseconds between interval-mined slots; 0 is off. */
  intervalMining: number;
  intervalMiningError?: string;
  /** A client that exited on its own, or whose container is gone even after `stopClient`. */
  clientError?: string;
  /** The latest execution block (`eth_getBlockByNumber`). */
  el: { hash: string; number: string; timestamp: string; [field: string]: unknown };
  /** Beacon API `finality_checkpoints` of the head state. */
  finality: {
    data: { finalized: { epoch: string; root: string }; [field: string]: unknown };
    [field: string]: unknown;
  };
}
export interface Resources {
  cpu: { user: number; system: number };
  memory: { rss: number; heapTotal: number; heapUsed: number; external: number };
}

/**
 * `POST /control/{method}` with the params array as the body; the reply is `{ result }`. Optional
 * parameters are spelled as alternative tuples because the documentation parser drops `?` marks.
 */
export interface Commands {
  /** Readiness and the current session. */
  lifecycle: { params: []; result: SnapshotLifecycle };
  /** This network owner's immutable snapshots. */
  snapshotList: { params: []; result: SnapshotRef[] };
  /** A durable outcome by operation UUID; an unknown operation returns nothing. */
  snapshotOperation: { params: [operationId: string]; result?: SnapshotOperationRecord };
  /** Save and resume at the same time. Supply an operation UUID to recover a lost response. */
  snapshotCreate: { params: [] | [operationId: string]; result: SnapshotRef };
  /** Restore a snapshot, change session, and turn automine and interval mining off. */
  snapshotRestore: {
    params: [snapshotId: string] | [snapshotId: string, operationId: string];
    result: SnapshotRestoreResult;
  };
  /** Remove only the saved artifact. */
  snapshotRemove: {
    params: [snapshotId: string] | [snapshotId: string, operationId: string];
    result: SnapshotRef;
  };
  /** Cleanly stop and preserve the active network at its completed slot. */
  stop: { params: []; result: SnapshotLifecycle };
  /** Resume the preserved active network and change session. */
  resume: { params: []; result: SnapshotLifecycle };
  /**
   * Stop the controller and remove its active network, like `deno task down`; completed snapshots
   * remain. Use `stop` to preserve the network for `resume`.
   */
  shutdown: { params: []; result: { id: string } };
  /** Protocol time, automine, interval mining, a lost client, the latest EL block and finality. */
  status: { params: []; result: Status };
  /** Controller process CPU and memory. */
  resources: { params: []; result: Resources };
  /** Advance one slot with every duty. */
  stepSlot: { params: []; result: Step };
  advanceSlots: { params: [count: number]; result: Step };
  advanceEpochs: { params: [count: number]; result: Step };
  /** Advance protocol time by seconds. */
  advanceTime: {
    params: [seconds: number] | [seconds: number, options: WarpOptions];
    result: Step;
  };
  /** Advance protocol time to a Unix timestamp in seconds. */
  advanceTo: {
    params: [timestamp: number] | [timestamp: number, options: WarpOptions];
    result: Step;
  };
  /** Skip slots without blocks; validators miss their duties. */
  skipSlots: { params: [count: number]; result: Step };
  /** Produce a block whenever an executable transaction arrives. */
  setAutomine: { params: [enabled: boolean]; result: null };
  /**
   * Produce a slot every `intervalMs` of real time, with or without transactions, like Hardhat's
   * `evm_setIntervalMining`; 0 turns it off. Works together with automine and time jumps.
   */
  setIntervalMining: { params: [intervalMs: number]; result: null };
  /** Container state of the managed EL, beacon node and validator client. */
  clients: { params: []; result: Clients };
  /** Stop or (with `kill`) crash a client. Time mutations are refused until it is started. */
  stopClient: {
    params: [role: ClientRole] | [role: ClientRole, options: ClientOptions];
    result: Clients;
  };
  /** Start a stopped client from its own data at the current protocol time. */
  startClient: { params: [role: ClientRole]; result: Clients };
  restartClient: {
    params: [role: ClientRole] | [role: ClientRole, options: ClientOptions];
    result: Clients;
  };
  /** Every registry validator, whether its key is in the VC and enabled. */
  validators: { params: []; result: ManagedValidator[] };
  /** Offline validators keep their keys and history but stop every duty until set online. */
  setValidatorsOnline: {
    params: [selector: (number | string)[], online: boolean];
    result: null;
  };
  /** Import an EIP-2335 keystore into the VC. */
  importValidator: { params: [keystore: string, password: string]; result: null };
  /** Remove a key from the VC; returns it with its slashing protection interchange JSON. */
  removeValidator: { params: [pubkey: string]; result: RemovedValidator };
  /** Fee recipient, gas limit and graffiti of one validator. */
  configureValidator: { params: [pubkey: string, settings: ValidatorSettings]; result: null };
  /** Sign and publish a voluntary exit for a managed validator. */
  exitValidator: { params: [pubkey: string]; result: null };
  /** The block of a future slot is not produced; every other duty continues. */
  missProposal: { params: [slot: number]; result: null };
  /** Gloas: the block of a future slot is published, its execution payload envelope is not. */
  withholdPayload: { params: [slot: number]; result: null };
}
export type CommandName = keyof Commands;
type Result<M extends CommandName> = Promise<Commands[M]["result"]>;

/** Error document of a failed control request. */
export interface ControlError {
  error: string;
  /** A failed snapshot operation; it may still contain a published snapshot or generation. */
  operation?: SnapshotOperationRecord;
}

/** A failed request: the controller's error message and HTTP status. */
export declare class ChronixError extends Error {
  constructor(message: string, status: number);
  readonly status: number;
}
/** A failed snapshot operation; it may still contain a published snapshot or generation. */
export declare class SnapshotOperationError extends ChronixError {
  constructor(operation: SnapshotOperationRecord, status?: number);
  readonly operation: SnapshotOperationRecord;
}

export interface ChronixClientOptions {
  /** Deadline of every request in milliseconds. Defaults to one hour. */
  timeoutMs?: number;
  /**
   * The fetch that sends every request. Defaults to the global fetch, read at each request. The
   * controller answers a command when it ends, and Node's fetch gives up after 300 s without
   * response headers: on Node, pass a fetch with an undici dispatcher whose `headersTimeout` and
   * `bodyTimeout` are 0, so `timeoutMs` stays the only deadline.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}
export interface ChronixClientApi {
  readonly url: string;
  /** Send any control command with its params array. */
  command<M extends CommandName>(method: M, params: Commands[M]["params"]): Result<M>;
  lifecycle(): Result<"lifecycle">;
  listSnapshots(): Result<"snapshotList">;
  snapshotOperation(id: string): Result<"snapshotOperation">;
  createSnapshot(operationId?: string): Result<"snapshotCreate">;
  restoreSnapshot(snapshot: SnapshotRef | string, operationId?: string): Result<"snapshotRestore">;
  removeSnapshot(snapshot: SnapshotRef | string, operationId?: string): Result<"snapshotRemove">;
  /** Download a snapshot archive to a new file and verify its SHA-256. Node and Deno only. */
  exportSnapshot(
    snapshot: SnapshotRef | string,
    path: string,
    options?: SnapshotExportOptions,
  ): Promise<SnapshotExportResult>;
  stop(): Result<"stop">;
  resume(): Result<"resume">;
  shutdown(): Result<"shutdown">;
  status(): Result<"status">;
  resources(): Result<"resources">;
  stepSlot(): Result<"stepSlot">;
  advanceSlots(count: number): Result<"advanceSlots">;
  advanceEpochs(count: number): Result<"advanceEpochs">;
  advanceTime(seconds: number, options?: WarpOptions): Result<"advanceTime">;
  advanceTo(timestamp: number | Date, options?: WarpOptions): Result<"advanceTo">;
  skipSlots(count: number): Result<"skipSlots">;
  setAutomine(enabled: boolean): Result<"setAutomine">;
  setIntervalMining(intervalMs: number): Result<"setIntervalMining">;
  clients(): Result<"clients">;
  stopClient(role: ClientRole, options?: ClientOptions): Result<"stopClient">;
  startClient(role: ClientRole): Result<"startClient">;
  restartClient(role: ClientRole, options?: ClientOptions): Result<"restartClient">;
  validators(): Result<"validators">;
  setValidatorsOnline(
    selector: (number | string)[],
    online: boolean,
  ): Result<"setValidatorsOnline">;
  importValidator(keystore: string, password: string): Result<"importValidator">;
  removeValidator(pubkey: string): Result<"removeValidator">;
  configureValidator(pubkey: string, settings: ValidatorSettings): Result<"configureValidator">;
  exitValidator(pubkey: string): Result<"exitValidator">;
  missProposal(slot: number): Result<"missProposal">;
  withholdPayload(slot: number): Result<"withholdPayload">;
  /** Execution JSON-RPC through the controller. */
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Beacon API GET through the controller, such as `/eth/v1/beacon/headers/head`. */
  beacon<T = unknown>(path: string): Promise<T>;
  /** Step slots until `predicate` holds; returns the number of slots stepped. */
  advanceUntil(
    predicate: () => Promise<boolean>,
    options: { maxSlots: number; timeoutMs?: number },
  ): Promise<number>;
}
export interface ChronixClient extends ChronixClientApi {}
/** HTTP client of a running Chronix controller, such as `http://127.0.0.1:8545`. */
export declare class ChronixClient {
  constructor(url: string, options?: ChronixClientOptions);
}
