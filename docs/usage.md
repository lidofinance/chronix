# Using Chronix

Chronix is a local Ethereum development environment for the Gloas profile (Pectra is kept only as
history and is no longer maintained): an execution client (EL; Reth by default, or Geth), a
Lighthouse beacon node and real validators, one Deno/TypeScript controller, and Docker managed
through dockerode. A one-shot ethereum-genesis-generator creates genesis. See
[measurements](measurements.md) for validation results and benchmarks, and the
[project plan](plan.md) for completed work and next steps.

## Setup and startup

Install **Deno 2.9.7** and start a local Docker daemon; see
[requirements](../README.md#requirements).

```sh
deno task smoke:docker
deno task bake gloas --tag local # Build local artifacts from the pinned recipe on this machine.
deno task test:profile gloas --bake local
deno task up --profile gloas --bake local # Foreground; Ctrl-C cleans up this instance's resources.
```

Tasks use the installed `deno` command. `deno.json` contains tasks, dependencies and runtime
settings; `deno.lock` pins resolved dependency versions.

For VS Code, open the repository root and install the recommended **Deno** extension
(`denoland.vscode-deno`). The extension can discover the installed Deno and the root `deno.json`.

See [bake profiles](bakes.md) for Lighthouse version selection, tags and validation suites, and the
[EL catalog](bakes.md#el-catalog) for the EL. For example, run
`deno task up --profile gloas --bake trial` after building and verifying `gloas:trial`.

## Connections and configuration

In another terminal, run `deno task down` or `deno task reset --profile gloas --bake local`.
`CHRONIX_ID` selects the instance (default: `local`), and `CHRONIX_PORT` sets the controller port
(8545). To select a Docker socket, use `CHRONIX_DOCKER_SOCKET=/path/to/docker.sock` or
`DOCKER_HOST=unix:///path/to/docker.sock`. Docker Desktop on macOS is detected automatically. Remote
Docker daemons are not supported because the network uses local bind mounts. Public RPC and Beacon
API bind to 127.0.0.1. The internal Engine proxy accepts container connections through the host
gateway and verifies JWTs; see the [architecture](architecture.md).

JSON-RPC is available at the root of the controller URL. Standard Beacon API paths `/eth/v1/...` and
`/eth/v2/...` use the same address. Automine is off by default. Keys and the mnemonic are public and
intended only for this local environment.

Protocol time moves only on commands. `setIntervalMining(12_000)` makes the network move like a live
chain, like Hardhat's `evm_setIntervalMining`: a slot every 12 seconds of real time, with or without
transactions; `0` turns it off. It works together with automine and time jumps. Creating a snapshot
keeps both modes; restoring a snapshot turns both off.

`CHRONIX_PROFILE`, `CHRONIX_BAKE` and `CHRONIX_EL` select the profile, bake and EL when command-line
options or API configuration do not specify them. `up` treats each of them as an explicit request:
it refuses when a controller already runs under that `CHRONIX_ID` with another profile, bake or EL.

## TypeScript API

`Devnet` is the [Chronix client](client.md) (`ChronixClient`) plus ownership of a controller it
starts. Other projects install the client alone from GitHub; the examples below use paths relative
to the repository root.

```ts
import { Devnet } from "./src/api.ts";

await using net = await Devnet.start({ id: "my-e2e", profile: "gloas", bake: "local" });
const initial = await net.status();
await net.stepSlot();
await net.advanceEpochs(2);
await net.advanceTime(3600); // Execute one protocol hour with continuous validator participation.
await net.advanceTo(new Date((initial.now + 7200) * 1000));
await net.setAutomine(true);
// eth_sendRawTransaction returns the usual transaction hash; wait for the receipt separately.
await net.advanceUntil(
  async () => BigInt((await net.status()).finality.data.finalized.epoch) >= 3n,
  { maxSlots: 160 },
);
```

To connect to a running controller, use `new Devnet("http://127.0.0.1:8545")`. `close()` and
`await using` stop only an instance created by that object. Connecting to another controller does
not transfer ownership of its lifecycle.

`await net.importValidator(keystoreJson, password)` imports one EIP-2335 keystore through
Lighthouse's keymanager. `await net.exitValidator(pubkey)` asks Lighthouse to sign a voluntary exit
and submits it to the Beacon API. Both operations run in the controller, alongside serialized time
controls; the caller does not need access to Chronix's files or keymanager token. Lighthouse
validates keys, signatures and consensus conditions. Importing an existing key is reported as an
error.

The HTTP equivalents are `POST /control/importValidator` with `["<EIP-2335 JSON>","<password>"]` and
`POST /control/exitValidator` with `["0x<48-byte-pubkey>"]`; `POST /control` also accepts
`{"method":...,"params":[...]}`. Every command is listed in the
[control API reference](control-api.md) and [OpenAPI](../client/openapi.json). See
[CI images](ci-containers.md) to use the same API from a container service.

## Protocol time

`advanceTime` accepts seconds with millisecond precision. `advanceTo` accepts a Unix timestamp in
seconds or a `Date`. Time only moves forward. Choose the mode per call:

```ts
await net.advanceTime(8192 * 12, { mode: "honest" }); // Default; produce every intervening slot.
await net.advanceTime(8192 * 12, { mode: "fast" }); // Skip most slots; inactivity penalties apply.
await net.advanceTo(new Date("2033-06-01T00:00:00Z"), { mode: "fast" });
```

Both modes preserve the exact target, including partial slots. Later duties within that slot wait
for the next advancement. `stepSlot`, `advanceSlots`, `advanceEpochs` and automine always execute
normal duties. All mutations share one serialized timeline, including mixed-mode calls.

Honest mode executes every intervening phase; bakes declaring `directSync` use its direct delivery
of verified individual sync messages. The older Pectra `panda` artifact uses ordinary delivery.
Roughly 13 minutes for 8192 Gloas `direct-sync` slots is a historical estimate, not a full passing
benchmark. Fast mode restores the earlier skip algorithm only when explicitly requested: jumps over
32 slots complete current duties, restart the VC just before the destination with the same keys and
slashing database, then produce the destination normally. Smaller jumps execute normally.
`skipSlots(n)` still provides explicit downtime without the destination block.

Fast mode permits missed-duty penalties, loss of rewards and stale finality at return. It does not
permit conflicting signatures or disabled slashing protection. Finality recovers through subsequent
honest slots. A test requiring normal validator economics or finality throughout the interval must
use honest mode. Protocol slots stay 12 seconds long; real network deadlines are unchanged.

The control endpoint accepts the same option:

```json
{ "method": "advanceTime", "params": [98304, { "mode": "fast" }] }
```

The fast regression budget is 25 seconds for 8192 slots **including the first next transaction**.
Honest mode has separate economic assertions and a failure watchdog per 1000-slot sample: 20 minutes
on Gloas and 55 minutes on the older Pectra artifact, not a one-minute performance promise. See
[mode validation](warp-modes.md). A full honest test contains two such samples; it does not certify
an 8192-slot honest traversal. These are test budgets, not per-call API deadlines. For
phase-by-phase execution, exact-target examples, VC restart and failure semantics, read
[the algorithm walkthrough](warp-algorithm.md).

## Network parameters

Everything a network fixes at genesis is one `NetworkOptions` object (`client/types.d.ts`).
`Devnet.start` takes its fields at the top level; the CLI takes it as `--network <json|file>` and
the CI image as `CHRONIX_NETWORK`. `--genesis` and `CHRONIX_GENESIS` remain a shorthand for its
`genesis` field, and `--el` and `CHRONIX_EL` for its `el` field; the CLI refuses `el` set both ways.
Unknown keys are rejected.

```ts
await using net = await Devnet.start({
  el: "geth-master-5d8fd6b", // An entry of clients/el/. Default "reth-main-f4676ea".
  chainId: 32382, // Default 1337.
  genesisTime: 1_900_000_000, // Integer unix seconds. Default 2,000,000,000 (2033).
  genesisForkVersion: "0x10000038", // Deposit signing domain. Default "0x10000000".
  history: "archive", // Keep every historical EL and CL state. Default "pruned".
  genesis: { validators: [{ count: 64, balance: "2048ETH", withdrawal: { type: "0x02" } }] },
});
```

The default genesis timestamp lies ahead of the host clock on purpose: protocol time is explicit.
The mainnet preset uses 32 slots per epoch, 64 genesis validators, and standard churn, activation
and withdrawal parameters. Electra/Prague is active from genesis. There is no `minimal` profile. At
every start Chronix compares `eth_chainId`, the Beacon genesis time and, when set, the fork version
with these options and refuses a mismatch. A retained network resumes only when every explicit
option equals its stored value; an explicit default equals an omitted option. The CLI refuses
explicit network options for an already running controller, because it cannot confirm them. Unknown
genesis keys are rejected. Only the current formats are supported: a network or snapshot from
another release is not converted; run `down` and start it again.

`history: "archive"` keeps all EL history (Geth: the hash state scheme and `--gcmode=archive`; Reth:
its default archive node) and runs Lighthouse with `--archive`, so `eth_call` and `eth_getBalance`
at any block and Beacon states of any finalized slot remain readable. A pruned network serves CL
states only above the finalized split. Its EL state covers about the last 128 blocks on Geth and the
last 10,064 blocks on Reth, the smallest account and storage history distance Reth accepts. The
storage layout is fixed at genesis: history travels with snapshots and cannot change on an existing
network.

## Execution client

The network option `el` names an entry of the [EL catalog](bakes.md#el-catalog). The default is
`reth-main-f4676ea` (Reth); `geth-master-5d8fd6b` runs Geth. A network keeps its EL for life: a
snapshot records it, and resuming or restoring with another `el` is refused. The client profile in
`src/el_client.ts` holds what Chronix does differently per client: start flags, the payload gate,
the shutdown check and the builder's minimum tip.

Reth is the default because Geth `geth-master-5d8fd6b` cannot build the pending block after
Amsterdam while protocol time is ahead of the host clock: `eth_getBlockByNumber("pending")` answers
`pending block is not available`, and calls on the `pending` tag answer
`pending state is not available`. Reth builds `pending` from the pool on top of `latest`.

Differences that tests can see:

- **Automine tip floor.** Automine waits only for transactions the EL's builder includes, so the
  effective tip must reach the profile's `minimumTip`: 1 Mwei on Geth (its `miner.gasprice`
  default), 0 on Reth. On Geth a transaction with a lower tip stays pending and triggers no slot.
- **Suggested tip.** On empty blocks Reth suggests a zero priority fee
  ([gas oracle](https://github.com/paradigmxyz/reth/blob/f4676eaa19ed807d59aa7bfdf090437f39ad7fca/crates/rpc/rpc-eth-types/src/gas_oracle.rs)),
  so libraries such as ethers send a zero tip; Reth's builder includes such a transaction.
- **Fee cap floor.** Reth's pool refuses a fee cap below 7 wei, the protocol's minimum base fee, as
  `transaction underpriced`
  ([txpool.rs](https://github.com/paradigmxyz/reth/blob/f4676eaa19ed807d59aa7bfdf090437f39ad7fca/crates/transaction-pool/src/pool/txpool.rs#L2163-L2165)).
- **Debug stubs.** Reth answers `debug_accountRange`, `debug_dumpBlock`,
  `debug_getModifiedAccountsByNumber`, `debug_getModifiedAccountsByHash` and `debug_storageRangeAt`
  with `null`
  ([debug.rs](https://github.com/paradigmxyz/reth/blob/f4676eaa19ed807d59aa7bfdf090437f39ad7fca/crates/rpc/rpc/src/debug.rs#L1257-L1428)).
  Chronix forwards these answers unchanged.
- **Blob transactions.** Reth's `eth_fillTransaction` does not compute KZG commitments and cell
  proofs
  ([transaction.rs](https://github.com/paradigmxyz/reth/blob/f4676eaa19ed807d59aa7bfdf090437f39ad7fca/crates/rpc/rpc-eth-api/src/helpers/transaction.rs#L586-L660));
  build the blob sidecar in the client.
- **Pruned history** keeps about 128 blocks of EL state on Geth and 10,064 on Reth.
- **Database growth.** Chronix sets Reth's MDBX growth step to 4 MB (`--db.growth-step=4MB`; the
  default is 4 GiB) because snapshots hash and copy the whole database file.

## Client images

Client images are not part of the Chronix image or of a bake manifest. One loader, `ensureImage` in
`src/client_images.ts`, brings each image into the Docker daemon at every start, resume and snapshot
restore:

1. An image with the pinned ID already in the daemon is used as is.
2. Otherwise the archive `<hex>.tar.gz` (the image ID without `sha256:`) in the client archive
   directory is loaded, and its ID is checked. An archive that holds another image is refused, and
   an image it added is removed again.
3. Otherwise an image with a registry digest is pulled by that digest for the bake's platform, and
   its ID and platform are checked. The EL digest comes from its catalog entry; the Lighthouse and
   genesis digests come from the bake (in the service image, from `release.json.clients`).
4. Otherwise startup fails with an error that names the image.

`CHRONIX_CLIENTS_DIR` sets the archive directory: `.cache/baker/images` by default from source,
`/clients` in the service image. The loader never writes there, so the directory may be mounted
read-only. A local build without a registry digest, such as a locally baked Lighthouse or a local EL
entry, comes only from the daemon or from an archive. To supply an archive, save the image by ID;
`<hex>` is the ID without `sha256:`:

```sh
docker save <image-id> | gzip > "<archive-directory>/<hex>.tar.gz"
```

The service image writes archives with `chronix clients save`; see
[CI images](ci-containers.md#client-images-and-archives).

A network records the EL client and image ID it was created with. A resume or a snapshot restore
whose catalog entry now names another image is refused; a running network stops with its recorded
client even if its catalog entry was removed.

## Genesis parameters

Genesis is created once, so everything a scenario needs from the first block is a `genesis` option
of `Devnet.start`. Omitted fields keep the defaults above.

```ts
await using net = await Devnet.start({
  genesis: {
    // One EL allocation for wallets and contracts. Balances are integer wei or whole "ETH".
    accounts: {
      "0x1111111111111111111111111111111111111111": { balance: "1000ETH" },
      "0x2222222222222222222222222222222222222222": {
        balance: "0",
        code: "0x60005460005260206000f3",
        storage: { "0x00": "0x2a" },
        nonce: 1,
      },
    },
    mnemonicAccounts: { count: 10, balance: "1000ETH" }, // First addresses of the test mnemonic.
    gasLimit: 60_000_000, // Genesis block, the EL builder's target and the Gloas gas limit schedule.
    feeRecipient: "0x3333333333333333333333333333333333333333",
    // Groups keep index order. Without `mnemonic` they continue the managed mnemonic's key
    // indices; every key is in the validator client.
    validators: [
      { count: 48 }, // 32 ETH, 0x01 credentials for the funded development account.
      { count: 16, balance: "2048ETH", withdrawal: { type: "0x02", address: "0x2222…" } },
      { count: 8, withdrawal: { type: "0x00" } }, // BLS withdrawal key from the mnemonic.
      { count: 8, mnemonic: "<12–24 words>", start: 0 }, // Keys of another mnemonic.
      { count: 8, online: false }, // Keys in the VC but disabled: silent from genesis.
    ],
    // Network config values only; the mainnet preset stays fixed.
    spec: { SHARD_COMMITTEE_PERIOD: 1, MIN_VALIDATOR_WITHDRAWABILITY_DELAY: 1 },
    gloasForkEpoch: 2, // Fulu before epoch 2, Gloas from it; default: Gloas from genesis.
    // Blob parameter only schedule for the EL and Lighthouse (up to 5 entries, epoch order).
    blobSchedule: [{ epoch: 0, max: 1, target: 1 }],
  },
});
```

With `gloasForkEpoch`, slots before the fork use Fulu duty times from the beacon node's spec, carry
their payload inside the block and have no payload timeliness committee. `withholdPayload` needs
Gloas slots. Snapshots work on both sides of the fork: a Fulu head is saved with the payload its
block carries, and a restored or imported pre-fork network forks again at the same epoch. The pinned
Lighthouse cannot derive fork-epoch PTC duties from a pre-Gloas head state, so its validator client
casts no payload attestations in the first Gloas epoch; Chronix does not wait for them there, and
PTC votes start in the following epoch.

The total of all groups must stay within 64–1024 validators. From 1024 validators committees have 32
members and only selected members aggregate; Chronix checks that selection with the same
deterministic proofs as the validator client. On the development host 1024 validators reached about
2.1 honest slots per second, and 0.7 slots per second with 64 of them offline, because Chronix then
also performs the sync aggregator duty. Allowed `spec` keys are `SHARD_COMMITTEE_PERIOD`,
`MIN_VALIDATOR_WITHDRAWABILITY_DELAY`, `EJECTION_BALANCE` and the churn limits listed in
`src/genesis.ts`; `churnLimitQuotient` and `consolidationChurnLimitQuotient` remain top-level
options. Genesis parameters are part of the network configuration, so a retained network or snapshot
is resumed only with the same values. The CLI and the CI image accept them inside `--network` /
`CHRONIX_NETWORK`, or alone as `--genesis <file.json>` / `CHRONIX_GENESIS` (inline JSON or a file
path).

## Client control

```ts
await net.clients(); // { el: { running, exitCode?, startedAt }, bn: …, vc: … }
await net.stopClient("bn"); // Graceful; { kill: true } simulates a crash.
await net.startClient("bn"); // Recreated from its own data at the current protocol time.
await net.restartClient("vc", { kill: true });
```

While a client is stopped, every time mutation, automine slot and snapshot is refused with
`Client <role> is stopped`; the timeline itself does not fault. `lifecycle()` stays available;
`status()` needs Docker, the EL and the beacon node. A client that exits on its own (a crash, an OOM
kill, a stop outside Chronix) or whose container is removed, even after `stopClient`, cannot be
started again: the next time mutation, snapshot or `stop` fails with
`Client <role> exited on its own (exit <code>[, OOMKilled])` or `Client <role> is missing` and
faults the timeline until a snapshot restore, or `down` and `up`. `status().clientError` and the CI
image's healthcheck report it before that; when the lost client is the EL or the beacon node,
`status()` fails with that message instead. A started client keeps its database; ports change, and
the controller rebinds its proxies, the Engine gate and validator readiness. Logs of each earlier
run are kept as `<role>-run-<time>.log` with the instance diagnostics. A killed validator client
recovers from its database without losing a block; `{ kill: true }` stays supported for it. A killed
EL may lose its unsaved head (observed with Geth; Reth runs with
`--engine.persistence-threshold=0`), and with no peers in this topology neither client can fetch a
lost head again. Lighthouse writes fork choice to disk only at startup, at a graceful stop, or on an
epoch transition or a reorg, so a killed beacon node restarts from that older record and the blocks
produced since are orphaned. The next slot then fails with a bounded error, which faults the
timeline: only a snapshot restore, or `down` and `up`, recovers it. Use a graceful
`restartClient("el")` or `restartClient("bn")` for EL and beacon-node restarts.

## Validator control

```ts
await net.validators(); // [{ index, pubkey, status, managed, online }] for the whole registry.
await net.setValidatorsOnline([56, 57, 58], false); // Indices or public keys.
await net.setValidatorsOnline([56, 57, 58], true);
await net.configureValidator(pubkey, { feeRecipient, gasLimit: 45_000_000, graffiti: "chronix" });
const removed = await net.removeValidator(pubkey); // { keystore, password, slashingProtection }
await net.importValidator(removed.keystore!, removed.password!);
await net.missProposal(slot); // The block of this future slot is not produced.
await net.withholdPayload(slot); // Gloas: the block is published, its payload envelope is not.
```

`configureValidator` sets the VC's fee recipient, graffiti and gas limit preference for that key;
all three apply to the validator's own blocks. The fee recipient and graffiti apply to the next
block. In Gloas the gas limit is a proposer preference that the VC publishes once per epoch for the
current and next epoch, so it takes effect from the first epoch not yet published; blocks without a
preference target the network's gas limit schedule (60M by default, or `genesis.gasLimit`).
`removeValidator` returns the keystore and its password over `/control`; like snapshots, this
assumes the disposable development keys of a local network, so do not publish the control port
beyond the test host.

A disabled key loses its index in the VC, and an imported key has none yet. The VC learns indices
again one request per key, in no fixed order, while it already performs the slot's duties. If such a
key proposes in the next slot and the VC asks for its block before it has the index, the VC refuses
its own block and that slot stays empty. Chronix sees the order on its relay and moves on instead of
waiting for the block. Change keys a few slots before a proposal that a test relies on.

An offline validator keeps its key and signing history in the VC but is disabled there, so it
neither requests duties nor signs: missed proposals, attestations, sync messages and payload
attestations, inactivity penalties and lost finality follow from the real protocol. A removed key
behaves the same way until it is imported again. Honest advancement waits only for duties of enabled
keys. Sync committee seats of silent validators cannot complete the bake's direct sync delivery;
Chronix then performs the sync aggregator duty with an online member's real key and the standard
Beacon API, so blocks carry exactly the online seats. As on a real network, a subcommittee without a
selected online aggregator contributes nothing in that slot.

`missProposal` and `withholdPayload` refuse the validator client's block or payload envelope request
for that slot; attestations and every other duty continue. Both need a future slot and are part of
the running session: snapshots are refused until scheduled slots have passed. Offline and removed
keys are stored with the validator keys and therefore stay in saved and restored networks. A
snapshot taken right after a withheld payload, before the next block, is refused because the head
has no executed payload yet.

## Execution tracing

The EL's `debug` namespace is enabled. The controller forwards only read-only methods such as
`debug_traceTransaction`, `debug_traceCall`, `debug_traceBlockByNumber`, `debug_storageRangeAt` and
`debug_getRaw*`; methods that can change EL state (for example `debug_setHead`) are answered with
HTTP 403 and a JSON-RPC error without reaching the EL. Some forwarded methods are `null` stubs on
Reth; see [Execution client](#execution-client). Bodies that JavaScript and the EL could read
differently (trailing data after the JSON value, a differently cased `method` key) are refused when
they could name a debug method. The EL's own HTTP port (`manifest.el`, bound to 127.0.0.1) is an
internal endpoint without this filter, like it is without automine notifications: any local process
can reach it, so use the controller address in tests and services.

## Tests and measurements

```sh
deno task test                         # Fast unit checks; Docker and e2e tests are skipped.
CHRONIX_DOCKER_TEST=1 deno task test        # Rollback and protection of unrelated resources.
CHRONIX_E2E=1 deno task test                # Selected profile's real e2e scenarios; requires its images.
deno task e2e                          # Time, automine, finality and a separate indexer.
deno task e2e:warp-fast                # Two fast 8192-slot jumps, next tx, signing and resumed finality.
deno task e2e:warp                     # Two honest 1000-slot jumps with economic checks.
deno task e2e:warp-economics           # Short honest economics/deployment regression.
deno task test:protocol                # Named deposit/consolidation and exit/withdrawal tests on every maintained hardfork.
deno task e2e:withdrawal               # Named exit/withdrawal stages on every maintained hardfork.
deno task e2e:protocol                 # Named deposit/activation/consolidation stages on every maintained hardfork.
deno task e2e:deploy                   # 20 sequential deployments through RPC and ethers.
deno task test:lifecycle               # Repeated up/down/reset and reproducible genesis.
deno task test:clock                   # Rust clock regression; uses the build cache.
deno task test:profile gloas --bake local --el geth-master-5d8fd6b # Full profile suite on one EL.
deno task measure                      # Two fresh instances: CPU, memory, disk and advancement speed.
deno task diagnose
deno task profile                      # A running instance; advances 32 slots.
deno task check
```

Scenario tasks run on the EL from `CHRONIX_EL` (default `reth-main-f4676ea`); `test:profile` takes
`--el` and writes its reports to `reports/profiles/<hardfork>/<tag>/<el>/`. For lifecycle test
files, stage descriptions, bake selection and single-profile commands, see the
[protocol test guide](../bakes/shared/tests/README.md).

## Automine and sequential deployments

For sequential deployments, enable `await net.setAutomine(true)`, wait for the previous
transaction's receipt, then submit the next transaction. Automine produces the next block
automatically; no `stepSlot` call or `sleep` is needed between transactions. Each block still goes
through real EL/CL processing, so computation takes a nonzero amount of time.

When using ethers, configure receipt polling for the fast local network:

```ts
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { privateKey } from "./src/config.ts";

const provider = new JsonRpcProvider(net.url, 1337, {
  staticNetwork: true, // This instance has a fixed chainId.
  pollingInterval: 25,
  cacheTimeout: -1,
  batchMaxCount: 1,
});
const signer = new NonceManager(new Wallet(privateKey, provider));
// new ContractFactory(abi, bytecode, signer).deploy(...)
// await contract.waitForDeployment() before the next dependent deployment.
// Call provider.destroy() when finished.
```

Polling and batching are client settings; they do not change the protocol slot length. Request
caching is disabled so sequential operations do not see stale nonces or block numbers. See the
[ethers options](https://docs.ethers.org/v6/api/providers/jsonrpc/#JsonRpcApiProviderOptions). The
[deployment example](../bakes/shared/tests/deploy.ts) checks constructors, runtime code and a
continuous block sequence. Individual latency measurements are saved in `reports/deploy.json`.

## Errors, timeouts and external services

Controller readiness, CL/VC completion barriers, Engine requests, validator operations and SDK
requests default to a **one-hour wall-clock watchdog** (`3600000` ms). Set `CHRONIX_TIMEOUT_MS` in
the controller process (or with `docker run -e CHRONIX_TIMEOUT_MS=3600000 ...`) to override it. A
separately running SDK reads its own environment. This is a hang safeguard, not a performance target
or a maximum slot count. A multi-stage operation can contain several bounded waits.

Tests keep their own explicit `timeoutMs`, `AbortSignal.timeout(...)` and warp watchdogs. The
missing-signer regression sets a 30-second controller budget for the failing step. Existing
Lighthouse binaries still answer native waits in at most 30-second segments; Chronix retries only
HTTP 408 within the common budget and still requires every exact slot/root completion mark. Health
probes, shutdown grace periods and JWT freshness checks remain separate from operation budgets: they
do not cut off a running warp. Client-internal networking deadlines are unchanged.

`advanceUntil` has both a slot limit and a real-time deadline. An error within a phase does not roll
back the clients. Further advancement is blocked until reset to avoid continuing from an uncertain
state. Independent requests and network watchdogs continue to use real time. An external service
sees advanced block timestamps, while its own system clock remains unchanged.

## State and cleanup

Fork sources, build artifacts and instance state live in `.cache/`, `.tools/` and `.chronix/`, which
are not committed. Volumes named `chronix-bake-cache-*` form a separate, reusable compiler cache.
`down/reset` cleans up resources only for the selected `CHRONIX_ID`. Global Docker prune is never
used.

## Validator exits and consolidation

The consolidation example sets `churnLimitQuotient: 4`: with 64 validators, standard churn leaves no
capacity for consolidation. Gloas also requires the separate `consolidationChurnLimitQuotient: 4`.
These are explicit test overrides; the ordinary churn defaults are 65536 for Pectra and 32768 for
Gloas, and Gloas consolidation defaults to 65536. The full exit example preserves standard delays
and uses explicit `skipSlots` for long periods without blocks. Real inactivity penalties apply after
skipped slots.

## Engine API

To control block production, the same Deno process hosts an Engine proxy in front of the EL. It
defers preparation of future payloads. For the current payload, the EL's client profile sets the
gate: on Geth the proxy waits for the pinned Geth version's full-payload JSON log; Reth's own
`getPayload` waits for its in-flight build, so the proxy forwards it at once. A new EL version needs
this checked again; see the [architecture](architecture.md). The [review results](review.md)
describe defects found and the checks used to verify their fixes.

## Limitations

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are unverified or unsupported in this version. After a crash, run
`deno task down`, then `deno task up`: resuming existing state after a controller restart is not
implemented. The EL's real-time transaction-pool expiry continues while protocol time is paused. A
killed beacon node loses the blocks produced since its last graceful stop (see
[client control](#client-control)).
