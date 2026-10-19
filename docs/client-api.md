# Chronix client API reference

Generated from `client/types.d.ts`. Regenerate with `deno task docs:api`; verify with
`deno task docs:api --check`.

[Client guide](client.md) · [Control API reference](control-api.md) ·
[OpenAPI 3.1](../client/openapi.json)

## `ChronixClient`

```ts
new ChronixClient(url: string, options?: ChronixClientOptions)
```

HTTP client of a running Chronix controller, such as `http://127.0.0.1:8545`.

`url` is read-only.

Options (`ChronixClientOptions`):

| Field       | Type                                                    | Required | Description                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs` | `number`                                                | no       | Deadline of every request in milliseconds. Defaults to one hour.                                                                                                                                                                                                                                                                               |
| `fetch`     | `(url: string, init: RequestInit) => Promise<Response>` | no       | The fetch that sends every request. Defaults to the global fetch, read at each request. The controller answers a command when it ends, and Node's fetch gives up after 300 s without response headers: on Node, pass a fetch with an undici dispatcher whose `headersTimeout` and `bodyTimeout` are 0, so `timeoutMs` stays the only deadline. |

## Methods

### `command`

```ts
command<M extends CommandName>(method: M, params: Commands[M]["params"]): Promise<Commands[M]["result"]>
```

Send any control command with its params array.

### `lifecycle`

```ts
lifecycle(): Promise<SnapshotLifecycle>
```

Readiness and the current session.

Sends `POST /control/lifecycle`.

### `listSnapshots`

```ts
listSnapshots(): Promise<SnapshotRef[]>
```

This network owner's immutable snapshots.

Sends `POST /control/snapshotList`.

### `snapshotOperation`

```ts
snapshotOperation(id: string): Promise<SnapshotOperationRecord | undefined>
```

A durable outcome by operation UUID; an unknown operation returns nothing.

Sends `POST /control/snapshotOperation`.

### `createSnapshot`

```ts
createSnapshot(operationId?: string): Promise<SnapshotRef>
```

Save and resume at the same time. Supply an operation UUID to recover a lost response.

Sends `POST /control/snapshotCreate`.

### `restoreSnapshot`

```ts
restoreSnapshot(snapshot: SnapshotRef | string, operationId?: string): Promise<SnapshotRestoreResult>
```

Restore a snapshot, change session, and turn automine and interval mining off.

Sends `POST /control/snapshotRestore`.

### `removeSnapshot`

```ts
removeSnapshot(snapshot: SnapshotRef | string, operationId?: string): Promise<SnapshotRef>
```

Remove only the saved artifact.

Sends `POST /control/snapshotRemove`.

### `exportSnapshot`

```ts
exportSnapshot(snapshot: SnapshotRef | string, path: string, options?: SnapshotExportOptions): Promise<SnapshotExportResult>
```

Download a snapshot archive to a new file and verify its SHA-256. Node and Deno only.

### `stop`

```ts
stop(): Promise<SnapshotLifecycle>
```

Cleanly stop and preserve the active network at its completed slot.

Sends `POST /control/stop`.

### `resume`

```ts
resume(): Promise<SnapshotLifecycle>
```

Resume the preserved active network and change session.

Sends `POST /control/resume`.

### `shutdown`

```ts
shutdown(): Promise<{ id: string }>
```

Stop the controller and remove its active network, like `deno task down`; completed snapshots
remain. Use `stop` to preserve the network for `resume`.

Sends `POST /control/shutdown`.

### `status`

```ts
status(): Promise<Status>
```

Protocol time, automine, interval mining, a lost client, the latest EL block and finality.

Sends `POST /control/status`.

### `resources`

```ts
resources(): Promise<Resources>
```

Controller process CPU and memory.

Sends `POST /control/resources`.

### `stepSlot`

```ts
stepSlot(): Promise<Step>
```

Advance one slot with every duty.

Sends `POST /control/stepSlot`.

### `advanceSlots`

```ts
advanceSlots(count: number): Promise<Step>
```

Sends `POST /control/advanceSlots`.

### `advanceEpochs`

```ts
advanceEpochs(count: number): Promise<Step>
```

Sends `POST /control/advanceEpochs`.

### `advanceTime`

```ts
advanceTime(seconds: number, options?: WarpOptions): Promise<Step>
```

Advance protocol time by seconds.

Sends `POST /control/advanceTime`.

### `advanceTo`

```ts
advanceTo(timestamp: number | Date, options?: WarpOptions): Promise<Step>
```

Advance protocol time to a Unix timestamp in seconds.

Sends `POST /control/advanceTo`.

### `skipSlots`

```ts
skipSlots(count: number): Promise<Step>
```

Skip slots without blocks; validators miss their duties.

Sends `POST /control/skipSlots`.

### `setAutomine`

```ts
setAutomine(enabled: boolean): Promise<null>
```

Produce a block whenever an executable transaction arrives.

Sends `POST /control/setAutomine`.

### `setIntervalMining`

```ts
setIntervalMining(intervalMs: number): Promise<null>
```

Produce a slot every `intervalMs` of real time, with or without transactions, like Hardhat's
`evm_setIntervalMining`; 0 turns it off. Works together with automine and time jumps.

Sends `POST /control/setIntervalMining`.

### `clients`

```ts
clients(): Promise<Clients>
```

Container state of the managed EL, beacon node and validator client.

Sends `POST /control/clients`.

### `stopClient`

```ts
stopClient(role: ClientRole, options?: ClientOptions): Promise<Clients>
```

Stop or (with `kill`) crash a client. Time mutations are refused until it is started.

Sends `POST /control/stopClient`.

### `startClient`

```ts
startClient(role: ClientRole): Promise<Clients>
```

Start a stopped client from its own data at the current protocol time.

Sends `POST /control/startClient`.

### `restartClient`

```ts
restartClient(role: ClientRole, options?: ClientOptions): Promise<Clients>
```

Sends `POST /control/restartClient`.

### `validators`

```ts
validators(): Promise<ManagedValidator[]>
```

Every registry validator, whether its key is in the VC and enabled.

Sends `POST /control/validators`.

### `setValidatorsOnline`

```ts
setValidatorsOnline(selector: (number | string)[], online: boolean): Promise<null>
```

Offline validators keep their keys and history but stop every duty until set online.

Sends `POST /control/setValidatorsOnline`.

### `importValidator`

```ts
importValidator(keystore: string, password: string): Promise<null>
```

Import an EIP-2335 keystore into the VC.

Sends `POST /control/importValidator`.

### `removeValidator`

```ts
removeValidator(pubkey: string): Promise<RemovedValidator>
```

Remove a key from the VC; returns it with its slashing protection interchange JSON.

Sends `POST /control/removeValidator`.

### `configureValidator`

```ts
configureValidator(pubkey: string, settings: ValidatorSettings): Promise<null>
```

Fee recipient, gas limit and graffiti of one validator.

Sends `POST /control/configureValidator`.

### `exitValidator`

```ts
exitValidator(pubkey: string): Promise<null>
```

Sign and publish a voluntary exit for a managed validator.

Sends `POST /control/exitValidator`.

### `missProposal`

```ts
missProposal(slot: number): Promise<null>
```

The block of a future slot is not produced; every other duty continues.

Sends `POST /control/missProposal`.

### `withholdPayload`

```ts
withholdPayload(slot: number): Promise<null>
```

Gloas: the block of a future slot is published, its execution payload envelope is not.

Sends `POST /control/withholdPayload`.

### `rpc`

```ts
rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>
```

Execution JSON-RPC through the controller.

### `beacon`

```ts
beacon<T = unknown>(path: string): Promise<T>
```

Beacon API GET through the controller, such as `/eth/v1/beacon/headers/head`.

### `advanceUntil`

```ts
advanceUntil(predicate: () => Promise<boolean>, options: { maxSlots: number; timeoutMs?: number }): Promise<number>
```

Step slots until `predicate` holds; returns the number of slots stepped.

## Errors

### `ChronixError`

```ts
class ChronixError extends Error
```

A failed request: the controller's error message and HTTP status.

| Field    | Type     | Required | Description |
| -------- | -------- | -------- | ----------- |
| `status` | `number` | yes      |             |

### `SnapshotOperationError`

```ts
class SnapshotOperationError extends ChronixError
```

A failed snapshot operation; it may still contain a published snapshot or generation.

| Field       | Type                      | Required | Description |
| ----------- | ------------------------- | -------- | ----------- |
| `operation` | `SnapshotOperationRecord` | yes      |             |

## Types

`Commands` maps every control command to its parameter tuple and result; see the
[control API reference](control-api.md).

### `ClientOptions`

| Field  | Type      | Required | Description                                                                |
| ------ | --------- | -------- | -------------------------------------------------------------------------- |
| `kill` | `boolean` | no       | `stopClient`/`restartClient`: crash the client instead of a graceful stop. |

### `ClientRole`

```ts
type ClientRole = "el" | "bn" | "vc";
```

### `ClientState`

| Field       | Type      | Required | Description |
| ----------- | --------- | -------- | ----------- |
| `running`   | `boolean` | yes      |             |
| `exitCode`  | `number`  | no       |             |
| `startedAt` | `string`  | yes      |             |

### `Clients`

```ts
type Clients = Record<ClientRole, ClientState>;
```

### `CommandName`

```ts
type CommandName = keyof Commands;
```

### `ControlError`

Error document of a failed control request.

| Field       | Type                      | Required | Description                                                                           |
| ----------- | ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `error`     | `string`                  | yes      |                                                                                       |
| `operation` | `SnapshotOperationRecord` | no       | A failed snapshot operation; it may still contain a published snapshot or generation. |

### `Genesis`

| Field              | Type                                                                               | Required | Description                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`         | `Record<string, GenesisAccount>`                                                   | no       | Explicit allocations; an entry for the default development account replaces it.                                                                                                         |
| `mnemonicAccounts` | `{ count: number; balance: string }`                                               | no       | Fund the first `count` addresses of the managed development mnemonic.                                                                                                                   |
| `gasLimit`         | `number`                                                                           | no       |                                                                                                                                                                                         |
| `validators`       | `ValidatorGroup[]`                                                                 | no       |                                                                                                                                                                                         |
| `feeRecipient`     | `string`                                                                           | no       |                                                                                                                                                                                         |
| `spec`             | `Partial<Record<SpecOverride, number>>`                                            | no       | Network config values only; the mainnet preset stays fixed.                                                                                                                             |
| `gloasForkEpoch`   | `number`                                                                           | no       | Epoch at which Gloas activates; earlier epochs run Fulu. Defaults to genesis.                                                                                                           |
| `blobSchedule`     | `{ epoch: number; max: number; target: number; baseFeeUpdateFraction?: number }[]` | no       | Blob parameter only (BPO) schedule for EL and CL, at most 5 entries in epoch order. Replaces the generator's default schedule; `baseFeeUpdateFraction` 0 or omitted lets it be derived. |

### `GenesisAccount`

One EL genesis allocation: a funded wallet, or a contract when code/storage are present.

| Field     | Type                     | Required | Description                                    |
| --------- | ------------------------ | -------- | ---------------------------------------------- |
| `balance` | `string`                 | yes      | Integer wei, or whole ether such as "1000ETH". |
| `code`    | `string`                 | no       |                                                |
| `storage` | `Record<string, string>` | no       |                                                |
| `nonce`   | `number`                 | no       |                                                |

### `HistoryMode`

Historical state storage. Both clients fix it at genesis.

```ts
type HistoryMode = "pruned" | "archive";
```

### `ManagedValidator`

| Field     | Type      | Required | Description                                                           |
| --------- | --------- | -------- | --------------------------------------------------------------------- |
| `index`   | `number`  | no       |                                                                       |
| `pubkey`  | `string`  | yes      |                                                                       |
| `status`  | `string`  | no       |                                                                       |
| `managed` | `boolean` | yes      | The key is present in the managed VC.                                 |
| `online`  | `boolean` | yes      | The key is present and enabled, so the validator performs its duties. |

### `NetworkOptions`

Network parameters fixed at genesis. `Devnet.start`, the CLI (`--network`) and the CI image
(`CHRONIX_NETWORK`) accept this one object; `CHRONIX_GENESIS` is a shorthand for `genesis`.

| Field                             | Type          | Required | Description                                                                               |
| --------------------------------- | ------------- | -------- | ----------------------------------------------------------------------------------------- |
| `chainId`                         | `number`      | no       | Default 1337.                                                                             |
| `genesisTime`                     | `number`      | no       | Unix seconds. Default 2,000,000,000 (2033), ahead of the host clock on purpose.           |
| `genesisForkVersion`              | `string`      | no       | Four lowercase hex bytes; sets the deposit signing domain. Default "0x10000000".          |
| `validators`                      | `number`      | no       | 64–1024; with genesis validator groups it equals their total. Default 64.                 |
| `churnLimitQuotient`              | `number`      | no       | Default: the profile's mainnet value.                                                     |
| `consolidationChurnLimitQuotient` | `number`      | no       | Default 65536.                                                                            |
| `history`                         | `HistoryMode` | no       | "archive" keeps every historical EL and CL state. Default "pruned".                       |
| `genesis`                         | `Genesis`     | no       |                                                                                           |
| `el`                              | `string`      | no       | EL client: an entry name of Chronix's `clients/el/` catalog. Default "reth-main-f4676ea". |

### `ProfileName`

```ts
type ProfileName = "gloas" | "pectra";
```

### `RemovedValidator`

| Field                | Type     | Required | Description                                    |
| -------------------- | -------- | -------- | ---------------------------------------------- |
| `pubkey`             | `string` | yes      |                                                |
| `keystore`           | `string` | no       |                                                |
| `password`           | `string` | no       |                                                |
| `slashingProtection` | `string` | yes      | EIP-3076 slashing protection interchange JSON. |

### `Resources`

| Field    | Type                                                                     | Required | Description |
| -------- | ------------------------------------------------------------------------ | -------- | ----------- |
| `cpu`    | `{ user: number; system: number }`                                       | yes      |             |
| `memory` | `{ rss: number; heapTotal: number; heapUsed: number; external: number }` | yes      |             |

### `SnapshotExportOptions`

| Field      | Type     | Required | Description                                 |
| ---------- | -------- | -------- | ------------------------------------------- |
| `maxBytes` | `number` | no       | Refuse a larger archive. Defaults to 8 GiB. |

### `SnapshotExportResult`

| Field    | Type     | Required | Description |
| -------- | -------- | -------- | ----------- |
| `path`   | `string` | yes      |             |
| `sha256` | `string` | yes      |             |
| `bytes`  | `number` | yes      |             |

### `SnapshotLifecycle`

Readiness and the current session; available without live clients.

| Field              | Type                                                 | Required | Description                      |
| ------------------ | ---------------------------------------------------- | -------- | -------------------------------- |
| `phase`            | `"ready" \| "maintenance" \| "parked" \| "faulted"`  | yes      |                                  |
| `ready`            | `boolean`                                            | yes      |                                  |
| `id`               | `string`                                             | yes      |                                  |
| `profile`          | `ProfileName`                                        | yes      |                                  |
| `bake`             | `string`                                             | yes      |                                  |
| `el`               | `string`                                             | yes      | EL catalog entry of the network. |
| `generation`       | `string`                                             | no       |                                  |
| `sessionId`        | `string`                                             | yes      |                                  |
| `now`              | `number`                                             | no       |                                  |
| `slot`             | `number`                                             | no       |                                  |
| `recoveryRequired` | `boolean`                                            | yes      |                                  |
| `active`           | `number`                                             | yes      |                                  |
| `streams`          | `number`                                             | yes      |                                  |
| `operation`        | `string`                                             | no       |                                  |
| `error`            | `string`                                             | no       |                                  |
| `cleanup`          | `{ state: "succeeded" \| "failed"; error?: string }` | no       |                                  |

### `SnapshotOperationRecord`

Stored operation metadata, including partial failure and independent cleanup.

| Field                 | Type                                                              | Required | Description |
| --------------------- | ----------------------------------------------------------------- | -------- | ----------- |
| `schema`              | `1`                                                               | yes      |             |
| `owner`               | `string`                                                          | yes      |             |
| `id`                  | `string`                                                          | yes      |             |
| `request`             | `SnapshotRequest`                                                 | yes      |             |
| `state`               | `"running" \| "succeeded" \| "failed"`                            | yes      |             |
| `stage`               | `string`                                                          | yes      |             |
| `createdAt`           | `string`                                                          | yes      |             |
| `updatedAt`           | `string`                                                          | yes      |             |
| `snapshot`            | `SnapshotRef`                                                     | no       |             |
| `sourceGeneration`    | `string`                                                          | no       |             |
| `candidateGeneration` | `string`                                                          | no       |             |
| `automine`            | `boolean`                                                         | no       |             |
| `intervalMining`      | `number`                                                          | no       |             |
| `result`              | `unknown`                                                         | no       |             |
| `error`               | `string`                                                          | no       |             |
| `cleanup`             | `{ state: "pending" \| "succeeded" \| "failed"; error?: string }` | no       |             |

### `SnapshotRef`

| Field           | Type          | Required | Description                    |
| --------------- | ------------- | -------- | ------------------------------ |
| `id`            | `string`      | yes      |                                |
| `createdAt`     | `string`      | yes      |                                |
| `profile`       | `ProfileName` | yes      |                                |
| `bakeKey`       | `string`      | yes      |                                |
| `nowMs`         | `number`      | yes      | Protocol time in milliseconds. |
| `headSlot`      | `number`      | yes      |                                |
| `headBlockRoot` | `string`      | yes      |                                |

### `SnapshotRequest`

| Field        | Type                                | Required | Description |
| ------------ | ----------------------------------- | -------- | ----------- |
| `kind`       | `"create" \| "restore" \| "remove"` | yes      |             |
| `snapshotId` | `string`                            | no       |             |

### `SnapshotRestoreResult`

| Field        | Type          | Required | Description                                                         |
| ------------ | ------------- | -------- | ------------------------------------------------------------------- |
| `snapshot`   | `SnapshotRef` | yes      |                                                                     |
| `generation` | `string`      | yes      |                                                                     |
| `sessionId`  | `string`      | yes      | Reset external providers and indexers for this replacement session. |
| `nowMs`      | `number`      | yes      |                                                                     |

### `SpecOverride`

```ts
type SpecOverride =
  | "SHARD_COMMITTEE_PERIOD"
  | "MIN_VALIDATOR_WITHDRAWABILITY_DELAY"
  | "EJECTION_BALANCE"
  | "MIN_PER_EPOCH_CHURN_LIMIT"
  | "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT"
  | "MIN_PER_EPOCH_CHURN_LIMIT_ELECTRA"
  | "MAX_PER_EPOCH_ACTIVATION_EXIT_CHURN_LIMIT"
  | "MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT_GLOAS";
```

### `Status`

| Field                 | Type                                                                                                           | Required | Description                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `id`                  | `string`                                                                                                       | yes      |                                                                                      |
| `profile`             | `ProfileName`                                                                                                  | yes      |                                                                                      |
| `bake`                | `string`                                                                                                       | yes      |                                                                                      |
| `bakeKey`             | `string`                                                                                                       | yes      |                                                                                      |
| `sessionId`           | `string`                                                                                                       | yes      |                                                                                      |
| `now`                 | `number`                                                                                                       | yes      | Protocol time in seconds.                                                            |
| `slot`                | `number`                                                                                                       | yes      |                                                                                      |
| `automine`            | `boolean`                                                                                                      | yes      |                                                                                      |
| `automineError`       | `string`                                                                                                       | no       |                                                                                      |
| `intervalMining`      | `number`                                                                                                       | yes      | Milliseconds between interval-mined slots; 0 is off.                                 |
| `intervalMiningError` | `string`                                                                                                       | no       |                                                                                      |
| `clientError`         | `string`                                                                                                       | no       | A client that exited on its own, or whose container is gone even after `stopClient`. |
| `el`                  | `{ hash: string; number: string; timestamp: string; [field: string]: unknown }`                                | yes      | The latest execution block (`eth_getBlockByNumber`).                                 |
| `finality`            | `{ data: { finalized: { epoch: string; root: string }; [field: string]: unknown }; [field: string]: unknown }` | yes      | Beacon API `finality_checkpoints` of the head state.                                 |

### `Step`

Protocol time after a time command.

| Field  | Type     | Required | Description               |
| ------ | -------- | -------- | ------------------------- |
| `now`  | `number` | yes      | Protocol time in seconds. |
| `slot` | `number` | yes      |                           |

### `ValidatorGroup`

Genesis validators with shared parameters; keys continue the managed mnemonic's indices.

| Field        | Type                                         | Required | Description                                                                           |
| ------------ | -------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `count`      | `number`                                     | yes      |                                                                                       |
| `balance`    | `string`                                     | no       | Integer gwei, or whole ether such as "2048ETH". Defaults to 32 ETH.                   |
| `withdrawal` | `{ type: WithdrawalType; address?: string }` | no       | Defaults to 0x01 credentials for the funded development account.                      |
| `mnemonic`   | `string`                                     | no       | Keys from this BIP-39 mnemonic instead of the managed development mnemonic.           |
| `start`      | `number`                                     | no       | First key index of `mnemonic` (default 0); managed keys continue from earlier groups. |
| `online`     | `boolean`                                    | no       | false: the keys are in the VC but disabled from genesis, so the group never signs.    |

### `ValidatorSettings`

| Field          | Type     | Required | Description |
| -------------- | -------- | -------- | ----------- |
| `feeRecipient` | `string` | no       |             |
| `gasLimit`     | `number` | no       |             |
| `graffiti`     | `string` | no       |             |

### `WarpMode`

```ts
type WarpMode = "honest" | "fast";
```

### `WarpOptions`

| Field  | Type       | Required | Description                                                                          |
| ------ | ---------- | -------- | ------------------------------------------------------------------------------------ |
| `mode` | `WarpMode` | no       | Honest executes every duty; fast permits empty slots and their inactivity penalties. |

### `WithdrawalType`

```ts
type WithdrawalType = "0x00" | "0x01" | "0x02";
```
