# Using Panda

Panda is a local Ethereum development environment for the Gloas profile (Pectra is kept only as
history and is no longer maintained): Geth, a Lighthouse beacon node and real validators, one
Deno/TypeScript controller, and Docker managed through dockerode. A one-shot
ethereum-genesis-generator creates genesis. See [measurements](measurements.md) for validation
results and benchmarks, and the [project plan](plan.md) for completed work and next steps.

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

See [bake profiles](bakes.md) for EL/CL version selection, tags and validation suites. For example,
run `deno task up --profile gloas --bake trial` after building and verifying `gloas:trial`.

## Connections and configuration

In another terminal, run `deno task down` or `deno task reset --profile gloas --bake local`.
`PANDA_ID` selects the instance (default: `local`), and `PANDA_PORT` sets the controller port
(8545). To select a Docker socket, use `PANDA_DOCKER_SOCKET=/path/to/docker.sock` or
`DOCKER_HOST=unix:///path/to/docker.sock`. Docker Desktop on macOS is detected automatically. Remote
Docker daemons are not supported because the network uses local bind mounts. Public RPC and Beacon
API bind to 127.0.0.1. The internal Engine proxy accepts container connections through the host
gateway and verifies JWTs; see the [architecture](architecture.md).

JSON-RPC is available at the root of the controller URL. Standard Beacon API paths `/eth/v1/...` and
`/eth/v2/...` use the same address. Automine is off by default. Keys and the mnemonic are public and
intended only for this local environment.

`PANDA_PROFILE` and `PANDA_BAKE` select the default profile and bake when command-line options or
API configuration do not specify them.

## TypeScript API

`Devnet` is the [Panda client](client.md) (`PandaClient`) plus ownership of a controller it starts.
Other projects install the client alone from GitHub; the examples below use paths relative to the
repository root.

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
controls; the caller does not need access to Panda's files or keymanager token. Lighthouse validates
keys, signatures and consensus conditions. Importing an existing key is reported as an error.

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
the CI image as `PANDA_NETWORK`. `--genesis` and `PANDA_GENESIS` remain a shorthand for its
`genesis` field. Unknown keys are rejected.

```ts
await using net = await Devnet.start({
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
every start Panda compares `eth_chainId`, the Beacon genesis time and, when set, the fork version
with these options and refuses a mismatch. A retained network resumes only when every explicit
option equals its stored value; an explicit default equals an omitted option. The CLI refuses
explicit network options for an already running controller, because it cannot confirm them. Unknown
genesis keys are rejected, so a network created by an older release with an unknown key in its
genesis needs `down` before it starts with this release.

`history: "archive"` runs Geth with the hash state scheme and `--gcmode=archive` and Lighthouse with
`--archive`, so `eth_call` and `eth_getBalance` at any block and Beacon states of any finalized slot
remain readable. A pruned network serves EL state of about the last 128 blocks and CL states only
above the finalized split. The storage layout is fixed at genesis: history travels with snapshots
and cannot change on an existing network.

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
    gasLimit: 60_000_000, // Genesis block, Geth's target and the Gloas gas limit schedule.
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
    // Blob parameter only schedule for Geth and Lighthouse (up to 5 entries, epoch order).
    blobSchedule: [{ epoch: 0, max: 1, target: 1 }],
  },
});
```

With `gloasForkEpoch`, slots before the fork use Fulu duty times from the beacon node's spec, carry
their payload inside the block and have no payload timeliness committee. Snapshots and
`withholdPayload` need Gloas slots: a snapshot whose head predates the fork is refused. The pinned
Lighthouse cannot derive fork-epoch PTC duties from a pre-Gloas head state, so its validator client
casts no payload attestations in the first Gloas epoch; Panda does not wait for them there, and PTC
votes start in the following epoch.

The total of all groups must stay within 64–1024 validators. From 1024 validators committees have 32
members and only selected members aggregate; Panda checks that selection with the same deterministic
proofs as the validator client. On the development host 1024 validators reached about 2.1 honest
slots per second, and 0.7 slots per second with 64 of them offline, because Panda then also performs
the sync aggregator duty. Allowed `spec` keys are `SHARD_COMMITTEE_PERIOD`,
`MIN_VALIDATOR_WITHDRAWABILITY_DELAY`, `EJECTION_BALANCE` and the churn limits listed in
`src/genesis.ts`; `churnLimitQuotient` and `consolidationChurnLimitQuotient` remain top-level
options. Genesis parameters are part of the network configuration, so a retained network or snapshot
is resumed only with the same values. The CLI and the CI image accept them inside `--network` /
`PANDA_NETWORK`, or alone as `--genesis <file.json>` / `PANDA_GENESIS` (inline JSON or a file path).

## Client control

```ts
await net.clients(); // { el: { running, exitCode?, startedAt }, bn: …, vc: … }
await net.stopClient("bn"); // Graceful; { kill: true } simulates a crash.
await net.startClient("bn"); // Recreated from its own data at the current protocol time.
await net.restartClient("vc", { kill: true });
```

While a client is stopped, every time mutation, automine slot and snapshot is refused with
`Client <role> is stopped`; the timeline itself does not fault. `lifecycle()` stays available,
`status()` needs EL and beacon node. A started client keeps its database; ports change, and the
controller rebinds its proxies, the Engine gate and validator readiness. Logs of each earlier run
are kept as `<role>-run-<time>.log` with the instance diagnostics. Killed validator clients and
beacon nodes recover from their databases. A killed Geth loses its unpersisted head and, with no
peers in this topology, cannot fetch it again: the next slot then fails with a bounded error and the
network needs a snapshot restore or reset. Use a graceful `restartClient("el")` for EL restarts.

## Validator control

```ts
await net.validators(); // [{ index, pubkey, status, managed, online }] for the whole registry.
await net.setValidatorsOnline([56, 57, 58], false); // Indices or public keys.
await net.setValidatorsOnline([56, 57, 58], true);
await net.configureValidator(pubkey, { feeRecipient, gasLimit: 45_000_000, graffiti: "panda" });
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

An offline validator keeps its key and signing history in the VC but is disabled there, so it
neither requests duties nor signs: missed proposals, attestations, sync messages and payload
attestations, inactivity penalties and lost finality follow from the real protocol. A removed key
behaves the same way until it is imported again. Honest advancement waits only for duties of enabled
keys. Sync committee seats of silent validators cannot complete the bake's direct sync delivery;
Panda then performs the sync aggregator duty with an online member's real key and the standard
Beacon API, so blocks carry exactly the online seats. As on a real network, a subcommittee without a
selected online aggregator contributes nothing in that slot.

`missProposal` and `withholdPayload` refuse the validator client's block or payload envelope request
for that slot; attestations and every other duty continue. Both need a future slot and are part of
the running session: snapshots are refused until scheduled slots have passed. Offline and removed
keys are stored with the validator keys and therefore stay in saved and restored networks. A
snapshot taken right after a withheld payload, before the next block, is refused because the head
has no executed payload yet.

## Execution tracing

Geth's `debug` namespace is enabled. The controller forwards only read-only methods such as
`debug_traceTransaction`, `debug_traceCall`, `debug_traceBlockByNumber`, `debug_storageRangeAt` and
`debug_getRaw*`; methods that can change Geth state (for example `debug_setHead`) are answered with
HTTP 403 and a JSON-RPC error without reaching Geth. Bodies that JavaScript and Geth could read
differently (trailing data after the JSON value, a differently cased `method` key) are refused when
they could name a debug method. Geth's own HTTP port (`manifest.el`, bound to 127.0.0.1) is an
internal endpoint without this filter, like it is without automine notifications: any local process
can reach it, so use the controller address in tests and services.

## Tests and measurements

```sh
deno task test                         # Fast unit checks; Docker and e2e tests are skipped.
PANDA_DOCKER_TEST=1 deno task test        # Rollback and protection of unrelated resources.
PANDA_E2E=1 deno task test                # Selected profile's real e2e scenarios; requires its images.
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
deno task measure                      # Two fresh instances: CPU, memory, disk and advancement speed.
deno task diagnose
deno task profile                      # A running instance; advances 32 slots.
deno task check
```

For lifecycle test files, stage descriptions, bake selection and single-profile commands, see the
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
requests default to a **one-hour wall-clock watchdog** (`3600000` ms). Set `PANDA_TIMEOUT_MS` in the
controller process (or with `docker run -e PANDA_TIMEOUT_MS=3600000 ...`) to override it. A
separately running SDK reads its own environment. This is a hang safeguard, not a performance target
or a maximum slot count. A multi-stage operation can contain several bounded waits.

Tests keep their own explicit `timeoutMs`, `AbortSignal.timeout(...)` and warp watchdogs. The
missing-signer regression sets a 30-second controller budget for the failing step. Existing
Lighthouse binaries still answer native waits in at most 30-second segments; Panda retries only HTTP
408 within the common budget and still requires every exact slot/root completion mark. Health
probes, shutdown grace periods and JWT freshness checks remain separate from operation budgets: they
do not cut off a running warp. Client-internal networking deadlines are unchanged.

`advanceUntil` has both a slot limit and a real-time deadline. An error within a phase does not roll
back the clients. Further advancement is blocked until reset to avoid continuing from an uncertain
state. Independent requests and network watchdogs continue to use real time. An external service
sees advanced block timestamps, while its own system clock remains unchanged.

## State and cleanup

Fork sources, build artifacts and instance state live in `.cache/`, `.tools/` and `.panda/`, which
are not committed. Volumes named `panda-bake-cache-*` form a separate, reusable compiler cache.
`down/reset` cleans up resources only for the selected `PANDA_ID`. Global Docker prune is never
used.

## Validator exits and consolidation

The consolidation example sets `churnLimitQuotient: 4`: with 64 validators, standard churn leaves no
capacity for consolidation. Gloas also requires the separate `consolidationChurnLimitQuotient: 4`.
These are explicit test overrides; the ordinary churn defaults are 65536 for Pectra and 32768 for
Gloas, and Gloas consolidation defaults to 65536. The full exit example preserves standard delays
and uses explicit `skipSlots` for long periods without blocks. Real inactivity penalties apply after
skipped slots.

## Engine API

Geth provides the execution layer. To control block production, the same Deno process hosts an
Engine proxy. It defers preparation of future payloads and waits for the current payload build to
finish, using the pinned Geth version's JSON log. This dependency must be checked again when
upgrading Geth. The [review results](review.md) describe defects found and the checks used to verify
their fixes.

## Limitations

HTTP JSON-RPC is supported. WebSocket, long-lived Beacon SSE, multiple beacon nodes and arbitrary
external validators are unverified or unsupported in this version. After a crash, run
`deno task down`, then `deno task up`: resuming existing state after a controller restart is not
implemented. Geth's real-time transaction-pool expiry continues while protocol time is paused.
